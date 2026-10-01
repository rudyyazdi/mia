import type { WorkerEnd } from "@mia/agent-adapter";

/** A worker agent's end, as the manager agent is told of it in a turn of its own. */
export interface EndReport {
  path: string;
  threadId: string;
  end: WorkerEnd;
  summary: string | null;
}

/** What one manager agent's turn takes: a user's message, or the worker agents' ends no turn has reported yet. */
export type QueuedTurn =
  { kind: "message"; text: string; runtimeMessageId: string } | { kind: "ends"; ends: EndReport[] };

/** The text of a turn that reports worker agents' ends, one line each. */
export const reportOf = (ends: readonly EndReport[]): string =>
  ends
    .map(
      ({ path, threadId, end, summary }) =>
        `[Mia] Worker agent ${path} (id ${threadId}) ended: ${end}.${summary === null ? "" : ` Its final message: ${summary}`}`,
    )
    .join("\n");

/**
 * The manager agent's next turns, in order. Codex takes one turn at a time and starts none of its own when a worker
 * agent ends, so a worker agent's end waits here for a turn that reports it, joining the other ends no turn has
 * reported yet. Messages are bounded by the caller's own message bound, and ends by the worker agents it started.
 */
export class TurnQueue {
  readonly #turns: QueuedTurn[] = [];

  message(text: string, runtimeMessageId: string): void {
    this.#turns.push({ kind: "message", text, runtimeMessageId });
  }

  end(report: EndReport): void {
    const last = this.#turns.at(-1);
    if (last?.kind === "ends") last.ends.push(report);
    else this.#turns.push({ kind: "ends", ends: [report] });
  }

  take(): QueuedTurn | undefined {
    return this.#turns.shift();
  }
}
