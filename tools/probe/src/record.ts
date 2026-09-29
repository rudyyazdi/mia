import type {
  GateDecision,
  GateRequest,
  RuntimeEvent,
  SessionEvent,
  SessionHandle,
  SessionResult,
  PermissionDecision,
  PermissionRequest,
  RuntimeConfig,
  TurnHandle,
  TurnResult,
} from "@mia/agent-adapter";
import type { FixtureState } from "@mia/controlled-mcp";

/** The probe's command-line options, as commander parsed them. */
export interface ProbeOptions {
  model: string;
  out: string;
  examples: string;
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
}

export interface StepRecord {
  name: string;
  session_id: string;
  first_turn: boolean;
  prompt: string;
  events: RuntimeEvent[];
  permission_requests: {
    /** The runtime's raw permission payload, snake_case as it arrived. */
    request: unknown;
    decision: PermissionDecision;
    abandoned: boolean;
  }[];
  turn: TurnResult | null;
  ledger_after: FixtureState | null;
  hook_evidence: Record<string, unknown>[] | null;
  /** Hook evidence lines that did not parse and are missing from `hook_evidence`. */
  hook_evidence_malformed_lines: number | null;
  /** Why the hook evidence file could not be read, when `hook_evidence` is empty for that reason. */
  hook_evidence_read_error: string | null;
  notes: string[];
  checks: Record<string, boolean | string>;
}

/** One manager agent's session (D2): its events, every gate request and decision, and how it ended. */
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

export interface SessionSpec {
  name: string;
  config: RuntimeConfig;
  /** Run with the open session: send messages, wait on events, and close or stop it. */
  drive: (handle: SessionHandle, session: SessionRecord) => Promise<void>;
  decide: GateDecider;
}

export type Decider = (
  request: PermissionRequest,
  step: StepRecord,
) => Promise<PermissionDecision> | PermissionDecision;

export interface StepSpec {
  name: string;
  config: RuntimeConfig;
  sessionId: string;
  firstTurn: boolean;
  prompt: string;
  turnIndex: number;
  decide: Decider;
  during?: (handle: TurnHandle, step: StepRecord) => Promise<void>;
}
