import { untilAborted, type GateRequest } from "@mia/agent-adapter";

/** How many offered calls wait for their hook's report on stdout; past it the oldest is read at once. */
const MAX_OFFERS = 64;

/** A manager agent's call the gate heard: how to read it in Mia's vocabulary, and who waits for that reading. */
interface Offer {
  read: () => GateRequest;
  settle: (request: GateRequest) => void;
}

/**
 * Pairs a manager agent's call as the gate hears it with Codex's report on stdout that its hook started, and reads
 * the call at that point in stdout order. Codex streams no proposal of a manager agent's call before its hook runs,
 * only the hook run (with the call id), and the gate alone knows the tool and its input. Reading it in stdout order
 * also means a stop names a worker agent whose start stdout has already reported. Each side waits, bounded, for the
 * other: a call never paired is read when its deadline passes.
 */
export class ProposalRendezvous {
  /** Offers no stdout report has taken yet, oldest first. */
  readonly #offers = new Map<string, Offer>();
  /** The stdout side's wait, at most one at a time since stdout is read one line at a time. */
  #waiting: { callId: string; arrived: (request: GateRequest) => void } | null = null;

  /** Resolves to the call as read once stdout reaches its hook, or once `signal` aborts first. */
  async offer(callId: string, read: () => GateRequest, signal: AbortSignal): Promise<GateRequest> {
    if (this.#waiting?.callId === callId) {
      const request = read();
      this.#waiting.arrived(request);
      this.#waiting = null;
      return request;
    }
    const taken = Promise.withResolvers<GateRequest>();
    const offer: Offer = { read, settle: taken.resolve };
    this.#offers.set(callId, offer);
    const oldest = this.#offers.entries().next();
    if (this.#offers.size > MAX_OFFERS && !oldest.done) {
      const [oldestId, evicted] = oldest.value;
      this.#offers.delete(oldestId);
      evicted.settle(evicted.read());
    }
    return untilAborted(
      () => taken.promise,
      signal,
      () => {
        if (this.#offers.get(callId) === offer) this.#offers.delete(callId);
        return read();
      },
    );
  }

  /** The call offered under `callId`, read now, waiting for it until `signal` aborts; null when it never came. */
  async take(callId: string, signal: AbortSignal): Promise<GateRequest | null> {
    const offered = this.#offers.get(callId);
    if (offered) {
      this.#offers.delete(callId);
      const request = offered.read();
      offered.settle(request);
      return request;
    }
    const arrived = Promise.withResolvers<GateRequest | null>();
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
