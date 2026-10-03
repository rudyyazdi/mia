import { MAX_LISTED_ENDS, type EndReport } from "./turn-queue.ts";

/**
 * The worker agents' ends Mia steered into the manager agent's running turn (`turn/steer`) instead of reporting them
 * in a turn of their own. Codex hands the manager agent each worker agent's final answer itself, into the running
 * turn until that turn writes its final answer and into the next turn after, but never starts a turn for it: an end
 * reported in a turn of its own after the running one would have the manager agent answer again what it may have
 * already answered. Codex accepts a steer until the turn is gone, but records one that lands after the turn's last
 * look for input without answering it, so an end counts as reported only once the manager agent writes reply text
 * after Codex recorded its steer; an end the turn did not answer goes back to be reported in a turn of its own.
 * Bounded by MAX_LISTED_ENDS ends, as a turn's batch is.
 */
export class SteeredEnds {
  /** By the `clientUserMessageId` each was steered under: its end, and whether Codex recorded it in the turn yet. */
  readonly #steers = new Map<string, { end: EndReport; recorded: boolean }>();

  /** No more ends can be steered into this turn. */
  get full(): boolean {
    return this.#steers.size >= MAX_LISTED_ENDS;
  }

  steer(clientId: string, end: EndReport): void {
    this.#steers.set(clientId, { end, recorded: false });
  }

  /** Codex recorded the user message sent under `clientId` in the turn: true when it is one of these steers. */
  recorded(clientId: string): boolean {
    const steer = this.#steers.get(clientId);
    if (steer) steer.recorded = true;
    return steer !== undefined;
  }

  /** The manager agent wrote reply text: the ends recorded before it, which the turn has now reported. */
  answered(): EndReport[] {
    const answered = [...this.#steers].filter(([, steer]) => steer.recorded);
    for (const [clientId] of answered) this.#steers.delete(clientId);
    return answered.map(([, steer]) => steer.end);
  }

  /** Codex refused the steer under `clientId`: its end, unless the turn already ended and gave it back. */
  refused(clientId: string): EndReport[] {
    const steer = this.#steers.get(clientId);
    this.#steers.delete(clientId);
    return steer ? [steer.end] : [];
  }

  /** The turn ended: the ends it did not answer, in the order they were steered. */
  turnEnded(): EndReport[] {
    const unanswered = [...this.#steers.values()].map((steer) => steer.end);
    this.#steers.clear();
    return unanswered;
  }
}
