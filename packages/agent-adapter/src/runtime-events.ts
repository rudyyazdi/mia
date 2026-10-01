import type { LaunchDescription } from "./session.ts";

/**
 * The runtime-independent contract between an agent runtime and the engine. A runtime's own message
 * format is translated into these at the adapter boundary; `evidence` carries the runtime's original
 * payload for the records and is never read to make a decision.
 */

/** What the runtime reported when its session started. */
export interface RuntimeInit {
  model: string;
  evidence: unknown;
}

/** What the runtime reported when the turn ended. */
export interface TurnSummary {
  /** The runtime reported the turn as failed. */
  isError: boolean;
  /** The runtime's own name for how the turn ended, e.g. "success" or "error_max_turns". */
  outcome: string;
  /** The runtime's closing text, when it gave one. */
  finalText?: string;
  /** The runtime's own token accounting, shaped as it reported it: forwarded and stored, never decided on. */
  usage?: unknown;
  totalCostUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  /** Tool calls the runtime itself reports having refused. */
  permissionDenials?: unknown[];
  evidence: unknown;
}

export type RuntimeEvent =
  | { type: "runtime_started"; pid: number; launch: LaunchDescription; at: string }
  /** A turn took a user message: the UUID Mia sent the message under. */
  | { type: "input_taken"; runtimeMessageId: string; at: string }
  | { type: "runtime_init"; init: RuntimeInit; at: string }
  | { type: "text_delta"; text: string; parentCallId: string | null; at: string }
  | {
      type: "tool_proposed";
      runtimeCallId: string;
      /**
       * The delegation call whose worker agent proposed this call, or null for the manager agent's own call.
       */
      parentCallId: string | null;
      toolIdentity: string;
      arguments: unknown;
      complete: boolean;
      at: string;
    }
  | { type: "assistant_message"; message: unknown; at: string }
  | {
      type: "tool_result";
      runtimeCallId: string;
      /** As on `tool_proposed`: the delegation call whose worker agent received this result, or null. */
      parentCallId: string | null;
      isError: boolean;
      content: unknown;
      raw: unknown;
      at: string;
    }
  | { type: "turn_result"; summary: TurnSummary; at: string }
  | { type: "runtime_stderr"; text: string; at: string }
  | { type: "malformed_event"; raw: string; error: string; at: string }
  | { type: "runtime_exit"; code: number | null; signal: NodeJS.Signals | null; at: string };

/**
 * How a worker agent ended, in Mia's words: each adapter maps its runtime's own word onto one of these, and a word it
 * does not know is `failed`.
 */
export type WorkerEnd = "completed" | "failed" | "stopped";

/**
 * What a manager agent's session reports besides a turn's events: the runtime's own record of each worker agent
 * it starts and ends. `runtimeTaskId` is the id the gate hook also reports as the worker agent's `agent_id`, and
 * `delegationCallId` is the manager agent's delegation call that started it.
 */
export type TaskEvent =
  | {
      type: "worker_started";
      runtimeTaskId: string;
      delegationCallId: string;
      description: string;
      prompt: string;
      background: boolean;
      at: string;
    }
  | {
      type: "worker_ended";
      runtimeTaskId: string;
      delegationCallId: string | null;
      /** How it ended, mapped from the runtime's own word by its adapter. */
      end: WorkerEnd;
      /** The runtime's own word for how it ended, kept as evidence and never decided on. */
      // eslint-disable-next-line no-restricted-syntax -- the runtime's own word, kept as reported; `end` is its meaning
      runtimeStatus: string;
      summary: string | null;
      at: string;
    };

/** Every event a manager agent's session hands the engine. */
export type SessionEvent = RuntimeEvent | TaskEvent;
