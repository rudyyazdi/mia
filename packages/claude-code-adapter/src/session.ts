import {
  writeLaunchFiles,
  type AgentRuntime,
  type RuntimeConfig,
  type SessionEvent,
  type SessionHandle,
  type SessionOptions,
  type SessionResult,
  type SessionRunner,
  type ToolGate,
} from "@mia/agent-adapter";
import { errorMessage, type RuntimeCancellation } from "@mia/protocol";
import { ApprovalBridge } from "./bridge.ts";
import { ClaudeTranslator, taskEventsOf } from "./claude-translate.ts";
import { prepareSession, type SessionPlan } from "./launch.ts";
import { spawnRuntime } from "./runtime-process.ts";

/**
 * Claude Code, started: the approval bridge its sessions name as their prompt tool, and the sessions themselves. The
 * caller owns the tool gate. `close` closes the bridge.
 */
export class ClaudeCodeRuntime implements AgentRuntime {
  private constructor(
    readonly sessions: ClaudeCodeSessions,
    readonly bridge: ApprovalBridge,
  ) {}

  /** `bridgeLog` names the file the bridge logs its requests to, if any. */
  static async start(input: {
    config: RuntimeConfig;
    gate: ToolGate;
    env: NodeJS.ProcessEnv;
    bridgeLog: string | undefined;
  }): Promise<ClaudeCodeRuntime> {
    const bridge = new ApprovalBridge({ logFile: input.bridgeLog });
    await bridge.start();
    return new ClaudeCodeRuntime(
      new ClaudeCodeSessions(input.config, { gate: input.gate, bridge }, input.env),
      bridge,
    );
  }

  close(): Promise<void> {
    return this.bridge.close();
  }
}

/**
 * A manager agent's session: one runtime process that stays up for the conversation, reads each user message
 * from stdin as a stream-json line, and reports every turn and worker agent on stdout. It owns the process; the
 * caller owns the gate and decides every tool call through it. The runtime replays each message's UUID as a turn
 * takes it (`--replay-user-messages`). `stop` kills the process group with SIGKILL, not SIGTERM: on SIGTERM the
 * runtime closes its MCP connections and re-sends an in-flight call once, bypassing Mia (capability record F1).
 */
export class ClaudeCodeSessions implements SessionRunner {
  /**
   * `gate` carries each session's decisions; `bridge` is the session's prompt tool, which no call should reach (the
   * hook decides every one) and which denies any that does, since it never has a handler.
   */
  constructor(
    readonly config: RuntimeConfig,
    private readonly transport: { gate: ToolGate; bridge: ApprovalBridge },
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  open(options: SessionOptions): SessionHandle {
    const plan = prepareSession({
      config: this.config,
      runtimeDir: options.runtimeDir,
      gateUrl: this.transport.gate.url,
      bridgeUrl: this.transport.bridge.url,
      sessionId: options.runtimeConversationId,
      resume: options.resume,
      sessionIndex: options.sessionIndex,
      managerPromptFile: options.managerPromptFile,
      workerPrompt: options.workerPrompt,
      env: this.env,
    });
    const notStarted = (error: string | null, stopped: boolean): SessionResult => ({
      status: stopped ? "killed" : "failed",
      cancellation: "not_needed",
      exit: null,
      error,
      streamLogPath: plan.files.streamLog,
      hookEvidencePath: plan.files.hookEvidence,
      launch: plan.description,
    });
    // Messages sent while the launch files are written wait here, bounded by the caller's own message bound.
    const queued: { text: string; runtimeMessageId: string }[] = [];
    let running: RunningSession | null = null;
    let stopped = false;
    let closed = false;
    // One session at a time per gate: the open one's decisions go to its handler until it ends.
    const { gate } = this.transport;
    const release = gate.setHandler(options.decide);
    const result = writeLaunchFiles(plan.setup).then(
      () => {
        if (stopped) return notStarted(null, true);
        running = startSession({ plan, onEvent: options.onEvent });
        for (const message of queued.splice(0))
          running.send(message.text, message.runtimeMessageId);
        if (closed) running.close();
        return running.result;
      },
      (error: unknown) =>
        notStarted(`could not write the session files: ${errorMessage(error)}`, stopped),
    );
    result.then(
      () => release(),
      () => release(),
    );
    return {
      // eslint-disable-next-line no-restricted-syntax -- a getter, so pid reads the runtime spawned after this returns
      get pid() {
        return running?.pid;
      },
      result,
      send: (text, runtimeMessageId) => {
        if (stopped || closed) return false;
        if (running) return running.send(text, runtimeMessageId);
        queued.push({ text, runtimeMessageId });
        return true;
      },
      close: () => {
        closed = true;
        running?.close();
      },
      stop: async (deadline) => {
        if (running) return running.stop(deadline);
        stopped = true;
        return "not_needed";
      },
    };
  }
}

interface RunningSession {
  pid: number | undefined;
  result: Promise<SessionResult>;
  send(text: string, runtimeMessageId: string): boolean;
  close(): void;
  stop(deadline: AbortSignal): Promise<RuntimeCancellation>;
}

/** Spawns the session's runtime once its files are written and follows it to its exit. */
const startSession = (input: {
  plan: SessionPlan;
  onEvent: (event: SessionEvent) => Promise<void>;
}): RunningSession => {
  const { plan, onEvent } = input;
  const now = () => new Date().toISOString();
  const base = {
    streamLogPath: plan.files.streamLog,
    hookEvidencePath: plan.files.hookEvidence,
    launch: plan.description,
  };
  const translator = new ClaudeTranslator();
  const runtime = spawnRuntime({
    command: plan.command,
    args: plan.args,
    cwd: plan.cwd,
    env: plan.env,
    streamLogPath: plan.files.streamLog,
    launch: plan.description,
    emit: onEvent,
    onMessage: async (message) => {
      for (const event of translator.translate(message, now)) await onEvent(event);
      for (const event of taskEventsOf(message, now)) await onEvent(event);
    },
  });
  if ("spawnFailed" in runtime)
    return {
      pid: undefined,
      result: Promise.resolve({
        ...base,
        status: "failed",
        cancellation: "not_needed",
        exit: null,
        error: runtime.spawnFailed,
      }),
      send: () => false,
      close: () => undefined,
      stop: async () => "not_needed",
    };
  const { child } = runtime;
  let stopped = false;
  let inputOpen = true;
  let cancellation: RuntimeCancellation = "not_needed";
  child.stdin?.on("error", () => {
    inputOpen = false;
  });

  const result = runtime.exited.then(async (exit): Promise<SessionResult> => {
    inputOpen = false;
    await onEvent({ type: "runtime_exit", code: exit.code, signal: exit.signal, at: now() });
    const spawnError = runtime.spawnError();
    const ended = { ...base, exit, cancellation };
    if (stopped) return { ...ended, status: "killed", error: null };
    if (spawnError)
      return { ...ended, status: "failed", error: `runtime process error: ${spawnError}` };
    if (exit.code === 0) return { ...ended, status: "ended", error: null };
    return {
      ...ended,
      status: "failed",
      error: `runtime exited with code ${exit.code} signal ${exit.signal}`,
    };
  });

  return {
    pid: child.pid,
    result,
    send: (text, runtimeMessageId) => {
      if (!inputOpen || !child.stdin?.writable) return false;
      // One stream-json user message per line, under its UUID, which the runtime replays when a turn takes it.
      child.stdin.write(
        JSON.stringify({
          type: "user",
          uuid: runtimeMessageId,
          message: { role: "user", content: text },
        }) + "\n",
      );
      return true;
    },
    close: () => {
      inputOpen = false;
      child.stdin?.end();
    },
    stop: async (deadline) => {
      if (runtime.hasExited()) return cancellation;
      stopped = true;
      inputOpen = false;
      cancellation = await runtime.kill(deadline);
      return cancellation;
    },
  };
};
