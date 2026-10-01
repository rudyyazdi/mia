# Mia: voice and text assistant

## Outcome and scope

An open-source client/server voice and text assistant controlling a user-configured host computer through configured agent runtimes. Desktop, phone, and terminal clients share one conversation, used through one active client at a time. Every client takes typed input; desktop and phone clients also take speech and show interactive views. Mia offers explicit device handoff, parallel tasks where tools allow it, and past-conversation retrieval. Remote operation requires the configured host to be awake and online.

Implement the nine testable deliverables below. Client/server separation is foundational from deliverable 1. Each milestone needs a user acceptance demo, relevant automated checks, and an acceptance checkpoint before expanding scope. This is an implementation plan; the planning task does not authorize implementation. Run agents through user-installed Codex, Claude Code, or OpenCode CLIs, reusing their authentication; document prerequisites and detect missing setup rather than assuming a particular developer's environment. Users need only configure the agent runtimes they intend to use.

Deliverable 2 was inserted after D1 was built; the deliverables numbered D2–D8 in older issues and pull requests are now D3–D9.

The project must be usable without the original author's accounts, paths, devices, or private services. Keep credentials, personal configuration, recordings, and logs outside version control; provide generic setup examples. Live service/device acceptance tests use the tester's own configured integrations.

## Out of scope and future expansion

- **Restricted agent tools:** Later, reuse CLI authentication while exposing only Mia-configured tools, without inheriting personal MCP servers, plugins, hooks, or permissions. Keep authentication reuse separate from tool configuration and approval policies in agent adapters so this can be added without rewriting the engine. Future enforcement must cover the manager agent and worker agents using either default or big-gun models, and bypass paths such as unrestricted shell access. Implementing or proving this isolation is not part of the current deliverables; existing approval and interruption requirements still apply.
- **Job-service implementation:** Build scheduling/monitoring in a separate repo. This plan includes its contract and integration (deliverable 9), not its engine or external-service shutdown policy. The contract covers job and job-run identities, schedules/triggers, deterministic or agent work, authorization, notifications, history, cancellation, and recovery.
- **Other deferred work:** Keybinding setup; model-weight fine-tuning (prompt tuning remains in scope); licensing, packaging, and publication; a second production UI adapter (the minimal adapter-boundary check remains in scope).

## Terminology

Terms are defined in the [glossary](GLOSSARY.md).

## Agreed requirements

### Conversation and execution

- GPT-Live handles conversation, clarification, and delivery for typed and spoken input alike; GPT-Live forwards substantive questions and requests to the manager agent. No input path bypasses GPT-Live; it is required even for text-only use, with no fallback when it is unavailable. Microphone and playback controls belong to the client; the engine carries out interruption of agent work.
- The manager agent never blocks. It accepts input at any time, makes no tool calls itself, and delegates all tool work to worker agents; starting a worker agent needs no approval. Tasks run in parallel and may outlive the turn that started them. A pending approval request, a rejection, or a long-running call delays only its own worker agent. When a task ends, the manager agent gets a new turn to report it, recorded as caused by that task.
- One conversation controls the host. Opening another client, the TUI included, offers device handoff rather than starting a second conversation or agent. Only one client is active; a newly opened client can only offer handoff, and closes if the user declines, leaving the active client in control. Input, replies, and views stay together on the active client; split-device use is not required. Device handoff transfers them together. View state stays with the conversation: the TUI does not display it, and a later handoff to a client with views restores the current views.
- Configuration selects an agent runtime and model for each of the default and big-gun roles. Preserve configured identifiers; examples include Opus 5, Codex 5.6 Sol, DeepSeek 4.1, Codex Astra, and Claude Fable. Config changes apply to a new conversation.
- Explicit user escalation moves the manager agent to the big-gun model until switched back or a fresh conversation starts. The escalated manager agent may escalate one, several, or all of its worker agents; each escalation is recorded. Without an explicit user escalation, nothing escalates. Worker agents that are not escalated keep their assigned model.
- Concurrency follows tool and external-service constraints: searches can overlap; an exclusive tool serves one worker agent at a time. The manager agent's instructions serialize exclusive work, and the engine refuses a second concurrent call to an exclusive tool. Worker agents must not contend over shared browser, desktop, or file state.
- Every client accepts typed input at any time; desktop and phone clients also have a microphone mode (hold to speak and release to submit, or hands-free conversation). The TUI has no microphone and replies only in text. Reply mode (text or voice) is independent of microphone mode. Each client remembers its own microphone and reply mode; device handoff does not carry them. A remembered mode never acts on its own: the microphone opens only after an explicit user action on that client since it was opened or received the handoff, and Mia does not start speaking on opening, reopening from a notification, or handoff.
- The server makes reply transcripts available to the client. Whether and when to show them is a client display decision expected to change; initially voice replies show no live transcript, and switching reply mode to text may show the transcripts of earlier voice replies.
- Speaking interrupts: it stops playback and blocks new consequential actions while listening. Submitting typed input is not itself an interruption; GPT-Live decides whether to stop speaking. Interrupting agent work takes speech or the explicit interrupt control. The manager agent can interrupt one worker agent or all of them at any time. Every client, the TUI included, has an explicit interrupt control with the guarantees of a spoken interruption; it stops every task through the engine directly, without relying on the manager agent. Handle in-flight actions according to actual cancellation support; never imply completed actions were undone.
- Mia's agents know the active client's capabilities (views, workspace control) and its current microphone and reply mode, and are told when either changes, including mid-task after a handoff. They shape replies accordingly; for example, they answer the TUI in text instead of offering a view.
- Reuse existing permissions, with configurable approval policy per tool where the agent runtime or tool integration supports enforcement, including requiring explicit approval on every call (for example, all tools of a configured password-manager MCP). Task instructions do not override an approval policy requiring confirmation on every call. Configure payment/booking approval rules through the relevant approval policy rather than a hard-coded fee rule. Surface unsupported enforcement before enabling that policy; never silently downgrade it.
- Worker agents propose tool calls; the engine and the agent adapter enforce approval before execution. The active client presents the tool, intended action, and relevant non-secret arguments with explicit approve/reject controls. Approval is bound to the exact pending call; changed arguments require renewed approval. No model may grant approval on the user's behalf. Pending approval requests survive device handoff/reconnect; no response or a disconnected client is not consent. GPT-Live may explain the request, but does not own enforcement.
- Access includes all host browsers/tabs and signed-in sessions where supported; phone use controls the host, not the phone's own apps. Authorized monitoring notifications need no repeated approval unless their approval policy requires it. Verify uncertain outcomes before retrying consequential actions. Configurable approvals are in scope; comprehensive isolation from inherited CLI capabilities remains deferred.

### Lifecycle

- Close shuts the client (its microphone, playback, and views) while the server and tasks continue. Task completion pings the user with a notification to reopen the client and resume; failure or required input also triggers notification. Reopening follows the remembered-mode rule under Conversation and execution. Notification delivery mechanism is a solution-design decision.
- A task notification offers resumption of its originating conversation. Ordinary opening offers Continue or New conversation when context exists. Only one conversation is active; resuming another requires an explicit switch. Starting fresh does not cancel running tasks.
- Fresh conversations do not automatically inherit past conversation context. The manager agent can delegate search/retrieval of past conversations to a worker agent, with source references, whether using the default or big-gun model.
- Quit fully stops Mia's server and clients cleanly and handles Mia-owned active tasks, preserving logs and reporting anything that cannot be cancelled.
- Remote access assumes an awake, online host. Unavailability is visible; consequential commands are not silently queued for later execution.

### Views and adapters

- Start with [A2UI](https://a2ui.org/) behind a replaceable UI adapter. Keep conversation/task behavior, content meaning, and UI-event handling independent of that choice. Replacement must not require rewriting the engine. Demonstrate the boundary with a minimal alternative/test UI adapter.
- Require compact, rich, versioned display messages, incremental updates, and references to large data. Cover text, metrics, charts, tables, test results, code and diffs, image choices, and simple layouts. Ordinary output must not require generated HTML. Display messages are layered: structured components, declarative chart specifications (data plus encoding, Vega-Lite style), and later sandboxed custom rendering code. The agent uses the highest level that expresses the result and drops to a lower level only when a higher one cannot; lower levels never gain access beyond the sandbox.
- Provide an app-style singleton desktop window and phone app, each holding the typed input, text replies, and any views. Mia decides when to open, update, or remove a view; the user changes which views exist only by asking Mia, apart from direct manipulation of existing content and window geometry below. A worker agent can use a configured Hyprland MCP integration to move/fullscreen the host window. Hide view removes views and leaves typed input and text replies in place, without stopping the conversation or tasks; “close the view” has the same meaning. Close Mia shuts the client. When asked to show an already visible view, report that it is visible rather than creating another window. If it is on another workspace, offer to switch when Hyprland MCP or equivalent window control is available; otherwise explain the limitation.
- Mia receives each view's current dimensions and changes. Existing content remains usable during resize; the agent decides whether context warrants a content change. More space may prompt an offer of additional detail, not automatic new analysis on every resize.
- Zooming, sorting, and expanding existing content work directly. Meaningful clicks, such as choosing a PNG, can reach Mia as conversational input equivalent to a spoken or typed choice. Requests for new data, analysis, or external actions go through the agent and existing permissions.

### Logs and tuning

- Keep audio, transcripts, typed input, what started each turn (typed input, spoken input, or a task's end) and its reply mode, exposed agent/tool events, results, errors, approvals, interruptions, and available usage data indefinitely outside Git. Organize by conversation start timestamp plus unique identifiers, linking tasks and job runs. Redact credentials; do not promise hidden model-provider reasoning or undisclosed prompts.
- Snapshot effective app prompts, exposed agent instructions, configuration, model identities, tool/display contracts, adapter versions, and relevant software versions. Each conversation references immutable prompt versions/content hashes, the architecture version and its design-document revision, and the running client/server build versions (including source commit and any local-change identifier). Retain the referenced snapshots so future edits do not erase debugging context. Linked tasks and job runs record their actual versions if different, including after a restart or device handoff. Distinguish generated speech from audio actually played.
- Start simple: no fixed latency thresholds yet. Record interruption, voice-model/manager-agent response, rendering/update timing, and display-message size for later investigation. Separate local, model, and network delays where observable.
- Clients send diagnostic state snapshots on errors, reconnects, device handoffs, and significant state changes, plus a lightweight periodic heartbeat while running. Capture active view/dimensions, client/UI version, connection/microphone/playback state, microphone and reply mode, recent interaction events, errors, and timing. Link records by client, conversation, task, and view identifiers with capture/receipt timestamps; avoid repeatedly sending unchanged detail.
- Store client diagnostics with server logs under the same retention policy. Expose relevant records through an agent diagnostic tool, rather than injecting them into every model request. Exclude credentials and sensitive approval content. Screenshots are optional and separately configurable; routine snapshots are structured state, not continuous screen recording. Missing or stale diagnostics must be apparent, including after disconnection or Close.

## Delivery approach

Deliverables are sequential checkpoints: the maintainer confirms each before the next begins. Each builds on the last by changing it, removing any code the new one no longer needs. Earlier journeys are re-run on the new code; acceptance evidence is attached to the deliverable's pull request, not kept in the repository.

Each deliverable extends a working user journey. Provide one repeatable demo with expected results and test relevant failure cases as soon as the capability appears. Its acceptance record identifies each requirement as demonstrated live, verified with a test substitute, or blocked. Missing required capabilities block acceptance; a substitute is not a live pass.

Establish shared agent-adapter checks for approval and interruption in deliverable 1 and repeat them for each runtime. Establish UI-adapter content/event checks in deliverable 5. Re-run relevant earlier journeys as capabilities expand. End-to-end evaluation is continuous, not a final milestone.

## Deliverable 1 — Prove one agent adapter

Outcome, scope, exclusions, C4 diagrams and implementation sequence: [D1 implementation plan](D1/PLAN.md).

**User acceptance test:** Send a text task, inspect streamed results, approve one controlled MCP call and reject another. Require approval on every call; verify approval cannot be reused for another call or changed arguments. Interrupt a running task and inspect the recorded outcome.

**Pass:** No execution before required approval. New consequential actions are blocked during interruption; in-flight actions that cannot stop are reported honestly. Failures are visible, and unsupported approval policies are not silently weakened. Logs identify the actual agent, prompts, and builds; retained snapshots survive later edits. Use controlled fixtures for consequential tests.

## Deliverable 2 — Delegate to worker agents

Replace D1's single agent with a manager agent and worker agents on the D1 runtime; Claude Code runs worker agents as its subagents. The manager agent never blocks, accepts input while tasks run (D1's busy response goes away), and makes no tool calls itself. Tasks run in parallel, outlive the turn that started them, and start a turn when they end. The engine refuses a second concurrent call to an exclusive tool, and the interrupt control stops every task through the engine. Add versioned manager-agent instructions (`prompts/manager-v1.md`). The runtime must first prove that worker agents' tool calls reach Mia's approval bridge, honor approval policy, and stop on interruption ([#200](https://github.com/rudyyazdi/mia/issues/200)); if it cannot, this deliverable is blocked.

**User acceptance test:** In the text client, ask for two independent things, one of which needs approval, and start a long-running background task. While the approval is pending, ask a third question and get its answer. Reject the approval. Have the manager agent interrupt one worker agent, then use the interrupt control to stop the rest. Inspect the record.

**Pass:** The manager agent answers every message without waiting on tool work and makes no tool calls. A pending approval request, a rejection, or a long-running task delays only its own worker agent. Each task's result reaches the user in a turn recorded as caused by that task, and a rejected call is reported as not run. No worker agent starts another. A second concurrent exclusive tool call is refused. The interrupt control stops every task without the manager agent; in-flight actions that cannot stop are reported honestly. Records link each task to its worker agent's execution and to the turn that started it.

## Deliverable 3 — Add desktop voice and text

Add the voice model (GPT-Live) as the conversational owner of typed and spoken input, and a desktop client with typing, hold-to-speak/release-to-submit, hands-free conversation, text/voice reply mode, concise spoken results, and an explicit interrupt control. Promote the D1 text client to the TUI, a product client whose input also goes through GPT-Live. Until D4 adds handoff, opening a second client is refused with an explanation.

**User acceptance test:** Ask a substantive question by voice and a follow-up by typing, approve/reject a tool request through the client, interrupt speech while work is running, and switch to hands-free mode. Switch reply mode from voice to text and back; send typed input while Mia is speaking, then use the explicit interrupt. Repeat the question, approval, and interrupt through the TUI.

**Pass:** Substantive questions reach the manager agent whether typed or spoken, in one conversation. Text reply mode produces no speech; each client's microphone and reply mode persist across client restarts, and after a restart the microphone stays closed and Mia silent until the user acts. Typed input during speech is not itself an interruption, and the record shows GPT-Live handled every typed turn. The explicit interrupt, in the desktop client and the TUI, gives the guarantees of a spoken interruption. Opening a second client is refused with an explanation, and never makes two clients active. No stale playback after interruption and no microphone transmission outside the chosen listening mode. Verify no new consequential action starts while a correction is being heard. Record audio, transcripts, actual playback, and observable timing without credentials or sensitive approval content.

## Deliverable 4 — Complete the task lifecycle

Implement Close, reconnect, Continue/New conversation, basic task notifications, Quit, and device handoff between the TUI and the desktop client, independently of the job service.

**User acceptance test:** Start a long task, Close, receive its completion notification, reopen and continue. Repeat with a failure and a pending approval request. Start a fresh conversation while prior work remains active. Open the TUI while the desktop client is active, decline then accept device handoff, approve a pending call from the TUI, and hand back. Repeat with the desktop client opened while the TUI is active. Disconnect unexpectedly, then test Quit and restart.

**Pass:** Close preserves server-side work; notifications offer resumption of the originating conversation without activating the microphone or speaking automatically. Pending approvals survive reconnect and are re-presented with the same tool, action, and arguments (including any code or diff content once D8 adds it), and silence is never consent. Starting fresh does not inherit past context or cancel tasks. No duplicate execution after reconnection or uncertain outcomes. Quit stops Mia's server/clients, preserves records, and reports uncancellable work. Only one client is active; declining closes the new client; after handoff, microphone and reply mode are the receiving client's own, and no microphone opens and no speech starts unchosen. Diagnostics distinguish unavailable clients from stale state.

## Deliverable 5 — Add one interactive view

Introduce the replaceable UI adapter for A2UI with a small chart or image-choice view, incremental updates, UI events, dimension reporting, and desktop view/window control.

**User acceptance test:** Ask Mia to show a view, select an image by click, by voice, and by typing, and Hide view while continuing to talk. Ask for the same view from the TUI, then hand off back to the desktop client. Ask to show it when it is already visible, then when its window is on another workspace. Resize, move, and fullscreen it where supported.

**Pass:** One desktop window; if already visible on the current workspace, Mia says so without creating another. If on another workspace, Mia offers to switch when Hyprland MCP or an equivalent integration is available. Missing window visibility/control support is explained; no claimed action without evidence. “Close the view” means Hide view, while Close Mia closes the client. Dimensions reach Mia and existing content remains usable; the agent decides whether to offer more detail. A meaningful selection reaches the correct conversation/task once. The TUI gets a text answer, not a view, and views that existed before a handoff to the TUI are restored on handoff back. A minimal substitute UI adapter preserves content/event behavior without core changes. Invalid display content cannot execute arbitrary local actions. Capture display errors, message sizes, and render timing.

## Deliverable 6 — Take the journey to the phone

Extend the working voice, text, view, approval, and task-notification journey to a phone client, extending D4's device handoff to phone↔desktop and phone↔TUI.

**User acceptance test:** Start on desktop, open phone, decline then accept device handoff, continue by voice and by typing with views, and transfer back. Start a view-producing task on the phone, hand off to the TUI before it finishes, receive the result as text, and hand back to the phone. Approve/reject a pending call after handoff. Close during a task and reopen from a phone notification. Exercise connection loss and host unavailability.

**Pass:** One active conversation and client, with input, replies, and views moving together and no duplicate agents/actions; the phone keeps its own microphone and reply mode and gets back the views the TUI could not show. Agents learn of each handoff and shape results to the receiving client. Only authorized clients can connect; no unsolicited microphone activation or silently queued consequential commands. Conversation, view state, and pending approvals remain correctly associated. Phone supports showing/hiding views; workspace controls apply to desktop only.

## Deliverable 7 — Expand agent runtimes and escalation

Add the remaining agent runtimes, each with manager and worker agents, and explicit big-gun escalation. Use the same adapter acceptance checks for each runtime.

**User acceptance test:** Repeat the text/voice/approval/interruption and delegation journeys with each configured runtime. Escalate the manager agent, have it escalate one of two running worker agents, and verify the other retains its assigned model.

**Pass:** Correct model attribution for every manager and worker agent; nothing escalates without an explicit user escalation, and every escalation is recorded. Default and big-gun agents honor approval policies and interruption. Any runtime missing required behavior remains blocked rather than being marked supported.

## Deliverable 8 — Add recall and richer workflows

Add sourced past-conversation retrieval, richer charts/tables/metrics/test reports, code and diff views (including the intended change in an approval request for file-modifying tools where the runtime exposes it), sandboxed custom rendering code (for example D3.js) as the lowest display level, agent retrieval of client diagnostics, and substantial browser/coding workflows.

**User acceptance test:** Start fresh and retrieve an earlier decision. Show Apple's stock price over seven days, switch to a table, and accept an offer of more detail after enlarging the view. Find/book a haircut within configured constraints; build and test a Dreame vacuum-control plugin and show the test report. Trigger a controlled rendering failure and ask why the chart disappeared.

**Pass:** Retrieved history is identifiable as past context, not a new command. Market data has sources, dates/timezone, and non-trading-day treatment. Booking obeys approval policy; simulate a lost submission response and verify the outcome before retrying. Plugin outcomes are verified with relevant tests; device-dependent checks identify required hardware. The plugin is an acceptance task, not a required embedded Mia integration. Client diagnostics support an evidence-based explanation of the controlled UI failure without requiring reproduction; absent/stale evidence is reported as uncertainty. Custom rendering code runs sandboxed with no access to local actions, host state, or other views, and the record shows which display level each view used. Repeat representative journeys across devices and compare prompt versions without replaying real-world side effects.

## Deliverable 9 — Integrate the job service

Connect the separate job service for deterministic schedules and intelligent monitoring, reusing the established notification/resumption journey. Ordinary long-running Mia tasks must already work without this service.

**Separate-repo interface:** CLI/API to create, inspect, list, update, pause/resume, and cancel jobs and inspect job runs/results. Include schedules/triggers, deterministic actions or agent tasks, model where needed, authorization, notification destination, originating conversation, stable identities, status/errors, cancellation outcomes, restart recovery, missed runs, duplicate suppression, and monitoring freshness.

**User acceptance test:** Schedule a daily 10 am vacuum action without model involvement per job run. Create an intelligent X-news monitor for company breaking news that notifies a configured Slack destination. Inspect/cancel both through Mia and directly through the job-service CLI. Close Mia's client and verify notifications still offer the correct conversation on return.

**Pass:** Jobs persist independently and execute/notify within authorized criteria without duplicates. Results remain retrievable if notification delivery is delayed. State actual monitoring access/latency limits. Use a contract substitute while the separate service is unavailable, but mark live job acceptance blocked until the real service and integrations pass. Repeat relevant earlier journeys to verify integration preserves voice, text, approvals, views, and lifecycle behavior.

## Prompt budget and implementation guidance

Start with versioned templates for the voice model (covering typed and spoken turns and each reply mode), the manager agent, and worker agents. Agents using the default or big-gun model initially share their role's template. Add summary/specialist prompts only when justified; aim for two to four app-owned templates. Version tool and display definitions alongside them.

Evaluate task success, transcription, forwarding, and delegation errors, interruption correctness, duplicate actions, latency, message size, spoken brevity, and available cost. Compare saved examples without replaying real-world side effects. Tuning means prompt iteration.

The implementer should verify current Live, CLI, MCP, and A2UI capabilities before implementation and choose implementation details independently. Confirm required capabilities early; present concrete alternatives for the maintainer when missing capabilities block requirements. Each milestone report states what works, the user acceptance demo, automated verification, and remaining blockers. Do not substitute a narrower behavior and mark it complete.
