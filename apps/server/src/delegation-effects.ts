import type { GateDecision } from "@mia/agent-adapter";
import type { EventPayload } from "@mia/protocol";
import type { Origin, OutgoingEvent } from "./engine-effects.ts";

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
 * One thing the D2 engine does once a transition's records have committed and its state has moved on, as data (see
 * `EngineEffect` for the kernel's rules, which apply alike).
 *
 * - `activate_conversation`, `deliver_event`, `notify_tool_call`: as D1's.
 * - `open_session`: start the manager agent's session. Only a message's transition queues one, before the
 *   `send_message` it is opened for.
 * - `send_message`: hand the session one recorded message, `eventId` its `message_received` event. A session that no
 *   longer reads input makes the engine record the message undelivered, in a transition of its own.
 * - `stop_session`: kill the session's runtime, stopping the manager agent and every worker agent at once; what the
 *   kill causes is recorded when the runtime's exit is.
 * - `answer_gate`: answer the gate request the transition decided, held or at once. Only a gate request's transition
 *   queues one, exactly one, first, for the reasons `answer_permission` is first in D1.
 * - `answer_held`: answer the gate request held under an approval, if it is still held.
 */
export type DelegationEffect =
  | { kind: "activate_conversation"; origin: Origin }
  | { kind: "deliver_event"; eventId: string; event: OutgoingEvent }
  | { kind: "notify_tool_call"; payload: EventPayload<"tool_call"> }
  | { kind: "open_session"; session: SessionStart }
  | { kind: "send_message"; text: string; eventId: string }
  | { kind: "stop_session" }
  | { kind: "answer_gate"; answer: GateAnswer }
  | { kind: "answer_held"; approvalId: string; decision: GateDecision };
