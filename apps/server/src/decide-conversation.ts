import { match } from "ts-pattern";
import {
  isManagerTool,
  notPermitted,
  WORKER_AGENT_NAME,
  type GateDecision,
  type HookEvidence,
  type ManagerCall,
  type RuntimeInit,
  type RuntimeKind,
  type TurnSummary,
  type WorkerEnd,
} from "@mia/agent-adapter";
import type { Decide, Decision as MachineDecision } from "@mia/kernel";
import {
  canonicalDigest,
  redactValue,
  type ClientDiagnostics,
  type Decision,
  type Effort,
  type EventPayload,
  type RuntimeCancellation,
  type TaskStatus,
  type ToolCallPolicy,
  type TurnStatus,
} from "@mia/protocol";
import type { ExecutionStatus, NewId } from "@mia/records";
import { buildConversationStart, type StartIds } from "./conversation-start.ts";
import { ConversationDraft, workerLinks, type BuiltTransition } from "./conversation-draft.ts";
import {
  MAX_CALLS_PER_TASK,
  MAX_QUEUED_INPUTS,
  MAX_RUNNING_TASKS,
  MAX_UNSETTLED_CALLS,
  resultTarget,
  taskByRuntimeId,
  type ConversationState,
  type TaskState,
  type UnsettledCall,
} from "./conversation-state.ts";
import type { EngineEffect, Origin } from "./engine-effects.ts";
import type { EngineRecord } from "./engine-records.ts";
import type { McpBody } from "./mcp-bodies.ts";
import type { NamedProvenancePlan } from "./provenance.ts";
import {
  managerEffortLevels,
  recordBodies,
  registerSessionFile,
  registerToolOutput,
  type CapturedOutput,
  type SessionFile,
} from "./recorded-outputs.ts";

// Every transition of a conversation, as its kernel machine's `decide`: pure, from the state, the event and the
// time. Every id comes from the generator the event brings (`Drawn.newId`): the boundary passes randomness in.

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

/** Everything but a start brings the client it is recorded under and the generator its ids come from. */
interface Drawn {
  origin: Origin;
  newId: NewId;
}

/** What the profile asks an execution to run on; what the runtime reports it ran is recorded on the execution. */
export interface Requested {
  runtime: RuntimeKind;
  model: string;
  effort: Effort;
}

export interface MessageEvent extends Drawn {
  kind: "message_submitted";
  text: string;
  clientId: string;
  requested: Requested;
  /** Written by Mia rather than typed by the person, e.g. asking the manager agent to stop a task. */
  fromMia: boolean;
  /** The UUID the message is sent to the runtime under, which it replays when a turn takes the message. */
  runtimeMessageId: string;
}

export interface MessageUndeliveredEvent extends Drawn {
  kind: "message_undelivered";
  runtimeMessageId: string;
}

export interface TurnBeganEvent extends Drawn {
  kind: "turn_began";
  init: RuntimeInit;
}

export interface InputTakenEvent extends Drawn {
  kind: "input_taken";
  runtimeMessageId: string;
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
  requested: Requested;
}

export interface WorkerEndedEvent extends Drawn {
  kind: "worker_ended";
  runtimeTaskId: string;
  end: WorkerEnd;
  /** The runtime's own word for how it ended, recorded as evidence. */
  // eslint-disable-next-line no-restricted-syntax -- the runtime's own word, recorded as reported; `end` is decided on
  runtimeStatus: string;
  summary: string | null;
}

export interface GateRequestEvent extends Drawn {
  kind: "gate_request";
  runtimeCallId: string | undefined;
  toolIdentity: string;
  input: unknown;
  /** The worker agent asking, by the runtime's task id, or null for the manager agent. */
  agentId: string | null;
  /** The manager agent's call, read at the boundary (`readManagerCall`); ignored for a worker agent's call. */
  managerCall: ManagerCall;
  policy: ToolCallPolicy;
  exclusive: boolean;
  /** The held approvals are at their bound: a call that would ask is denied instead (see MAX_HELD_CALLS). */
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
  /** The delegation call whose worker agent received it, or null for one of the manager agent's own calls. */
  parentCallId: string | null;
  isError: boolean;
  content: unknown;
  /** The tool output the result declared, captured and stored at the boundary, or null when it declared none. */
  output: CapturedOutput | null;
  /** The MCP bodies debug mode read for the call, or null when it read none. */
  bodies: readonly McpBody[] | null;
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
  /** The session's transcript as the boundary retained it; null when the runtime wrote none. */
  transcript: SessionFile | null;
  hooks: { file: SessionFile | null; evidence: HookEvidence };
  /** Debug mode's MCP bodies of each released call whose result never arrived, by runtime call id. */
  unresultedBodies: ReadonlyMap<string, readonly McpBody[]>;
}

/**
 * The session ended but its end could not be recorded: memory still lets go of it, records nothing, and so cannot
 * fail, so a later message opens a new session instead of writing to a dead one.
 */
export interface SessionLostEvent {
  kind: "session_lost";
}

export interface ClientDisconnectedEvent extends Drawn {
  kind: "client_disconnected";
  connectionId: string;
}

export interface DiagnosticsReportedEvent extends Drawn {
  kind: "client_diagnostics";
  from: { clientId: string; connectionId: string };
  diagnostics: ClientDiagnostics;
}

export type ConversationEvent =
  | StartEvent
  | MessageEvent
  | MessageUndeliveredEvent
  | TurnBeganEvent
  | InputTakenEvent
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
  | SessionEndedEvent
  | SessionLostEvent
  | ClientDisconnectedEvent
  | DiagnosticsReportedEvent;

export type ConversationRejection =
  | { kind: "not_started" }
  | { kind: "already_started" }
  | { kind: "busy"; queued: number }
  | { kind: "stopping" }
  | { kind: "no_worker_prompt" }
  | { kind: "no_session" }
  | { kind: "not_queued" }
  | { kind: "no_task" }
  | { kind: "duplicate_task" }
  | { kind: "not_owner" }
  | { kind: "not_pending" }
  | { kind: "already_stopping" }
  /** A result of the manager agent's own call that settles nothing: a started delegation's, or TaskStop's. */
  | { kind: "manager_result" };

type Decided = MachineDecision<
  ConversationState,
  ConversationRejection,
  EngineRecord,
  EngineEffect
>;

const rejected = (rejection: ConversationRejection): Decided => ({ kind: "rejected", rejection });

const draftFor = (state: ConversationState, event: Drawn, now: Date): ConversationDraft =>
  new ConversationDraft({ state, now, origin: event.origin, newId: event.newId });

// ---------------------------------------------------------------- conversation and session

const conversationStart = (event: StartEvent, now: Date): BuiltTransition => {
  const draft = new ConversationDraft({
    state: null,
    now,
    origin: event.origin,
    newId: () => {
      throw new Error("a start records only the ids it was given");
    },
  });
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
      pendingNote: null,
      queuedInputs: [],
      endedTasks: [],
      turn: null,
      openingTurn: null,
      pendingDelegations: new Set(),
      unsettledCalls: new Map(),
      tasks: new Map(),
      leases: new Map(),
    }),
  });
  return draft.accepted();
};

/**
 * The person (or Mia) sends the manager agent a message. Work running never refuses it: the session reads it as the
 * input of a coming turn, opened first if none is. Only a full queue, a session being stopped, or a worker prompt that
 * was missing at start refuses it. A Mia note left by an ended session rides on the next message.
 */
const messageSubmitted = (state: ConversationState, event: MessageEvent, now: Date): Decided => {
  if (state.queuedInputs.length >= MAX_QUEUED_INPUTS)
    return rejected({ kind: "busy", queued: state.queuedInputs.length });
  if (state.session?.status === "stopping") return rejected({ kind: "stopping" });
  if (state.workerPrompt === null) return rejected({ kind: "no_worker_prompt" });
  const draft = draftFor(state, event, now);
  let { session, sessionCount } = state;
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
        runtimeIdentity: event.requested.runtime,
        runtimeConversationId: state.runtimeConversationId,
        requestedModel: event.requested.model,
        requestedEffort: event.requested.effort,
        provenanceSetId: state.provenanceSetId,
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
    {
      text: event.text,
      from: event.fromMia ? "mia" : "user",
      client_id: event.clientId,
      runtime_message_id: event.runtimeMessageId,
      // What Mia put before the text, so the record shows all the manager agent read.
      ...(state.pendingNote === null ? {} : { note: state.pendingNote }),
    },
    { id: received, executionId: session.executionId },
  );
  const text = state.pendingNote === null ? event.text : `${state.pendingNote}\n\n${event.text}`;
  draft.advance({
    ...draft.draft,
    session,
    sessionCount,
    pendingNote: null,
    queuedInputs: [
      ...state.queuedInputs,
      { eventId: received, runtimeMessageId: event.runtimeMessageId },
    ],
  });
  draft.effect({ kind: "send_message", text, runtimeMessageId: event.runtimeMessageId });
  return draft.accepted();
};

/** The queued message the session was handed under `runtimeMessageId`, if it is still queued. */
const queuedInput = (state: ConversationState, runtimeMessageId: string) =>
  state.queuedInputs.find((input) => input.runtimeMessageId === runtimeMessageId);

/** The session did not take a recorded message (it had stopped reading): it leaves the queue, recorded as lost. */
const messageUndelivered = (
  state: ConversationState,
  event: MessageUndeliveredEvent,
  now: Date,
): Decided => {
  const queued = queuedInput(state, event.runtimeMessageId);
  if (!queued) return rejected({ kind: "not_queued" });
  const draft = draftFor(state, event, now);
  draft.record(
    "message_undelivered",
    { message_event_id: queued.eventId },
    { id: draft.id("evt"), causedBy: queued.eventId },
  );
  draft.advance({
    ...draft.draft,
    queuedInputs: state.queuedInputs.filter((input) => input !== queued),
  });
  return draft.accepted();
};

/** The runtime began a manager turn (a fresh init, capability record W4); its cause shows with what comes next. */
const turnBegan = (state: ConversationState, event: TurnBeganEvent, now: Date): Decided => {
  if (state.session === null) return rejected({ kind: "no_session" });
  const draft = draftFor(state, event, now);
  if (state.turn !== null)
    finishTurn(draft, { status: "failed", error: "no result before the next turn" });
  draft.advance({
    ...draft.draft,
    openingTurn: { initEvidence: event.init.evidence, model: event.init.model },
  });
  return draft.accepted();
};

/**
 * Record the turn the runtime began, now that its cause shows: a message the runtime replayed makes it the user's;
 * anything else first makes it the report of every task end no turn reported yet. No turn opening: nothing to do.
 */
const openTurn = (
  draft: ConversationDraft,
  cause: { kind: "message"; eventId: string } | { kind: "activity" },
): void => {
  const state = draft.draft;
  const { openingTurn, session } = state;
  if (state.turn !== null || openingTurn === null || session === null) return;
  const turnId = draft.id("turn");
  const [firstEnded] = state.endedTasks;
  const reported = cause.kind === "activity" ? (firstEnded ?? null) : null;
  draft.write({
    kind: "create_turn",
    input: {
      id: turnId,
      conversationId: state.id,
      executionId: session.executionId,
      startedAt: draft.at,
      cause: reported === null ? { kind: "user_input" } : { kind: "task_end", taskId: reported },
    },
  });
  if (!state.sessionStarted)
    draft.write({
      kind: "update_execution",
      id: session.executionId,
      fields: { reportedModel: openingTurn.model },
    });
  draft.record("runtime_init", openingTurn.initEvidence, {
    id: draft.id("evt"),
    executionId: session.executionId,
  });
  draft.emit(
    {
      type: "turn_started",
      payload: {
        conversation_id: state.id,
        turn_id: turnId,
        cause: reported === null ? "user_input" : "task_end",
        ...(reported === null ? {} : { task_id: reported }),
      },
    },
    {
      id: draft.id("evt"),
      executionId: session.executionId,
      causedBy: cause.kind === "message" ? cause.eventId : null,
    },
  );
  if (reported !== null)
    draft.record(
      "turn_reports_tasks",
      { turn_id: turnId, task_ids: state.endedTasks },
      { id: draft.id("evt"), executionId: session.executionId },
    );
  draft.advance({
    ...draft.draft,
    sessionStarted: true,
    openingTurn: null,
    endedTasks: reported === null ? state.endedTasks : [],
    turn: {
      id: turnId,
      cause: reported === null ? "user_input" : "task_end",
      causedByTaskId: reported,
    },
  });
};

/** The runtime replayed a message as a turn took it: it leaves the queue, and a just-begun turn is the user's. */
const inputTaken = (state: ConversationState, event: InputTakenEvent, now: Date): Decided => {
  const queued = queuedInput(state, event.runtimeMessageId);
  if (!queued) return rejected({ kind: "not_queued" });
  const draft = draftFor(state, event, now);
  openTurn(draft, { kind: "message", eventId: queued.eventId });
  draft.record(
    "message_taken",
    { message_event_id: queued.eventId, turn_id: draft.draft.turn?.id ?? null },
    { id: draft.id("evt"), causedBy: queued.eventId },
  );
  draft.advance({
    ...draft.draft,
    queuedInputs: draft.draft.queuedInputs.filter((input) => input !== queued),
  });
  return draft.accepted();
};

/** Record the running turn's end with `outcome`, and tell the client. */
const finishTurn = (
  draft: ConversationDraft,
  outcome: {
    status: Exclude<TurnStatus, "running">;
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
const replyText = (state: ConversationState, event: ReplyEvent, now: Date): Decided => {
  const draft = draftFor(state, event, now);
  openTurn(draft, { kind: "activity" });
  const { turn } = draft.draft;
  if (turn === null) return rejected({ kind: "no_session" });
  draft.emit(
    {
      type: "reply_delta",
      payload: { conversation_id: state.id, turn_id: turn.id, text: event.text },
    },
    { id: draft.id("evt"), executionId: state.session?.executionId ?? null },
  );
  return draft.accepted();
};

/** The manager agent's turn ends with the runtime's result. */
const turnEnded = (state: ConversationState, event: TurnEndedEvent, now: Date): Decided => {
  const draft = draftFor(state, event, now);
  openTurn(draft, { kind: "activity" });
  if (draft.draft.turn === null) return rejected({ kind: "no_session" });
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
const workerStarted = (state: ConversationState, event: WorkerStartedEvent, now: Date): Decided => {
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
        delegation: {
          turnId,
          runtimeTaskId: event.runtimeTaskId,
          delegationCallId: event.delegationCallId,
        },
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
        runtimeIdentity: event.requested.runtime,
        runtimeConversationId: event.runtimeTaskId,
        requestedModel: event.requested.model,
        requestedEffort: event.requested.effort,
        provenanceSetId: state.provenanceSetId,
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
    status: "running",
    gateOpen: state.session.status === "open",
    calls: new Map(),
    pendingApprovals: new Map(),
  };
  const pendingDelegations = new Set(state.pendingDelegations);
  pendingDelegations.delete(event.delegationCallId);
  draft.advance({
    ...draft.draft,
    pendingDelegations,
    tasks: new Map(state.tasks).set(taskId, task),
  });
  return draft.accepted();
};

/** The task status a worker agent's end leaves: interrupted whenever its task was being stopped. */
const endedStatus = (end: WorkerEnd, stopped: boolean): TaskStatus =>
  stopped
    ? "interrupted"
    : match(end)
        .with("completed", (): TaskStatus => "completed")
        .with("failed", (): TaskStatus => "failed")
        .with("stopped", (): TaskStatus => "interrupted")
        .exhaustive();

const EXECUTION_STATUS: Record<TaskStatus, ExecutionStatus> = {
  running: "running",
  awaiting_approval: "running",
  interrupting: "running",
  completed: "completed",
  failed: "failed",
  interrupted: "killed",
  outcome_unknown: "killed",
};

/** Each call of an ended task, with the status its end left it in. */
type EndedCalls = EventPayload<"interruption_outcome">["actions"];

/**
 * End task `task` with `status`. A held call is invalidated and its hook denied. A released call without its result
 * becomes unknown: after a worker agent's end it may still run (capability record W3), so it keeps any exclusive tool
 * it holds and waits for its result among the unsettled calls; after the session's end (`runtimeGone`) no result can
 * come, so its lease is released. An unknown call turns a clean end into outcome_unknown. The client is told with
 * interruption_outcome when the task was stopped, and task_finished otherwise. Returns the task's calls as it left them.
 */
const endTask = (
  draft: ConversationDraft,
  task: TaskState,
  outcome: {
    status: TaskStatus;
    stopped: boolean;
    runtimeGone: boolean;
    cancellation: RuntimeCancellation;
  },
): EndedCalls => {
  let unknown = false;
  const unsettled: [string, UnsettledCall][] = [];
  const actions: EndedCalls = [];
  for (const call of task.calls.values()) {
    if (call.status === "dispatched") {
      unknown = true;
      draft.changeCall(task.id, call.id, {
        status: "unknown",
        detail: outcome.runtimeGone
          ? "the runtime ended before the call's result arrived; it may have run"
          : "its worker agent ended before the call's result arrived; it may still run",
      });
      // Its exclusive-tool lease stays held: the call may still be running (an HTTP call outlives a killed runtime),
      // so no other call may use the tool. Only the call's result releases it.
      if (!outcome.runtimeGone)
        unsettled.push([
          call.runtimeCallId,
          {
            taskId: task.id,
            executionId: task.executionId,
            callId: call.id,
            toolIdentity: call.toolIdentity,
          },
        ]);
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
  if (outcome.stopped)
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
  const unsettledCalls = new Map([...draft.draft.unsettledCalls, ...unsettled]);
  // Beyond the bound the oldest is given up on: its outcome stays unknown, and a lease it holds stays held.
  for (const runtimeCallId of unsettledCalls.keys()) {
    if (unsettledCalls.size <= MAX_UNSETTLED_CALLS) break;
    unsettledCalls.delete(runtimeCallId);
  }
  draft.advance({ ...draft.draft, tasks, unsettledCalls });
  return actions;
};

/**
 * Mia's note on a worker agent's end, or null when every call it made had its result. A worker agent that ends without
 * a call's result can only guess at it (it may say a call it was never let make "has not returned yet"), so the note
 * states Mia's record of each such call, however it came to be without one, and that it overrides the worker agent's
 * account.
 */
const endNoteOf = (calls: EndedCalls): string | null => {
  const outcomes = calls.flatMap(({ tool_identity: tool, status }) => {
    if (status === "invalidated") return [`${tool} did not run`];
    if (status === "unknown") return [`${tool} has an unknown outcome and may still run`];
    return [];
  });
  if (outcomes.length === 0) return null;
  return `[Mia note] Mia's record of the calls this worker agent had no result for, which overrides anything it says about them: ${outcomes.join("; ")}.`;
};

/** The runtime reports a worker agent's end: its task ends, a coming turn reports it, and Mia notes what its calls came to. */
const workerEnded = (state: ConversationState, event: WorkerEndedEvent, now: Date): Decided => {
  const task = taskByRuntimeId(state, event.runtimeTaskId);
  if (!task) return rejected({ kind: "no_task" });
  const draft = draftFor(state, event, now);
  draft.record(
    "worker_ended",
    {
      runtime_task_id: event.runtimeTaskId,
      end: event.end,
      status: event.runtimeStatus,
      summary: event.summary,
    },
    { ...workerLinks(task), id: draft.id("evt") },
  );
  const calls = endTask(draft, task, {
    status: endedStatus(event.end, !task.gateOpen),
    stopped: !task.gateOpen,
    runtimeGone: false,
    cancellation: "not_needed",
  });
  const note = endNoteOf(calls);
  if (note !== null) draft.effect({ kind: "note_end", runtimeTaskId: event.runtimeTaskId, note });
  // Bounded: a turn that reports task ends reports all of them, so only ends no turn has come for yet pile up.
  const endedTasks = [...draft.draft.endedTasks, task.id].slice(-MAX_RUNNING_TASKS);
  draft.advance({ ...draft.draft, endedTasks });
  return draft.accepted();
};

// ---------------------------------------------------------------- the gate

/**
 * Close task `task`'s gate: no call of it is allowed or released from here on, its pending approvals are invalidated
 * and their hooks denied, and the client is told it is being interrupted. The worker agent itself ends when the
 * runtime stops it. A gate already closed is left as it is.
 */
const closeTask = (
  draft: ConversationDraft,
  task: TaskState,
  by: "manager" | "client" | "all",
): void => {
  if (!task.gateOpen) return;
  draft.record(
    "stop_requested",
    { scope: by === "all" ? "all" : "task", by },
    { ...workerLinks(task), id: draft.id("evt") },
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
      payload: { conversation_id: draft.draft.id, task_id: task.id },
    },
    { ...workerLinks(task), id: draft.id("evt") },
  );
};

/**
 * A call of the manager agent, which makes no tool calls itself: it may only start Mia's worker agent in the
 * background, within MAX_RUNNING_TASKS counting delegations not yet started, and stop a running worker agent.
 */
const managerCall = (state: ConversationState, event: GateRequestEvent, now: Date): Decided => {
  const draft = draftFor(state, event, now);
  openTurn(draft, { kind: "activity" });
  const executionId = state.session?.executionId ?? null;
  const answer = (
    decision: GateDecision,
    recorded: "tool_dispatched" | "tool_refused",
    reason?: string,
  ): Decided => {
    draft.record(
      recorded,
      {
        runtime_call_id: event.runtimeCallId ?? null,
        tool_identity: event.toolIdentity,
        agent: "manager",
        ...(reason === undefined ? {} : { reason }),
      },
      { id: draft.id("evt"), executionId },
    );
    draft.effect({ kind: "answer_gate", answer: { kind: "answer", decision } });
    return draft.accepted();
  };
  const refuse = (reason: string) => answer(deny(`Mia: ${reason}`), "tool_refused", reason);
  const allow = () => answer({ behavior: "allow" }, "tool_dispatched");
  return match(event.managerCall)
    .with({ kind: "delegate" }, ({ subagentType, background }) => {
      if (subagentType !== WORKER_AGENT_NAME)
        return refuse(`start only the ${WORKER_AGENT_NAME} worker agent`);
      if (!background)
        return refuse("start worker agents with run_in_background: true, so you never wait on one");
      if (state.session?.status !== "open") return refuse("every task is being stopped");
      if (state.tasks.size + state.pendingDelegations.size >= MAX_RUNNING_TASKS)
        return refuse(`${MAX_RUNNING_TASKS} tasks are already running; wait for one to end`);
      if (event.runtimeCallId !== undefined)
        draft.advance({
          ...draft.draft,
          pendingDelegations: new Set(draft.draft.pendingDelegations).add(event.runtimeCallId),
        });
      return allow();
    })
    .with({ kind: "stop" }, ({ runtimeTaskId }) => {
      const task = runtimeTaskId === null ? undefined : taskByRuntimeId(state, runtimeTaskId);
      if (!task) return refuse("that task is not running");
      closeTask(draft, task, "manager");
      return allow();
    })
    .with({ kind: "other" }, () =>
      refuse("the manager agent makes no tool calls itself; start a worker agent for this"),
    )
    .exhaustive();
};

/** What the gate decides for a worker agent's call, before anything is recorded. */
type CallOutcome =
  | { kind: "deny"; status: "denied" | "blocked_gate"; detail: string; decision: GateDecision }
  | { kind: "allow" }
  | { kind: "ask" };

const callOutcome = (
  state: ConversationState,
  task: TaskState,
  event: GateRequestEvent,
): CallOutcome => {
  if (!task.gateOpen)
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
      decision: notPermitted(event.toolIdentity),
    };
  if (event.exclusive && state.leases.has(event.toolIdentity))
    return {
      kind: "deny",
      status: "denied",
      detail: "an exclusive tool another call is using",
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

/** Release call `call` of task `task`, taking its exclusive tool's lease when it has one. */
const dispatch = (
  draft: ConversationDraft,
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
 * never guessed (the engine first waits a bounded time for the runtime to report the worker agent's start); a worker
 * agent cannot start or stop worker agents; otherwise policy, the task's gate, the exclusive tools and the held
 * approvals' bound decide, and the call's record says how.
 */
const workerCall = (
  state: ConversationState,
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
  if (isManagerTool(event.toolIdentity))
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
            tool_identity: event.toolIdentity,
            intended_action: `${event.toolIdentity} ${JSON.stringify(redacted)}`.slice(0, 500),
            redacted_arguments: redacted,
            argument_digest: digest,
            explainable: true,
          },
        },
        { ...workerLinks(task), id: requested, causedBy: proposed },
      );
      // After approval_requested, whose event the approval names as the one that asked for it.
      draft.write({
        kind: "create_approval",
        input: {
          id: approvalId,
          requestedAt: draft.at,
          toolCallId: callId,
          requestingEventId: requested,
        },
      });
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
const gateRequest = (state: ConversationState, event: GateRequestEvent, now: Date): Decided => {
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
 * The owner decides a pending approval. Approving releases the call only while its task's gate is open and, for an
 * exclusive tool, no other call holds it; anything else denies it with the reason. Either way the
 * held hook gets its answer.
 */
const approvalDecision = (
  state: ConversationState,
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
  let decision: GateDecision;
  if (!approve) {
    draft.changeCall(task.id, call.id, { status: "denied", detail: "rejected by user" });
    decision = REJECTED_BY_USER;
  } else if (!task.gateOpen) {
    draft.changeCall(task.id, call.id, {
      status: "blocked_gate",
      detail: "approved after its task was stopped",
    });
    decision = STOPPED;
  } else if (event.exclusive && state.leases.has(call.toolIdentity)) {
    draft.changeCall(task.id, call.id, {
      status: "denied",
      detail: "an exclusive tool another call is using",
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
  state: ConversationState,
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

/**
 * A call returned. A worker agent's released call completes or fails, with its declared output and MCP bodies, and
 * frees its exclusive tool; a call of an ended task settles from unknown the same way. A manager agent's result
 * frees its delegation's place, recorded as unstarted when it failed. Anything else is recorded unmatched.
 */
const toolResult = (state: ConversationState, event: ToolResultEvent, now: Date): Decided => {
  const draft = draftFor(state, event, now);
  if (event.parentCallId === null) {
    if (!state.pendingDelegations.has(event.runtimeCallId))
      return rejected({ kind: "manager_result" });
    const pendingDelegations = new Set(state.pendingDelegations);
    pendingDelegations.delete(event.runtimeCallId);
    // A launch's result can precede the report of the worker agent it started: only a failed one is unstarted.
    if (!event.isError) {
      draft.advance({ ...draft.draft, pendingDelegations });
      return draft.accepted();
    }
    draft.record(
      "delegation_unstarted",
      { delegation_call_id: event.runtimeCallId, is_error: event.isError },
      { id: draft.id("evt"), executionId: state.session?.executionId ?? null },
    );
    draft.advance({ ...draft.draft, pendingDelegations });
    return draft.accepted();
  }
  const target = resultTarget(state, event.runtimeCallId);
  if (target === null) {
    draft.record(
      "tool_result_unmatched",
      { runtime_call_id: event.runtimeCallId, is_error: event.isError },
      { id: draft.id("evt") },
    );
    return draft.accepted();
  }
  const links =
    target.kind === "running"
      ? workerLinks(target.task)
      : { taskId: target.call.taskId, executionId: target.call.executionId };
  const callId = target.kind === "running" ? target.callId : target.call.callId;
  const toolIdentity = target.kind === "running" ? target.toolIdentity : target.call.toolIdentity;
  const recorded = draft.id("evt");
  draft.record(
    "tool_result",
    {
      tool_call_id: callId,
      runtime_call_id: event.runtimeCallId,
      is_error: event.isError,
      content: event.content,
    },
    { ...links, id: recorded },
  );
  if (target.kind === "unsettled" || target.released) {
    const status = event.isError ? "failed" : "completed";
    draft.write({
      kind: "update_tool_call",
      id: callId,
      fields: { updatedAt: draft.at, resultEventId: recorded },
    });
    if (target.kind === "running") draft.changeCall(target.task.id, callId, { status });
    else
      draft.write({
        kind: "update_tool_call",
        id: callId,
        fields: {
          updatedAt: draft.at,
          status,
          detail: "its result arrived after its worker agent ended",
        },
      });
    if (event.output)
      registerToolOutput(draft, { output: event.output, links, callId, resultEventId: recorded });
    recordBodies(draft, {
      bodies: event.bodies ?? [],
      call: { id: callId, runtimeCallId: event.runtimeCallId },
      links: { ...links, causedBy: recorded },
    });
  }
  if (state.leases.get(toolIdentity)?.callId === callId)
    draft.releaseLease(toolIdentity, draft.id("evt"));
  if (target.kind === "unsettled") {
    const unsettledCalls = new Map(draft.draft.unsettledCalls);
    unsettledCalls.delete(event.runtimeCallId);
    draft.advance({ ...draft.draft, unsettledCalls });
  }
  return draft.accepted();
};

/**
 * The interrupt control, or shutdown, stops every task through the engine: every task's gate closes and its approvals
 * are invalidated, the session is marked stopping (so a worker agent it still starts starts closed, and no message is
 * taken), and the session is killed. What the kill leaves is recorded when the runtime's exit is (`sessionEnded`).
 */
const stopAll = (state: ConversationState, event: StopAllEvent, now: Date): Decided => {
  if (state.session === null) return rejected({ kind: "no_session" });
  if (state.session.status === "stopping") return rejected({ kind: "already_stopping" });
  const draft = draftFor(state, event, now);
  draft.record(
    "stop_requested",
    { scope: "all", by: event.by, tasks: [...state.tasks.keys()] },
    { id: draft.id("evt"), executionId: state.session.executionId },
  );
  for (const task of state.tasks.values()) closeTask(draft, task, "all");
  draft.advance({
    ...draft.draft,
    session: { ...state.session, status: "stopping" },
  });
  draft.effect({ kind: "stop_session" });
  return draft.accepted();
};

/**
 * The person stops one task: its gate closes at once, so nothing more of it runs whatever the manager agent does; the
 * engine then asks the manager agent to stop its worker agent, as a message of its own.
 */
const stopTask = (state: ConversationState, event: StopTaskEvent, now: Date): Decided => {
  const task = state.tasks.get(event.taskId);
  if (!task) return rejected({ kind: "no_task" });
  if (!task.gateOpen) return rejected({ kind: "already_stopping" });
  const draft = draftFor(state, event, now);
  closeTask(draft, task, "client");
  return draft.accepted();
};

/** The note the next message carries after a session ended with work the manager agent did not see finish. */
const noteAfterSession = (input: {
  ended: readonly TaskState[];
  unsettled: readonly UnsettledCall[];
  lost: number;
}): string | null => {
  const unknownCalls = [
    ...input.ended.flatMap((task) =>
      [...task.calls.values()]
        .filter((call) => call.status === "dispatched")
        .map((call) => call.toolIdentity),
    ),
    ...input.unsettled.map((call) => call.toolIdentity),
  ];
  if (input.ended.length === 0 && unknownCalls.length === 0 && input.lost === 0) return null;
  const parts = ["[Mia note] Your previous session ended."];
  if (input.ended.length > 0) parts.push(`${input.ended.length} task(s) did not finish.`);
  if (unknownCalls.length > 0)
    parts.push(
      `These calls were running and their outcome is unknown: ${unknownCalls.join(", ")}. Do not assume they did or did not happen.`,
    );
  if (input.lost > 0) parts.push(`${input.lost} message(s) sent to you were never read.`);
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
 * The session's runtime exited. The manager agent's execution ends with its effort evidence; its transcript and hook
 * evidence are registered; its running turn ends; every task still running ends (interrupted after a stop, failed
 * otherwise), each released call unknown and its exclusive tool released, since no result can come now; messages no
 * turn took are recorded undelivered; and a note for the next message says what was left unseen.
 */
const sessionEnded = (state: ConversationState, event: SessionEndedEvent, now: Date): Decided => {
  const { session } = state;
  if (session === null) return rejected({ kind: "no_session" });
  const draft = draftFor(state, event, now);
  const stopped = session.status === "stopping" || event.status === "killed";
  draft.record(
    "runtime_exit",
    { status: event.status, error: event.error, runtime_cancellation: event.runtimeCancellation },
    { id: draft.id("evt"), executionId: session.executionId },
  );
  for (const [file, kind] of [
    [event.transcript, "runtime_transcript"],
    [event.hooks.file, "effort_evidence"],
  ] as const)
    if (file) registerSessionFile(draft, { file, kind, executionId: session.executionId });
  const efforts = managerEffortLevels(event.hooks.evidence);
  draft.write({
    kind: "update_execution",
    id: session.executionId,
    fields: {
      status: sessionExecutionStatus(stopped, event.status),
      endedAt: draft.at,
      reportedEffort: efforts.length === 1 ? (efforts[0] ?? null) : null,
      effortEvidence: {
        source: "PreToolUse hook",
        values: efforts,
        samples: event.hooks.evidence.records.length,
        malformed_lines: event.hooks.evidence.malformedLines,
        read_error: event.hooks.evidence.readError,
      },
    },
  });
  if (state.turn !== null)
    finishTurn(draft, {
      status: stopped ? "interrupted" : "failed",
      error: stopped ? "every task was stopped" : (event.error ?? "the session ended mid-turn"),
    });
  const ended = [...state.tasks.values()];
  for (const task of ended) {
    for (const call of task.calls.values())
      recordBodies(draft, {
        bodies: event.unresultedBodies.get(call.runtimeCallId) ?? [],
        call,
        links: workerLinks(task),
      });
    endTask(draft, task, {
      status: stopped ? "interrupted" : "failed",
      stopped,
      runtimeGone: true,
      cancellation: event.runtimeCancellation,
    });
  }
  const unsettled = [...state.unsettledCalls.values()];
  for (const call of unsettled)
    if (draft.draft.leases.get(call.toolIdentity)?.callId === call.callId)
      draft.releaseLease(call.toolIdentity, draft.id("evt"));
  for (const queued of state.queuedInputs)
    draft.record(
      "message_undelivered",
      { message_event_id: queued.eventId },
      { id: draft.id("evt"), causedBy: queued.eventId },
    );
  draft.advance({
    ...draft.draft,
    session: null,
    turn: null,
    openingTurn: null,
    queuedInputs: [],
    endedTasks: [],
    pendingDelegations: new Set(),
    unsettledCalls: new Map(),
    pendingNote: noteAfterSession({ ended, unsettled, lost: state.queuedInputs.length }),
  });
  return draft.accepted();
};

/** A session whose end could not be recorded: memory lets go of it (see `SessionLostEvent`). */
const sessionLost = (state: ConversationState): Decided =>
  state.session === null
    ? rejected({ kind: "no_session" })
    : {
        kind: "accepted",
        next: {
          ...state,
          session: null,
          turn: null,
          openingTurn: null,
          queuedInputs: [],
          endedTasks: [],
          pendingDelegations: new Set(),
          tasks: new Map(),
          // Kept: their records are unreleased, and the calls holding them may still run.
          unsettledCalls: new Map(),
          pendingNote: "[Mia note] Your previous session ended and Mia could not record how.",
        },
        records: [],
        effects: [],
      };

/** The conversation's client connection closed: recorded, and nothing else changes (disconnection is not consent). */
const clientDisconnected = (
  state: ConversationState,
  event: ClientDisconnectedEvent,
  now: Date,
): Decided => {
  const draft = draftFor(state, event, now);
  draft.record(
    "client_disconnected",
    {
      connection_id: event.connectionId,
      pending_approvals: [...state.tasks.values()].flatMap((task) => [
        ...task.pendingApprovals.keys(),
      ]),
    },
    { id: draft.id("evt") },
  );
  return draft.accepted();
};

/** A client's diagnostics about this conversation: its row and the event naming it. */
const diagnosticsReported = (
  state: ConversationState,
  event: DiagnosticsReportedEvent,
  now: Date,
): Decided => {
  const draft = draftFor(state, event, now);
  const eventId = draft.id("evt");
  draft.record(
    "client_diagnostics",
    {
      client_id: event.from.clientId,
      captured_at: event.diagnostics.captured_at,
      connection_state: event.diagnostics.connection_state,
    },
    { id: eventId },
  );
  draft.write({
    kind: "record_diagnostics",
    input: {
      id: draft.id("diag"),
      receivedAt: draft.at,
      conversationId: state.id,
      clientId: event.from.clientId,
      clientConnectionId: event.from.connectionId,
      eventId,
      capturedAt: event.diagnostics.captured_at,
      state: event.diagnostics,
    },
  });
  return draft.accepted();
};

/** Decide with `transition` over a started conversation; before its start commits, nothing but a start is decided. */
const whenStarted = (
  state: ConversationState | null,
  transition: (started: ConversationState) => Decided,
): Decided => (state === null ? rejected({ kind: "not_started" }) : transition(state));

/** Every transition of one conversation, from before its start (null). */
export const decideConversation: Decide<
  ConversationState | null,
  ConversationEvent,
  ConversationRejection,
  EngineRecord,
  EngineEffect
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
    .with({ kind: "input_taken" }, (taken) =>
      whenStarted(state, (started) => inputTaken(started, taken, now)),
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
    .with({ kind: "session_lost" }, () => whenStarted(state, sessionLost))
    .with({ kind: "client_disconnected" }, (disconnected) =>
      whenStarted(state, (started) => clientDisconnected(started, disconnected, now)),
    )
    .with({ kind: "client_diagnostics" }, (reported) =>
      whenStarted(state, (started) => diagnosticsReported(started, reported, now)),
    )
    .exhaustive();
