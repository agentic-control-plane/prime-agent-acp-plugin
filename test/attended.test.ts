import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import acp from "../index.ts";

function ctxOf(hasUI: boolean) {
  return {
    hasUI,
    cwd: "/tmp",
    signal: new AbortController().signal,
    sessionManager: { getSessionId: () => "sess-att" },
    ui: { notify: () => {}, confirm: async () => true },
  };
}

/** Mount against a stub gateway; returns handlers + every body the gateway saw. */
async function setup(tier?: string) {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ decision: "allow" }));
    });
  });
  const base: string = await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as any).port}`)),
  );
  process.env.ACP_BEARER_TOKEN = "gsk_test_token";
  process.env.ACP_GOVERN_BASE = base;
  if (tier === undefined) delete process.env.ACP_AGENT_TIER;
  else process.env.ACP_AGENT_TIER = tier;
  const handlers: Record<string, any> = {};
  acp({ on: (e: string, fn: any) => (handlers[e] = fn) } as any);
  return { handlers, bodies, server };
}

const CALL = { type: "tool_call", toolName: "bash", toolCallId: "c1", input: { command: "ls" } };
const RESULT = { type: "tool_result", toolName: "bash", toolCallId: "c1", input: {}, content: [{ type: "text", text: "ok" }], isError: false };

const WORKER = "PRIME_AGENT_INTERNAL_DAEMON_WORKER";

async function withEnv<T>(fn: () => Promise<T>, { worker = false, argv = [] as string[] } = {}): Promise<T> {
  const savedArgv = process.argv;
  const savedWorker = process.env[WORKER];
  if (worker) process.env[WORKER] = "1";
  else delete process.env[WORKER];
  process.argv = [...savedArgv, ...argv];
  try {
    return await fn();
  } finally {
    process.argv = savedArgv;
    if (savedWorker === undefined) delete process.env[WORKER];
    else process.env[WORKER] = savedWorker;
  }
}

test("PreToolUse: provably attended -> claim true, source hasUI, native_ask", async () => {
  await withEnv(async () => {
    const { handlers, bodies, server } = await setup();
    await handlers.tool_call(CALL, ctxOf(true));
    assert.deepEqual(bodies[0].attended, { claim: true, source: "hasUI" });
    assert.deepEqual(bodies[0].capabilities, ["native_ask"]);
    server.close();
  });
});

test("hasUI false -> claim false", async () => {
  await withEnv(async () => {
    const { handlers, bodies, server } = await setup();
    await handlers.tool_call(CALL, ctxOf(false));
    assert.deepEqual(bodies[0].attended, { claim: false, source: "hasUI" });
    server.close();
  });
});

test("hasUI true but headless argv (-p) -> claim false", async () => {
  await withEnv(async () => {
    const { handlers, bodies, server } = await setup();
    await handlers.tool_call(CALL, ctxOf(true));
    assert.equal(bodies[0].attended.claim, false);
    server.close();
  }, { argv: ["-p"] });
});

test("hasUI true inside a daemon worker -> claim false (attendance unknown)", async () => {
  await withEnv(async () => {
    const { handlers, bodies, server } = await setup();
    await handlers.tool_call(CALL, ctxOf(true));
    assert.equal(bodies[0].attended.claim, false);
    server.close();
  }, { worker: true });
});

test("claim is not derived from ACP_AGENT_TIER", async () => {
  await withEnv(async () => {
    const t = await setup("interactive");
    await t.handlers.tool_call(CALL, ctxOf(false));
    assert.equal(t.bodies[0].agent_tier, "interactive"); // tier behaviour unchanged
    assert.equal(t.bodies[0].attended.claim, false);
    t.server.close();
  });
});

test("PostToolUse carries no attended and no capabilities", async () => {
  await withEnv(async () => {
    const { handlers, bodies, server } = await setup();
    await handlers.tool_result(RESULT, ctxOf(true));
    assert.equal(bodies[0].hook_event_name, "PostToolUse");
    assert.equal("attended" in bodies[0], false);
    assert.equal("capabilities" in bodies[0], false);
    server.close();
  });
});
