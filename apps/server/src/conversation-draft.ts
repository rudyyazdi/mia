import type { Decision } from "@mia/kernel";
import type { EventPayload, TaskStatus, ToolCallStatus } from "@mia/protocol";
import type { IdPrefix, JournalEventType, NewId } from "@mia/records";
import {
  withCall,
  withTask,
  type ConversationState,
  type TaskState,
} from "./conversation-state.ts";
import type { EngineEffect, Origin, OutgoingEvent } from "./engine-effects.ts";
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

/** What one transition built, as its kernel machine's accepted decision. */
export type BuiltTransition = Extract<
  Decision<ConversationState, never, EngineRecord, EngineEffect>,
  { kind: "accepted" }
>;

/** The linkage every event of a task records: the task and its worker agent's execution. */
export const workerLinks = (
  task: Pick<TaskState, "id" | "executionId">,
): { taskId: string; executionId: string } => ({
  taskId: task.id,
  executionId: task.executionId,
});

/**
 * One transition as it is built: the records it will commit, the effects it will perform once they have, and the
 * state it moves to. Building touches nothing outside it, so a pure transition builds through one, and one whose
 * records never commit leaves nothing behind. A conversation's start builds from no state (null) and advances to
 * the conversation before it records any event. Records and effects keep the order they were added in: the order the
 * catalog numbers events in and the effects run in.
 */
export class ConversationDraft {
  /** The one time every row of the transition records. */
  readonly at: string;
  protected readonly origin: Origin;
  private next: ConversationState | null;
  private readonly records: EngineRecord[] = [];
  private readonly effects: EngineEffect[] = [];
  private readonly newId: NewId;

  constructor(input: { state: ConversationState | null; now: Date; origin: Origin; newId: NewId }) {
    this.next = input.state;
    this.newId = input.newId;
    this.at = input.now.toISOString();
    this.origin = input.origin;
  }

  /** The state as the transition leaves it so far: what its records name, and what it moves to. */
  get draft(): ConversationState {
    if (!this.next) throw new Error("the transition has no conversation to change");
    return this.next;
  }

  /** Move the state the transition commits to. */
  advance(next: ConversationState): void {
    this.next = next;
  }

  /** Queue records to commit. */
  write(...records: EngineRecord[]): void {
    this.records.push(...records);
  }

  /** Queue an effect for after the commit and its next state. */
  effect(effect: EngineEffect): void {
    this.effects.push(effect);
  }

  /** What the transition built, as a kernel machine's accepted decision, which always has a next state. */
  accepted(): BuiltTransition {
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
    this.effect({ kind: "deliver_event", eventId: opts.id, event });
  }

  /** A fresh id of kind `prefix`, from the generator the event brought: the transition draws no randomness itself. */
  id(prefix: IdPrefix): string {
    return this.newId(prefix);
  }

  /** Move task `taskId` the transition commits to; see `withTask`. */
  advanceTask(taskId: string, update: (task: TaskState) => TaskState): void {
    this.advance(withTask(this.draft, taskId, update));
  }

  /** Record task `taskId`'s status and move the draft to it. */
  recordTaskStatus(taskId: string, status: TaskStatus): void {
    this.write({ kind: "update_task", id: taskId, fields: { status } });
    this.advanceTask(taskId, (task) => ({ ...task, status }));
  }

  /** Record call `callId` of task `taskId` taking `status`, move the draft to it, and tell the client. */
  changeCall(
    taskId: string,
    callId: string,
    change: { status: ToolCallStatus; detail?: string; dispatchEventId?: string },
  ): void {
    this.write({
      kind: "update_tool_call",
      id: callId,
      fields: {
        updatedAt: this.at,
        status: change.status,
        ...(change.detail === undefined ? {} : { detail: change.detail }),
        ...(change.dispatchEventId === undefined
          ? {}
          : { dispatchEventId: change.dispatchEventId }),
      },
    });
    this.advanceTask(taskId, (task) => withCall(task, callId, { status: change.status }));
    this.notifyCall(taskId, callId, change.detail);
  }

  /** Queue the progress notice of call `callId` of task `taskId`, as the draft leaves it. */
  notifyCall(taskId: string, callId: string, detail?: string): void {
    const call = this.draft.tasks.get(taskId)?.calls.get(callId);
    if (!call) throw new Error(`call ${callId} is not a call of task ${taskId}`);
    this.effect({
      kind: "notify_tool_call",
      payload: toolCallNotice({ conversationId: this.draft.id, taskId, call, detail }),
    });
  }

  /** Record how a pending approval of task `taskId` was resolved, and tell the client. */
  resolveApproval(
    task: Pick<TaskState, "id" | "executionId">,
    resolved: {
      approvalId: string;
      callId: string;
      status: EventPayload<"approval_resolved">["status"];
      eventId: string;
      reason?: string;
      decisionClientId?: string;
    },
  ): void {
    this.emit(
      {
        type: "approval_resolved",
        payload: {
          conversation_id: this.draft.id,
          task_id: task.id,
          approval_id: resolved.approvalId,
          tool_call_id: resolved.callId,
          status: resolved.status,
          ...(resolved.reason === undefined ? {} : { reason: resolved.reason }),
        },
      },
      { ...workerLinks(task), id: resolved.eventId },
    );
    // After approval_resolved, whose event the approval names as its decision's.
    this.write({
      kind: "update_approval",
      id: resolved.approvalId,
      fields: {
        status: resolved.status,
        consumedAt: this.at,
        decisionEventId: resolved.eventId,
        ...(resolved.reason === undefined ? {} : { reason: resolved.reason }),
        ...(resolved.decisionClientId === undefined
          ? {}
          : { decisionClientId: resolved.decisionClientId }),
      },
    });
  }

  /** Record a lease release of exclusive tool `toolIdentity`, if one is held, and drop it from the draft. */
  releaseLease(toolIdentity: string, eventId: string): void {
    const lease = this.draft.leases.get(toolIdentity);
    if (!lease) return;
    this.write({ kind: "release_lease", id: lease.id, releasedAt: this.at });
    this.record(
      "lease_released",
      { lease_id: lease.id, tool_identity: toolIdentity, tool_call_id: lease.callId },
      { taskId: lease.taskId, id: eventId },
    );
    const leases = new Map(this.draft.leases);
    leases.delete(toolIdentity);
    this.advance({ ...this.draft, leases });
  }
}

/** A tool call's progress notice (never recorded: the durable evidence is the events under it). */
export const toolCallNotice = (input: {
  conversationId: string;
  taskId: string;
  call: {
    id: string;
    runtimeCallId: string;
    toolIdentity: string;
    status: ToolCallStatus;
    redactedArguments: unknown;
  };
  detail?: string;
}): EventPayload<"tool_call"> => ({
  conversation_id: input.conversationId,
  task_id: input.taskId,
  tool_call_id: input.call.id,
  runtime_call_id: input.call.runtimeCallId,
  tool_identity: input.call.toolIdentity,
  status: input.call.status,
  ...(input.detail ? { detail: input.detail } : {}),
  redacted_arguments: input.call.redactedArguments,
});
