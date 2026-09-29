import { match } from "ts-pattern";
import type { GateDecision, RuntimeInit, TurnSummary } from "@mia/agent-adapter";
import type { Decide, Decision as MachineDecision } from "@mia/kernel";
import {
  canonicalDigest,
  redactValue,
  type Decision,
  type Effort,
  type RuntimeCancellation,
  type TaskStatus,
  type ToolCallPolicy,
  type ToolCallStatus,
} from "@mia/protocol";
import type { ExecutionStatus } from "@mia/records";
import { buildConversationStart, type StartIds } from "./conversation-start.ts";
import { DelegationDraft, workerLinks, type BuiltDelegation } from "./delegation-draft.ts";
import type { DelegationEffect } from "./delegation-effects.ts";
import {
  MAX_CALLS_PER_TASK,
  MAX_QUEUED_INPUTS,
  MAX_RUNNING_TASKS,
  callByRuntimeId,
  isSettled,
  taskByRuntimeId,
  type DelegationState,
  type TaskState,
} from "./delegation-state.ts";
import type { Origin } from "./engine-effects.ts";
import type { EngineRecord } from "./engine-records.ts";
import type { NamedProvenancePlan } from "./provenance.ts";

// Every transition of a delegating conversation (D2), as its kernel machine's `decide`: pure, from the state, the
// event and the time, with every id drawn beforehand (see `DelegationDraft.id`).

/** The tool identities of the manager agent's delegation, as the gate and the stream report it. */
const DELEGATION_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);
/** The manager agent's tool that stops a worker agent. */
const STOP_TOOL = "TaskStop";

/** The answer to a call Mia refuses, with the reason the runtime passes on to the agent. */
const deny = (message: string): GateDecision => ({ behavior: "deny", message });

const REJECTED_BY_USER = deny("The user rejected this call. Do not retry it.");
const STOPPED = deny("Mia blocked this call: its task was stopped.");

export interface StartEvent {
  kind: "start_conversation";
  origin: Origin;
  closes: string | null;
  provenance: NamedProvenancePlan;
  managerPromptFile: string | null;
  workerPrompt: string | null;
  conversationsRoot: string;
  debugMode: boolean;
  ids: StartIds;
}

/** Everything but a start: each draws the ids its transition may record (see `DelegationDraft.id`). */
interface Drawn {
  origin: Origin;
  ids: readonly string[];
}

export interface MessageEvent extends Drawn {
  kind: "message_submitted";
  text: string;
  clientId: string;
  requested: { model: string; effort: Effort };
  /** Written by Mia rather than typed by the person, e.g. asking the manager agent to stop a task. */
  fromMia: boolean;
}

export interface MessageUndeliveredEvent extends Drawn {
  kind: "message_undelivered";
  /** The message_received event of the message the session did not take. */
  eventId: string;
}

export interface TurnBeganEvent extends Drawn {
  kind: "turn_began";
  init: RuntimeInit;
}

export interface ReplyEvent extends Drawn {
  kind: "reply_text";
  text: string;
}

export interface TurnEndedEvent extends Drawn {
  kind: "turn_ended";
  summary: TurnSummary;
}

export interface WorkerStartedEvent extends Drawn {
  kind: "worker_started";
  runtimeTaskId: string;
  delegationCallId: string;
  description: string;
  clientId: string | null;
  requested: { model: string; effort: Effort };
}

export interface WorkerEndedEvent extends Drawn {
  kind: "worker_ended";
  runtimeTaskId: string;
  // eslint-disable-next-line no-restricted-syntax -- the runtime's own word for how it ended, mapped by `endedStatus`
  status: string;
  summary: string | null;
}

export interface GateRequestEvent extends Drawn {
  kind: "gate_request";
  runtimeCallId: string | undefined;
  toolIdentity: string;
  input: unknown;
  /** The worker agent asking, by the runtime's task id, or null for the manager agent. */
  agentId: string | null;
  policy: ToolCallPolicy;
  exclusive: boolean;
  /** The held approvals are at their bound: a call that would ask is denied instead (see MAX_HELD_PROMPTS). */
  heldFull: boolean;
}

export interface ApprovalDecisionEvent extends Drawn {
  kind: "approval_decision";
  taskId: string;
  approvalId: string;
  decision: Decision;
  deciderClientId: string;
  ownerClientId: string | null;
  exclusive: boolean;
}

/** The hook holding an approval's call went away before the person decided (its runtime was killed or dropped it). */
export interface ApprovalAbandonedEvent extends Drawn {
  kind: "approval_abandoned";
  approvalId: string;
}

export interface ToolResultEvent extends Drawn {
  kind: "tool_result";
  runtimeCallId: string;
  isError: boolean;
  content: unknown;
}

export interface StopAllEvent extends Drawn {
  kind: "stop_all";
  by: "client" | "shutdown";
}

export interface StopTaskEvent extends Drawn {
  kind: "stop_task";
  taskId: string;
}

export interface SessionEndedEvent extends Drawn {
  kind: "session_ended";
  status: "ended" | "killed" | "failed";
  error: string | null;
  runtimeCancellation: RuntimeCancellation;
}

export type DelegationEvent =
  | StartEvent
  | MessageEvent
  | MessageUndeliveredEvent
  | TurnBeganEvent
  | ReplyEvent
  | TurnEndedEvent
  | WorkerStartedEvent
  | WorkerEndedEvent
  | GateRequestEvent
  | ApprovalDecisionEvent
  | ApprovalAbandonedEvent
  | ToolResultEvent
  | StopAllEvent
  | StopTaskEvent
  | SessionEndedEvent;

export type DelegationRejection =
  | { kind: "not_started" }
  | { kind: "already_started" }
  | { kind: "busy"; queued: number }
  | { kind: "stopping" }
  | { kind: "no_worker_prompt" }
  | { kind: "no_session" }
  | { kind: "no_turn" }
  | { kind: "no_task" }
  | { kind: "duplicate_task" }
  | { kind: "not_owner" }
  | { kind: "not_pending" }
  | { kind: "already_stopping" };

type Decided = MachineDecision<
  DelegationState,
  DelegationRejection,
  EngineRecord,
  DelegationEffect
>;

const rejected = (rejection: DelegationRejection): Decided => ({ kind: "rejected", rejection });

const draftFor = (state: DelegationState, event: Drawn, now: Date): DelegationDraft =>
  new DelegationDraft({ state, now, origin: event.origin, ids: event.ids });

// ---------------------------------------------------------------- conversation and session

const conversationStart = (event: StartEvent, now: Date): BuiltDelegation => {
  const draft = new DelegationDraft({ state: null, now, origin: event.origin, ids: [] });
  buildConversationStart({
    draft,
    start: event,
    stateOf: (conversation) => ({
      ...conversation,
      managerPromptFile: event.managerPromptFile,
      workerPrompt: event.workerPrompt,
      sessionCount: 0,
      sessionStarted: false,
      session: null,
      epoch: 0,
      pendingNote: null,
      queuedInputs: [],
      endedTasks: [],
      turn: null,
      tasks: new Map(),
      leases: new Map(),
    }),
    activate: { kind: "activate_conversation", origin: event.origin },
  });
  return draft.accepted();
};

/**
 * The person (or Mia) sends the manager agent a message. It is never refused because work is running: the session
 * reads it as the next turn's input, opened first if none is. Only a full queue, a session being stopped, or a
 * worker prompt that was missing at start refuses it. A Mia note left by a stop rides on the next message.
 */
const messageSubmitted = (state: DelegationState, event: MessageEvent, now: Date): Decided => {
  if (state.queuedInputs.length >= MAX_QUEUED_INPUTS)
    return rejected({ kind: "busy", queued: state.queuedInputs.length });
  if (state.session?.status === "stopping") return rejected({ kind: "stopping" });
  if (state.workerPrompt === null) return rejected({ kind: "no_worker_prompt" });
  const draft = draftFor(state, event, now);
  let session = state.session;
  let { sessionCount } = state;
  if (session === null) {
    const executionId = draft.id("exec");
    sessionCount += 1;
    draft.write({
      kind: "create_execution",
      input: {
        id: executionId,
        startedAt: draft.at,
        taskId: null,
        agentRole: "manager",
        conversationId: state.id,
        runtimeIdentity: "claude-code",
        runtimeConversationId: state.runtimeConversationId,
        requestedModel: event.requested.model,
        requestedEffort: event.requested.effort,
        provenanceSetId: state.provenanceSetId,
        executionEpoch: state.epoch,
      },
    });
    session = { executionId, status: "open" };
    draft.effect({
      kind: "open_session",
      session: { executionId, sessionIndex: sessionCount, resume: state.sessionStarted },
    });
  }
  const received = draft.id("evt");
  draft.record(
    "message_received",
    { text: event.text, from: event.fromMia ? "mia" : "user", client_id: event.clientId },
    { id: received, executionId: session.executionId },
  );
  const text = state.pendingNote === null ? event.text : `${state.pendingNote}\n\n${event.text}`;
  draft.advance({
    ...draft.draft,
    session,
    sessionCount,
    pendingNote: null,
    queuedInputs: [...state.queuedInputs, received],
  });
  draft.effect({ kind: "send_message", text, eventId: received });
  return draft.accepted();
};

/** The session did not take a recorded message (it had stopped reading): it leaves the queue, recorded as lost. */
const messageUndelivered = (
  state: DelegationState,
  event: MessageUndeliveredEvent,
  now: Date,
): Decided => {
  if (!state.queuedInputs.includes(event.eventId)) return rejected({ kind: "no_session" });
  const draft = draftFor(state, event, now);
  draft.record(
    "message_undelivered",
    { message_event_id: event.eventId },
    { id: draft.id("evt"), causedBy: event.eventId },
  );
  draft.advance({
    ...draft.draft,
    queuedInputs: state.queuedInputs.filter((queued) => queued !== event.eventId),
  });
  return draft.accepted();
};

/**
 * The runtime begins a manager turn (a fresh `init`, capability record W4). It reports the oldest task end no turn
 * has reported yet, if any, else it takes the oldest queued message. The runtime may fold several messages into one
 * turn; a message no turn takes stays queued until the session ends, and is then recorded undelivered.
 */
const turnBegan = (state: DelegationState, event: TurnBeganEvent, now: Date): Decided => {
  const { session } = state;
  if (session === null) return rejected({ kind: "no_session" });
  const draft = draftFor(state, event, now);
  if (state.turn !== null)
    finishTurn(draft, { status: "failed", error: "no result before the next turn" });
  const [endedTask, ...otherEnds] = state.endedTasks;
  const [input, ...otherInputs] = state.queuedInputs;
  const turnId = draft.id("turn");
  const cause =
    endedTask === undefined
      ? ({ kind: "user_input" } as const)
      : ({ kind: "task_end", taskId: endedTask } as const);
  draft.write({
    kind: "create_turn",
    input: {
      id: turnId,
      conversationId: state.id,
      executionId: session.executionId,
      startedAt: draft.at,
      cause,
    },
  });
  if (!state.sessionStarted)
    draft.write({
      kind: "update_execution",
      id: session.executionId,
      fields: { reportedModel: event.init.model },
    });
  draft.record("runtime_init", event.init.evidence, {
    id: draft.id("evt"),
    executionId: session.executionId,
  });
  draft.emit(
    {
      type: "turn_started",
      payload: {
        conversation_id: state.id,
        turn_id: turnId,
        cause: cause.kind,
        ...(endedTask === undefined ? {} : { task_id: endedTask }),
      },
    },
    {
      id: draft.id("evt"),
      executionId: session.executionId,
      causedBy: endedTask === undefined ? input : null,
    },
  );
  draft.advance({
    ...draft.draft,
    sessionStarted: true,
    turn: { id: turnId, cause: cause.kind, causedByTaskId: endedTask ?? null },
    endedTasks: otherEnds,
    queuedInputs: endedTask === undefined ? otherInputs : state.queuedInputs,
  });
  return draft.accepted();
};

/** Record the running turn's end with `outcome`, and tell the client. */
const finishTurn = (
  draft: DelegationDraft,
  outcome: {
    status: "completed" | "failed" | "interrupted";
    error?: string;
    summary?: TurnSummary;
  },
): void => {
  const { turn, session } = draft.draft;
  if (turn === null) return;
  const { summary } = outcome;
  draft.write({
    kind: "update_turn",
    id: turn.id,
    fields: {
      status: outcome.status,
      finishedAt: draft.at,
      ...(summary === undefined
        ? {}
        : {
            usage: {
              usage: summary.usage,
              totalCostUsd: summary.totalCostUsd,
              durationMs: summary.durationMs,
              durationApiMs: summary.durationApiMs,
              numTurns: summary.numTurns,
            },
          }),
    },
  });
  draft.emit(
    {
      type: "turn_finished",
      payload: {
        conversation_id: draft.draft.id,
        turn_id: turn.id,
        status: outcome.status,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      },
    },
    { id: draft.id("evt"), executionId: session?.executionId ?? null },
  );
  draft.advance({ ...draft.draft, turn: null });
};

/** Text of the manager agent's reply, delivered under its turn. */
const replyText = (state: DelegationState, event: ReplyEvent, now: Date): Decided => {
  if (state.turn === null) return rejected({ kind: "no_turn" });
  const draft = draftFor(state, event, now);
  draft.emit(
    {
      type: "reply_delta",
      payload: { conversation_id: state.id, turn_id: state.turn.id, text: event.text },
    },
    { id: draft.id("evt"), executionId: state.session?.executionId ?? null },
  );
  return draft.accepted();
};

/** The manager agent's turn ends with the runtime's result. */
const turnEnded = (state: DelegationState, event: TurnEndedEvent, now: Date): Decided => {
  if (state.turn === null) return rejected({ kind: "no_turn" });
  const draft = draftFor(state, event, now);
  draft.record("runtime_result", event.summary.evidence, {
    id: draft.id("evt"),
    executionId: state.session?.executionId ?? null,
  });
  finishTurn(draft, {
    status: event.summary.isError ? "failed" : "completed",
    ...(event.summary.isError ? { error: `runtime reported ${event.summary.outcome}` } : {}),
    summary: event.summary,
  });
  return draft.accepted();
};

// ---------------------------------------------------------------- tasks

/**
 * The runtime starts a worker agent: its task, linked to the turn that delegated it, and the worker agent's
 * execution. A task started while every task is being stopped starts with its gate closed.
 */
const workerStarted = (state: DelegationState, event: WorkerStartedEvent, now: Date): Decided => {
  if (state.session === null) return rejected({ kind: "no_session" });
  if (taskByRuntimeId(state, event.runtimeTaskId)) return rejected({ kind: "duplicate_task" });
  const draft = draftFor(state, event, now);
  const taskId = draft.id("task");
  const executionId = draft.id("exec");
  const turnId = state.turn?.id ?? null;
  draft.write(
    {
      kind: "create_task",
      input: {
        id: taskId,
        createdAt: draft.at,
        conversationId: state.id,
        text: event.description,
        clientId: event.clientId,
        ...(turnId === null
          ? {}
          : {
              delegation: {
                turnId,
                runtimeTaskId: event.runtimeTaskId,
                delegationCallId: event.delegationCallId,
              },
            }),
      },
    },
    {
      kind: "create_execution",
      input: {
        id: executionId,
        startedAt: draft.at,
        taskId,
        agentRole: "worker",
        conversationId: state.id,
        runtimeIdentity: "claude-code",
        runtimeConversationId: event.runtimeTaskId,
        requestedModel: event.requested.model,
        requestedEffort: event.requested.effort,
        provenanceSetId: state.provenanceSetId,
        executionEpoch: state.epoch,
      },
    },
  );
  const links = { taskId, executionId };
  draft.record(
    "worker_started",
    {
      runtime_task_id: event.runtimeTaskId,
      delegation_call_id: event.delegationCallId,
      turn_id: turnId,
    },
    { ...links, id: draft.id("evt") },
  );
  draft.emit(
    {
      type: "task_started",
      payload: {
        conversation_id: state.id,
        task_id: taskId,
        execution_id: executionId,
        execution_epoch: state.epoch,
        text: event.description,
        ...(turnId === null ? {} : { turn_id: turnId }),
      },
    },
    { ...links, id: draft.id("evt") },
  );
  const task: TaskState = {
    id: taskId,
    executionId,
    runtimeTaskId: event.runtimeTaskId,
    delegationCallId: event.delegationCallId,
    turnId,
    epoch: state.epoch,
    status: "running",
    gateOpen: state.session.status === "open",
    calls: new Map(),
    pendingApprovals: new Map(),
  };
  draft.advance({ ...draft.draft, tasks: new Map(state.tasks).set(taskId, task) });
  return draft.accepted();
};

/** The task status a worker agent's end leaves, from the runtime's own word for it. */
// eslint-disable-next-line no-restricted-syntax -- the runtime's own word for a worker agent's end, mapped here
const endedStatus = (runtimeStatus: string, stopped: boolean): TaskStatus => {
  if (stopped || runtimeStatus === "stopped" || runtimeStatus === "killed") return "interrupted";
  return runtimeStatus === "completed" ? "completed" : "failed";
};

const EXECUTION_STATUS: Record<TaskStatus, ExecutionStatus> = {
  running: "running",
  awaiting_approval: "running",
  interrupting: "running",
  completed: "completed",
  failed: "failed",
  interrupted: "killed",
  outcome_unknown: "killed",
};

/**
 * End task `task` with `status`: a call released without a result becomes unknown (a stopped worker agent's
 * in-flight call keeps running, capability record W3), a held call is invalidated and its hook denied, its leases
 * are released, and the task leaves the running tasks. An unknown call turns a clean end into outcome_unknown.
 */
const endTask = (
  draft: DelegationDraft,
  task: TaskState,
  outcome: {
    status: TaskStatus;
    event: "task_finished" | "interruption_outcome";
    cancellation: RuntimeCancellation;
  },
): void => {
  let unknown = false;
  const actions: {
    tool_call_id: string;
    tool_identity: string;
    status: ToolCallStatus;
    detail?: string;
  }[] = [];
  for (const call of task.calls.values()) {
    if (call.status === "dispatched") {
      unknown = true;
      draft.changeCall(task.id, call.id, {
        status: "unknown",
        detail: "its worker agent ended before the call's result arrived; it may still run",
      });
    } else if (call.status === "awaiting_approval" && call.approvalId !== null) {
      draft.resolveApproval(task, {
        approvalId: call.approvalId,
        callId: call.id,
        status: "expired",
        reason: "its worker agent ended",
        eventId: draft.id("evt"),
      });
      draft.changeCall(task.id, call.id, {
        status: "invalidated",
        detail: "its worker agent ended",
      });
      draft.effect({ kind: "answer_held", approvalId: call.approvalId, decision: STOPPED });
    }
    const now = draft.draft.tasks.get(task.id)?.calls.get(call.id);
    if (now)
      actions.push({ tool_call_id: now.id, tool_identity: now.toolIdentity, status: now.status });
    if (draft.draft.leases.get(call.toolIdentity)?.callId === call.id)
      draft.releaseLease(call.toolIdentity, draft.id("evt"));
  }
  const status = unknown && outcome.status === "completed" ? "outcome_unknown" : outcome.status;
  draft.write(
    { kind: "update_task", id: task.id, fields: { status, finishedAt: draft.at } },
    {
      kind: "update_execution",
      id: task.executionId,
      fields: { status: EXECUTION_STATUS[status], endedAt: draft.at },
    },
  );
  const links = { ...workerLinks(task), id: draft.id("evt") };
  const conversationId = draft.draft.id;
  if (outcome.event === "interruption_outcome")
    draft.emit(
      {
        type: "interruption_outcome",
        payload: {
          conversation_id: conversationId,
          task_id: task.id,
          task_status: status,
          actions,
          runtime_cancellation: outcome.cancellation,
        },
      },
      links,
    );
  else
    draft.emit(
      {
        type: "task_finished",
        payload: { conversation_id: conversationId, task_id: task.id, status },
      },
      links,
    );
  const tasks = new Map(draft.draft.tasks);
  tasks.delete(task.id);
  draft.advance({ ...draft.draft, tasks });
};

/** The runtime reports a worker agent's end: its task ends, and the next turn reports it. */
const workerEnded = (state: DelegationState, event: WorkerEndedEvent, now: Date): Decided => {
  const task = taskByRuntimeId(state, event.runtimeTaskId);
  if (!task) return rejected({ kind: "no_task" });
  const draft = draftFor(state, event, now);
  draft.record(
    "worker_ended",
    { runtime_task_id: event.runtimeTaskId, status: event.status, summary: event.summary },
    { ...workerLinks(task), id: draft.id("evt") },
  );
  endTask(draft, task, {
    status: endedStatus(event.status, !task.gateOpen),
    event: task.gateOpen ? "task_finished" : "interruption_outcome",
    cancellation: "not_needed",
  });
  draft.advance({ ...draft.draft, endedTasks: [...draft.draft.endedTasks, task.id] });
  return draft.accepted();
};

// ---------------------------------------------------------------- the gate

/** A manager agent's delegation, stop, or other call; the manager agent makes no tool calls of its own. */
const managerCall = (state: DelegationState, event: GateRequestEvent, now: Date): Decided => {
  const draft = draftFor(state, event, now);
  const executionId = state.session?.executionId ?? null;
  const refuse = (reason: string): Decided => {
    draft.record(
      "tool_refused",
      {
        runtime_call_id: event.runtimeCallId ?? null,
        tool_identity: event.toolIdentity,
        agent: "manager",
        reason,
      },
      { id: draft.id("evt"), executionId },
    );
    draft.effect({
      kind: "answer_gate",
      answer: { kind: "answer", decision: deny(`Mia: ${reason}`) },
    });
    return draft.accepted();
  };
  const allow = (): Decided => {
    draft.record(
      "tool_dispatched",
      {
        runtime_call_id: event.runtimeCallId ?? null,
        tool_identity: event.toolIdentity,
        agent: "manager",
      },
      { id: draft.id("evt"), executionId },
    );
    draft.effect({
      kind: "answer_gate",
      answer: { kind: "answer", decision: { behavior: "allow" } },
    });
    return draft.accepted();
  };
  if (DELEGATION_TOOLS.has(event.toolIdentity)) {
    const input = redactValue(event.input);
    const background = JSON.stringify(input).includes('"run_in_background":true');
    if (!background)
      return refuse("start worker agents with run_in_background: true, so you never wait on one");
    if (state.session?.status !== "open") return refuse("every task is being stopped");
    if (state.tasks.size >= MAX_RUNNING_TASKS)
      return refuse(`${MAX_RUNNING_TASKS} tasks are already running; wait for one to end`);
    return allow();
  }
  if (event.toolIdentity === STOP_TOOL) {
    const runtimeTaskId = stopTarget(event.input);
    const task = runtimeTaskId === null ? undefined : taskByRuntimeId(state, runtimeTaskId);
    if (!task) return refuse("that task is not running");
    closeTask(draft, task, "manager");
    return allow();
  }
  return refuse("the manager agent makes no tool calls itself; start a worker agent for this");
};

/** The runtime task a `TaskStop` call names, or null when it names none. */
const stopTarget = (input: unknown): string | null => {
  if (typeof input !== "object" || input === null) return null;
  for (const [key, value] of Object.entries(input))
    if ((key === "task_id" || key === "shell_id") && typeof value === "string") return value;
  return null;
};

/**
 * Close task `task`'s gate: no call of it is allowed or released from here on, its pending approvals are invalidated
 * and their hooks denied, and the client is told it is being interrupted. The worker agent itself ends when the
 * runtime stops it.
 */
const closeTask = (
  draft: DelegationDraft,
  task: TaskState,
  by: "manager" | "client" | "all",
): void => {
  draft.record(
    "stop_requested",
    { scope: by === "all" ? "all" : "task", by },
    {
      ...workerLinks(task),
      id: draft.id("evt"),
    },
  );
  for (const [approvalId, callId] of task.pendingApprovals) {
    draft.resolveApproval(task, {
      approvalId,
      callId,
      status: "invalidated",
      reason: "its task was stopped",
      eventId: draft.id("evt"),
    });
    draft.changeCall(task.id, callId, { status: "invalidated", detail: "its task was stopped" });
    draft.effect({ kind: "answer_held", approvalId, decision: STOPPED });
  }
  draft.recordTaskStatus(task.id, "interrupting");
  draft.advanceTask(task.id, (next) => ({ ...next, gateOpen: false, pendingApprovals: new Map() }));
  draft.emit(
    {
      type: "interruption_requested",
      payload: { conversation_id: draft.draft.id, task_id: task.id, execution_epoch: task.epoch },
    },
    { ...workerLinks(task), id: draft.id("evt") },
  );
};

/** What the gate decides for a worker agent's call, before anything is recorded. */
type CallOutcome =
  | { kind: "deny"; status: "denied" | "blocked_gate"; detail: string; decision: GateDecision }
  | { kind: "allow" }
  | { kind: "ask" };

const callOutcome = (
  state: DelegationState,
  task: TaskState,
  event: GateRequestEvent,
): CallOutcome => {
  if (!task.gateOpen || task.epoch !== state.epoch)
    return {
      kind: "deny",
      status: "blocked_gate",
      detail: "its task was stopped",
      decision: STOPPED,
    };
  if (event.policy === "deny" || event.policy === "unlisted")
    return {
      kind: "deny",
      status: "denied",
      detail: event.policy === "deny" ? "denied by policy" : "not in Mia's tool policy",
      decision: deny(`Mia: ${event.toolIdentity} is not permitted. Do not retry it.`),
    };
  const lease = state.leases.get(event.toolIdentity);
  if (event.exclusive && lease !== undefined)
    return {
      kind: "deny",
      status: "denied",
      detail: "an exclusive tool another task is using",
      decision: deny(
        `Mia: ${event.toolIdentity} is in use by another task; only one may use it at a time. Report this and stop.`,
      ),
    };
  if (event.policy === "allow") return { kind: "allow" };
  if (event.heldFull)
    return {
      kind: "deny",
      status: "denied",
      detail: "too many approvals are already waiting",
      decision: deny("Mia: too many approvals are already waiting; this call was not asked."),
    };
  return { kind: "ask" };
};

/** Release call `callId` of task `task`, taking its exclusive tool's lease when it has one. */
const dispatch = (
  draft: DelegationDraft,
  release: {
    task: TaskState;
    call: { id: string; runtimeCallId: string; toolIdentity: string; policy: ToolCallPolicy };
    via: { how: "policy" | "approval"; exclusive: boolean; causedBy: string };
  },
): void => {
  const { task, call, via } = release;
  const dispatched = draft.id("evt");
  draft.record(
    "tool_dispatched",
    {
      tool_call_id: call.id,
      runtime_call_id: call.runtimeCallId,
      tool_identity: call.toolIdentity,
      policy: call.policy,
      via: via.how,
    },
    { ...workerLinks(task), id: dispatched, causedBy: via.causedBy },
  );
  draft.changeCall(task.id, call.id, { status: "dispatched", dispatchEventId: dispatched });
  if (!via.exclusive) return;
  const leaseId = draft.id("lease");
  draft.write({
    kind: "acquire_lease",
    input: {
      id: leaseId,
      conversationId: draft.draft.id,
      toolIdentity: call.toolIdentity,
      taskId: task.id,
      toolCallId: call.id,
      acquiredAt: draft.at,
    },
  });
  draft.record(
    "lease_acquired",
    { lease_id: leaseId, tool_identity: call.toolIdentity, tool_call_id: call.id },
    { ...workerLinks(task), id: draft.id("evt") },
  );
  draft.advance({
    ...draft.draft,
    leases: new Map(draft.draft.leases).set(call.toolIdentity, {
      id: leaseId,
      taskId: task.id,
      callId: call.id,
    }),
  });
};

/**
 * A worker agent's call. One the runtime does not attribute to a running task is denied and recorded unattributed,
 * never guessed; a worker agent cannot start or stop worker agents; otherwise policy, the task's gate, the exclusive
 * tools and the held approvals' bound decide, and the call's record says how.
 */
const workerCall = (
  state: DelegationState,
  event: GateRequestEvent & { agentId: string; runtimeCallId: string },
  now: Date,
): Decided => {
  const draft = draftFor(state, event, now);
  const answer = (decision: GateDecision): void =>
    draft.effect({ kind: "answer_gate", answer: { kind: "answer", decision } });
  const task = taskByRuntimeId(state, event.agentId);
  if (!task) {
    draft.record(
      "tool_unattributed",
      {
        runtime_call_id: event.runtimeCallId,
        tool_identity: event.toolIdentity,
        agent_id: event.agentId,
      },
      { id: draft.id("evt") },
    );
    answer(deny("Mia cannot tell which task made this call; it was not run."));
    return draft.accepted();
  }
  const refuse = (reason: string): Decided => {
    draft.record(
      "tool_refused",
      {
        runtime_call_id: event.runtimeCallId,
        tool_identity: event.toolIdentity,
        agent: "worker",
        reason,
      },
      { ...workerLinks(task), id: draft.id("evt") },
    );
    answer(deny(`Mia: ${reason}`));
    return draft.accepted();
  };
  if (DELEGATION_TOOLS.has(event.toolIdentity) || event.toolIdentity === STOP_TOOL)
    return refuse("worker agents cannot start or stop worker agents");
  if (task.calls.values().some((call) => call.runtimeCallId === event.runtimeCallId))
    return refuse("this call was already decided");
  if (task.calls.size >= MAX_CALLS_PER_TASK)
    return refuse(`this task already made ${MAX_CALLS_PER_TASK} calls`);
  const outcome = callOutcome(state, task, event);
  const callId = draft.id("call");
  const proposed = draft.id("evt");
  const redacted = redactValue(event.input);
  const digest = canonicalDigest(event.input);
  draft.record(
    "tool_proposed",
    {
      runtime_call_id: event.runtimeCallId,
      tool_identity: event.toolIdentity,
      redacted_arguments: redacted,
      argument_digest: digest,
      source: "gate",
    },
    { ...workerLinks(task), id: proposed },
  );
  draft.write({
    kind: "create_tool_call",
    input: {
      id: callId,
      createdAt: draft.at,
      conversationId: state.id,
      taskId: task.id,
      executionId: task.executionId,
      runtimeCallId: event.runtimeCallId,
      bindingRevision: 1,
      toolIdentity: event.toolIdentity,
      argumentDigest: digest,
      redactedArguments: redacted,
      policy: event.policy,
      status: "proposed",
      proposalEventId: proposed,
    },
  });
  const call = {
    id: callId,
    runtimeCallId: event.runtimeCallId,
    toolIdentity: event.toolIdentity,
    digest,
    redactedArguments: redacted,
    policy: event.policy,
    status: "proposed" as const,
    approvalId: null,
  };
  draft.advanceTask(task.id, (next) => ({ ...next, calls: new Map(next.calls).set(callId, call) }));
  return match(outcome)
    .with({ kind: "deny" }, (denied) => {
      draft.changeCall(task.id, callId, { status: denied.status, detail: denied.detail });
      answer(denied.decision);
      return draft.accepted();
    })
    .with({ kind: "allow" }, () => {
      dispatch(draft, {
        task,
        call,
        via: { how: "policy", exclusive: event.exclusive, causedBy: proposed },
      });
      answer({ behavior: "allow" });
      return draft.accepted();
    })
    .with({ kind: "ask" }, () => {
      const approvalId = draft.id("appr");
      const requested = draft.id("evt");
      draft.write({
        kind: "create_approval",
        input: {
          id: approvalId,
          requestedAt: draft.at,
          toolCallId: callId,
          executionEpoch: task.epoch,
          requestingEventId: requested,
        },
      });
      draft.emit(
        {
          type: "approval_requested",
          payload: {
            conversation_id: state.id,
            task_id: task.id,
            approval_id: approvalId,
            tool_call_id: callId,
            runtime_call_id: event.runtimeCallId,
            binding_revision: 1,
            execution_epoch: task.epoch,
            tool_identity: event.toolIdentity,
            intended_action: `${event.toolIdentity} ${JSON.stringify(redacted)}`.slice(0, 500),
            redacted_arguments: redacted,
            argument_digest: digest,
            explainable: true,
          },
        },
        { ...workerLinks(task), id: requested, causedBy: proposed },
      );
      draft.changeCall(task.id, callId, { status: "awaiting_approval" });
      draft.advanceTask(task.id, (next) => ({
        ...next,
        calls: new Map(next.calls).set(callId, {
          ...call,
          status: "awaiting_approval",
          approvalId,
        }),
        pendingApprovals: new Map(next.pendingApprovals).set(approvalId, callId),
      }));
      draft.recordTaskStatus(task.id, "awaiting_approval");
      draft.effect({ kind: "answer_gate", answer: { kind: "hold", approvalId } });
      return draft.accepted();
    })
    .exhaustive();
};

/** A call reached the gate: the manager agent's or a worker agent's; one without a call id is refused. */
const gateRequest = (state: DelegationState, event: GateRequestEvent, now: Date): Decided => {
  const { runtimeCallId, agentId } = event;
  if (runtimeCallId === undefined || runtimeCallId === "") {
    const draft = draftFor(state, event, now);
    draft.record(
      "tool_refused",
      { tool_identity: event.toolIdentity, reason: "no runtime call id" },
      { id: draft.id("evt") },
    );
    draft.effect({
      kind: "answer_gate",
      answer: {
        kind: "answer",
        decision: deny("Mia cannot bind this call to a runtime call id; it was not run."),
      },
    });
    return draft.accepted();
  }
  if (agentId === null) return managerCall(state, event, now);
  return workerCall(state, { ...event, agentId, runtimeCallId }, now);
};

// ---------------------------------------------------------------- approvals, results and stops

/**
 * The owner decides a pending approval. Approving releases the call only while its task's gate is open, its epoch is
 * current and, for an exclusive tool, no other task holds it; anything else denies it with the reason. Either way the
 * held hook gets its answer.
 */
const approvalDecision = (
  state: DelegationState,
  event: ApprovalDecisionEvent,
  now: Date,
): Decided => {
  const task = state.tasks.get(event.taskId);
  if (!task) return rejected({ kind: "no_task" });
  if (event.ownerClientId !== null && event.deciderClientId !== event.ownerClientId)
    return rejected({ kind: "not_owner" });
  const callId = task.pendingApprovals.get(event.approvalId);
  const call = callId === undefined ? undefined : task.calls.get(callId);
  if (!call || call.status !== "awaiting_approval") return rejected({ kind: "not_pending" });
  const draft = draftFor(state, event, now);
  const approve = event.decision === "approve";
  const resolved = draft.id("evt");
  draft.resolveApproval(task, {
    approvalId: event.approvalId,
    callId: call.id,
    status: approve ? "approved" : "rejected",
    eventId: resolved,
    decisionClientId: event.deciderClientId,
  });
  const pendingApprovals = new Map(task.pendingApprovals);
  pendingApprovals.delete(event.approvalId);
  draft.advanceTask(task.id, (next) => ({ ...next, pendingApprovals }));
  const heldByOther = event.exclusive && state.leases.has(call.toolIdentity);
  let decision: GateDecision;
  if (!approve) {
    draft.changeCall(task.id, call.id, { status: "denied", detail: "rejected by user" });
    decision = REJECTED_BY_USER;
  } else if (!task.gateOpen || task.epoch !== state.epoch) {
    draft.changeCall(task.id, call.id, {
      status: "blocked_gate",
      detail: "approved after its task was stopped",
    });
    decision = STOPPED;
  } else if (heldByOther) {
    draft.changeCall(task.id, call.id, {
      status: "denied",
      detail: "an exclusive tool another task is using",
    });
    decision = deny(
      `Mia: ${call.toolIdentity} is in use by another task; only one may use it at a time.`,
    );
  } else {
    dispatch(draft, {
      task,
      call,
      via: { how: "approval", exclusive: event.exclusive, causedBy: resolved },
    });
    decision = { behavior: "allow" };
  }
  if (task.gateOpen)
    draft.recordTaskStatus(task.id, pendingApprovals.size > 0 ? "awaiting_approval" : "running");
  draft.effect({ kind: "answer_held", approvalId: event.approvalId, decision });
  return draft.accepted();
};

/**
 * A held call's hook went away before the person decided: the approval expires and the call is invalidated, so no
 * later decision can release a call whose runtime was already told no.
 */
const approvalAbandoned = (
  state: DelegationState,
  event: ApprovalAbandonedEvent,
  now: Date,
): Decided => {
  const task = state.tasks
    .values()
    .find((running) => running.pendingApprovals.has(event.approvalId));
  const callId = task?.pendingApprovals.get(event.approvalId);
  if (!task || callId === undefined) return rejected({ kind: "not_pending" });
  const draft = draftFor(state, event, now);
  draft.resolveApproval(task, {
    approvalId: event.approvalId,
    callId,
    status: "expired",
    reason: "the runtime abandoned the call before a decision",
    eventId: draft.id("evt"),
  });
  draft.changeCall(task.id, callId, {
    status: "invalidated",
    detail: "abandoned before a decision",
  });
  const pendingApprovals = new Map(task.pendingApprovals);
  pendingApprovals.delete(event.approvalId);
  draft.advanceTask(task.id, (next) => ({ ...next, pendingApprovals }));
  if (task.gateOpen)
    draft.recordTaskStatus(task.id, pendingApprovals.size > 0 ? "awaiting_approval" : "running");
  return draft.accepted();
};

/** A worker agent's call returned: a released call completes or fails, and its exclusive tool is free again. */
const toolResult = (state: DelegationState, event: ToolResultEvent, now: Date): Decided => {
  const draft = draftFor(state, event, now);
  const found = callByRuntimeId(state, event.runtimeCallId);
  if (!found) {
    draft.record(
      "tool_result_unmatched",
      { runtime_call_id: event.runtimeCallId, is_error: event.isError },
      { id: draft.id("evt") },
    );
    return draft.accepted();
  }
  const { task, call } = found;
  const recorded = draft.id("evt");
  draft.record(
    "tool_result",
    {
      tool_call_id: call.id,
      runtime_call_id: call.runtimeCallId,
      is_error: event.isError,
      content: event.content,
    },
    { ...workerLinks(task), id: recorded },
  );
  if (!isSettled(call.status) && call.status === "dispatched") {
    draft.write({
      kind: "update_tool_call",
      id: call.id,
      fields: { updatedAt: draft.at, resultEventId: recorded },
    });
    draft.changeCall(task.id, call.id, { status: event.isError ? "failed" : "completed" });
  }
  if (state.leases.get(call.toolIdentity)?.callId === call.id)
    draft.releaseLease(call.toolIdentity, draft.id("evt"));
  return draft.accepted();
};

/**
 * The interrupt control, or shutdown, stops every task through the engine: the epoch advances, every task's gate
 * closes and its approvals are invalidated, and the session is killed. What the kill leaves is recorded when the
 * runtime's exit is (`sessionEnded`).
 */
const stopAll = (state: DelegationState, event: StopAllEvent, now: Date): Decided => {
  if (state.session === null) return rejected({ kind: "no_session" });
  if (state.session.status === "stopping") return rejected({ kind: "already_stopping" });
  const draft = draftFor(state, event, now);
  draft.record(
    "stop_requested",
    { scope: "all", by: event.by, tasks: [...state.tasks.keys()] },
    {
      id: draft.id("evt"),
      executionId: state.session.executionId,
    },
  );
  for (const task of state.tasks.values()) if (task.gateOpen) closeTask(draft, task, "all");
  draft.advance({
    ...draft.draft,
    epoch: state.epoch + 1,
    session: { ...state.session, status: "stopping" },
  });
  draft.effect({ kind: "stop_session" });
  return draft.accepted();
};

/**
 * The person stops one task. Its gate closes at once, so nothing more of it runs whatever the manager agent does;
 * then Mia asks the manager agent to stop its worker agent, as a message of its own.
 */
const stopTask = (state: DelegationState, event: StopTaskEvent, now: Date): Decided => {
  const task = state.tasks.get(event.taskId);
  if (!task) return rejected({ kind: "no_task" });
  if (!task.gateOpen) return rejected({ kind: "already_stopping" });
  const draft = draftFor(state, event, now);
  closeTask(draft, task, "client");
  return draft.accepted();
};

/** The note the next message carries after a session ended with work the manager agent did not see finish. */
const noteAfterSession = (ended: readonly TaskState[], lost: number): string | null => {
  const unknownCalls = ended.flatMap((task) =>
    [...task.calls.values()]
      .filter((call) => call.status === "dispatched")
      .map((call) => call.toolIdentity),
  );
  if (ended.length === 0 && lost === 0) return null;
  const parts = ["[Mia note] Your previous session was stopped."];
  if (ended.length > 0) parts.push(`${ended.length} task(s) were interrupted.`);
  if (unknownCalls.length > 0)
    parts.push(
      `These calls were running and their outcome is unknown: ${unknownCalls.join(", ")}. Do not assume they did or did not happen.`,
    );
  if (lost > 0) parts.push(`${lost} message(s) sent to you were never read.`);
  return parts.join(" ");
};

/** How the manager agent's execution ended, from how its session did. */
const sessionExecutionStatus = (
  stopped: boolean,
  status: SessionEndedEvent["status"],
): ExecutionStatus => {
  if (stopped) return "killed";
  return status === "ended" ? "completed" : "failed";
};

/**
 * The session's runtime exited: the manager agent's execution ends, its running turn ends, every task still running
 * ends (interrupted after a stop, failed otherwise), messages no turn took are recorded undelivered, and a note for
 * the next message says what was left unseen.
 */
const sessionEnded = (state: DelegationState, event: SessionEndedEvent, now: Date): Decided => {
  const { session } = state;
  if (session === null) return rejected({ kind: "no_session" });
  const draft = draftFor(state, event, now);
  const stopped = session.status === "stopping" || event.status === "killed";
  draft.record(
    "runtime_exit",
    { status: event.status, error: event.error, runtime_cancellation: event.runtimeCancellation },
    { id: draft.id("evt"), executionId: session.executionId },
  );
  draft.write({
    kind: "update_execution",
    id: session.executionId,
    fields: {
      status: sessionExecutionStatus(stopped, event.status),
      endedAt: draft.at,
    },
  });
  if (state.turn !== null)
    finishTurn(draft, {
      status: stopped ? "interrupted" : "failed",
      error: stopped ? "every task was stopped" : (event.error ?? "the session ended mid-turn"),
    });
  const ended = [...state.tasks.values()];
  for (const task of ended)
    endTask(draft, task, {
      status: stopped ? "interrupted" : "failed",
      event: "interruption_outcome",
      cancellation: event.runtimeCancellation,
    });
  for (const queued of state.queuedInputs)
    draft.record(
      "message_undelivered",
      { message_event_id: queued },
      { id: draft.id("evt"), causedBy: queued },
    );
  draft.advance({
    ...draft.draft,
    session: null,
    turn: null,
    queuedInputs: [],
    endedTasks: [],
    pendingNote: noteAfterSession(ended, state.queuedInputs.length),
  });
  return draft.accepted();
};

/** Decide with `transition` over a started conversation; before its start commits, nothing but a start is decided. */
const whenStarted = (
  state: DelegationState | null,
  transition: (started: DelegationState) => Decided,
): Decided => (state === null ? rejected({ kind: "not_started" }) : transition(state));

/** Every transition of one delegating conversation, from before its start (null). */
export const decideDelegation: Decide<
  DelegationState | null,
  DelegationEvent,
  DelegationRejection,
  EngineRecord,
  DelegationEffect
> = ({ state, event, now }) =>
  match(event)
    .with({ kind: "start_conversation" }, (start) =>
      state === null ? conversationStart(start, now) : rejected({ kind: "already_started" }),
    )
    .with({ kind: "message_submitted" }, (message) =>
      whenStarted(state, (started) => messageSubmitted(started, message, now)),
    )
    .with({ kind: "message_undelivered" }, (undelivered) =>
      whenStarted(state, (started) => messageUndelivered(started, undelivered, now)),
    )
    .with({ kind: "turn_began" }, (began) =>
      whenStarted(state, (started) => turnBegan(started, began, now)),
    )
    .with({ kind: "reply_text" }, (reply) =>
      whenStarted(state, (started) => replyText(started, reply, now)),
    )
    .with({ kind: "turn_ended" }, (ended) =>
      whenStarted(state, (started) => turnEnded(started, ended, now)),
    )
    .with({ kind: "worker_started" }, (worker) =>
      whenStarted(state, (started) => workerStarted(started, worker, now)),
    )
    .with({ kind: "worker_ended" }, (worker) =>
      whenStarted(state, (started) => workerEnded(started, worker, now)),
    )
    .with({ kind: "gate_request" }, (request) =>
      whenStarted(state, (started) => gateRequest(started, request, now)),
    )
    .with({ kind: "approval_decision" }, (decision) =>
      whenStarted(state, (started) => approvalDecision(started, decision, now)),
    )
    .with({ kind: "approval_abandoned" }, (abandoned) =>
      whenStarted(state, (started) => approvalAbandoned(started, abandoned, now)),
    )
    .with({ kind: "tool_result" }, (result) =>
      whenStarted(state, (started) => toolResult(started, result, now)),
    )
    .with({ kind: "stop_all" }, (stop) =>
      whenStarted(state, (started) => stopAll(started, stop, now)),
    )
    .with({ kind: "stop_task" }, (stop) =>
      whenStarted(state, (started) => stopTask(started, stop, now)),
    )
    .with({ kind: "session_ended" }, (ended) =>
      whenStarted(state, (started) => sessionEnded(started, ended, now)),
    )
    .exhaustive();
