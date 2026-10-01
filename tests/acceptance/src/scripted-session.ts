import { join } from "node:path";
import type {
  GateDecision,
  SessionEvent,
  SessionHandle,
  SessionOptions,
  SessionResult,
  SessionRunner,
  WorkerEnd,
} from "@mia/agent-adapter";
import type { RuntimeCancellation } from "@mia/protocol";

// A scripted substitute for the runtime (the only thing acceptance tests fake): the test plays the manager agent's
// session, reporting turns and worker agents and asking the engine about calls exactly as the real session and its
// gate hook do.

const at = () => new Date().toISOString();

/** One scripted session: the messages the engine sent it, and the controls the test drives it with. */
export class ScriptedSession {
  readonly messages: { text: string; runtimeMessageId: string }[] = [];
  readonly handle: SessionHandle;
  private readonly ended = Promise.withResolvers<SessionResult>();
  private readonly messageWaiters: (() => void)[] = [];
  private open = true;
  stopped = false;
  /** What `stop` reports once called; a test sets "unknown" to stand for a kill whose exit was never seen. */
  cancellation: RuntimeCancellation = "forced_kill";
  /** False holds the killed session's exit until the test calls `exitAfterStop`, as a slow-dying runtime would. */
  exitsOnStop = true;
  private exitStopped: (() => void) | null = null;

  constructor(readonly options: SessionOptions) {
    const result: Omit<SessionResult, "status" | "cancellation"> = {
      exit: { code: 0, signal: null },
      error: null,
      streamLogPath: join(options.runtimeDir, "scripted.stream.jsonl"),
      hookEvidencePath: join(options.runtimeDir, "scripted.hooks.jsonl"),
      launch: {
        model: "scripted-model",
        effort: "medium",
        session_id: options.runtimeConversationId,
        resume: options.resume,
        builtin_tools: ["Task", "TaskStop"],
        mcp_servers: [],
      },
    };
    this.finish = (status) => this.ended.resolve({ ...result, status, cancellation: "not_needed" });
    this.handle = {
      pid: 4242,
      result: this.ended.promise,
      send: (text, runtimeMessageId) => {
        if (!this.open) return false;
        this.messages.push({ text, runtimeMessageId });
        for (const wake of this.messageWaiters.splice(0)) wake();
        return true;
      },
      close: () => {
        this.open = false;
      },
      stop: async () => {
        this.stopped = true;
        this.open = false;
        const { cancellation } = this;
        const exit = () =>
          this.ended.resolve({ ...result, status: "killed", exit: null, cancellation });
        // As the real session: the kill's consequences arrive only after `stop` returns.
        if (this.exitsOnStop) queueMicrotask(exit);
        else this.exitStopped = exit;
        return cancellation;
      },
    };
  }

  /** Let a session held by `exitsOnStop = false` exit now that it was stopped. */
  exitAfterStop(): void {
    this.exitStopped?.();
  }

  /** End the session on its own, as the runtime exiting after stdin closed or failing. */
  readonly finish: (status: SessionResult["status"]) => void;

  /** Resolves once the engine has sent `count` messages in all. */
  async waitForMessages(count: number): Promise<string[]> {
    while (this.messages.length < count) {
      const next = Promise.withResolvers<undefined>();
      this.messageWaiters.push(() => next.resolve(undefined));
      await next.promise;
    }
    return this.messages.map((message) => message.text);
  }

  emit(event: SessionEvent): Promise<void> {
    return this.options.onEvent(event);
  }

  /** Begin a turn, and with `takes`, take the `takes`th message sent (0 for the first), as the runtime replays it. */
  async beginTurn(takes?: number): Promise<void> {
    await this.emit({
      type: "runtime_init",
      init: { model: "scripted-model", evidence: {} },
      at: at(),
    });
    if (takes === undefined) return;
    const message = this.messages[takes];
    if (!message) throw new Error(`no message ${takes} was sent`);
    await this.emit({ type: "input_taken", runtimeMessageId: message.runtimeMessageId, at: at() });
  }

  reply(text: string): Promise<void> {
    return this.emit({ type: "text_delta", text, parentCallId: null, at: at() });
  }

  endTurn(): Promise<void> {
    return this.emit({
      type: "turn_result",
      summary: { isError: false, outcome: "success", evidence: {} },
      at: at(),
    });
  }

  /** The manager agent asks to delegate to Mia's worker agent in the background; allowed, the runtime starts it. */
  async delegate(
    runtimeTaskId: string,
    description = `task ${runtimeTaskId}`,
  ): Promise<GateDecision> {
    const decision = await this.ask({
      toolName: "Agent",
      input: { subagent_type: "mia-worker", run_in_background: true, prompt: description },
      toolUseId: `toolu_delegate_${runtimeTaskId}`,
      agentId: null,
    });
    if (decision.behavior === "allow")
      await this.emit({
        type: "worker_started",
        runtimeTaskId,
        delegationCallId: `toolu_delegate_${runtimeTaskId}`,
        description,
        prompt: description,
        background: true,
        at: at(),
      });
    return decision;
  }

  endWorker(runtimeTaskId: string, end: WorkerEnd = "completed"): Promise<void> {
    return this.emit({
      type: "worker_ended",
      runtimeTaskId,
      delegationCallId: `toolu_delegate_${runtimeTaskId}`,
      end,
      runtimeStatus: end,
      summary: `${runtimeTaskId} ${end}`,
      at: at(),
    });
  }

  /**
   * Ask the engine about a call, as the gate hook would; `abandon` aborting stands for the hook going away. A manager
   * agent's call is first proposed on stdout, as the runtime streams it before running the hook, unless `unproposed`.
   */
  async ask(input: {
    toolName: string;
    input?: unknown;
    toolUseId: string;
    agentId: string | null;
    abandon?: AbortSignal;
    unproposed?: boolean;
  }): Promise<GateDecision> {
    if (input.agentId === null && input.unproposed !== true)
      await this.emit({
        type: "tool_proposed",
        runtimeCallId: input.toolUseId,
        parentCallId: null,
        toolIdentity: input.toolName,
        arguments: input.input ?? {},
        complete: false,
        at: at(),
      });
    return this.options.decide({
      toolName: input.toolName,
      input: input.input ?? {},
      toolUseId: input.toolUseId,
      agentId: input.agentId,
      agentType: input.agentId === null ? null : "mia-worker",
      raw: {},
      receivedAt: at(),
      abandoned: input.abandon ?? new AbortController().signal,
    });
  }

  toolResult(result: {
    runtimeCallId: string;
    workerTaskId: string;
    content: unknown;
    isError?: boolean;
  }): Promise<void> {
    return this.emit({
      type: "tool_result",
      runtimeCallId: result.runtimeCallId,
      parentCallId: `toolu_delegate_${result.workerTaskId}`,
      isError: result.isError ?? false,
      content: result.content,
      raw: null,
      at: at(),
    });
  }
}

/** The scripted runtime's sessions, in the order the engine opened them. */
export class ScriptedSessions implements SessionRunner {
  readonly opened: ScriptedSession[] = [];
  private readonly waiters: (() => void)[] = [];

  open(options: SessionOptions): SessionHandle {
    const session = new ScriptedSession(options);
    this.opened.push(session);
    for (const wake of this.waiters.splice(0)) wake();
    return session.handle;
  }

  /** Resolves with the `index`th session (0 for the first) once the engine has opened it. */
  async session(index = 0): Promise<ScriptedSession> {
    for (;;) {
      const session = this.opened[index];
      if (session) return session;
      const next = Promise.withResolvers<undefined>();
      this.waiters.push(() => next.resolve(undefined));
      await next.promise;
    }
  }
}
