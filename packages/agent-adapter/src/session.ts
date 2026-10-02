import type { Effort, RuntimeCancellation } from "@mia/protocol";
import type { GateHandler } from "./gate.ts";
import type { SessionEvent } from "./runtime-events.ts";

/**
 * The redacted, retained description of what a session launched (no secrets, no Mia-owned prompts): the fields every
 * runtime reports, and whatever else its adapter records about the launch, shaped as that adapter reports it.
 */
export interface LaunchDescription {
  model: string;
  effort: Effort;
  session_id: string;
  resume: boolean;
  /** The runtime's own tools the manager agent's session enables. */
  builtin_tools: string[];
  mcp_servers: string[];
  [field: string]: unknown;
}

export interface SessionOptions {
  runtimeConversationId: string;
  /** False creates the runtime session under `runtimeConversationId`; true resumes it, so it must already exist. */
  resume: boolean;
  runtimeDir: string;
  sessionIndex: number;
  /** The manager agent's instructions file (Mia's retained prompt), or null to give it none. */
  managerPromptFile: string | null;
  workerPrompt: string;
  /**
   * Decides every tool call the session's manager agent and worker agents are about to make: the runtime-neutral
   * approval interface (hold the exact call, decide it, or see it abandoned). Each adapter carries it its own way.
   */
  decide: GateHandler;
  /**
   * Handles one session event and settles once it is handled; it must not reject. The next event is handed over only
   * after the previous one settled, so a slow handler pauses the runtime's output instead of queueing events, and
   * they are handled in the order the runtime reported them.
   */
  onEvent: (event: SessionEvent) => Promise<void>;
}

export interface SessionResult {
  /** ended: the runtime exited on its own after stdin closed; killed: `stop` ended it; failed: anything else. */
  status: "ended" | "killed" | "failed";
  /** What `stop` observed: not_needed when it was not stopped, unknown when the kill's exit was never seen. */
  cancellation: RuntimeCancellation;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  error: string | null;
  streamLogPath: string;
  hookEvidencePath: string;
  launch: LaunchDescription;
}

export interface SessionHandle {
  readonly pid: number | undefined;
  readonly result: Promise<SessionResult>;
  /**
   * Hands the manager agent one user message under `runtimeMessageId`, which the session reports as `input_taken`
   * when a turn takes the message. Returns false when the session no longer reads input (it ended, or was stopped or
   * closed), so the caller records the message as not delivered rather than assuming it was.
   */
  send(text: string, runtimeMessageId: string): boolean;
  /**
   * Mia's note on worker agent `runtimeTaskId`'s end, for the manager agent to read with that end's report: what Mia
   * recorded of the calls the worker agent had no result for, which the worker agent's own account cannot know. The
   * caller notes an end while it handles that end's `worker_ended`, before the event settles.
   */
  noteEnd(runtimeTaskId: string, note: string): void;
  /** Ends input: the runtime finishes what it has and exits. Stopping afterwards still kills it. */
  close(): void;
  /**
   * Kills the runtime, stopping the manager agent and every worker agent at once, without giving it a chance to act
   * on an in-flight call again. Resolves once exit is observed, or "unknown" once `deadline` aborts first.
   */
  stop(deadline: AbortSignal): Promise<RuntimeCancellation>;
}

/** What runs the manager agent's sessions: a runtime's adapter, or a test's scripted runtime. */
export interface SessionRunner {
  open(options: SessionOptions): SessionHandle;
}

/**
 * One agent runtime, started: it runs sessions until closed. It owns whatever its adapter serves besides the shared
 * tool gate, which the caller owns and passes in.
 */
export interface AgentRuntime {
  readonly sessions: SessionRunner;
  close(): Promise<void>;
}
