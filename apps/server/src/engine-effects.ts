import type { GateDecision } from "@mia/agent-adapter";
import type { EventPayload, ServerEventType } from "@mia/protocol";

/** A client-facing event as a correlated type/payload pair, so the envelope needs no assertion. */
export type OutgoingEvent = {
  [T in ServerEventType]: { type: T; payload: EventPayload<T> };
}[ServerEventType];

/**
 * The client and the connection a transition's events are recorded under: the conversation's active ones when the
 * transition was decided, or, for a start, the ones it makes active. They belong with the client lifecycle, not the
 * conversation's state, so the boundary reads them and hands them in with the event.
 */
export interface Origin {
  clientId: string | null;
  connectionId: string | null;
}

/**
 * What a gate request's transition answers the runtime: at once, or by holding the call under the approval it
 * requested until the user decides.
 */
export type GateAnswer =
  { kind: "answer"; decision: GateDecision } | { kind: "hold"; approvalId: string };

/** The session a message's transition opens: the manager agent's execution it runs as, and how it launches. */
export interface SessionStart {
  executionId: string;
  sessionIndex: number;
  /** The runtime conversation exists from an earlier session, so this one resumes it. */
  resume: boolean;
}

/**
 * One thing the engine does once a transition's records have committed and its state has moved on, as data, so a
 * pure `decide` can return it and the kernel performs it (see `createKernel` for when, in what order, and what a
 * throwing effect leaves standing).
 *
 * - `activate_conversation`: make the conversation just started the active one, owned by the client and reached
 *   through the connection of `origin`. Only a start queues one, first, so the start's delivery goes to that client.
 * - `deliver_event`: send a recorded event to the active connection, with the sequence the catalog gave it.
 * - `notify_tool_call`: send a call's progress, which is never recorded, so it has no sequence.
 * - `open_session`: start the manager agent's session. Only a message's transition queues one, before the
 *   `send_message` it is opened for.
 * - `send_message`: hand the session one recorded message under `runtimeMessageId`, the UUID the runtime replays when a
 *   turn takes it. A session that no longer reads input makes the engine record the message undelivered, in a
 *   transition of its own.
 * - `stop_session`: kill the session's runtime, stopping the manager agent and every worker agent at once; what the
 *   kill causes is recorded when the runtime's exit is.
 * - `answer_gate`: answer the gate request the transition decided, held or at once. Only a gate request's transition
 *   queues one, exactly one, first: the hold then sits between the commit and the rest of its effects, and a request
 *   whose records did not commit is never held, only denied.
 * - `answer_held`: answer the gate request held under an approval, if it is still held.
 */
export type EngineEffect =
  | { kind: "activate_conversation"; origin: Origin }
  | { kind: "deliver_event"; eventId: string; event: OutgoingEvent }
  | { kind: "notify_tool_call"; payload: EventPayload<"tool_call"> }
  | { kind: "open_session"; session: SessionStart }
  | { kind: "send_message"; text: string; runtimeMessageId: string }
  | { kind: "stop_session" }
  | { kind: "answer_gate"; answer: GateAnswer }
  | { kind: "answer_held"; approvalId: string; decision: GateDecision };
