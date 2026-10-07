// ACP plugin conformance adapter for prime-agent-acp-plugin.
//
// Drives the REAL plugin entry point (../index.ts) against a fake gateway,
// against the shared corpus vendored byte-identically at
// test/fixtures/plugin-corpus.json (canonical home:
// davidcrowe/gatewaystack-connect:conformance/plugin-corpus.json, tracking
// davidcrowe/gatewaystack-connect#1344). Do not hand-edit the fixture; re-copy
// it from the canonical source and update CORPUS_FINGERPRINT below together.
//
// Invocation follows test/decisions.test.ts's existing convention: a fake
// `pi` object that records registered event handlers, and a fake
// ExtensionContext, driven directly (no real @earendil-works/pi-coding-agent
// runtime needed — the plugin only imports its types, which are erased).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import acp from "../index.ts";

const CORPUS_PATH = fileURLToPath(new URL("./fixtures/plugin-corpus.json", import.meta.url));
const CORPUS_FINGERPRINT = "aa186d3fb3e7d18c";
const PLUGIN_NAME = "prime-agent-acp-plugin";

// Canonical tool-name mapping for prime-agent: NONE. index.ts's checkPayload()
// forwards event.toolName straight through as tool_name on both
// /govern/tool-use and /govern/tool-output (see index.ts:311 / :444) — there
// is no rename table. So "the adapter's declared canonical mapping" is the
// identity function.
const CANONICAL_TOOL_NAME = (nativeToolName: string): string => nativeToolName;

// Populated only for a capability the corpus lists "supported" that this
// adapter actually observed failing on origin/main. Each entry here MUST be
// asserted to fail below; the final test asserts this list is exactly what
// was recorded (an empty list here means everything the corpus called
// "supported" for this plugin genuinely passed).
const EXPECTED_DIVERGENCES: Array<{ id: string; issue: string; evidence: string }> = [];

type Handler = (event: any, ctx: any) => Promise<any> | any;

/** Minimal prime-agent-shaped API that captures registered handlers (copied style: test/decisions.test.ts). */
function fakePi() {
  const handlers: Record<string, Handler> = {};
  return {
    handlers,
    on: (event: string, fn: Handler) => {
      handlers[event] = fn;
    },
  };
}

/**
 * Fake ExtensionContext. `notifies` records every ctx.ui.notify() call — the
 * person-visible channel tell() (index.ts:127) writes to whenever
 * ctx.hasUI is true, which is the default here and in the plugin's own
 * TUI/RPC/attended posture.
 */
function fakeCtx({ hasUI = true, sessionId = "conf-sess" } = {}) {
  const notifies: Array<{ msg: string; level: string }> = [];
  return {
    notifies,
    hasUI,
    cwd: "/tmp",
    signal: new AbortController().signal,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify: (msg: string, level: string) => notifies.push({ msg, level }),
      confirm: async () => true,
    },
  };
}

/** One-route stub gateway; respond(url, body) decides per request. Records every request. */
function stubGateway(
  respond: (url: string, body: any) => { status?: number; json?: any },
): Promise<{ server: Server; base: string; requests: Array<{ method: string; path: string; body: any }> }> {
  const requests: Array<{ method: string; path: string; body: any }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push({ method: req.method ?? "", path: req.url ?? "", body });
      const { status = 200, json = {} } = respond(req.url ?? "", body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}`, requests });
    }),
  );
}

/**
 * Isolate HOME/state to a fresh temp dir per case (so ~/.acp/credentials or
 * lapse.log on the developer's machine can't influence a run), set the
 * dummy credential the plugin requires to install its handlers, clear any
 * inherited ACP_SHADOW, then apply the case's own env. Returns a restore fn.
 */
function isolateEnv(caseEnv: Record<string, string> = {}): () => void {
  const saved = { ...process.env };
  delete process.env.ACP_SHADOW;
  delete process.env.ACP_AGENT_TIER;
  delete process.env.ACP_GOVERN_BASE;
  delete process.env.ACP_API_BASE;
  process.env.HOME = mkdtempSync(join(tmpdir(), "prime-agent-conf-"));
  process.env.ACP_BEARER_TOKEN = "acpconf-dummy-token-never-real";
  for (const [k, v] of Object.entries(caseEnv)) process.env[k] = v;
  return () => {
    process.env = saved;
  };
}

function expectedDivergence(id: string) {
  return EXPECTED_DIVERGENCES.find((d) => d.id === id);
}

/** Run `assertion`; if `id` is a declared divergence, require it to FAIL instead. */
function checkCase(id: string, assertion: () => void): void {
  const div = expectedDivergence(id);
  if (!div) {
    assertion();
    return;
  }
  assert.throws(
    assertion,
    undefined,
    `case "${id}" is listed in EXPECTED_DIVERGENCES (${div.issue}) but now PASSES — remove the entry`,
  );
}

// --- fingerprint gate: refuse to run against a corpus that has drifted ---

test("vendored corpus matches the pinned fingerprint", () => {
  const raw = readFileSync(CORPUS_PATH);
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  assert.equal(
    digest,
    CORPUS_FINGERPRINT,
    "test/fixtures/plugin-corpus.json has drifted from the canonical corpus " +
      "(davidcrowe/gatewaystack-connect:conformance/plugin-corpus.json) — re-copy it, don't hand-edit",
  );
});

const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
const myRows: Array<{ plugin: string; capability: string; status: string }> = corpus.harnesses.filter(
  (h: any) => h.plugin === PLUGIN_NAME,
);
const supportedCapabilities = new Set(myRows.filter((r) => r.status === "supported").map((r) => r.capability));

function caseById(id: string): any {
  const c = corpus.cases.find((x: any) => x.id === id);
  assert.ok(c, `corpus is missing case "${id}"`);
  return c;
}

test("corpus declares both notice and post-tool as supported for prime-agent-acp-plugin", () => {
  assert.deepEqual([...supportedCapabilities].sort(), ["notice", "post-tool"]);
});

// --- notice capability (issue #1334) ---
// Channel captured: ctx.ui.notify() — the fake ExtensionContext's spy on the
// call tell() (index.ts:127) makes when ctx.hasUI is true, reached from the
// tool_result handler's shadow-notice branch at index.ts:465-469.

test('notice-shown: ACP_SHADOW unset -> gateway notice reaches ctx.ui.notify() ("notify" channel)', async () => {
  assert.ok(supportedCapabilities.has("notice"));
  const c = caseById("notice-shown");
  const restore = isolateEnv(c.env);
  const { server, base, requests } = await stubGateway((url) =>
    url.includes("/govern/tool-output") ? { json: c.gatewayReply } : { json: { decision: "allow" } },
  );
  process.env.ACP_GOVERN_BASE = base;
  const pi = fakePi();
  acp(pi as any);
  const ctx = fakeCtx();
  await pi.handlers.tool_result(
    { type: "tool_result", toolName: "shell", toolCallId: "conf-1", input: {}, content: [{ type: "text", text: "ok" }], isError: false },
    ctx,
  );
  server.close();
  restore();

  const req = requests.find((r) => r.path.includes("/govern/tool-output"));
  assert.ok(req, "expected the plugin to POST /govern/tool-output");
  const personSees = ctx.notifies.some((n) => n.msg.includes(c.expect.contains));
  checkCase("notice-shown", () => {
    assert.equal(personSees, c.expect.personSees, `expected ctx.ui.notify() to ${c.expect.personSees ? "" : "NOT "}carry "${c.expect.contains}"`);
  });
});

test("notice-shadow-off: ACP_SHADOW=off -> marker absent from ctx.ui.notify() AND stderr", async () => {
  assert.ok(supportedCapabilities.has("notice"));
  const c = caseById("notice-shadow-off");
  const restore = isolateEnv(c.env);
  const { server, base } = await stubGateway((url) =>
    url.includes("/govern/tool-output") ? { json: c.gatewayReply } : { json: { decision: "allow" } },
  );
  process.env.ACP_GOVERN_BASE = base;
  const pi = fakePi();
  acp(pi as any);
  // Also watch stderr — tell() falls back to console.error when ctx.hasUI is
  // false or ctx.ui.notify throws; the corpus requires the marker absent from
  // EVERY channel, so this test spies both.
  const ctx = fakeCtx();
  const originalErrorWrite = process.stderr.write.bind(process.stderr);
  let stderrCaptured = "";
  (process.stderr.write as any) = (chunk: any, ...rest: any[]) => {
    stderrCaptured += String(chunk);
    return originalErrorWrite(chunk, ...(rest as []));
  };
  try {
    await pi.handlers.tool_result(
      { type: "tool_result", toolName: "shell", toolCallId: "conf-2", input: {}, content: [{ type: "text", text: "ok" }], isError: false },
      ctx,
    );
  } finally {
    process.stderr.write = originalErrorWrite;
    server.close();
    restore();
  }

  const notifySaw = ctx.notifies.some((n) => n.msg.includes(c.expect.contains));
  const stderrSaw = stderrCaptured.includes(c.expect.contains);
  checkCase("notice-shadow-off", () => {
    assert.equal(notifySaw, false, "ACP_SHADOW=off must suppress the notify() channel");
    assert.equal(stderrSaw, false, "ACP_SHADOW=off must suppress the stderr channel");
  });
});

// --- post-tool capability (issue #1344) ---
// prime-agent's native post-tool hook is the `tool_result` pi event; its own
// field names are toolName / input / content (an array of {type, text}
// blocks). Built here from the corpus's harness-neutral case.call.

test("post-tool-fields: native tool_result payload -> POST /govern/tool-output carries required fields", async () => {
  assert.ok(supportedCapabilities.has("post-tool"));
  const c = caseById("post-tool-fields");
  const restore = isolateEnv(c.env);
  const { server, base, requests } = await stubGateway((url) =>
    url.includes("/govern/tool-output") ? { json: c.gatewayReply } : { json: { decision: "allow" } },
  );
  process.env.ACP_GOVERN_BASE = base;
  const pi = fakePi();
  acp(pi as any);
  const nativeToolName = c.call.tool; // "shell" — prime-agent forwards this verbatim, see CANONICAL_TOOL_NAME above
  const ctx = fakeCtx({ sessionId: c.call.sessionId });
  await pi.handlers.tool_result(
    {
      type: "tool_result",
      toolName: nativeToolName,
      toolCallId: "conf-post-tool-1",
      input: { command: c.call.command },
      content: [{ type: "text", text: c.call.output }],
      isError: false,
    },
    ctx,
  );
  server.close();
  restore();

  const req = requests.find((r) => r.path.includes("/govern/tool-output"));
  assert.ok(req, "expected a POST to /govern/tool-output");
  const marker = corpus.marker as string;

  checkCase("post-tool-fields", () => {
    assert.equal(req!.method, "POST");
    assert.equal(req!.body.hook_event_name, "PostToolUse");
    assert.equal(req!.body.tool_name, CANONICAL_TOOL_NAME(nativeToolName));
    assert.match(JSON.stringify(req!.body.tool_input), new RegExp(marker), "tool_input must carry the marker");
    assert.match(JSON.stringify(req!.body.tool_output), new RegExp(marker), "tool_output must carry the marker");
    assert.equal(typeof req!.body.session_id, "string");
    assert.ok((req!.body.session_id as string).length > 0, "session_id must be non-empty");
  });
});

test("EXPECTED_DIVERGENCES is exactly what this adapter observed on origin/main", () => {
  // prime-agent-acp-plugin passed every supported case when this adapter was
  // written — see the report accompanying this commit for the break-proof
  // evidence that the harness genuinely detects a regression here.
  assert.deepEqual(EXPECTED_DIVERGENCES, []);
});
