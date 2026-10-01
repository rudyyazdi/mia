# Mia

Mia is an open-source voice and text assistant for your own computer. This repository currently implements a text
client, a persistent server, and two agent adapters, Claude Code and Codex, of which each profile picks one: a manager
agent that never blocks and delegates every tool call to worker agents, enforced per-call tool approval, interruption with honest outcomes, and a private,
exportable conversation record. What comes next, including promoting the text client to the TUI, voice, views and
phone clients, is described in [`docs/PLAN.md`](docs/PLAN.md).

Read first: [glossary](docs/GLOSSARY.md), [plan](docs/PLAN.md), [capability record](https://github.com/rudyyazdi/mia/pull/202#issuecomment-5922737456).

## Prerequisites

| Requirement                                                                                                | Why                                                                                                | How Mia checks it                                 |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Node.js 26 (`.node-version`)                                                                               | runtime for server, client, tests; built-in `node:sqlite`                                          | `npm install` refuses older engines               |
| Claude Code CLI on `PATH`, logged in (`claude` 2.1.274 is the version the capability record was made with) | the `claude-code` runtime; Mia reuses your existing login and never copies credentials             | `npm run probe` (static checks, then live checks) |
| or Codex CLI 0.159.3 on `PATH`, logged in (`codex login`, or `OPENAI_API_KEY`)                             | the `codex` runtime; Mia links your `~/.codex/auth.json` into its own Codex home, never copying it | `npm run probe -- --runtime codex`                |
| A configured profile (see `examples/config`)                                                               | Mia has no defaults: model, effort, MCP servers, per-tool policy and tool surface are all explicit | the server refuses to start on an invalid profile |

Nothing personal is committed: state lives under `$XDG_STATE_HOME/mia` (or a directory you name in the profile), the
client secret is generated there with mode 0600, and example profiles use `${ENV}` placeholders. A placeholder is
substituted only inside a string value, and the client loads the profile as the server does, so both need it set.

## Install

```sh
npm install
npm run typecheck
npm run check       # format, lint, types, duplicates, unit and acceptance tests (see Tests)
```

## Configure

Copy `examples/config/production-opus.example.json` (Claude Code) or `examples/config/production-codex.example.json`
(Codex), edit it, and keep it outside Git (or under `config/*.local.json`, which is ignored). Every profile states:

- `runtime.kind`: the agent runtime, `"claude-code"` or `"codex"`. Only Claude Code takes `runtime.extraSettings`.
  Mia supports one Codex release, 0.159.3; the static probe reports any other as an error. Mia runs Codex with its own
  Codex home (`<stateDirectory>/codex-home`), so your Codex plugins, MCP servers and `AGENTS.md` stay out of its
  sessions. Codex has no SSE transport: give each MCP server as `http` or `stdio`.

- `runtime.model` / `runtime.effort`: passed explicitly on every invocation (`--model`, `--effort`). The Opus example is
  marked **unverified** because the capability record was produced on `claude-sonnet-5`; run the probe with
  `--model claude-opus-5` before relying on it.
- `runtime.mcpServers`: the MCP servers the agent may use. Under Claude Code, `mia_approval` is reserved for the
  approval bridge.
- `runtime.toolPolicy`: one entry per tool, `allow` (no prompt, still gated during interruption), `ask` (explicit
  per-call decision) or `deny`. Tools not listed are denied with a visible error.
- `runtime.agentPromptFile` / `runtime.workerAgent`: the manager agent's prompt (e.g. `prompts/manager-v2.md`), and the
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

## Tests

| Kind         | Command                      | Checks                                                                                                  |
| ------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `unit`       | `npm run test:unit`          | one module at a time, beside it; the runtime and network are faked                                      |
| `acceptance` | `npm run test:acceptance`    | the real server, gateway, records and client together, with a scripted runtime                          |
| `probe`      | `npm run probe`              | that the runtime behaves as Mia assumes: gating in worker agents, denial, interruption, stops, resume   |
| `live`       | `npm run live -- --repeat 2` | Mia's user journeys against the real runtime and the controlled fixture, judged from the fixture ledger |

CI runs `npm run check` (unit and acceptance) on every pull request. `probe` and `live` need a logged-in agent runtime,
never run in CI, and run locally to sign off a deliverable. Both take `--runtime claude` (the default) or
`--runtime codex`; `live` runs both fixture profiles on the runtime it names. Each runtime has a default model,
`claude-sonnet-5` or `gpt-6-luna`; `--model` runs another, so a stronger Codex model is an explicit choice on each run. Both count live calls in `.mia-state/live-calls.jsonl`, stop
at `MIA_LIVE_CALL_CAP` (default 50), and write their results under `.mia-state/`; pass `--manager-prompt <file>` to
`live` to compare manager prompt versions on the same evidence.

## Layout

| Path                           | Contents                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `apps/server`                  | provenance snapshots, engine (conversation/task state, approval and interruption), WebSocket gateway         |
| `apps/text-client`             | terminal client and the reusable `MiaClient`                                                                 |
| `apps/debug-cli`               | `mia debug …` read-only inspection, export, verify, reconcile                                                |
| `packages/protocol`            | versioned client/server messages (zod), canonical digests, redaction                                         |
| `packages/kernel`              | dependency-free commit-first kernel: decide, commit, apply, perform; committed-change feed; held replies     |
| `packages/agent-adapter`       | runtime-neutral session contract, profile loading, tool gate and its hook, runtime launch files, live budget |
| `packages/claude-code-adapter` | Claude Code adapter: session plan, stream-json translation, approval bridge, static probe                    |
| `packages/codex-adapter`       | Codex adapter: `codex app-server` session, Mia's Codex home, JSON-RPC translation, static probe              |
| `packages/runtimes`            | picks the adapter a profile's `runtime.kind` names, for the server and the probe                             |
| `packages/records`             | SQLite catalog, content-addressed objects, record writer, snapshot queries, export/verify, HTML report       |
| `packages/mcp-http`            | loopback Streamable-HTTP host used by the fixture and the bridge                                             |
| `fixtures/controlled-mcp`      | controlled MCP fixture with append-only ledger and barriers                                                  |
| `tests/acceptance`             | acceptance tests (scripted runtime), live tests                                                              |
| `tools/probe`                  | capability probe                                                                                             |
| `prompts/`                     | versioned manager and worker agent instructions (`manager-v2.md`, `worker-v1.md`)                            |
