import type { Decision } from "@mia/kernel";
import type { EventPayload, TaskStatus } from "@mia/protocol";
import {
  callById,
  withCall,
  withTask,
  type CallState,
  type ConversationState,
  type TaskState,
} from "./conversation-state.ts";
import { Draft, type EventLinks } from "./draft.ts";
import type { EngineEffect, OutgoingEvent } from "./engine-effects.ts";
import type { EngineRecord } from "./engine-records.ts";
import type { ApprovalChange, CallChange } from "./transitions.ts";

/** The linkage every event of `task`'s turn records. */
export const taskLinks = (task: TaskState): EventLinks => ({
  taskId: task.id,
  executionId: task.executionId,
});

/**
 * What one transition built, as a kernel machine's accepted decision: the state it moves to, and the records and
 * effects that take it there.
 */
export type BuiltTransition = Extract<
  Decision<ConversationState, never, EngineRecord, EngineEffect>,
  { kind: "accepted" }
>;

/** D1's transition draft (see `Draft`): a conversation with its one task. */
export class TransitionDraft extends Draft<ConversationState, EngineEffect> {
  protected delivery(eventId: string, event: OutgoingEvent): EngineEffect {
    return { kind: "deliver_event", eventId, event };
  }

  /** Move the task the transition commits to; see `withTask`. */
  advanceTask(taskId: string, update: (task: TaskState) => TaskState): void {
    this.advance(withTask(this.draft, taskId, update));
  }

  /** Call `callId` of task `taskId` as the transition leaves it so far. */
  call(taskId: string, callId: string): CallState {
    const task = this.draft.task;
    const call = task?.id === taskId ? callById(task, callId) : undefined;
    if (!call) throw new Error(`call ${callId} is not a call of task ${taskId}`);
    return call;
  }

  /**
   * Queue the progress notification for call `callId` of task `taskId`, as the draft leaves it: the status the commit
   * leaves the call in, so the notice follows every change the transition made to it so far.
   */
  notifyCall(taskId: string, callId: string, notice?: string): void {
    const call = this.call(taskId, callId);
    this.effect({
      kind: "notify_tool_call",
      payload: {
        conversation_id: this.draft.id,
        task_id: taskId,
        tool_call_id: call.id,
        runtime_call_id: call.runtimeCallId,
        tool_identity: call.toolIdentity,
        status: call.status,
        ...(notice ? { detail: notice } : {}),
        redacted_arguments: call.redactedArguments,
      },
    });
  }

  /** The approval_resolved event that tells the client how an approval of `task` was resolved. */
  approvalResolved(
    task: TaskState,
    resolved: Pick<ApprovalChange, "approvalId" | "callId"> & {
      status: EventPayload<"approval_resolved">["status"];
      reason?: string;
    },
  ): OutgoingEvent {
    return {
      type: "approval_resolved",
      payload: {
        conversation_id: this.draft.id,
        task_id: task.id,
        approval_id: resolved.approvalId,
        tool_call_id: resolved.callId,
        status: resolved.status,
        ...(resolved.reason ? { reason: resolved.reason } : {}),
      },
    };
  }

  /** Record an approval resolved without a user decision, and the event that tells the client. */
  recordApprovalChange(
    task: TaskState,
    change: ApprovalChange,
    cause: { decisionEventId: string | null } = { decisionEventId: null },
  ): void {
    this.write({
      kind: "update_approval",
      id: change.approvalId,
      fields: {
        status: change.status,
        consumedAt: this.at,
        reason: change.reason,
        ...(cause.decisionEventId ? { decisionEventId: cause.decisionEventId } : {}),
      },
    });
    this.emit(this.approvalResolved(task, change), {
      ...taskLinks(task),
      id: change.eventId,
      causedBy: cause.decisionEventId,
    });
  }

  recordCallChange(change: CallChange): void {
    this.write({
      kind: "update_tool_call",
      id: change.callId,
      fields: {
        updatedAt: this.at,
        status: change.status,
        ...(change.detail ? { detail: change.detail } : {}),
      },
    });
  }

  /** Record a call's release; the runtime learns of it only through the answer queued after the commit. */
  recordDispatch(
    task: TaskState,
    call: CallState,
    cause: { id: string; via: "approval" | "policy"; causedBy: string },
  ): void {
    this.record(
      "tool_dispatched",
      {
        tool_call_id: call.id,
        runtime_call_id: call.runtimeCallId,
        tool_identity: call.toolIdentity,
        policy: call.policy,
        via: cause.via,
      },
      { ...taskLinks(task), id: cause.id, causedBy: cause.causedBy },
    );
    this.write({
      kind: "update_tool_call",
      id: call.id,
      fields: { updatedAt: this.at, status: "dispatched", dispatchEventId: cause.id },
    });
  }

  /**
   * Record the task's status and move the draft to it. It writes even an unchanged status, as every step that may
   * change it does, so the records need no comparison against what an earlier step of the same transition set. The
   * write and the draft both keep transition order, so the last one wins in the records and in memory alike (a
   * superseded approval resumes the task, then the new revision's ask holds it).
   */
  recordTaskStatus(task: TaskState, status: TaskStatus): void {
    this.write({ kind: "update_task", id: task.id, fields: { status } });
    this.advanceTask(task.id, (next) => ({ ...next, status }));
  }

  /**
   * The call takes its new status in the next state. With `notify`, the client is then told of it; its held prompt,
   * if any, is answered after.
   */
  commitCallChange(
    task: TaskState,
    change: CallChange,
    options: { notify: boolean } = { notify: false },
  ): void {
    this.advanceTask(task.id, (next) => withCall(next, change.callId, { status: change.status }));
    if (options.notify) this.notifyCall(task.id, change.callId, change.notice);
    const approvalId = this.call(task.id, change.callId).approvalId;
    if (change.settle && approvalId !== null)
      this.effect({ kind: "answer_prompt", approvalId, decision: change.settle });
  }
}
