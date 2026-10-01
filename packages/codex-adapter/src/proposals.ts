import { untilAborted } from "@mia/agent-adapter";

/** A manager agent's call as the gate saw it, in Mia's vocabulary. */
export interface ProposedCall {
  toolName: string;
  input: unknown;
}

/** How many offered calls wait for their hook's report on stdout; past it the oldest is forgotten. */
const MAX_OFFERS = 64;

/**
 * Pairs a manager agent's call as the gate hears it with Codex's report on stdout that its hook started, so the
 * call is proposed in stdout order. Codex streams no proposal of a manager agent's call before its hook runs, only
 * the hook run (with the call id), and the gate alone knows the tool and its input. The stdout side waits, bounded,
 * for the gate's offer; an offer that arrives first waits for the stdout side.
 */
export class ProposalRendezvous {
  /** Offers no stdout report has taken yet, oldest first. */
  readonly #offers = new Map<string, ProposedCall>();
  /** The stdout side's wait, at most one at a time since stdout is read one line at a time. */
  #waiting: { callId: string; arrived: (call: ProposedCall) => void } | null = null;

  offer(callId: string, call: ProposedCall): void {
    if (this.#waiting?.callId === callId) {
      this.#waiting.arrived(call);
      this.#waiting = null;
      return;
    }
    this.#offers.set(callId, call);
    if (this.#offers.size <= MAX_OFFERS) return;
    const oldest = this.#offers.keys().next();
    if (!oldest.done) this.#offers.delete(oldest.value);
  }

  /** The call offered under `callId`, waiting for it until `signal` aborts; null when it never came. */
  async take(callId: string, signal: AbortSignal): Promise<ProposedCall | null> {
    const offered = this.#offers.get(callId);
    if (offered) {
      this.#offers.delete(callId);
      return offered;
    }
    const arrived = Promise.withResolvers<ProposedCall | null>();
    const waiting = { callId, arrived: arrived.resolve };
    this.#waiting = waiting;
    try {
      return await untilAborted(
        () => arrived.promise,
        signal,
        () => null,
      );
    } finally {
      if (this.#waiting === waiting) this.#waiting = null;
    }
  }
}
