import type { JournalEventType } from "@mia/records";
import type { Origin, OutgoingEvent } from "./engine-effects.ts";
import type { EngineRecord } from "./engine-records.ts";

/** Linkage recorded with an event: the task and execution it belongs to and the event that caused it. */
export interface EventLinks {
  taskId?: string | null;
  executionId?: string | null;
  causedBy?: string | null;
}

/** An event's id, drawn before its transition is decided, and its linkage. */
export interface EventOpts extends EventLinks {
  id: string;
}

/**
 * One transition as it is built: the records it will commit, the effects it will perform once they have, and the
 * state it moves to. Building touches nothing outside it, so a pure transition builds through one, and one whose
 * records never commit leaves nothing behind. A conversation's start builds from no state (null) and advances to
 * the conversation before it records any event. Records and effects keep the order they were added in: the order the
 * catalog numbers events in and the effects run in. D1's conversation (`TransitionDraft`) and D2's delegating
 * conversation (`DelegationDraft`) each add the steps their transitions share.
 */
export abstract class Draft<State extends { readonly id: string }, Effect> {
  /** The one time every row of the transition records. */
  readonly at: string;
  protected readonly origin: Origin;
  private next: State | null;
  private readonly records: EngineRecord[] = [];
  private readonly effects: Effect[] = [];

  constructor(input: { state: State | null; now: Date; origin: Origin }) {
    this.next = input.state;
    this.at = input.now.toISOString();
    this.origin = input.origin;
  }

  /** The state as the transition leaves it so far: what its records name, and what it moves to. */
  get draft(): State {
    if (!this.next) throw new Error("the transition has no conversation to change");
    return this.next;
  }

  /** Move the state the transition commits to. */
  advance(next: State): void {
    this.next = next;
  }

  /** Queue records to commit. */
  write(...records: EngineRecord[]): void {
    this.records.push(...records);
  }

  /** Queue an effect for after the commit and its next state. */
  effect(effect: Effect): void {
    this.effects.push(effect);
  }

  /** What the transition built, as a kernel machine's accepted decision, which always has a next state. */
  accepted(): { kind: "accepted"; next: State; records: EngineRecord[]; effects: Effect[] } {
    return { kind: "accepted", next: this.draft, records: this.records, effects: this.effects };
  }

  /** Persist evidence that has no client-facing schema, under the conversation the transition records. */
  record(type: JournalEventType, payload: unknown, opts: EventOpts): void {
    this.write({
      kind: "append_event",
      input: {
        id: opts.id,
        receivedAt: this.at,
        conversationId: this.draft.id,
        type,
        payload,
        taskId: opts.taskId ?? null,
        executionId: opts.executionId ?? null,
        clientId: this.origin.clientId,
        clientConnectionId: this.origin.connectionId,
        causedByEventId: opts.causedBy ?? null,
      },
    });
  }

  /** Persist an event and queue its delivery with the id it was given and the sequence it commits at. */
  emit(event: OutgoingEvent, opts: EventOpts): void {
    this.record(event.type, event.payload, opts);
    this.effect(this.delivery(opts.id, event));
  }

  /** The effect that delivers recorded event `eventId`. */
  protected abstract delivery(eventId: string, event: OutgoingEvent): Effect;
}
