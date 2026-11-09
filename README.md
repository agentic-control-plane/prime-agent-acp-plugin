# @agenticcontrolplane/prime-agent

[![tests](https://github.com/agentic-control-plane/prime-agent-acp-plugin/actions/workflows/test.yml/badge.svg)](https://github.com/agentic-control-plane/prime-agent-acp-plugin/actions/workflows/test.yml) [![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[Agentic Control Plane](https://agenticcontrolplane.com) for [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent): every tool call is checked against your policies before it runs, and every decision is recorded: what ran, what was blocked, and why.

Prime Agent ships one model-facing tool (`ipython`, where code **is** the action), long-running autonomous sessions, and [no built-in permission framework](https://agenticcontrolplane.com/controls/prime-agent). Its own docs list the permission gate as the canonical extension to write. This is that extension, backed by a workspace policy instead of a hardcoded list:

```
┌─ ipython / custom & extension tools ────────┐
│                                             │
│   tool_call  ──►  allow · ask · deny        │   your policy, before the code runs
│   tool_result ─►  audit · redact · block    │   DLP + the record, after
└─────────────────────────────────────────────┘
```

Because Prime Agent is a hard fork of pi-mono that kept pi's typed extension API, this is the [pi extension](https://github.com/agentic-control-plane/pi-acp-plugin) retargeted at Prime Agent's paths and posture. Same events, same decision mapping, plus a Prime-specific attendance fix (see Troubleshooting).

## Install

```sh
curl -sf https://agenticcontrolplane.com/install.sh | bash
```

That detects Prime Agent, drops this extension at `~/.prime/agent/extensions/acp.ts`, opens your browser once to sign in, and saves the key to `~/.acp/credentials`, which the extension reads on its own. There is no token to copy and nothing to export.

<details>
<summary>Manual install</summary>

Drop `index.ts` into the global extensions directory as `acp.ts`:

```sh
mkdir -p ~/.prime/agent/extensions
curl -sf https://raw.githubusercontent.com/agentic-control-plane/prime-agent-acp-plugin/main/index.ts \
  -o ~/.prime/agent/extensions/acp.ts
```

Get a key at [cloud.agenticcontrolplane.com](https://cloud.agenticcontrolplane.com) and save it to `~/.acp/credentials`, or set `ACP_BEARER_TOKEN`. Restart Prime Agent (`/reload` also works).

To confirm it loaded, look for the first governed call in your [activity log](https://cloud.agenticcontrolplane.com/logs). Every session also ends with a one-line `[ACP] Session receipt`.

</details>

The extension imports only a **type** from Prime Agent (erased at runtime) and Node built-ins, so it has zero dependencies and no build step. It runs as-is the moment Prime Agent discovers it.

## How it works

Prime Agent dispatches every tool through two typed events, and this extension registers on both:

| event | ACP endpoint | What happens |
|---|---|---|
| `tool_call` | `POST /govern/tool-use` | Server returns `allow` / `ask` / `deny`. Deny blocks the call with the reason in the transcript. An ask follows the approval rules below. |
| `tool_result` | `POST /govern/tool-output` | Output scanning. A server block turns the result into corrective feedback; a redact replaces the content the model reads. |

The extension sees every tool call Prime Agent dispatches, because everything goes through these events: `ipython` (its sole built-in model-facing tool, where shell, files and Python all run as code in the persistent kernel) and any custom or extension-registered tool. MCP integrations arrive as Python skills, which execute *inside* ipython, so there is no second dispatch path.

## Approvals when nobody is watching

- **Attended** (interactive TUI, RPC hosts with a working UI): the extension can show an `ask` as Prime Agent's own confirm dialog. Approve and the call proceeds; decline and it's blocked. Today the gateway sends a hold as a prompt only to Claude Code, so in Prime Agent a hold is usually a block: approve it on the console or from the email, then retry (see the [coverage matrix](https://agenticcontrolplane.com/coverage)).
- **Unattended** (`-p` / `--print`, `--mode json`): an `ask` becomes a **deny**. An agent with nobody watching cannot self-approve, and the request is surfaced in the console for later review. No timeouts, no hangs, no silent auto-yes.

## Failure posture

If the gateway can't be reached:

- **Provably attended sessions fail open, loudly.** The call proceeds, a `[ACP] ⚠ UNGOVERNED` warning is shown, and a line lands in `~/.acp/lapse.log`.
- **Ambiguous worker sessions get the confirm-probe.** Inside a daemon worker, a real TUI user is asked *"proceed ungoverned?"*. The headless no-op UI can't say yes, so those sessions fail closed.
- **Unattended runs fail closed.** With nobody watching, the block is the safety net. That includes Prime Agent's `/autonomous` mode and daemon-scheduled sessions.
- Policy denies are unaffected. This posture only covers the case where the policy can't be asked. One transport retry precedes the fail posture, because the slow answers are cold starts.

## Configuration

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `ACP_BEARER_TOKEN` | `~/.acp/credentials` | Workspace key. |
| `ACP_GOVERN_BASE` | `https://govern.agenticcontrolplane.com` | Gateway, or your self-hosted one. |
| `ACP_AGENT_TIER` | attended ? `interactive` : `background` | Override the attended/unattended tier. |
| `ACP_SHADOW` | on | `off` silences shadow-mode counterfactual notices. |

No key? The extension says so loudly at session start and stays out of the way, so it never blocks a session.

## Add the cost X-ray

Prime Agent's model calls can route through the ACP proxy for metering via its provider-override seam, with a one-file extension:

```ts
// ~/.prime/agent/extensions/acp-proxy.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerProvider("anthropic", { baseUrl: "https://api.agenticcontrolplane.com/v1" });
}
```

The proxy is multi-provider (routes `gpt-*`, `claude-*`, `gemini-*` by model id) and forwards unchanged. You get the same responses, now metered, joined to the tool-audit rows for the same session.

## Requirements and load order

- Prime Agent requires **Node 22.8+** and enforces it with a clear error (use `fnm` or `nvm`).
- Only the **global** directory (`~/.prime/agent/extensions/`) loads without a project-trust prompt. The installer uses it so the extension is active before any repo is opened.

## Troubleshooting

**Attendance detection.** Prime Agent 0.8.x reports `ctx.hasUI = true` even in headless print mode (its docs say false; verified against 0.8.1). Every CLI session, TUI and `-p` alike, also runs inside a daemon worker process, where `hasUI` can't tell an attached human from nobody. The extension resolves attendance in two layers:

- **The prompt is the probe.** An `ask` always attempts Prime Agent's confirm dialog. An attached TUI client gets a real prompt. The headless no-op UI cannot approve, so the ask resolves to deny. An `ask` in `-p` mode ends as `Denied at approval prompt` and the code never runs.
- **Conservative tier.** Worker processes (`PRIME_AGENT_INTERNAL_DAEMON_WORKER=1` / `--mode daemon`) and headless argv (`-p`, `--print`, `--mode json`) are labeled `background` unless `ACP_AGENT_TIER` overrides. A mislabel toward stricter policy is answerable at the prompt. A mislabel toward `interactive` would fail open with nobody watching.

**Resident daemon.** Prime Agent runs a daemon (supervisor plus session workers, sockets under `$TMPDIR/prime-agent-<uid>/`). Extensions load per worker, so `/reload` or a fresh session picks up changes. If you `kill -9` workers while testing, clear that socket dir: a stale socket hangs the next CLI start.

## Learn more

- [What ACP can see and control in Prime Agent](https://agenticcontrolplane.com/controls/prime-agent): the controls reference
- [Which coding agent has the best native controls?](https://agenticcontrolplane.com/controls): the cross-harness comparison
- [The pi extension](https://github.com/agentic-control-plane/pi-acp-plugin): the upstream sibling of this plugin

## Test

```sh
npm test        # decision mapping, fail posture, unattended asks (argv + worker detection), receipt
npm run typecheck
npm run build   # emits dist/ (JS + .d.ts); prepack runs this from clean
```

MIT
