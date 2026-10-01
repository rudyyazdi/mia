import type { TaskStatus, ToolCallPolicy, ToolCallStatus, TurnCause } from "@mia/protocol";

/**
 * What the engine holds in memory about the active conversation, as one immutable value: its manager agent's
 * session, the turn that session is running, the input and task ends waiting for turns, and every running task with
 * its calls, approvals and exclusive-tool leases. Memory follows the records: a transition builds the next value
 * beside its records, and the conversation's kernel machine replaces the whole value only once they commit, so
 * nothing here is ever mutated. The runtime session itself (its process, the gate's held calls) is a resource the
 * engine owns, not state.
 */
export interface ConversationState {
  readonly id: string;
  readonly runtimeConversationId: string;
  readonly provenanceSetId: string;
  readonly directory: string;
  /** The retained manager-agent prompt object every session appends; null when it was missing at start. */
  readonly managerPromptFile: string | null;
  /**
   * The worker agent's instructions, the bytes of the retained prompt object as text: the runtime takes a subagent's
   * prompt as text. Null when the prompt was missing at start, and then no session can open.
   */
  readonly workerPrompt: string | null;
  /** Sessions opened so far; the next one takes this number plus one for its files. */
  readonly sessionCount: number;
  /** A session has started the runtime's conversation, so the next session resumes it instead of creating it. */
  readonly sessionStarted: boolean;
  /** The manager agent's running session, or null while none is open. */
  readonly session: SessionState | null;
  /** A Mia note carried into the next message after a stop left outcomes the manager agent did not see. */
  readonly pendingNote: string | null;
  /**
   * The recorded messages sent to the session that no turn has taken yet, oldest first (MAX_QUEUED_INPUTS). The
   * runtime replays each one a turn takes (`input_taken`), which removes it, however many a turn takes.
   */
  readonly queuedInputs: readonly QueuedInput[];
  /**
   * The tasks whose end no turn has reported yet, oldest first (MAX_RUNNING_TASKS: a turn that reports task ends
   * reports all of them, and an end beyond the bound drops the oldest unreported one).
   */
  readonly endedTasks: readonly string[];
  /**
   * The turn the session is running, or null between turns. A turn begins at the runtime's init but is recorded only
   * once its cause shows: a replayed message makes it the user's, anything else first makes it a report of task ends.
   */
  readonly turn: TurnState | null;
  /** The runtime began a turn whose cause has not shown yet: its init's evidence, to record with the turn. */
  readonly openingTurn: { readonly initEvidence: unknown; readonly model: string } | null;
  /**
   * The delegations the gate allowed whose worker agent the runtime has not reported starting yet, by delegation call
   * id: they count against MAX_RUNNING_TASKS, so parallel delegations cannot exceed it.
   */
  readonly pendingDelegations: ReadonlySet<string>;
  /**
   * The released calls of tasks that ended before their result arrived, by runtime call id (MAX_UNSETTLED_CALLS):
   * a late result still settles them and frees the exclusive tool they hold.
   */
  readonly unsettledCalls: ReadonlyMap<string, UnsettledCall>;
  /** Every running task by id, in the order they started (see MAX_RUNNING_TASKS). */
  readonly tasks: ReadonlyMap<string, TaskState>;
  /** The exclusive tools held, by tool identity: the lease and the call holding it. */
  readonly leases: ReadonlyMap<string, LeaseState>;
}

export interface QueuedInput {
  /** The message_received event that recorded the message. */
  readonly eventId: string;
  /** The UUID the message was sent to the runtime under, which it replays when a turn takes the message. */
  readonly runtimeMessageId: string;
}

/** A released call whose task ended before its result arrived. */
export interface UnsettledCall {
  readonly taskId: string;
  readonly executionId: string;
  readonly callId: string;
  readonly toolIdentity: string;
}

export interface SessionState {
  /** The manager agent's execution this session runs as. */
  readonly executionId: string;
  /** `open` until a stop of every task asks the session to end; its end is recorded when the runtime exits. */
  readonly status: "open" | "stopping";
}

export interface TurnState {
  readonly id: string;
  readonly cause: TurnCause;
  /** The first task whose end this turn reports; null for a turn started by user input. */
  readonly causedByTaskId: string | null;
}

export interface TaskState {
  readonly id: string;
  /** The worker agent's execution. */
  readonly executionId: string;
  /** The runtime's id for the worker agent: the gate hook's `agent_id` for its calls. */
  readonly runtimeTaskId: string;
  readonly delegationCallId: string;
  readonly turnId: string | null;
  readonly status: TaskStatus;
  /** Closed by a stop of this task or of every task: no call of this task is allowed or released from then on. */
  readonly gateOpen: boolean;
  /** Every call the worker agent asked the gate about, by tool call id, in the order it asked (MAX_CALLS_PER_TASK). */
  readonly calls: ReadonlyMap<string, CallState>;
  /** The id of the call each pending approval holds, keyed by approval id, in the order they were requested. */
  readonly pendingApprovals: ReadonlyMap<string, string>;
}

export interface CallState {
  readonly id: string;
  readonly runtimeCallId: string;
  readonly toolIdentity: string;
  readonly digest: string;
  readonly redactedArguments: unknown;
  readonly policy: ToolCallPolicy;
  readonly status: ToolCallStatus;
  readonly approvalId: string | null;
}

export interface LeaseState {
  readonly id: string;
  readonly taskId: string;
  readonly callId: string;
}

/**
 * How many tasks may run at once. A delegation beyond it is refused at the gate, so the runtime never starts a worker
 * agent Mia would not hold a task for; far above what one conversation runs in parallel.
 */
export const MAX_RUNNING_TASKS = 16;

/**
 * How many messages may wait for a turn at once. A message beyond it is refused as busy: the session reads one turn
 * at a time, and a longer queue would only hold input the person cannot see being worked on.
 */
export const MAX_QUEUED_INPUTS = 16;

/** How many calls one task may ask about; a call beyond it is denied, which bounds a worker agent that keeps asking. */
export const MAX_CALLS_PER_TASK = 256;

/**
 * How many released calls of ended tasks may wait for their result at once. Beyond it the oldest is given up on: its
 * outcome stays unknown, and an exclusive tool it held stays leased for the conversation, as the call may still run.
 */
export const MAX_UNSETTLED_CALLS = 64;

/** The task a worker agent's runtime id names, if it is running. */
export const taskByRuntimeId = (
  state: ConversationState,
  runtimeTaskId: string,
): TaskState | undefined =>
  state.tasks.values().find((task) => task.runtimeTaskId === runtimeTaskId);

/** The running task holding call `runtimeCallId`, and the call. */
export const callByRuntimeId = (
  state: ConversationState,
  runtimeCallId: string,
): { task: TaskState; call: CallState } | undefined => {
  for (const task of state.tasks.values())
    for (const call of task.calls.values())
      if (call.runtimeCallId === runtimeCallId) return { task, call };
  return undefined;
};

/** The state with task `taskId` replaced by `update` of it; a task the state lacks is a bug, and throws. */
export const withTask = (
  state: ConversationState,
  taskId: string,
  update: (task: TaskState) => TaskState,
): ConversationState => {
  const task = state.tasks.get(taskId);
  if (!task) throw new Error(`task ${taskId} is not running`);
  return { ...state, tasks: new Map(state.tasks).set(taskId, update(task)) };
};

/** The task with call `callId` changed by `fields`; a call the task lacks is a bug, and throws. */
export const withCall = (
  task: TaskState,
  callId: string,
  fields: Partial<Pick<CallState, "status" | "approvalId">>,
): TaskState => {
  const call = task.calls.get(callId);
  if (!call) throw new Error(`call ${callId} is not a call of task ${task.id}`);
  return { ...task, calls: new Map(task.calls).set(callId, { ...call, ...fields }) };
};
