# @agenticcontrolplane/prime-agent

[![tests](https://img.shields.io/badge/tests-18%20passing-brightgreen)](#test) [![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[Agentic Control Plane](https://agenticcontrolplane.com) for [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent): every tool call is checked against your policies before it runs, and every decision is recorded — what ran, what was blocked, and why.

Prime Agent ships one model-facing tool (`ipython` — code **is** the action), long-running autonomous sessions, and [no built-in permission framework](https://agenticcontrolplane.com/controls/prime-agent) — its own docs list the permission gate as the canonical extension to write. This extension is that extension, backed by a workspace policy plane instead of a hardcoded list:

```
┌─ ipython / custom & extension tools ────────┐
│                                             │
│   tool_call  ──►  allow · ask · deny        │   your policy, before the code runs
│   tool_result ─►  audit · redact · block    │   DLP + the record, after
└─────────────────────────────────────────────┘
```

Because Prime Agent is a hard fork of pi-mono that kept pi's typed extension API, this is the [pi extension](https://github.com/agentic-control-plane/pi-acp-plugin) retargeted at Prime Agent's paths and posture — same events, same decision mapping, plus two Prime-specific fixes (below).

## Install

```sh
curl -sf https://agenticcontrolplane.com/install.sh | bash
```

That detects Prime Agent, drops this extension at `~/.prime/agent/extensions/acp.ts`, opens your browser once to sign in, and saves the key to `~/.acp/credentials` — which the extension reads on its own. There is no token to copy and nothing to export.

<details>
<summary>Manual install</summary>

Drop `index.ts` into the global extensions directory as `acp.ts`:

```sh
mkdir -p ~/.prime/agent/extensions
curl -sf https://raw.githubusercontent.com/agentic-control-plane/prime-agent-acp-plugin/main/index.ts \
  -o ~/.prime/agent/extensions/acp.ts
```

Get a key at [cloud.agenticcontrolplane.com](https://cloud.agenticcontrolplane.com) and save it to `~/.acp/credentials`, or set `ACP_BEARER_TOKEN`. Restart Prime Agent (`/reload` also works).

Confirm it loaded — the first governed call shows up in your [activity log](https://cloud.agenticcontrolplane.com/logs), and every session ends with a one-line `[ACP] Session receipt`.

</details>

The extension imports only a **type** from Prime Agent (erased at runtime) and Node built-ins — zero dependencies, no build step. It runs as-is the moment Prime Agent discovers it.

## How it works

Prime Agent dispatches every tool through two typed events, and this extension registers on both:

| event | ACP endpoint | What happens |
|---|---|---|
| `tool_call` | `POST /govern/tool-use` | Server returns `allow` / `ask` / `deny`. Deny blocks the call with the reason in the transcript; ask prompts you (see below). |
| `tool_result` | `POST /govern/tool-output` | Output scanning. A server block turns the result into corrective feedback; a redact replaces the content the model reads. |

Coverage is complete because Prime Agent routes everything through these events: `ipython` (its sole built-in model-facing tool — shell, files, and Python all run as code in the persistent kernel) and any custom or extension-registered tool. MCP integrations arrive as Python skills, which execute *inside* ipython — so they're covered too, not a second path.

## Approvals and the empty chair

- **Attended** (interactive TUI, RPC hosts with a working UI): an `ask` decision prompts you inline via Prime Agent's own confirm dialog. Approve and the call proceeds; decline and it's blocked.
- **Unattended** (`-p` / `--print`, `--mode json`): an `ask` becomes a **deny** — an agent with nobody watching cannot self-approve, and the request is surfaced in the console for later review. No timeouts, no hangs, no silent auto-yes.

**Prime-specific fix:** Prime Agent 0.8.x reports `ctx.hasUI = true` even in headless print mode (its docs say false; the runtime disagrees — verified against 0.8.1). Worse, *every* CLI session — TUI and `-p` alike — runs inside a daemon worker process, where `hasUI` can't distinguish an attached human from an empty chair. This extension resolves attendance in two layers:

- **The prompt is the probe.** An `ask` always attempts Prime Agent's confirm dialog: an attached TUI client gets a real prompt; the headless no-op UI cannot approve, so the ask resolves to deny. Verified live: an `ask` in `-p` mode ends as `Denied at approval prompt` and the code never runs.
- **Conservative tier.** Worker processes (`PRIME_AGENT_INTERNAL_DAEMON_WORKER=1` / `--mode daemon`) and headless argv (`-p`, `--print`, `--mode json`) are labeled `background` unless `ACP_AGENT_TIER` overrides — a mislabel toward stricter policy is answerable at the prompt; a mislabel toward `interactive` would fail open with nobody watching.

## Failure posture

An outage of the control plane must not brick the harness, and a lapse in coverage must never be silent:

- **Provably attended sessions fail open, loudly.** Gateway unreachable → the call proceeds, a `[ACP] ⚠ UNGOVERNED` warning is shown, and a line lands in `~/.acp/lapse.log`.
- **Ambiguous worker sessions get the confirm-probe.** Gateway unreachable inside a daemon worker → a real TUI user is asked *"proceed ungoverned?"* (never bricked, and loud by construction); the headless no-op UI can't say yes, so the empty chair fails closed.
- **Unattended runs fail closed.** With nobody watching, the block is the safety net — that includes Prime Agent's `/autonomous` mode and daemon-scheduled sessions, which is exactly where you want it.
- Policy denies are unaffected — this posture only covers the inability to *ask* the policy. One transport retry precedes the fail posture, because the slow answers are cold starts.

## Configuration

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `ACP_BEARER_TOKEN` | `~/.acp/credentials` | Workspace key. |
| `ACP_GOVERN_BASE` | `https://govern.agenticcontrolplane.com` | Gateway, or your self-hosted one. |
| `ACP_AGENT_TIER` | attended ? `interactive` : `background` | Override the attended/unattended tier. |
| `ACP_SHADOW` | on | `off` silences shadow-mode counterfactual notices. |

No key? The extension says so loudly at session start and stays out of the way — it never bricks a session.

## Add the cost X-ray

Prime Agent's model calls can route through the ACP proxy for metering via its provider-override seam — a one-file extension:

```ts
// ~/.prime/agent/extensions/acp-proxy.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerProvider("anthropic", { baseUrl: "https://api.agenticcontrolplane.com/v1" });
}
```

The proxy is multi-provider (routes `gpt-*`, `claude-*`, `gemini-*` by model id) and forwards unchanged — same responses, now metered, joined to the tool-audit rows for the same session.

## Three things to know

- Prime Agent requires **Node 22.8+** and enforces it with a clear error (use `fnm`/`nvm`).
- Only the **global** directory (`~/.prime/agent/extensions/`) loads without a project-trust prompt; the installer uses it so governance is on before any repo is opened.
- Prime Agent runs a **resident daemon** (supervisor + session workers, sockets under `$TMPDIR/prime-agent-<uid>/`). Extensions load per worker, so `/reload` or a fresh session picks up changes. If you `kill -9` workers while testing, clear that socket dir — a stale socket hangs the next CLI start.

## Learn more

- [What ACP can see and control in Prime Agent](https://agenticcontrolplane.com/controls/prime-agent) — the living controls reference
- [Which coding agent has the best native controls?](https://agenticcontrolplane.com/controls) — the cross-harness comparison
- [The pi extension](https://github.com/agentic-control-plane/pi-acp-plugin) — the upstream sibling of this plugin

## Test

```sh
npm test        # 18 tests: decision mapping, fail posture, empty chair (argv + worker detection), receipt
npm run typecheck
npm run build   # emits dist/ (JS + .d.ts); prepack runs this from clean
```

MIT
