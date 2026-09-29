import type { RuntimeCancellation } from "@mia/protocol";
import type {
  GateDecision,
  GateHandler,
  SessionEvent,
  SessionHandle,
  SessionOptions,
  SessionResult,
} from "@mia/agent-adapter";
import type { GateHost, SessionRunner } from "@mia/server";

// A scripted substitute for the manager agent's runtime session and the gate its hook asks (D2): the test plays the
// runtime, reporting turns and worker agents and asking the gate about calls exactly as the real session and hook do.

const at = () => new Date().toISOString();

/** The tool gate the engine decides through, asked by the test instead of a hook. */
export class ScriptedGate implements GateHost {
  readonly url = "http://127.0.0.1:0/gate/scripted";
  private handler: GateHandler | null = null;

  setHandler(handler: GateHandler | null): void {
    this.handler = handler;
  }

  /** Ask the gate about a call, as the hook would; `abandon` aborting stands for the hook going away. */
  ask(input: {
    toolName: string;
    input?: unknown;
    toolUseId: string;
    agentId: string | null;
    abandon?: AbortSignal;
  }): Promise<GateDecision> {
    const handler = this.handler;
    if (!handler) return Promise.resolve({ behavior: "deny", message: "no gate handler" });
    return handler({
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
}

/** One scripted session: the messages the engine sent it, and the controls the test drives it with. */
export class ScriptedSession {
  readonly messages: string[] = [];
  readonly handle: SessionHandle;
  private readonly ended = Promise.withResolvers<SessionResult>();
  private readonly messageWaiters: (() => void)[] = [];
  private open = true;
  stopped = false;

  constructor(readonly options: SessionOptions) {
    const result: SessionResult = {
      status: "ended",
      exit: { code: 0, signal: null },
      error: null,
      streamLogPath: `${options.runtimeDir}/scripted.stream.jsonl`,
      hookEvidencePath: `${options.runtimeDir}/scripted.hooks.jsonl`,
      launch: {
        model: "scripted-model",
        effort: "medium",
        session_id: options.runtimeConversationId,
        resume: options.resume,
        builtin_tools: ["Task", "TaskStop"],
        worker_agents: {},
        mcp_servers: [],
        gate: "pre_tool_use_hook",
        settings: {},
        mcp_config: {},
      },
    };
    this.handle = {
      pid: 4242,
      result: this.ended.promise,
      send: (text) => {
        if (!this.open) return false;
        this.messages.push(text);
        for (const wake of this.messageWaiters.splice(0)) wake();
        return true;
      },
      close: () => {
        this.open = false;
      },
      stop: async (): Promise<RuntimeCancellation> => {
        this.stopped = true;
        this.open = false;
        // As the real session: the kill's consequences arrive only after `stop` returns.
        queueMicrotask(() => this.ended.resolve({ ...result, status: "killed", exit: null }));
        return "forced_kill";
      },
    };
    this.finish = (status) => this.ended.resolve({ ...result, status });
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
    return this.messages;
  }

  emit(event: SessionEvent): Promise<void> {
    return this.options.onEvent(event);
  }

  beginTurn(): Promise<void> {
    return this.emit({
      type: "runtime_init",
      init: { model: "scripted-model", evidence: {} },
      at: at(),
    });
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

  startWorker(runtimeTaskId: string, description: string): Promise<void> {
    return this.emit({
      type: "worker_started",
      runtimeTaskId,
      delegationCallId: `toolu_delegate_${runtimeTaskId}`,
      description,
      prompt: description,
      background: true,
      at: at(),
    });
  }

  endWorker(runtimeTaskId: string, status = "completed"): Promise<void> {
    return this.emit({
      type: "worker_ended",
      runtimeTaskId,
      delegationCallId: `toolu_delegate_${runtimeTaskId}`,
      status,
      summary: `${runtimeTaskId} ${status}`,
      at: at(),
    });
  }

  toolResult(result: { runtimeCallId: string; workerTaskId: string; content: unknown }) {
    return this.emit({
      type: "tool_result",
      runtimeCallId: result.runtimeCallId,
      parentCallId: `toolu_delegate_${result.workerTaskId}`,
      isError: false,
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
