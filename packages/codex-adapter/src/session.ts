import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { match } from "ts-pattern";
import { z } from "zod";
import {
  DELEGATE_TOOL,
  redactJsonLine,
  sessionResultOf,
  spawnRuntime,
  writeLaunchFiles,
  type AgentRuntime,
  type CodexConfig,
  type GateDecision,
  type GateRequest,
  type RuntimeProcess,
  type SessionEvent,
  type SessionHandle,
  type SessionOptions,
  type SessionResult,
  type SessionRunner,
  type ToolGate,
} from "@mia/agent-adapter";
import { errorMessage, type RuntimeCancellation } from "@mia/protocol";
import { backstopAnswer } from "./backstop.ts";
import { CodexConnection } from "./connection.ts";
import { miaGateRequest } from "./gate-mapping.ts";
import { gateHookTrust, trustEdit } from "./hook-trust.ts";
import { DELEGATION_INSTRUCTIONS, prepareCodexSession, type CodexSessionPlan } from "./launch.ts";
import { ADAPTER_VERSION } from "./probe.ts";
import { HooksListResultSchema, parseCodexLine, ThreadResultSchema } from "./protocol.ts";
import { ProposalRendezvous } from "./proposals.ts";
import { CodexTranslator, type Notification } from "./translate.ts";
import { reportOf, TurnQueue } from "./turn-queue.ts";

/** What every Codex session needs from the runtime that opens it. */
interface CodexDeps {
  config: CodexConfig;
  gate: ToolGate;
  env: NodeJS.ProcessEnv;
  codexHome: string;
  /**
   * A fresh deadline for each wait on Codex: for its answer to a request, and for a manager agent's call to be paired
   * with stdout's report of its hook (see `ProposalRendezvous`). The entry point builds it.
   */
  replyDeadline: () => AbortSignal;
}

/** Codex, started: it owns nothing besides its sessions, and the caller owns the gate. */
export class CodexRuntime implements AgentRuntime {
  private constructor(readonly sessions: CodexSessions) {}

  static start(deps: CodexDeps): Promise<CodexRuntime> {
    return Promise.resolve(new CodexRuntime(new CodexSessions(deps)));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Opens manager agents' sessions, each one `codex app-server` process for the conversation. One session at a time per
 * gate: the open one's decisions go to its handler until it ends.
 */
export class CodexSessions implements SessionRunner {
  constructor(private readonly deps: CodexDeps) {}

  open(options: SessionOptions): SessionHandle {
    const plan = prepareCodexSession({
      config: this.deps.config,
      codexHome: this.deps.codexHome,
      runtimeDir: options.runtimeDir,
      gateUrl: this.deps.gate.url,
      sessionId: options.runtimeConversationId,
      resume: options.resume,
      sessionIndex: options.sessionIndex,
      workerPrompt: options.workerPrompt,
      env: this.deps.env,
    });
    const session = new CodexSession(plan, options, this.deps);
    const release = this.deps.gate.setHandler((request) => session.decide(request));
    const result = session.run();
    result.then(
      () => release(),
      () => release(),
    );
    return session.handle(result);
  }
}

/** Which Codex thread holds a conversation, written when the thread is started and read to resume it. */
const ThreadRecordSchema = z.object({ runtimeConversationId: z.string(), threadId: z.string() });

/** How many delegations a session remembers between their allow and their worker agent's start. */
const MAX_PENDING_SPAWNS = 64;

/**
 * One manager agent's session: it starts the manager agent's turns one at a time from its `TurnQueue`. Input ends
 * once the session is closed, idle, has nothing queued and no worker agent running; Codex exits at the end of its
 * input.
 */
class CodexSession {
  readonly #translator = new CodexTranslator();
  readonly #proposals = new ProposalRendezvous();
  /** Delegations the gate allowed whose worker agent has not been reported started. */
  readonly #pendingSpawns = new Set<string>();
  readonly #queue = new TurnQueue();
  readonly #connection: CodexConnection;
  #runtime: RuntimeProcess | null = null;
  #threadId: string | null = null;
  /** starting: before the thread is ready; idle: between turns; turn: a manager agent's turn runs. */
  #phase: "starting" | "idle" | "turn" = "starting";
  #stopped = false;
  #closed = false;
  #inputEnded = false;
  #cancellation: RuntimeCancellation = "not_needed";
  /** Why Mia gave up on the session, which then ends as failed. */
  #failure: string | null = null;

  constructor(
    private readonly plan: CodexSessionPlan,
    private readonly options: SessionOptions,
    private readonly deps: CodexDeps,
  ) {
    this.#connection = new CodexConnection((line) => this.#write(line));
  }

  /**
   * Decides a call through the caller's handler, in Mia's vocabulary, and remembers an allowed delegation. A manager
   * agent's call is read once stdout reaches its hook, so a stop finds the worker agents stdout reported before it.
   */
  async decide(request: GateRequest): Promise<GateDecision> {
    const read = () => miaGateRequest(request, (target) => this.#translator.taskIdOf(target));
    const callId = request.toolUseId;
    const mia =
      request.agentId === null && callId !== undefined
        ? await this.#proposals.offer(callId, read, this.deps.replyDeadline())
        : read();
    const decision = await this.options.decide(mia);
    const delegation = mia.agentId === null && mia.toolName === DELEGATE_TOOL;
    if (delegation && callId !== undefined && decision.behavior === "allow") {
      this.#pendingSpawns.add(callId);
      if (this.#pendingSpawns.size > MAX_PENDING_SPAWNS) {
        const oldest = this.#pendingSpawns.values().next();
        if (!oldest.done) this.#pendingSpawns.delete(oldest.value);
      }
    }
    return decision;
  }

  handle(result: Promise<SessionResult>): SessionHandle {
    const runtime = () => this.#runtime;
    return {
      // eslint-disable-next-line no-restricted-syntax -- a getter, so pid reads the runtime spawned after this returns
      get pid() {
        return runtime()?.child.pid;
      },
      result,
      send: (text, runtimeMessageId) => {
        if (this.#stopped || this.#closed || this.#inputEnded) return false;
        this.#queue.message(text, runtimeMessageId);
        this.#pump();
        return true;
      },
      close: () => {
        this.#closed = true;
        this.#pump();
      },
      stop: async (deadline) => {
        const running = this.#runtime;
        // A runtime that already exited ends as it did; only one that is still running is killed.
        if (running?.hasExited()) return this.#cancellation;
        this.#stopped = true;
        if (!running) return this.#cancellation;
        this.#cancellation = await running.kill(deadline);
        return this.#cancellation;
      },
    };
  }

  async run(): Promise<SessionResult> {
    const files = {
      streamLogPath: this.plan.files.streamLog,
      hookEvidencePath: this.plan.files.hookEvidence,
      launch: this.plan.description,
    };
    const notStarted = (error: string | null): SessionResult => ({
      ...files,
      status: this.#stopped ? "killed" : "failed",
      cancellation: "not_needed",
      exit: null,
      error,
    });
    let instructions: { developer: string; resumeThread: string | null };
    try {
      instructions = await this.#prepare();
    } catch (error) {
      return notStarted(`could not prepare the session: ${errorMessage(error)}`);
    }
    if (this.#stopped) return notStarted(null);
    const { plan } = this;
    const runtime = spawnRuntime({
      command: plan.command,
      args: plan.args,
      cwd: plan.cwd,
      env: plan.env,
      streamLogPath: plan.files.streamLog,
      launch: plan.description,
      emit: this.options.onEvent,
      handleLine: (line) => this.#handleLine(line),
    });
    if ("spawnFailed" in runtime) return notStarted(runtime.spawnFailed);
    this.#runtime = runtime;
    runtime.child.stdin?.on("error", () => {
      this.#inputEnded = true;
    });
    this.#startThread(instructions).catch((error: unknown) =>
      this.#giveUp(`could not start the Codex thread: ${errorMessage(error)}`),
    );
    const exit = await runtime.exited;
    this.#inputEnded = true;
    this.#connection.close("the runtime exited");
    await this.options.onEvent({ type: "runtime_exit", ...exit, at: now() });
    return sessionResultOf({
      exit,
      cancellation: this.#cancellation,
      stopped: this.#stopped,
      failure: this.#failure,
      spawnError: runtime.spawnError(),
      files,
    });
  }

  /** Writes the launch files and links the user's login, and reads what the thread starts with. */
  async #prepare(): Promise<{ developer: string; resumeThread: string | null }> {
    const { plan, options } = this;
    await writeLaunchFiles(plan.setup);
    await rm(plan.auth.link, { force: true });
    await symlink(plan.auth.source, plan.auth.link);
    const prompt =
      options.managerPromptFile === null ? null : await readFile(options.managerPromptFile, "utf8");
    const developer = [prompt, DELEGATION_INSTRUCTIONS]
      .filter((part) => part !== null)
      .join("\n\n");
    if (!options.resume) return { developer, resumeThread: null };
    const record = ThreadRecordSchema.parse(
      JSON.parse(await readFile(plan.files.threadRecord, "utf8")),
    );
    if (record.runtimeConversationId !== options.runtimeConversationId)
      throw new Error(`${plan.files.threadRecord} records another conversation's thread`);
    return { developer, resumeThread: record.threadId };
  }

  /** Initializes the connection, makes sure the gate hook runs, and starts or resumes the manager agent's thread. */
  async #startThread(instructions: {
    developer: string;
    resumeThread: string | null;
  }): Promise<void> {
    const rpc = this.#connection;
    const { config } = this.deps;
    const reply = this.deps.replyDeadline;
    await rpc.request(
      "initialize",
      {
        clientInfo: { name: "mia", title: "Mia", version: ADAPTER_VERSION },
        capabilities: { experimentalApi: true },
      },
      reply(),
    );
    rpc.notify("initialized");
    await this.#trustGateHook();
    const thread = {
      model: config.model,
      cwd: config.workingDirectory,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: instructions.developer,
    };
    const started = ThreadResultSchema.parse(
      instructions.resumeThread === null
        ? await rpc.request("thread/start", { ...thread, ephemeral: false }, reply())
        : await rpc.request(
            "thread/resume",
            { ...thread, threadId: instructions.resumeThread, excludeTurns: true },
            reply(),
          ),
    );
    const threadId = started.thread.id;
    this.#translator.adopt({ threadId, model: started.model });
    if (instructions.resumeThread === null) {
      const record = { runtimeConversationId: this.options.runtimeConversationId, threadId };
      await writeFile(this.plan.files.threadRecord, JSON.stringify(record), { mode: 0o600 });
    }
    this.#threadId = threadId;
    this.#phase = "idle";
    this.#pump();
  }

  /**
   * Trusts Mia's own hook by the hash Codex reports, and refuses to go on unless Codex then runs it: without the
   * hook no call would be gated.
   */
  async #trustGateHook(): Promise<void> {
    const hook = { source: this.plan.files.hooks, command: this.plan.hookCommand };
    const list = async () =>
      HooksListResultSchema.parse(
        await this.#connection.request(
          "hooks/list",
          { cwds: [this.deps.config.workingDirectory] },
          this.deps.replyDeadline(),
        ),
      );
    const before = gateHookTrust(await list(), hook);
    if (before.kind === "untrusted")
      await this.#connection.request(
        "config/batchWrite",
        trustEdit(before.key, before.hash),
        this.deps.replyDeadline(),
      );
    const after = before.kind === "untrusted" ? gateHookTrust(await list(), hook) : before;
    if (after.kind !== "trusted")
      throw new Error(`Codex will not run Mia's gate hook (${after.kind})`);
  }

  /** Starts the manager agent's next turn when it is idle and something is queued; ends input once all is done. */
  #pump(): void {
    const threadId = this.#threadId;
    if (this.#phase !== "idle" || threadId === null || this.#stopped || this.#inputEnded) return;
    const next = this.#queue.take();
    if (!next) {
      if (this.#closed && this.#translator.runningWorkers === 0) this.#endInput();
      return;
    }
    this.#phase = "turn";
    const params = match(next)
      .with({ kind: "message" }, ({ text, runtimeMessageId }) => ({
        input: [{ type: "text", text, text_elements: [] }],
        clientUserMessageId: runtimeMessageId,
      }))
      .with({ kind: "ends" }, ({ ends, unlisted }) => ({
        input: [{ type: "text", text: reportOf(ends, unlisted), text_elements: [] }],
      }))
      .exhaustive();
    // A turn Codex refused would leave its message or its ends unreported for good, so the session ends instead,
    // and the engine records what it had sent as lost with the session.
    this.#connection
      .request(
        "turn/start",
        { threadId, effort: this.deps.config.effort, ...params },
        this.deps.replyDeadline(),
      )
      .catch((error: unknown) =>
        this.#giveUp(`Codex did not start a turn: ${errorMessage(error)}`),
      );
  }

  /** Gives up on the session: it ends as failed once Codex exits at the end of its input. */
  #giveUp(reason: string): void {
    this.#failure ??= reason;
    this.#note(`[mia] ${reason}`);
    this.#endInput();
  }

  #endInput(): void {
    if (this.#inputEnded) return;
    this.#inputEnded = true;
    this.#runtime?.child.stdin?.end();
  }

  #write(line: string): boolean {
    const stdin = this.#runtime?.child.stdin;
    if (this.#inputEnded || !stdin?.writable) return false;
    stdin.write(`${line}\n`);
    return true;
  }

  /** Reports a note that nothing waits on, as the process's own stderr is reported. */
  #note(text: string): void {
    this.options.onEvent({ type: "runtime_stderr", text, at: now() }).catch(() => undefined);
  }

  /** Handles one stdout line in order, and returns its redacted text for the transcript. */
  async #handleLine(line: string): Promise<string | null> {
    const parsed = parseCodexLine(line);
    if (!parsed) return null;
    const retained = redactJsonLine(parsed.line);
    if (!parsed.ok) {
      await this.options.onEvent({
        type: "malformed_event",
        raw: retained.slice(0, 2000),
        error: parsed.error,
        at: now(),
      });
      return retained;
    }
    await match(parsed.message)
      .with({ kind: "response" }, (response) => this.#connection.settle(response))
      .with({ kind: "request" }, async ({ id, method }) => {
        const answer = backstopAnswer(method);
        if (answer.kind === "result") this.#connection.respond(id, answer.result);
        else this.#connection.refuse(id, answer.message);
        await this.options.onEvent({
          type: "runtime_stderr",
          text: `[mia] declined Codex's ${method}`,
          at: now(),
        });
      })
      .with({ kind: "notification" }, (notification) => this.#onNotification(notification))
      .exhaustive();
    return retained;
  }

  async #onNotification(notification: Notification): Promise<void> {
    const { onEvent } = this.options;
    const hookCall = this.#translator.managerHookStart(notification);
    if (hookCall !== null) {
      const call = await this.#proposals.take(hookCall, this.deps.replyDeadline());
      if (call)
        await onEvent({
          type: "tool_proposed",
          runtimeCallId: hookCall,
          parentCallId: null,
          toolIdentity: call.toolName,
          arguments: call.input,
          complete: true,
          at: now(),
        });
    }
    for (const event of this.#translator.translate(notification, now)) {
      await onEvent(event);
      await this.#react(event);
    }
  }

  /** What the session does after handing over an event: settles delegations, queues ends, takes the next turn. */
  async #react(event: SessionEvent): Promise<void> {
    if (event.type === "worker_started") this.#pendingSpawns.delete(event.delegationCallId);
    if (event.type === "worker_ended") {
      this.#queue.end({
        path: this.#translator.pathOf(event.runtimeTaskId) ?? event.runtimeTaskId,
        threadId: event.runtimeTaskId,
        end: event.end,
        // The event's summary is redacted for the records; the manager agent reads what the worker agent wrote.
        summary: this.#translator.finalTextOf(event.runtimeTaskId),
      });
      this.#pump();
    }
    if (event.type !== "turn_result") return;
    // A delegation the gate allowed whose worker agent Codex never reported starting did not start.
    for (const callId of [...this.#pendingSpawns]) {
      this.#pendingSpawns.delete(callId);
      await this.options.onEvent({
        type: "tool_result",
        runtimeCallId: callId,
        parentCallId: null,
        isError: true,
        content: "Codex started no worker agent for this call.",
        raw: null,
        at: now(),
      });
    }
    this.#phase = "idle";
    this.#pump();
  }
}

const now = (): string => new Date().toISOString();
