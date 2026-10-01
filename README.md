# Mia

Mia is an open-source voice and text assistant for your own computer. This repository currently implements a text
client, a persistent server, and one agent adapter (Claude Code): a manager agent that never blocks and delegates every
tool call to worker agents, enforced per-call tool approval, interruption with honest outcomes, and a private,
exportable conversation record. What comes next, including promoting the text client to the TUI, voice, views and
phone clients, is described in [`docs/PLAN.md`](docs/PLAN.md).

Read first: [glossary](docs/GLOSSARY.md), [plan](docs/PLAN.md), [capability record](https://github.com/rudyyazdi/mia/pull/202#issuecomment-5922737456).

## Prerequisites

| Requirement                                                                                                | Why                                                                                                | How Mia checks it                                 |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Node.js 26 (`.node-version`)                                                                               | runtime for server, client, tests; built-in `node:sqlite`                                          | `npm install` refuses older engines               |
| Claude Code CLI on `PATH`, logged in (`claude` 2.1.274 is the version the capability record was made with) | the only agent runtime supported; Mia reuses your existing login and never copies credentials      | `npm run probe` (static checks, then live checks) |
| A configured profile (see `examples/config`)                                                               | Mia has no defaults: model, effort, MCP servers, per-tool policy and tool surface are all explicit | the server refuses to start on an invalid profile |

Nothing personal is committed: state lives under `$XDG_STATE_HOME/mia` (or a directory you name in the profile), the
client secret is generated there with mode 0600, and example profiles use `${ENV}` placeholders. A placeholder is
substituted only inside a string value, and the client loads the profile as the server does, so both need it set.

## Install

```sh
npm install
npm run typecheck
npm test            # deterministic lane: fixture, gate, bridge, records, engine (scripted runtime)
```

## Configure

Copy `examples/config/production-opus.example.json`, edit it, and keep it outside Git (or under `config/*.local.json`,
which is ignored). Every profile states:

- `runtime.model` / `runtime.effort`: passed explicitly on every invocation (`--model`, `--effort`). The Opus example is
  marked **unverified** because the capability record was produced on `claude-sonnet-5`; run the probe with
  `--model claude-opus-5` before relying on it.
- `runtime.mcpServers`: the MCP servers the agent may use. `mia_approval` is reserved for the approval bridge.
- `runtime.toolPolicy`: one entry per tool, `allow` (no prompt, still gated during interruption), `ask` (explicit
  per-call decision) or `deny`. Tools not listed are denied with a visible error.
- `runtime.agentPromptFile` / `runtime.workerAgent`: the manager agent's prompt (e.g. `prompts/manager-v1.md`), and the
  worker agent's `description` and `promptFile`. The manager agent can only delegate to and stop worker agents; worker
  agents make every tool call, each decided by Mia before it runs (see the
  [capability record](https://github.com/rudyyazdi/mia/pull/202#issuecomment-5922737456)).
- `runtime.exclusiveTools`: tools only one worker agent may use at a time.

## Run

```sh
npm run server -- --config path/to/profile.json      # loopback WebSocket, prints the URL
npm run server -- --config path/to/profile.json --debug   # also marks each conversation it starts as captured in debug mode, and records the MCP bodies of calls to a server with a `bodyLog` (the controlled fixture)
npm run client -- --config path/to/profile.json      # terminal client: text in, streamed text out, /approve /reject /interrupt [task] /tasks
npm run mia -- debug conversations --state <stateDirectory>
npm run mia -- debug conversation <id> --state <stateDirectory>
npm run mia -- debug watch <id> --state <stateDirectory>        # live web view, with an address for other devices on the network; --no-open prints the addresses only
npm run mia -- debug export <id> --output ./exports/<id> --state <stateDirectory>
npm run mia -- debug verify ./exports/<id>
```

## Verify against the real runtime

```sh
npm run probe                     # capability probe (writes .mia-state/probe/<stamp>/, 4 live sessions)
npm run live -- --repeat 2        # promptfoo live lane against the controlled fixture (~18 live messages)
```

Both count live calls in `.mia-state/live-calls.jsonl` and stop at `MIA_LIVE_CALL_CAP` (default 50). The live lane writes
`.mia-state/live/<stamp>/live-results.md`; pass `--manager-prompt <file>` to compare manager prompt versions on the same
fixture-ledger evidence.

## Layout

| Path                      | Contents                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server`             | provenance snapshots, engine (conversation/task state, approval and interruption), WebSocket gateway                           |
| `apps/text-client`        | terminal client and the reusable `MiaClient`                                                                                   |
| `apps/debug-cli`          | `mia debug …` read-only inspection, export, verify, reconcile                                                                  |
| `packages/protocol`       | versioned client/server messages (zod), canonical digests, redaction                                                           |
| `packages/kernel`         | dependency-free commit-first kernel: decide, commit, apply, perform; committed-change feed; held replies                       |
| `packages/agent-adapter`  | profile loading, Claude Code adapter: session plan, stream-json parsing, tool gate, approval bridge, static probe, live budget |
| `packages/records`        | SQLite catalog, content-addressed objects, record writer, snapshot queries, export/verify, HTML report                         |
| `packages/mcp-http`       | loopback Streamable-HTTP host used by the fixture and the bridge                                                               |
| `fixtures/controlled-mcp` | controlled MCP fixture with append-only ledger and barriers                                                                    |
| `tests/acceptance`        | H lane (scripted runtime), promptfoo live lane                                                                                 |
| `tools/probe`             | capability probe                                                                                                               |
| `prompts/`                | versioned manager and worker agent instructions (`manager-v1.md`, `worker-v1.md`)                                              |
