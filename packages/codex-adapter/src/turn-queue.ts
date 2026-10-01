import type { WorkerEnd } from "@mia/agent-adapter";

/** A worker agent's end, as the manager agent is told of it in a turn of its own. */
export interface EndReport {
  path: string;
  threadId: string;
  end: WorkerEnd;
  /** The worker agent's final message, unredacted: the manager agent reads it, as it would its own tool result. */
  summary: string | null;
}

/** What one manager agent's turn takes: a user's message, or the worker agents' ends no turn has reported yet. */
export type QueuedTurn =
  | { kind: "message"; text: string; runtimeMessageId: string }
  | { kind: "ends"; ends: EndReport[]; unlisted: number };

/** How many ends one report lists; ends past it are only counted (each summary is bounded by the translator). */
export const MAX_LISTED_ENDS = 64;

/** The text of a turn that reports worker agents' ends, one line each. */
export const reportOf = (ends: readonly EndReport[], unlisted: number): string =>
  [
    ...ends.map(
      ({ path, threadId, end, summary }) =>
        `[Mia] Worker agent ${path} (id ${threadId}) ended: ${end}.${summary === null ? "" : ` Its final message: ${summary}`}`,
    ),
    ...(unlisted === 0
      ? []
      : [`[Mia] ${unlisted} more worker agents ended; their results are in Mia's records.`]),
  ].join("\n");

/**
 * The manager agent's next turns. Codex takes one turn at a time and starts none of its own when a worker agent
 * ends, so ends wait here for a turn that reports them. The next turn reports every end waiting, before any message
 * waiting, because Mia records a turn that takes no message as reporting every end not yet reported. Messages are
 * bounded by the caller's own message bound; ends are listed up to MAX_LISTED_ENDS and counted past it.
 */
export class TurnQueue {
  readonly #messages: { text: string; runtimeMessageId: string }[] = [];
  #ends: EndReport[] = [];
  #unlisted = 0;

  message(text: string, runtimeMessageId: string): void {
    this.#messages.push({ text, runtimeMessageId });
  }

  end(report: EndReport): void {
    if (this.#ends.length < MAX_LISTED_ENDS) this.#ends.push(report);
    else this.#unlisted += 1;
  }

  take(): QueuedTurn | undefined {
    if (this.#ends.length > 0) {
      const turn: QueuedTurn = { kind: "ends", ends: this.#ends, unlisted: this.#unlisted };
      this.#ends = [];
      this.#unlisted = 0;
      return turn;
    }
    const message = this.#messages.shift();
    return message === undefined ? undefined : { kind: "message", ...message };
  }
}
