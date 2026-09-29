# Glossary

Every doc uses these terms with these meanings, and each concept has exactly one term.

| Term | Meaning |
| --- | --- |
| Mia | The assistant as a whole. |
| Host | The user's configured computer, where agents and computer actions run. |
| Server | Mia's persistent host process managing conversation, tasks, and clients. |
| Engine | The server component that owns conversation and task state, decides every change to it, and enforces approval and interruption. |
| Client | Desktop, phone, or terminal (TUI) app through which the user takes part in the conversation. |
| TUI | Terminal client with typed input and text replies only. |
| Conversation | A stored dialogue and its context, resumable across devices and disconnects. Only one conversation is active at a time. |
| Active client | Client currently handling conversational input, replies, and views together on one device. |
| Device handoff | Explicit transfer of the conversation and its view state together to another client, on another device or the same one. |
| Voice model | GPT-Live, responsible for typed and spoken interaction; it forwards substantive input to the manager agent. |
| Microphone mode | Whether and how a client listens: off, hold-to-speak, or hands-free. Typing is always available. |
| Reply mode | Whether Mia delivers replies as text or voice. |
| Manager agent | Agent owning substantive answers and delegation, running through a configured agent runtime. It never blocks: it makes no tool calls itself and only starts, instructs, and interrupts worker agents. |
| Worker agent | Agent the manager agent starts for one task. Worker agents make every tool call and cannot start worker agents. |
| Delegation | The manager agent starting a worker agent for a task. |
| Turn | One run of the manager agent, started by user input or by the end of a task. |
| Agent runtime | Installed software running an agent, such as Codex, Claude Code, or OpenCode. |
| Model provider | Company or service supplying a model to an agent runtime. |
| Default / big-gun model | Configured normal / explicitly requested escalation model. |
| Task | One worker agent's delegated work. It may outlive the turn that started it and any client connection. |
| Job | Scheduled or ongoing work managed by the job service. |
| Job run | One execution of a job, such as today's run of a daily vacuum schedule. |
| Job service | Separate external service managing scheduled or ongoing jobs. |
| Tool | Callable operation available to a worker agent, subject to approval and concurrency rules. |
| Exclusive tool | Tool that only one worker agent may use at a time, such as computer use. |
| External service | System exposing capabilities through tools, such as a browser integration or job service. |
| Agent adapter | Mia's connection to an agent runtime, including its events and approval interface. |
| UI adapter | Translates display messages and UI events for the chosen UI format, initially A2UI. |
| Approval policy | Rules determining whether a tool call requires explicit user approval. |
| Approval request | Pending request for the user to authorize a specific tool call. |
| Approval decision | The user's approve or reject response to an approval request. |
| View | Visual content Mia chooses to show on a client that supports views, such as a chart or test report. |
| UI event | An interaction with a view that may become input to Mia. |
| Hide view | Ask Mia to dismiss views while the conversation and tasks keep running. |
| Close | Close the client while the server and tasks keep running; task completion notifies the user to reopen the client. |
| Quit | Fully stop Mia's server and clients cleanly, excluding external services. |

Avoid unqualified “session”: distinguish conversation, voice-model connection, and agent session.

D1's evidence records and its agent prompts (`prompts/agent-v1.md`, `prompts/agent-v2.md`) predate these terms and stay as recorded; “active agent” there means D1's single agent.
