import type { Decision } from "@mia/kernel";
import type { EventPayload, TaskStatus, ToolCallStatus } from "@mia/protocol";
import { withCall, withTask, type DelegationState, type TaskState } from "./delegation-state.ts";
import type { DelegationEffect } from "./delegation-effects.ts";
import { Draft, toolCallNotice, type EventLinks } from "./draft.ts";
import type { IdPrefix } from "@mia/records";
import type { Origin, OutgoingEvent } from "./engine-effects.ts";
import type { EngineRecord } from "./engine-records.ts";

/** What one D2 transition built, as its kernel machine's accepted decision. */
export type BuiltDelegation = Extract<
  Decision<DelegationState, never, EngineRecord, DelegationEffect>,
  { kind: "accepted" }
>;

/** The linkage every event of a task records: the task and its worker agent's execution. */
export const workerLinks = (task: Pick<TaskState, "id" | "executionId">): EventLinks => ({
  taskId: task.id,
  executionId: task.executionId,
});

/**
 * D2's transition draft (see `Draft`): a delegating conversation with its session, turn and tasks. Its ids come from
 * `ids`, random suffixes the engine drew before deciding, so a transition names its rows without drawing randomness;
 * one that needs more than were drawn is a bug at the boundary, and throws.
 */
export class DelegationDraft extends Draft<DelegationState, DelegationEffect> {
  private readonly ids: readonly string[];
  private used = 0;

  constructor(input: {
    state: DelegationState | null;
    now: Date;
    origin: Origin;
    ids: readonly string[];
  }) {
    super(input);
    this.ids = input.ids;
  }

  /** A fresh id of kind `prefix`, in the shape `newId` gives. */
  id(prefix: IdPrefix): string {
    const suffix = this.ids[this.used];
    if (suffix === undefined) throw new Error("the transition needs more ids than were drawn");
    this.used += 1;
    return `${prefix}_${suffix}`;
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

  protected delivery(eventId: string, event: OutgoingEvent): DelegationEffect {
    return { kind: "deliver_event", eventId, event };
  }
}
