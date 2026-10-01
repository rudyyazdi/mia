import { join } from "node:path";
import { match } from "ts-pattern";
import {
  bodyLogFor,
  hookEvidenceFrom,
  policyFor,
  readManagerCall,
  untilAborted,
  type GateDecision,
  type GateHandler,
  type GateRequest,
  type Profile,
  type RuntimeFileRead,
  type RuntimeFileReader,
  type SessionEvent,
  type SessionHandle,
  type SessionOptions,
  type SessionResult,
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
import {
  extractDeclaredArtifact,
  type Capture,
  type DeclaredArtifact,
  type Retention,
} from "./artifact-capture.ts";
import type { ArtifactCollector } from "./artifact-collector.ts";
import { ClientOwnership, recordHeartbeat, type Delivery } from "./client-ownership.ts";
import {
  decideConversation,
  type ConversationEvent,
  type ConversationRejection,
} from "./decide-conversation.ts";
import type { ConversationState } from "./conversation-state.ts";
import type { EngineEffect, GateAnswer, SessionStart } from "./engine-effects.ts";
import {
  commitEvents,
  committedEvents,
  eventSequence,
  type EngineRecord,
  type EventChange,
} from "./engine-records.ts";
import {
  MAX_BODY_LOG_BYTES,
  mcpBodiesFrom,
  unrecordedBodies,
  type BodyReadPoint,
  type McpBody,
} from "./mcp-bodies.ts";
import {
  MAX_CONVERSATION_FILE_BYTES,
  agentPromptObject,
  nameProvenance,
  prepareConversationProvenance,
  workerPromptObject,
  type ServerIdentity,
} from "./provenance.ts";
import type { CapturedOutput, SessionFile } from "./recorded-outputs.ts";

export interface CommandContext {
  connectionId: string;
  clientId: string;
  commandId: string;
  clientBuild: unknown;
}

export type CommandResult =
  { ok: true; result?: Record<string, unknown> } | { ok: false; code: ErrorCode; message: string };

const fail = (code: ErrorCode, message: string): CommandResult => ({ ok: false, code, message });

/** What runs the manager agent's sessions: the real `ClaudeCodeSessions`, or a test's scripted runtime. */
export interface SessionRunner {
  open(options: SessionOptions): SessionHandle;
}

export interface EngineDeps {
  profile: Profile;
  catalog: Catalog;
  writer: RecordWriter;
  sessions: SessionRunner;
  identity: ServerIdentity;
  /**
   * A fresh deadline for one batch of evidence reads and stores: a conversation start's files and snapshots, a tool
   * result's declared output and body log, a session's transcript and hook evidence. A read it abandons is recorded
   * unreadable; a start it interrupts is refused.
   */
  evidenceReadDeadline: () => AbortSignal;
  /** How long a session's kill may take to be observed before its cancellation is recorded unknown. */
  stopDeadline: () => AbortSignal;
  /**
   * How long a worker agent's call may wait for the runtime to report that worker agent's start (stdout and the gate
   * race), before it is denied as unattributed.
   */
  attributionDeadline: () => AbortSignal;
  /** Reads runtime-written and conversation files: `readRuntimeFile`, or a test's own. */
  readEvidence: RuntimeFileReader;
  /** Captures a tool output a completed call declared: `collectArtifact`, or a test's own. */
  collectArtifact: ArtifactCollector;
  /** Injected randomness for every id the engine records; transitions take it as an input. */
  newId: NewId;
  /** Injected randomness for the UUID each message is sent to the runtime under. */
  newRuntimeMessageId: () => string;
  /** The clock: each transaction reads it once, and so does each event sent. */
  now: () => Date;
  /**
   * Debug mode, chosen once per server start: each conversation records `captured_in_debug_mode`, and the MCP bodies
   * of each released call to a server that writes a body log.
   */
  debugMode: boolean;
  log: (message: string) => void;
}

/**
 * How many held calls the gate keeps open at once, across tasks, waiting for the user's decision. A call that would
 * ask beyond it is denied without asking, so no approval is recorded that cannot be held.
 */
export const MAX_HELD_CALLS = 32;

/** How many gate requests may wait for their worker agent's start at once; beyond it they are denied unattributed. */
export const MAX_ATTRIBUTION_WAITS = 32;

/**
 * The most of a session's transcript or hook evidence its end reads into memory. A long-lived session's files can grow
 * past it; such a file is recorded as unreadable for its size and left where the runtime wrote it.
 */
/** The key a manager agent's call waits under for its proposal; distinct from any runtime task id. */
const proposalKey = (runtimeCallId: string): string => `proposal:${runtimeCallId}`;

export const MAX_SESSION_EVIDENCE_BYTES = 64 * 1024 * 1024;

/** A few readers of one conversation at once, each a page behind at most before it reads the catalog again. */
const FEED_LIMITS: FeedLimits = { subscribers: 8, buffered: 256 };

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

type ConversationMachine = Machine<
  ConversationState | null,
  ConversationEvent,
  ConversationRejection,
  EventChange
>;

/** The runtime session a conversation runs: a resource the engine owns, reported into the machine that opened it. */
interface OpenSession {
  handle: SessionHandle;
  machine: ConversationMachine;
  /** Settles once the session's end has been recorded (or given up on). */
  ended: Promise<void>;
}

/** A gate request being dispatched, and the answer its `answer_gate` effect gave once performed. */
interface Asking {
  abandoned: AbortSignal;
  answer: Promise<GateDecision> | null;
}

/** What the gateway and the server need from the engine. */
export interface CommandEngine {
  readonly conversation: { readonly id: string } | null;
  handle(ctx: CommandContext, command: ClientCommand): Promise<CommandResult>;
  adoptConnection(connectionId: string, clientId: string): boolean;
  onDisconnect(connectionId: string): void;
  attachDelivery(delivery: Delivery): () => void;
  shutdown(turnWait: AbortSignal): Promise<void>;
}

/**
 * The engine: one conversation at a time, whose manager agent never blocks. It owns the conversation's kernel machine
 * (the rules are ./decide-conversation.ts), the manager agent's runtime session, and the held calls. Every change goes
 * through a dispatch that decides, commits the records, moves the state on and then performs the effects; the
 * runtime's reports and the gate's requests arrive as events of their own, after any I/O they need (captures, body
 * logs, evidence) is done at this boundary.
 */
export class Engine implements CommandEngine {
  readonly clients = new ClientOwnership();
  /** The active conversation's machine; replaced only through a start's activation. */
  private machine: ConversationMachine | null = null;
  private session: OpenSession | null = null;
  private shuttingDown = false;
  /** Aborted by shutdown, so I/O still pending (a start's reads, evidence stores) is abandoned. */
  private readonly stopping = new AbortController();
  /** One conversation start at a time awaits its reads and stores. */
  private starting = false;
  private readonly held = new Holds<GateDecision>(MAX_HELD_CALLS);
  private asking: Asking | null = null;
  /**
   * Gate requests waiting for stdout to catch up (MAX_ATTRIBUTION_WAITS): a worker agent's call for the report of its
   * start (keyed by the runtime's task id), and a manager agent's call for its own proposal (keyed by call id).
   */
  private readonly attributionWaits = new Map<string, (() => void)[]>();
  /** The manager agent's calls stdout has proposed, most recent last (MAX_ATTRIBUTION_WAITS). */
  private readonly proposedManagerCalls: string[] = [];
  /** The handler the session decides its calls with; one per engine, so it can be told from a successor's. */
  private readonly decide: GateHandler = (request) => this.decideGate(request);

  constructor(private readonly deps: EngineDeps) {}

  /** The active conversation's state as it is now; null before the first start. */
  get conversation(): ConversationState | null {
    return this.machine?.state ?? null;
  }

  private get origin() {
    return this.clients.origin;
  }

  // ---------------------------------------------------------------- event plumbing

  /**
   * A new conversation's machine, at null until its start is dispatched into it, on a kernel of its own: the kernel
   * commits the records in one catalog transaction and reads the clock once per dispatch. A commit that throws keeps
   * the state and performs no effect. After a commit each effect runs on its own: one that throws is logged, and the
   * records, the state and the remaining effects stand. An effect may not dispatch: the kernel refuses a nested
   * dispatch, so a follow-up is dispatched once the current dispatch has returned.
   */
  private openConversation(conversationId: string): ConversationMachine {
    const kernel = createKernel<EngineRecord, EventChange, EngineEffect>({
      commit: (records) => commitEvents(this.deps.writer, records),
      perform: (effect, changes) => this.perform(effect, { machine, conversationId, changes }),
      reportEffectFailure: (error) =>
        this.deps.log(`delivery failed after commit; records stand: ${errorMessage(error)}`),
      replay: committedEvents(this.deps.catalog, conversationId),
      now: () => this.deps.now(),
      limits: FEED_LIMITS,
    });
    const machine: ConversationMachine = kernel.machine(decideConversation, null);
    return machine;
  }

  /** Dispatch a report into `machine`: nothing waits on it, so a refusal or a failed commit is logged. */
  private report(
    machine: ConversationMachine,
    event: ConversationEvent,
  ): Dispatched<ConversationRejection, EventChange> | null {
    try {
      const dispatched = machine.dispatch(event);
      if (dispatched.kind === "rejected")
        this.deps.log(`${event.kind} not applied: ${dispatched.rejection.kind}`);
      if (dispatched.kind === "failed")
        this.deps.log(`${event.kind} not recorded: ${errorMessage(dispatched.error)}`);
      return dispatched;
    } catch (error) {
      this.deps.log(`${event.kind} failed: ${errorMessage(error)}`);
      return null;
    }
  }

  private drawn() {
    return { origin: this.origin, newId: this.deps.newId };
  }

  private perform(
    effect: EngineEffect,
    committed: {
      machine: ConversationMachine;
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
      // A replaced conversation's late events (its closed session finishing what it had) are recorded, but its
      // client now follows the new conversation, so they are not delivered.
      .with({ kind: "deliver_event" }, ({ eventId, event }) => {
        if (machine !== this.machine) return;
        this.clients.deliver(event, {
          id: eventId,
          conversationId,
          sequence: eventSequence(changes, eventId),
          serverTime,
        });
      })
      .with({ kind: "notify_tool_call" }, ({ payload }) => {
        if (machine !== this.machine) return;
        this.clients.deliver(
          { type: "tool_call", payload },
          { id: this.deps.newId("evt"), conversationId, sequence: null, serverTime },
        );
      })
      .with({ kind: "open_session" }, ({ session }) => this.openSession(machine, session))
      .with({ kind: "send_message" }, ({ text, runtimeMessageId }) => {
        if (this.session?.handle.send(text, runtimeMessageId) === true) return;
        // Recorded as a transition of its own, once this dispatch has returned: an effect may not dispatch.
        queueMicrotask(() =>
          this.report(machine, { kind: "message_undelivered", ...this.drawn(), runtimeMessageId }),
        );
      })
      .with({ kind: "stop_session" }, () => {
        this.session?.handle
          .stop(this.deps.stopDeadline())
          .catch((error: unknown) => this.deps.log(`stop failed: ${errorMessage(error)}`));
      })
      .with({ kind: "answer_gate" }, ({ answer }) => {
        const asking = this.asking;
        if (!asking) throw new Error("no gate request is being dispatched");
        if (asking.answer) throw new Error("a gate request is answered once");
        asking.answer = this.takeAnswer(machine, asking, answer);
      })
      .with({ kind: "answer_held" }, ({ approvalId, decision }) => {
        this.held.reply(approvalId, decision);
      })
      .exhaustive();
  }

  /** Open the manager agent's session for the conversation `machine` runs. */
  private openSession(machine: ConversationMachine, start: SessionStart): void {
    const conversation = machine.state;
    if (!conversation || conversation.workerPrompt === null)
      throw new Error("a session opens only for a started conversation with a worker prompt");
    const handle = this.deps.sessions.open({
      runtimeConversationId: conversation.runtimeConversationId,
      resume: start.resume,
      runtimeDir: join(conversation.directory, "runtime"),
      sessionIndex: start.sessionIndex,
      managerPromptFile: conversation.managerPromptFile,
      workerPrompt: conversation.workerPrompt,
      decide: this.decide,
      onEvent: async (event) => this.onSessionEvent(machine, event),
    });
    const open: OpenSession = {
      handle,
      machine,
      ended: handle.result
        .then((result) => this.recordSessionEnd(machine, result))
        .catch((error: unknown) => this.deps.log(`session end failed: ${errorMessage(error)}`))
        .finally(() => {
          if (this.session === open) this.session = null;
        }),
    };
    this.session = open;
  }

  /**
   * Record the session's end: its transcript and hook evidence read and stored first, and in debug mode the bodies of
   * calls whose result never arrived. If the end cannot be recorded, memory lets the session go anyway
   * (`session_lost`), so the conversation does not keep writing to a dead runtime.
   */
  private async recordSessionEnd(
    machine: ConversationMachine,
    result: SessionResult,
  ): Promise<void> {
    const signal = AbortSignal.any([this.stopping.signal, this.deps.evidenceReadDeadline()]);
    const maxBytes = MAX_SESSION_EVIDENCE_BYTES;
    const [transcript, hookRead, unresultedBodies] = await Promise.all([
      this.deps.readEvidence(result.streamLogPath, { signal, maxBytes }),
      this.deps.readEvidence(result.hookEvidencePath, { signal, maxBytes }),
      this.readUnresultedBodies(machine.state),
    ]);
    const hookEvidence = hookEvidenceFrom(hookRead);
    const [transcriptFile, hooksFile] = await Promise.all([
      this.retainFile(transcript, {
        name: "session.stream.jsonl",
        path: result.streamLogPath,
        signal,
      }),
      this.retainFile(hookRead, {
        name: "session.hooks.jsonl",
        path: result.hookEvidencePath,
        signal,
      }),
    ]);
    const dispatched = this.report(machine, {
      kind: "session_ended",
      ...this.drawn(),
      status: result.status,
      error: result.error,
      runtimeCancellation: result.cancellation,
      transcript: transcriptFile,
      hooks: { file: hooksFile, evidence: hookEvidence },
      unresultedBodies,
    });
    if (dispatched?.kind !== "committed" && machine.state?.session) {
      this.deps.log("the session's end could not be recorded; letting it go");
      this.report(machine, { kind: "session_lost" });
    }
  }

  /** What a session's file retains: the stored bytes or why not; null when the runtime never wrote it. */
  private async retainFile(
    read: RuntimeFileRead,
    file: { name: string; path: string; signal: AbortSignal },
  ): Promise<SessionFile | null> {
    if (read.status === "absent") return null;
    const capture: Capture =
      read.status === "read"
        ? { status: "retained", bytes: read.bytes }
        : { status: "failed", reason: `unreadable: ${read.reason}` };
    return {
      name: file.name,
      originalPath: file.path,
      retention: await this.store(capture, file.signal),
    };
  }

  /**
   * Stores a retained capture's bytes before the transaction that registers them: best-effort, so bytes that cannot be
   * stored become a failed capture that says why; bytes whose transaction then fails stay an unreferenced object.
   */
  private async store(capture: Capture, signal: AbortSignal): Promise<Retention> {
    if (capture.status !== "retained") return capture;
    return this.deps.writer.objects.put(capture.bytes, { signal }).then(
      (stored): Retention => ({ status: "retained", stored }),
      (error: unknown): Retention => ({
        status: "failed",
        reason: `not retained: ${errorMessage(error)}`,
      }),
    );
  }

  /** In debug mode, the body log a released call of a server that writes one reads; null when it reads none. */
  private bodyLogOf(toolIdentity: string): string | null {
    return this.deps.debugMode ? bodyLogFor(this.deps.profile.runtime, toolIdentity) : null;
  }

  private async readBodies(
    path: string,
    runtimeCallId: string,
    readAt: BodyReadPoint,
  ): Promise<McpBody[]> {
    const signal = AbortSignal.any([this.stopping.signal, this.deps.evidenceReadDeadline()]);
    const read = await this.deps.readEvidence(path, { signal, maxBytes: MAX_BODY_LOG_BYTES });
    try {
      return mcpBodiesFrom(read, runtimeCallId, readAt);
    } catch (error) {
      return unrecordedBodies(`the body log could not be parsed: ${errorMessage(error)}`);
    }
  }

  /** In debug mode, the bodies each released call without a result has in its server's body log, at session end. */
  private async readUnresultedBodies(
    state: ConversationState | null,
  ): Promise<ReadonlyMap<string, readonly McpBody[]>> {
    if (!state) return new Map();
    const calls = [...state.tasks.values()].flatMap((task) =>
      [...task.calls.values()].flatMap((call) => {
        const path = call.status === "dispatched" ? this.bodyLogOf(call.toolIdentity) : null;
        return path === null ? [] : [{ runtimeCallId: call.runtimeCallId, path }];
      }),
    );
    const read = await Promise.all(
      calls.map(async ({ runtimeCallId, path }): Promise<[string, McpBody[]]> => [
        runtimeCallId,
        await this.readBodies(path, runtimeCallId, "session_end"),
      ]),
    );
    return new Map(read);
  }

  /** Captures and stores a tool output a result declared. */
  private async captureOutput(declared: DeclaredArtifact): Promise<CapturedOutput> {
    const capture = await this.deps
      .collectArtifact(declared, this.deps.profile.runtime.outputDirectories)
      .catch((error: unknown): Capture => ({
        status: "failed",
        reason: `declared file unreadable: ${errorMessage(error)}`,
      }));
    return { declared, retention: await this.store(capture, this.stopping.signal) };
  }

  /** One report of a session, dispatched into the machine of the conversation that opened it. */
  private async onSessionEvent(machine: ConversationMachine, event: SessionEvent): Promise<void> {
    const { runtime } = this.deps.profile;
    const drawn = this.drawn();
    await match(event)
      .with({ type: "runtime_init" }, ({ init }) => {
        this.report(machine, { ...drawn, kind: "turn_began", init });
      })
      .with({ type: "input_taken" }, ({ runtimeMessageId }) => {
        this.report(machine, { ...drawn, kind: "input_taken", runtimeMessageId });
      })
      .with({ type: "text_delta" }, ({ text, parentCallId }) => {
        // A worker agent's own text is its task's working, not the reply.
        if (parentCallId === null) this.report(machine, { ...drawn, kind: "reply_text", text });
      })
      .with({ type: "turn_result" }, ({ summary }) => {
        this.report(machine, { ...drawn, kind: "turn_ended", summary });
      })
      .with({ type: "tool_result" }, async (result) => {
        const call = this.releasedCall(machine.state, result.runtimeCallId);
        const declared = call && !result.isError ? extractDeclaredArtifact(result.content) : null;
        const bodyLog = call ? this.bodyLogOf(call.toolIdentity) : null;
        const [output, bodies] = await Promise.all([
          declared ? this.captureOutput(declared) : null,
          bodyLog === null ? null : this.readBodies(bodyLog, result.runtimeCallId, "tool_result"),
        ]);
        this.report(machine, {
          ...drawn,
          kind: "tool_result",
          runtimeCallId: result.runtimeCallId,
          parentCallId: result.parentCallId,
          isError: result.isError,
          content: result.content,
          output,
          bodies,
        });
      })
      .with({ type: "worker_started" }, (started) => {
        this.report(machine, {
          ...drawn,
          kind: "worker_started",
          runtimeTaskId: started.runtimeTaskId,
          delegationCallId: started.delegationCallId,
          description: started.description,
          clientId: this.clients.clientId,
          requested: { model: runtime.model, effort: runtime.effort },
        });
        this.wakeWaits(started.runtimeTaskId);
      })
      .with({ type: "worker_ended" }, (ended) => {
        this.report(machine, {
          ...drawn,
          kind: "worker_ended",
          runtimeTaskId: ended.runtimeTaskId,
          status: ended.status,
          summary: ended.summary,
        });
      })
      .with({ type: "runtime_stderr" }, ({ text }) => this.deps.log(`runtime: ${text.trim()}`))
      .with({ type: "malformed_event" }, ({ error }) =>
        this.deps.log(`malformed runtime output: ${error}`),
      )
      .with({ type: "tool_proposed" }, ({ runtimeCallId, parentCallId }) => {
        if (parentCallId !== null) return;
        const key = proposalKey(runtimeCallId);
        this.proposedManagerCalls.push(key);
        this.proposedManagerCalls.splice(
          0,
          this.proposedManagerCalls.length - MAX_ATTRIBUTION_WAITS,
        );
        this.wakeWaits(key);
      })
      .with(
        { type: "runtime_started" },
        { type: "assistant_message" },
        { type: "runtime_exit" },
        () => undefined,
      )
      .exhaustive();
  }

  /** The released call a result names, among running tasks and the unsettled calls of ended ones. */
  private releasedCall(
    state: ConversationState | null,
    runtimeCallId: string,
  ): { toolIdentity: string } | null {
    if (!state) return null;
    for (const task of state.tasks.values())
      for (const call of task.calls.values())
        if (call.runtimeCallId === runtimeCallId && call.status === "dispatched") return call;
    return state.unsettledCalls.get(runtimeCallId) ?? null;
  }

  // ---------------------------------------------------------------- the gate

  /**
   * Decide one call the runtime is about to make, from the manager agent or a worker agent. A worker agent's call that
   * races the report of its start waits for it, bounded. The answer comes from the committed transition's
   * `answer_gate` effect; a request whose records did not commit is denied.
   */
  private async decideGate(request: GateRequest): Promise<GateDecision> {
    const machine = this.session?.machine;
    if (!machine || this.shuttingDown) return NO_CONVERSATION;
    await this.awaitStdout(machine, request);
    const { runtime } = this.deps.profile;
    const asking: Asking = { abandoned: request.abandoned, answer: null };
    const previous = this.asking;
    this.asking = asking;
    let dispatched: Dispatched<ConversationRejection, EventChange>;
    try {
      dispatched = machine.dispatch({
        kind: "gate_request",
        ...this.drawn(),
        runtimeCallId: request.toolUseId,
        toolIdentity: request.toolName,
        input: request.input,
        agentId: request.agentId,
        managerCall: readManagerCall(request.toolName, request.input),
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
    if (dispatched.kind === "failed") {
      this.deps.log(`gate request not recorded: ${errorMessage(dispatched.error)}`);
      return NOT_RECORDED;
    }
    if (dispatched.kind === "rejected") return NO_CONVERSATION;
    return asking.answer ?? NOT_RECORDED;
  }

  /** Wait until the runtime has reported worker agent `agentId`'s start, or the attribution deadline passes. */
  /**
   * Waits, bounded, until stdout has caught up with a gate request that can outrun it: a worker agent's call until the
   * report of its start, and a manager agent's call until its proposal, so the turn it belongs to is opened from the
   * stdout events before it (the replayed message that makes the turn the user's) rather than by the call.
   */
  private async awaitStdout(machine: ConversationMachine, request: GateRequest): Promise<void> {
    const { agentId, toolUseId } = request;
    // A call without an id cannot be matched to its proposal; the decision reads it as it is.
    if (agentId === null && toolUseId === undefined) return;
    const key = agentId ?? proposalKey(toolUseId ?? "");
    const caughtUp = () =>
      agentId === null
        ? this.proposedManagerCalls.includes(key)
        : [...(machine.state?.tasks.values() ?? [])].some((task) => task.runtimeTaskId === agentId);
    if (caughtUp()) return;
    const waiting = [...this.attributionWaits.values()].reduce((sum, list) => sum + list.length, 0);
    if (waiting >= MAX_ATTRIBUTION_WAITS) return;
    const reached = Promise.withResolvers<undefined>();
    const wake = () => reached.resolve(undefined);
    this.attributionWaits.set(key, [...(this.attributionWaits.get(key) ?? []), wake]);
    await untilAborted(
      () => reached.promise,
      this.deps.attributionDeadline(),
      () => undefined,
    );
    // A wait the deadline ended leaves the list; one stdout woke has already left it.
    const remaining = (this.attributionWaits.get(key) ?? []).filter((other) => other !== wake);
    if (remaining.length > 0) this.attributionWaits.set(key, remaining);
    else this.attributionWaits.delete(key);
  }

  private wakeWaits(key: string): void {
    for (const wake of this.attributionWaits.get(key) ?? []) wake();
    this.attributionWaits.delete(key);
  }

  private takeAnswer(
    machine: ConversationMachine,
    asking: Asking,
    answer: GateAnswer,
  ): Promise<GateDecision> {
    return match(answer)
      .with({ kind: "answer" }, ({ decision }) => Promise.resolve(decision))
      .with({ kind: "hold" }, ({ approvalId }) => {
        const held = this.held.hold(approvalId, {
          signal: asking.abandoned,
          onAbort: () => {
            // Recorded once the dispatch that held it has returned, if it aborted that early.
            queueMicrotask(() =>
              this.report(machine, { kind: "approval_abandoned", ...this.drawn(), approvalId }),
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

  /** A reconnecting client (same client id) may resume ownership when no other connection is active. */
  adoptConnection(connectionId: string, clientId: string): boolean {
    return this.clients.adopt(connectionId, clientId);
  }

  /** Disconnection is not consent: pending approvals stay pending, and tasks keep running. */
  onDisconnect(connectionId: string): void {
    if (!this.clients.disconnect(connectionId) || !this.machine) return;
    this.report(this.machine, { kind: "client_disconnected", ...this.drawn(), connectionId });
  }

  /** Run one validated client command; once shutdown has begun, every command is refused unrun. */
  async handle(ctx: CommandContext, command: ClientCommand): Promise<CommandResult> {
    if (this.shuttingDown) return fail("invalid_state", "the server is shutting down");
    return match(command)
      .with({ type: "start_conversation" }, () => this.startConversation(ctx))
      .with({ type: "submit_text" }, ({ payload }) => this.submitText(ctx, payload))
      .with({ type: "approval_decision" }, ({ payload }) => this.approvalDecision(ctx, payload))
      .with({ type: "interrupt_task" }, ({ payload }) => this.interruptTask(ctx, payload))
      .with({ type: "interrupt_all" }, ({ payload }) => this.interruptAll(ctx, payload))
      .with({ type: "diagnostic_snapshot" }, ({ payload }) => this.diagnosticSnapshot(ctx, payload))
      .with({ type: "heartbeat" }, ({ payload }) => this.heartbeat(ctx, payload))
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

  /** The machine of the guarded conversation; `guard` returned null, so there is one. */
  private get active(): ConversationMachine {
    if (!this.machine) throw new Error("engine has no active conversation");
    return this.machine;
  }

  /** Why the conversation cannot be replaced now, or null: work still running, or another client owning it. */
  private refuseStart(ctx: CommandContext): CommandResult | null {
    const state = this.conversation;
    if (state && (state.tasks.size > 0 || state.turn !== null || state.queuedInputs.length > 0))
      return fail("busy", "work is running; stop it before starting a new conversation");
    if (state && this.clients.connectionId && this.clients.connectionId !== ctx.connectionId)
      return fail("busy", "another client owns the active conversation");
    return null;
  }

  /**
   * Starts a conversation: reads its files and stores its provenance before the transaction, then commits the start
   * in a machine of its own. An idle session of the conversation it replaces is closed: it ends once it has finished
   * what it has, recorded into its own conversation.
   */
  private async startConversation(ctx: CommandContext): Promise<CommandResult> {
    const refused = this.refuseStart(ctx);
    if (refused) return refused;
    if (this.starting) return fail("busy", "another conversation is starting");
    this.starting = true;
    try {
      const signal = AbortSignal.any([this.stopping.signal, this.deps.evidenceReadDeadline()]);
      const { profile, readEvidence, identity, writer } = this.deps;
      const { objects } = writer;
      let provenance;
      let workerPrompt: string | null = null;
      try {
        provenance = nameProvenance(
          await prepareConversationProvenance({
            profile,
            read: readEvidence,
            identity,
            clientBuild: ctx.clientBuild,
            objects,
            signal,
          }),
          this.deps.newId,
        );
        const worker = workerPromptObject(provenance);
        // The retained object's own bytes, so the prompt the runtime gets is the one the provenance holds.
        if (worker !== null) {
          const read = await objects.readVerified(worker.digest, {
            expectedBytes: worker.byteCount,
            maxBytes: MAX_CONVERSATION_FILE_BYTES,
            signal,
          });
          if (read.status !== "verified")
            return fail("record_failure", `the retained worker prompt is ${read.status}`);
          workerPrompt = read.bytes.toString("utf8");
        }
      } catch (error) {
        return fail("record_failure", `could not create conversation: ${errorMessage(error)}`);
      }
      const again = this.shuttingDown
        ? fail("invalid_state", "the server is shutting down")
        : this.refuseStart(ctx);
      if (again) return again;
      const manager = agentPromptObject(provenance);
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
          runtimeConversation: this.deps.newRuntimeMessageId(),
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
      this.session?.handle.close();
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

  /** A message for the manager agent: accepted while work runs, and read as a coming turn's input. */
  private submitText(
    ctx: CommandContext,
    payload: { conversation_id: string; text: string },
    fromMia = false,
  ): CommandResult {
    const guard = this.guard(ctx, payload.conversation_id);
    if (guard) return guard;
    const { runtime } = this.deps.profile;
    const dispatched = this.active.dispatch({
      kind: "message_submitted",
      ...this.drawn(),
      text: payload.text,
      clientId: ctx.clientId,
      requested: { model: runtime.model, effort: runtime.effort },
      fromMia,
      runtimeMessageId: this.deps.newRuntimeMessageId(),
    });
    return match(dispatched)
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
      .exhaustive();
  }

  private approvalDecision(
    ctx: CommandContext,
    payload: { conversation_id: string; task_id: string; approval_id: string; decision: Decision },
  ): CommandResult {
    const guard = this.guard(ctx, payload.conversation_id);
    if (guard) return guard;
    const task = this.conversation?.tasks.get(payload.task_id);
    const callId = task?.pendingApprovals.get(payload.approval_id);
    const call = callId === undefined ? undefined : task?.calls.get(callId);
    const dispatched = this.active.dispatch({
      kind: "approval_decision",
      ...this.drawn(),
      taskId: payload.task_id,
      approvalId: payload.approval_id,
      decision: payload.decision,
      deciderClientId: ctx.clientId,
      ownerClientId: this.clients.clientId,
      exclusive:
        call !== undefined && this.deps.profile.runtime.exclusiveTools.includes(call.toolIdentity),
    });
    return match(dispatched)
      .with({ kind: "committed" }, (): CommandResult => {
        const status =
          callId === undefined
            ? undefined
            : this.conversation?.tasks.get(payload.task_id)?.calls.get(callId)?.status;
        return {
          ok: true,
          result: {
            approval_id: payload.approval_id,
            decision: payload.decision,
            released: status === "dispatched" || status === "completed" || status === "failed",
          },
        };
      })
      .with({ kind: "failed" }, ({ error }) =>
        fail("record_failure", `decision not recorded; call remains held: ${errorMessage(error)}`),
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
      .exhaustive();
  }

  /**
   * The person stops one task: its gate closes at once, then Mia asks the manager agent, in a message of its own, to
   * stop the worker agent. The closed gate holds whether or not the manager agent does; the reply says whether it was
   * asked.
   */
  private interruptTask(
    ctx: CommandContext,
    payload: { conversation_id: string; task_id: string },
  ): CommandResult {
    const guard = this.guard(ctx, payload.conversation_id);
    if (guard) return guard;
    const task = this.conversation?.tasks.get(payload.task_id);
    const dispatched = this.active.dispatch({
      kind: "stop_task",
      ...this.drawn(),
      taskId: payload.task_id,
    });
    // A task already being stopped is asked about again: an earlier ask may have failed (a full queue, a failed
    // record), and asking twice only repeats the request.
    const alreadyStopping =
      dispatched.kind === "rejected" && dispatched.rejection.kind === "already_stopping";
    if (dispatched.kind === "rejected" && !alreadyStopping)
      return fail("not_found", `task ${payload.task_id} is not running`);
    if (dispatched.kind === "failed")
      return fail("record_failure", `stop not recorded: ${errorMessage(dispatched.error)}`);
    const asked = task
      ? this.submitText(
          ctx,
          {
            conversation_id: payload.conversation_id,
            text: `[Mia] The user stopped the task "${task.id}" (worker agent ${task.runtimeTaskId}). Stop that worker agent now with TaskStop, and do not start it again.`,
          },
          true,
        )
      : fail("not_found", "the task ended");
    return {
      ok: true,
      result: {
        task_id: payload.task_id,
        gate_closed: true,
        ...(alreadyStopping ? { already_stopping: true } : {}),
        manager_asked: asked.ok,
        ...(asked.ok ? {} : { manager_not_asked: asked.message }),
      },
    };
  }

  /** The interrupt control: every task stops through the engine, whatever the manager agent does. */
  private interruptAll(ctx: CommandContext, payload: { conversation_id: string }): CommandResult {
    const guard = this.guard(ctx, payload.conversation_id);
    if (guard) return guard;
    const running = [...(this.conversation?.tasks.keys() ?? [])];
    const dispatched = this.active.dispatch({ kind: "stop_all", ...this.drawn(), by: "client" });
    return match(dispatched)
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
      .exhaustive();
  }

  /** A client's diagnostics: under the active conversation it is about, else as its row alone. */
  private diagnosticSnapshot(
    ctx: CommandContext,
    payload: { conversation_id: string | null; diagnostics: ClientDiagnostics },
  ): CommandResult {
    try {
      const machine = this.machine;
      if (machine && this.conversation?.id === payload.conversation_id) {
        const dispatched = machine.dispatch({
          kind: "client_diagnostics",
          ...this.drawn(),
          from: { clientId: ctx.clientId, connectionId: ctx.connectionId },
          diagnostics: payload.diagnostics,
        });
        if (dispatched.kind === "failed") throw dispatched.error;
        return { ok: true };
      }
      this.deps.writer.recordDiagnostics({
        id: this.deps.newId("diag"),
        receivedAt: this.deps.now().toISOString(),
        conversationId: null,
        clientId: ctx.clientId,
        clientConnectionId: ctx.connectionId,
        eventId: null,
        capturedAt: payload.diagnostics.captured_at,
        state: payload.diagnostics,
      });
      return { ok: true };
    } catch (error) {
      return fail("record_failure", errorMessage(error));
    }
  }

  private heartbeat(
    ctx: CommandContext,
    payload: Extract<ClientCommand, { type: "heartbeat" }>["payload"],
  ): CommandResult {
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
      return { ok: true };
    } catch (error) {
      return fail("record_failure", errorMessage(error));
    }
  }

  /**
   * Stop for good: refuse every later command, stop every task as the interrupt control does, and wait for the
   * session's end to be recorded or for `turnWait` to abort. It never rejects; a stop that cannot be recorded kills the
   * session anyway, because a runtime left running outlives the server and can keep calling tools.
   */
  async shutdown(turnWait: AbortSignal): Promise<void> {
    this.shuttingDown = true;
    const session = this.session;
    if (session) {
      const dispatched = this.report(session.machine, {
        kind: "stop_all",
        ...this.drawn(),
        by: "shutdown",
      });
      if (dispatched?.kind !== "committed") {
        this.deps.log("shutdown: the stop was not recorded; killing the session anyway");
        session.handle
          .stop(this.deps.stopDeadline())
          .catch((error: unknown) => this.deps.log(`stop failed: ${errorMessage(error)}`));
      }
      const timedOut = Promise.withResolvers<undefined>();
      const onAbort = () => timedOut.resolve(undefined);
      if (turnWait.aborted) onAbort();
      else turnWait.addEventListener("abort", onAbort, { once: true });
      await Promise.race([session.ended, timedOut.promise]).finally(() =>
        turnWait.removeEventListener("abort", onAbort),
      );
    }
    this.stopping.abort(new Error("the server is shutting down"));
  }
}
