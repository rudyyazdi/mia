import type {
  GateDecision,
  GateRequest,
  ClaudeCodeConfig,
  SessionEvent,
  SessionHandle,
  SessionResult,
} from "@mia/agent-adapter";
import type { FixtureState } from "@mia/controlled-mcp";

/** The probe's command-line options, as commander parsed them. */
export interface ProbeOptions {
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
}

/** One manager agent's session: its events, every gate request and decision, and how it ended. */
export interface SessionRecord {
  name: string;
  session_id: string;
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
  /** Permission-prompt requests the approval bridge received: none are expected, as the gate decides every call. */
  bridge_requests: number;
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

export interface SessionSpec {
  name: string;
  config: ClaudeCodeConfig;
  /** Run with the open session: send messages, wait on events, and close or stop it. */
  drive: (session: DrivenSession, record: SessionRecord) => Promise<void>;
  decide: GateDecider;
}
