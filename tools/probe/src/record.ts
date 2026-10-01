import type {
  GateDecision,
  GateRequest,
  RuntimeConfig,
  SessionEvent,
  SessionHandle,
  SessionResult,
} from "@mia/agent-adapter";
import type { FixtureState } from "@mia/controlled-mcp";
import type { LiveRuntime } from "@mia/runtimes";

/** What the probe was asked to run, as its entry point read it from the command line. */
export interface ProbeOptions {
  /** The runtime `--runtime` named, with its live defaults. */
  runtime: LiveRuntime;
  /** `--model`, else the runtime's live default. */
  model: string;
  out: string;
  only?: string;
}

/** Deadlines the probe's entry point builds; each call starts a fresh one for a single wait. */
export interface ProbeDeadlines {
  /** How long the model may take to call the fixture's slow tool. */
  slowEntered: () => AbortSignal;
  /** How long the fixture's ledger may take to settle after the event that caused it. */
  ledgerSettled: () => AbortSignal;
  /** How long the manager agent may take to end a turn while a background worker agent's call is held. */
  managerTurnEnded: () => AbortSignal;
  /** How long a worker agent's session may take to report its worker agents' ends and the turns they start. */
  sessionSettled: () => AbortSignal;
  /** How long a stopped session's exit may take to be observed. */
  stopped: () => AbortSignal;
  /** How long the runtime may take to answer a request, or to report a manager agent's call (see `RuntimeStart`). */
  attribution: () => AbortSignal;
}

/** One manager agent's session: its events, every gate request and decision, and how it ended. */
export interface SessionRecord {
  name: string;
  session_id: string;
  /** The runtime conversation the session ran, which names its runtime directory; shared by a resumed session. */
  conversation_id: string;
  /** Numbers the session within its conversation, from 1. */
  session_index: number;
  events: SessionEvent[];
  gate_requests: {
    request: Omit<GateRequest, "abandoned">;
    decision: GateDecision;
    abandoned: boolean;
    /** How many events the session had recorded when the request arrived: those streamed before it. */
    event_index: number;
  }[];
  /** Events and gate requests past MAX_RECORDED (see context.ts), counted instead of kept. */
  dropped: number;
  result: SessionResult | null;
  ledger_after: FixtureState | null;
  notes: string[];
  checks: Record<string, boolean | string>;
}

export type GateDecider = (
  request: GateRequest,
  session: SessionRecord,
) => Promise<GateDecision> | GateDecision;

/** The open session a step drives: user messages go in, and it is closed or stopped when the step is done. */
export interface DrivenSession {
  handle: SessionHandle;
  /** Hands the manager agent `text` under a fresh message id. */
  send: (text: string) => boolean;
}

/**
 * Which runtime conversation a session runs: a fresh one by default, or an earlier session's, resumed, as the server
 * reopens a conversation after a restart.
 */
export interface SessionConversation {
  id: string;
  /** Numbers the session's files within the conversation, from 1. */
  sessionIndex: number;
  resume: boolean;
}

export interface SessionSpec {
  name: string;
  config: RuntimeConfig;
  conversation?: SessionConversation;
  /** Run with the open session: send messages, wait on events, and close or stop it. */
  drive: (session: DrivenSession, record: SessionRecord) => Promise<void>;
  decide: GateDecider;
}
