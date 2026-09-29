import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { match } from "ts-pattern";
import {
  policyFor,
  type GateDecision,
  type GateHandler,
  type GateRequest,
  type Profile,
  type RuntimeFileReader,
  type SessionEvent,
  type SessionHandle,
  type SessionOptions,
} from "@mia/agent-adapter";
import { createKernel, Holds, type Dispatched, type FeedLimits, type Machine } from "@mia/kernel";
import {
  errorMessage,
  type ClientCommand,
  type ClientDiagnostics,
  type Decision,
  type ErrorCode,
} from "@mia/protocol";
import type { Catalog, NewId, RecordWriter } from "@mia/records";
import { ClientOwnership, recordHeartbeat, type Delivery } from "./client-ownership.ts";
import {
  decideDelegation,
  type DelegationEvent,
  type DelegationRejection,
} from "./decide-delegation.ts";
import type { DelegationEffect, GateAnswer } from "./delegation-effects.ts";
import type { DelegationState } from "./delegation-state.ts";
import type { CommandContext, CommandResult } from "./engine.ts";
import {
  commitEvents,
  committedEvents,
  eventSequence,
  type EventChange,
} from "./engine-records.ts";
import {
  MAX_CONVERSATION_FILE_BYTES,
  agentPromptObject,
  nameProvenance,
  prepareConversationProvenance,
  workerPromptObject,
  type ServerIdentity,
} from "./provenance.ts";

/** What the D2 engine needs to run a manager agent's session: the real `ClaudeCodeSessions` or a test's own. */
export interface SessionRunner {
  open(options: SessionOptions): SessionHandle;
}

/** The tool gate the session's hook asks (`ToolGate`, or a test's own): the engine decides every call through it. */
export interface GateHost {
  readonly url: string;
  setHandler(handler: GateHandler | null): void;
}

export interface DelegationEngineDeps {
  profile: Profile;
  catalog: Catalog;
  writer: RecordWriter;
  sessions: SessionRunner;
  gate: GateHost;
  identity: ServerIdentity;
  /** A fresh deadline for a conversation start's reads and stores (see `EngineDeps.evidenceReadDeadline`). */
  evidenceReadDeadline: () => AbortSignal;
  readEvidence: RuntimeFileReader;
  /** Injected randomness: the ids every transition records, drawn before it is decided. */
  newId: NewId;
  now: () => Date;
  debugMode: boolean;
  log: (message: string) => void;
}

/**
 * How many held calls the gate keeps open at once, across tasks, waiting for the user's decision. A call that would
 * ask beyond it is denied without asking, so no approval is recorded that cannot be held.
 */
export const MAX_HELD_CALLS = 32;

/** As in D1: a few readers of one conversation at once, each a page behind at most. */
const FEED_LIMITS: FeedLimits = { subscribers: 8, buffered: 256 };

/**
 * How many ids a transition may draw. Generous and fixed: the transitions that record the most (a session's end, a
 * stop of every task) record a few events per task and call, far below this for MAX_RUNNING_TASKS tasks.
 */
const IDS_PER_TRANSITION = 64;

const fail = (code: ErrorCode, message: string): CommandResult => ({ ok: false, code, message });

const NOT_RECORDED: GateDecision = {
  behavior: "deny",
  message: "Mia could not record this call; it was not run.",
};
const NO_CONVERSATION: GateDecision = {
  behavior: "deny",
  message: "Mia has no conversation for this call; it was not run.",
};
const ABANDONED: GateDecision = {
  behavior: "deny",
  message: "Mia: the call was dropped before the user decided; it was not run.",
};

type DelegationMachine = Machine<
  DelegationState | null,
  DelegationEvent,
  DelegationRejection,
  EventChange
>;

/** The runtime session the active conversation runs, a resource the engine owns (see `DelegationState`). */
interface OpenSession {
  handle: SessionHandle;
  /** Settles once the session's end has been recorded (or failed to be). */
  ended: Promise<void>;
}

/** A gate request being dispatched, and the answer its `answer_gate` effect gave once performed. */
interface Asking {
  abandoned: AbortSignal;
  answer: Promise<GateDecision> | null;
}

/**
 * The D2 engine: one delegating conversation at a time, whose manager agent never blocks. It owns the conversation's
 * kernel machine (the rules are ./decide-delegation.ts), the manager agent's runtime session, and the gate's held
 * calls. Every change goes through a dispatch that decides, commits the records, moves the state on and then performs
 * the effects, as D1's engine does; the runtime's reports and the gate's requests arrive as events of their own.
 */
export class DelegationEngine {
  readonly clients = new ClientOwnership();
  private machine: DelegationMachine | null = null;
  private session: OpenSession | null = null;
  private shuttingDown = false;
  /** Aborted by shutdown, so a conversation start still reading its files is refused. */
  private readonly stopping = new AbortController();
  /** One conversation start at a time awaits its reads and stores. */
  private starting = false;
  private readonly held = new Holds<GateDecision>(MAX_HELD_CALLS);
  private asking: Asking | null = null;

  constructor(private readonly deps: DelegationEngineDeps) {
    deps.gate.setHandler((request) => this.decideGate(request));
  }

  /** The active conversation's state as it is now; null before the first start. */
  get conversation(): DelegationState | null {
    return this.machine?.state ?? null;
  }

  private get origin() {
    return this.clients.origin;
  }

  /** `count` fresh id suffixes for one transition (see `DelegationDraft.id`). */
  private drawIds(count = IDS_PER_TRANSITION): string[] {
    return Array.from({ length: count }, () => this.deps.newId("evt").replace(/^evt_/, ""));
  }

  // ---------------------------------------------------------------- event plumbing

  private openConversation(conversationId: string): DelegationMachine {
    const kernel = createKernel<
      Parameters<typeof commitEvents>[1][number],
      EventChange,
      DelegationEffect
    >({
      commit: (records) => commitEvents(this.deps.writer, records),
      perform: (effect, changes) => this.perform(effect, { machine, conversationId, changes }),
      reportEffectFailure: (error) =>
        this.deps.log(`delivery failed after commit; records stand: ${errorMessage(error)}`),
      replay: committedEvents(this.deps.catalog, conversationId),
      now: () => this.deps.now(),
      limits: FEED_LIMITS,
    });
    const machine: DelegationMachine = kernel.machine(decideDelegation, null);
    return machine;
  }

  private dispatch(event: DelegationEvent): Dispatched<DelegationRejection, EventChange> {
    if (!this.machine) throw new Error("engine has no active conversation");
    return this.machine.dispatch(event);
  }

  /** Dispatch a runtime report: nothing waits on it, so a refusal or a failed commit is logged. */
  private report(event: DelegationEvent): void {
    try {
      const dispatched = this.dispatch(event);
      if (dispatched.kind === "rejected")
        this.deps.log(`${event.kind} not applied: ${dispatched.rejection.kind}`);
      if (dispatched.kind === "failed")
        this.deps.log(`${event.kind} not recorded: ${errorMessage(dispatched.error)}`);
    } catch (error) {
      this.deps.log(`${event.kind} failed: ${errorMessage(error)}`);
    }
  }

  private perform(
    effect: DelegationEffect,
    committed: {
      machine: DelegationMachine;
      conversationId: string;
      changes: readonly EventChange[];
    },
  ): void {
    const { machine, conversationId, changes } = committed;
    const serverTime = this.deps.now().toISOString();
    match(effect)
      .with({ kind: "activate_conversation" }, ({ origin }) => {
        this.machine = machine;
        this.clients.activate(origin);
      })
      .with({ kind: "deliver_event" }, ({ eventId, event }) =>
        this.clients.deliver(event, {
          id: eventId,
          conversationId,
          sequence: eventSequence(changes, eventId),
          serverTime,
        }),
      )
      .with({ kind: "notify_tool_call" }, ({ payload }) =>
        this.clients.deliver(
          { type: "tool_call", payload },
          { id: this.deps.newId("evt"), conversationId, sequence: null, serverTime },
        ),
      )
      .with({ kind: "open_session" }, ({ session }) => this.openSession(machine, session))
      .with({ kind: "send_message" }, ({ text, eventId }) => {
        if (this.session?.handle.send(text) === true) return;
        // Recorded as a transition of its own, once this dispatch has returned: an effect may not dispatch.
        queueMicrotask(() =>
          this.report({
            kind: "message_undelivered",
            origin: this.origin,
            ids: this.drawIds(),
            eventId,
          }),
        );
      })
      .with({ kind: "stop_session" }, () => {
        this.session?.handle
          .stop()
          .catch((error: unknown) => this.deps.log(`stop failed: ${errorMessage(error)}`));
      })
      .with({ kind: "answer_gate" }, ({ answer }) => {
        const asking = this.asking;
        if (!asking) throw new Error("no gate request is being dispatched");
        if (asking.answer) throw new Error("a gate request is answered once");
        asking.answer = this.takeAnswer(asking, answer);
      })
      .with({ kind: "answer_held" }, ({ approvalId, decision }) => {
        this.held.reply(approvalId, decision);
      })
      .exhaustive();
  }

  /** Open the manager agent's session for the conversation `machine` runs. */
  private openSession(
    machine: DelegationMachine,
    start: { executionId: string; sessionIndex: number; resume: boolean },
  ): void {
    const conversation = machine.state;
    const workerPrompt = conversation?.workerPrompt ?? null;
    if (!conversation || workerPrompt === null)
      throw new Error("a session opens only for a started conversation with a worker prompt");
    const { profile } = this.deps;
    const handle = this.deps.sessions.open({
      runtimeConversationId: conversation.runtimeConversationId,
      resume: start.resume,
      runtimeDir: join(conversation.directory, "runtime"),
      sessionIndex: start.sessionIndex,
      managerPromptFile: conversation.managerPromptFile,
      workerPrompt,
      gateUrl: this.deps.gate.url,
      onEvent: async (event) => this.onSessionEvent(event),
    });
    const ended = handle.result.then(
      (result) =>
        this.report({
          kind: "session_ended",
          origin: this.origin,
          ids: this.drawIds(),
          status: result.status,
          error: result.error,
          runtimeCancellation: result.status === "killed" ? "forced_kill" : "not_needed",
        }),
      (error: unknown) => this.deps.log(`session failed: ${errorMessage(error)}`),
    );
    const open: OpenSession = {
      handle,
      ended: ended.finally(() => {
        if (this.session === open) this.session = null;
      }),
    };
    this.session = open;
    this.deps.log(
      `session ${start.sessionIndex} opened (model ${profile.runtime.model}, effort ${profile.runtime.effort})`,
    );
  }

  /** One report of the manager agent's session, dispatched as the event it is. */
  private async onSessionEvent(event: SessionEvent): Promise<void> {
    if (!this.conversation) return;
    const base = { origin: this.origin, ids: this.drawIds() };
    const { runtime } = this.deps.profile;
    match(event)
      .with({ type: "runtime_init" }, ({ init }) =>
        this.report({ ...base, kind: "turn_began", init }),
      )
      .with({ type: "text_delta" }, ({ text, parentCallId }) => {
        // A worker agent's own text is its task's working, not the reply.
        if (parentCallId === null) this.report({ ...base, kind: "reply_text", text });
      })
      .with({ type: "turn_result" }, ({ summary }) =>
        this.report({ ...base, kind: "turn_ended", summary }),
      )
      .with({ type: "tool_result" }, ({ runtimeCallId, parentCallId, isError, content }) => {
        // The manager agent's own results are its delegations' and stops' acknowledgements.
        if (parentCallId !== null)
          this.report({ ...base, kind: "tool_result", runtimeCallId, isError, content });
      })
      .with({ type: "worker_started" }, (started) =>
        this.report({
          ...base,
          kind: "worker_started",
          runtimeTaskId: started.runtimeTaskId,
          delegationCallId: started.delegationCallId,
          description: started.description,
          clientId: this.clients.clientId,
          requested: { model: runtime.model, effort: runtime.effort },
        }),
      )
      .with({ type: "worker_ended" }, (ended) =>
        this.report({
          ...base,
          kind: "worker_ended",
          runtimeTaskId: ended.runtimeTaskId,
          status: ended.status,
          summary: ended.summary,
        }),
      )
      .with({ type: "runtime_stderr" }, ({ text }) => this.deps.log(`runtime: ${text.trim()}`))
      .with({ type: "malformed_event" }, ({ error }) =>
        this.deps.log(`malformed runtime output: ${error}`),
      )
      .with(
        { type: "runtime_started" },
        { type: "tool_proposed" },
        { type: "assistant_message" },
        { type: "runtime_exit" },
        () => undefined,
      )
      .exhaustive();
  }

  // ---------------------------------------------------------------- the gate

  /**
   * Decide one call the runtime is about to make, from the manager agent or a worker agent. The answer comes from
   * the committed transition's `answer_gate` effect; a request whose records did not commit is denied.
   */
  private async decideGate(request: GateRequest): Promise<GateDecision> {
    if (!this.conversation || this.shuttingDown) return NO_CONVERSATION;
    const { runtime } = this.deps.profile;
    const asking: Asking = { abandoned: request.abandoned, answer: null };
    const previous = this.asking;
    this.asking = asking;
    let dispatched: Dispatched<DelegationRejection, EventChange>;
    try {
      dispatched = this.dispatch({
        kind: "gate_request",
        origin: this.origin,
        ids: this.drawIds(),
        runtimeCallId: request.toolUseId,
        toolIdentity: request.toolName,
        input: request.input,
        agentId: request.agentId,
        policy: policyFor(runtime, request.toolName),
        exclusive: runtime.exclusiveTools.includes(request.toolName),
        heldFull: this.held.full,
      });
    } catch (error) {
      this.deps.log(`gate request failed: ${errorMessage(error)}`);
      return NOT_RECORDED;
    } finally {
      this.asking = previous;
    }
    if (dispatched.kind !== "committed") return NOT_RECORDED;
    return asking.answer ?? NOT_RECORDED;
  }

  private takeAnswer(asking: Asking, answer: GateAnswer): Promise<GateDecision> {
    return match(answer)
      .with({ kind: "answer" }, ({ decision }) => Promise.resolve(decision))
      .with({ kind: "hold" }, ({ approvalId }) => {
        const held = this.held.hold(approvalId, {
          signal: asking.abandoned,
          onAbort: () => {
            // Recorded once the dispatch that held it has returned, if it aborted that early.
            queueMicrotask(() =>
              this.report({
                kind: "approval_abandoned",
                origin: this.origin,
                ids: this.drawIds(),
                approvalId,
              }),
            );
            return ABANDONED;
          },
        });
        if (held.kind === "held") return held.reply;
        this.deps.log(`call for approval ${approvalId} could not be held (${held.refusal})`);
        return Promise.resolve(ABANDONED);
      })
      .exhaustive();
  }

  // ---------------------------------------------------------------- commands

  /** Attach the function that delivers events to connections (see `ClientOwnership.attach`). */
  attachDelivery(delivery: Delivery): () => void {
    return this.clients.attach(delivery);
  }

  adoptConnection(connectionId: string, clientId: string): boolean {
    return this.clients.adopt(connectionId, clientId);
  }

  /** Disconnection is not consent: pending approvals stay pending, and tasks keep running. */
  onDisconnect(connectionId: string): void {
    this.clients.disconnect(connectionId);
  }

  async handle(ctx: CommandContext, command: ClientCommand): Promise<CommandResult> {
    if (this.shuttingDown) return fail("invalid_state", "the server is shutting down");
    return match(command)
      .with({ type: "start_conversation" }, () => this.startConversation(ctx))
      .with({ type: "submit_text" }, ({ payload }) => this.submitText(ctx, payload))
      .with({ type: "approval_decision" }, ({ payload }) => this.approvalDecision(ctx, payload))
      .with({ type: "interrupt_task" }, ({ payload }) => this.interruptTask(ctx, payload))
      .with({ type: "interrupt_all" }, ({ payload }) => this.interruptAll(ctx, payload))
      .with({ type: "diagnostic_snapshot" }, ({ payload }) => this.diagnosticSnapshot(ctx, payload))
      .with({ type: "heartbeat" }, ({ payload }) => {
        try {
          recordHeartbeat({
            writer: this.deps.writer,
            newId: this.deps.newId,
            now: this.deps.now,
            from: ctx,
            conversationId:
              this.conversation?.id === payload.conversation_id ? payload.conversation_id : null,
            payload,
          });
          return Promise.resolve<CommandResult>({ ok: true });
        } catch (error) {
          return Promise.resolve(fail("record_failure", errorMessage(error)));
        }
      })
      .exhaustive();
  }

  private guard(ctx: CommandContext, conversationId: string): CommandResult | null {
    const conversation = this.conversation;
    if (!conversation)
      return fail("invalid_state", "no conversation; send start_conversation first");
    if (conversation.id !== conversationId)
      return fail("not_found", `conversation ${conversationId} is not active`);
    const refusal = this.clients.refusal(ctx.connectionId, ctx.clientId);
    return refusal === null ? null : fail("busy", refusal);
  }

  /**
   * Starts a conversation: reads its files and stores its provenance before the transaction, then commits the start
   * in a machine of its own. A conversation whose session is still open is not replaced: stop its work first.
   */
  private async startConversation(ctx: CommandContext): Promise<CommandResult> {
    const refused = (): CommandResult | null => {
      if (this.session)
        return fail("busy", "work is running; stop it before starting a new conversation");
      if (
        this.conversation &&
        this.clients.connectionId &&
        this.clients.connectionId !== ctx.connectionId
      )
        return fail("busy", "another client owns the active conversation");
      return null;
    };
    const first = refused();
    if (first) return first;
    if (this.starting) return fail("busy", "another conversation is starting");
    this.starting = true;
    try {
      const signal = AbortSignal.any([this.stopping.signal, this.deps.evidenceReadDeadline()]);
      let stored;
      try {
        stored = await prepareConversationProvenance({
          profile: this.deps.profile,
          read: this.deps.readEvidence,
          identity: this.deps.identity,
          clientBuild: ctx.clientBuild,
          objects: this.deps.writer.objects,
          signal,
        });
      } catch (error) {
        return fail("record_failure", `could not create conversation: ${errorMessage(error)}`);
      }
      const again = this.shuttingDown
        ? fail("invalid_state", "the server is shutting down")
        : refused();
      if (again) return again;
      const provenance = nameProvenance(stored, this.deps.newId);
      const manager = agentPromptObject(provenance);
      const worker = workerPromptObject(provenance);
      const { objects } = this.deps.writer;
      let workerPrompt: string | null = null;
      if (worker !== null) {
        // The retained object's own bytes, so the prompt the runtime gets is the one the provenance holds.
        const read = await objects.readVerified(worker.digest, {
          expectedBytes: worker.byteCount,
          maxBytes: MAX_CONVERSATION_FILE_BYTES,
          signal,
        });
        if (read.status !== "verified")
          return fail("record_failure", `the retained worker prompt is ${read.status}`);
        workerPrompt = read.bytes.toString("utf8");
      }
      const conversationId = this.deps.newId("conv");
      const machine = this.openConversation(conversationId);
      const dispatched = machine.dispatch({
        kind: "start_conversation",
        origin: { clientId: ctx.clientId, connectionId: ctx.connectionId },
        closes: this.conversation?.id ?? null,
        provenance,
        managerPromptFile: manager === null ? null : objects.pathFor(manager.digest),
        workerPrompt,
        conversationsRoot: this.deps.catalog.paths.conversations,
        debugMode: this.deps.debugMode,
        ids: {
          conversation: conversationId,
          runtimeConversation: randomUUID(),
          provenanceRecorded: this.deps.newId("evt"),
          started: this.deps.newId("evt"),
          captured: this.deps.newId("evt"),
        },
      });
      if (dispatched.kind !== "committed")
        return fail(
          "record_failure",
          dispatched.kind === "failed"
            ? `could not create conversation: ${errorMessage(dispatched.error)}`
            : `start refused: ${dispatched.rejection.kind}`,
        );
      const conversation = machine.state;
      if (!conversation) throw new Error("a conversation start committed without its conversation");
      return {
        ok: true,
        result: {
          conversation_id: conversation.id,
          provenance_set_id: conversation.provenanceSetId,
        },
      };
    } finally {
      this.starting = false;
    }
  }

  /** A message for the manager agent: accepted while work runs, and read as its next turn's input. */
  private submitText(
    ctx: CommandContext,
    payload: { conversation_id: string; text: string },
    fromMia = false,
  ): Promise<CommandResult> {
    const guard = this.guard(ctx, payload.conversation_id);
    if (guard) return Promise.resolve(guard);
    const { runtime } = this.deps.profile;
    const dispatched = this.dispatch({
      kind: "message_submitted",
      origin: this.origin,
      ids: this.drawIds(),
      text: payload.text,
      clientId: ctx.clientId,
      requested: { model: runtime.model, effort: runtime.effort },
      fromMia,
    });
    return Promise.resolve(
      match(dispatched)
        .with({ kind: "committed" }, (): CommandResult => ({
          ok: true,
          result: { queued: this.conversation?.queuedInputs.length ?? 0 },
        }))
        .with({ kind: "failed" }, ({ error }) =>
          fail("record_failure", `could not record the message: ${errorMessage(error)}`),
        )
        .with({ kind: "rejected" }, ({ rejection }) =>
          match(rejection)
            .with({ kind: "busy" }, ({ queued }) =>
              fail("busy", `${queued} messages are already waiting for the manager agent`),
            )
            .with({ kind: "stopping" }, () =>
              fail("invalid_state", "every task is being stopped; send the message once they have"),
            )
            .with({ kind: "no_worker_prompt" }, () =>
              fail(
                "configuration_error",
                "the worker prompt was missing when the conversation started",
              ),
            )
            .otherwise(({ kind }) => fail("internal", `message refused: ${kind}`)),
        )
        .exhaustive(),
    );
  }

  private approvalDecision(
    ctx: CommandContext,
    payload: { conversation_id: string; task_id: string; approval_id: string; decision: Decision },
  ): Promise<CommandResult> {
    const guard = this.guard(ctx, payload.conversation_id);
    if (guard) return Promise.resolve(guard);
    const task = this.conversation?.tasks.get(payload.task_id);
    const callId = task?.pendingApprovals.get(payload.approval_id);
    const call = callId === undefined ? undefined : task?.calls.get(callId);
    const dispatched = this.dispatch({
      kind: "approval_decision",
      origin: this.origin,
      ids: this.drawIds(),
      taskId: payload.task_id,
      approvalId: payload.approval_id,
      decision: payload.decision,
      deciderClientId: ctx.clientId,
      ownerClientId: this.clients.clientId,
      exclusive:
        call !== undefined && this.deps.profile.runtime.exclusiveTools.includes(call.toolIdentity),
    });
    return Promise.resolve(
      match(dispatched)
        .with({ kind: "committed" }, (): CommandResult => {
          const decided =
            callId === undefined ? undefined : this.callStatus(payload.task_id, callId);
          return {
            ok: true,
            result: {
              approval_id: payload.approval_id,
              decision: payload.decision,
              released: decided === "dispatched" || decided === "completed" || decided === "failed",
            },
          };
        })
        .with({ kind: "failed" }, ({ error }) =>
          fail(
            "record_failure",
            `decision not recorded; call remains held: ${errorMessage(error)}`,
          ),
        )
        .with({ kind: "rejected" }, ({ rejection }) =>
          match(rejection)
            .with({ kind: "no_task" }, () =>
              fail("not_found", `task ${payload.task_id} is not running`),
            )
            .with({ kind: "not_owner" }, () =>
              fail(
                "unauthenticated",
                "decision must come from the client that owns the conversation",
              ),
            )
            .with({ kind: "not_pending" }, () =>
              fail("invalid_state", `approval ${payload.approval_id} is not pending`),
            )
            .otherwise(({ kind }) => fail("internal", `decision refused: ${kind}`)),
        )
        .exhaustive(),
    );
  }

  private callStatus(taskId: string, callId: string) {
    return this.conversation?.tasks.get(taskId)?.calls.get(callId)?.status;
  }

  /**
   * The person stops one task: its gate closes at once, then Mia asks the manager agent, in a message of its own, to
   * stop the worker agent. The closed gate holds whether or not the manager agent does.
   */
  private async interruptTask(
    ctx: CommandContext,
    payload: { conversation_id: string; task_id: string },
  ): Promise<CommandResult> {
    const guard = this.guard(ctx, payload.conversation_id);
    if (guard) return guard;
    const task = this.conversation?.tasks.get(payload.task_id);
    const dispatched = this.dispatch({
      kind: "stop_task",
      origin: this.origin,
      ids: this.drawIds(),
      taskId: payload.task_id,
    });
    if (dispatched.kind === "rejected")
      return dispatched.rejection.kind === "already_stopping"
        ? { ok: true, result: { already_stopping: true } }
        : fail("not_found", `task ${payload.task_id} is not running`);
    if (dispatched.kind === "failed")
      return fail("record_failure", `stop not recorded: ${errorMessage(dispatched.error)}`);
    if (task) {
      const asked = await this.submitText(
        ctx,
        {
          conversation_id: payload.conversation_id,
          text: `[Mia] The user stopped the task "${task.id}" (worker agent ${task.runtimeTaskId}). Stop that worker agent now with TaskStop, and do not start it again.`,
        },
        true,
      );
      if (!asked.ok)
        this.deps.log(`could not ask the manager agent to stop ${task.id}: ${asked.message}`);
    }
    return { ok: true, result: { task_id: payload.task_id } };
  }

  /** The interrupt control: every task stops through the engine, whatever the manager agent does. */
  private interruptAll(
    ctx: CommandContext,
    payload: { conversation_id: string },
  ): Promise<CommandResult> {
    const guard = this.guard(ctx, payload.conversation_id);
    if (guard) return Promise.resolve(guard);
    const running = [...(this.conversation?.tasks.keys() ?? [])];
    const dispatched = this.dispatch({
      kind: "stop_all",
      origin: this.origin,
      ids: this.drawIds(),
      by: "client",
    });
    return Promise.resolve(
      match(dispatched)
        .with({ kind: "committed" }, (): CommandResult => ({
          ok: true,
          result: { interrupted: running },
        }))
        .with({ kind: "failed" }, ({ error }) =>
          fail("record_failure", `stop not recorded: ${errorMessage(error)}`),
        )
        .with({ kind: "rejected" }, ({ rejection }): CommandResult =>
          rejection.kind === "already_stopping"
            ? { ok: true, result: { already_stopping: true } }
            : { ok: true, result: { interrupted: [] } },
        )
        .exhaustive(),
    );
  }

  /** A client's diagnostics snapshot, recorded as its row under the conversation it is about, if it is the active one. */
  private diagnosticSnapshot(
    ctx: CommandContext,
    payload: { conversation_id: string | null; diagnostics: ClientDiagnostics },
  ): Promise<CommandResult> {
    try {
      this.deps.writer.recordDiagnostics({
        id: this.deps.newId("diag"),
        receivedAt: this.deps.now().toISOString(),
        conversationId:
          this.conversation?.id === payload.conversation_id ? payload.conversation_id : null,
        clientId: ctx.clientId,
        clientConnectionId: ctx.connectionId,
        eventId: null,
        capturedAt: payload.diagnostics.captured_at,
        state: payload.diagnostics,
      });
      return Promise.resolve({ ok: true });
    } catch (error) {
      return Promise.resolve(fail("record_failure", errorMessage(error)));
    }
  }

  /**
   * Stop for good: refuse every later command, stop every task as the interrupt control does, and wait for the
   * session's end to be recorded or for `turnWait` to abort. It never rejects; a stop that cannot be recorded kills
   * the session anyway, because a runtime left running outlives the server and can keep calling tools.
   */
  async shutdown(turnWait: AbortSignal): Promise<void> {
    this.shuttingDown = true;
    this.stopping.abort(new Error("the server is shutting down"));
    const session = this.session;
    this.deps.gate.setHandler(null);
    if (!session) return;
    try {
      const dispatched = this.dispatch({
        kind: "stop_all",
        origin: this.origin,
        ids: this.drawIds(),
        by: "shutdown",
      });
      if (dispatched.kind !== "committed") throw new Error(`stop ${dispatched.kind}`);
    } catch (error) {
      this.deps.log(`shutdown: ${errorMessage(error)}; killing the session anyway`);
      session.handle
        .stop()
        .catch((stopError: unknown) => this.deps.log(`stop failed: ${String(stopError)}`));
    }
    const timedOut = Promise.withResolvers<undefined>();
    const onAbort = () => timedOut.resolve(undefined);
    if (turnWait.aborted) onAbort();
    else turnWait.addEventListener("abort", onAbort, { once: true });
    await Promise.race([session.ended, timedOut.promise]).finally(() =>
      turnWait.removeEventListener("abort", onAbort),
    );
  }
}
