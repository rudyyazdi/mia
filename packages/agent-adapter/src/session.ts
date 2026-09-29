import { errorMessage, type RuntimeCancellation } from "@mia/protocol";
import { writeLaunchFiles } from "./adapter.ts";
import type { ApprovalBridge } from "./bridge.ts";
import { ClaudeTranslator, taskEventsOf } from "./claude-translate.ts";
import type { RuntimeConfig } from "./config.ts";
import { prepareSession, type SessionPlan } from "./launch.ts";
import type { SessionEvent } from "./runtime-events.ts";
import { spawnRuntime } from "./runtime-process.ts";

export interface SessionOptions {
  runtimeConversationId: string;
  /** False creates the runtime session (`--session-id`); true resumes it (`--resume`), so it must already exist. */
  resume: boolean;
  runtimeDir: string;
  sessionIndex: number;
  managerPromptFile: string | null;
  workerPrompt: string;
  /** The tool gate's URL (see `ToolGate`); the caller owns the gate and its handler. */
  gateUrl: string;
  /** As `TurnOptions.onEvent`: handled one at a time in stdout order, and it must not reject. */
  onEvent: (event: SessionEvent) => Promise<void>;
}

export interface SessionResult {
  /** ended: the runtime exited on its own after stdin closed; killed: `stop` ended it; failed: anything else. */
  status: "ended" | "killed" | "failed";
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  error: string | null;
  streamLogPath: string;
  hookEvidencePath: string;
  launch: SessionPlan["description"];
}

export interface SessionHandle {
  readonly pid: number | undefined;
  readonly result: Promise<SessionResult>;
  /**
   * Hands the manager agent one user message. Returns false when the session no longer reads input (it ended, or
   * was stopped or closed), so the caller records the message as not delivered rather than assuming it was.
   */
  send(text: string): boolean;
  /** Closes stdin: the runtime finishes what it has and exits. Stopping afterwards still kills it. */
  close(): void;
  /**
   * Kills the runtime's process group with SIGKILL, stopping the manager agent and every worker agent at once (the
   * reason is the one on `TurnHandle.interrupt`). Resolves once exit is observed, or "unknown" after EXIT_WAIT_MS.
   */
  stop(): Promise<RuntimeCancellation>;
}

/**
 * A manager agent's session (D2): one runtime process that stays up for the conversation, reads each user message
 * from stdin as a stream-json line, and reports every turn and worker agent on stdout. It owns the process; the
 * caller owns the gate and decides every tool call through it.
 */
export class ClaudeCodeSessions {
  constructor(
    readonly config: RuntimeConfig,
    readonly bridge: ApprovalBridge,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  open(options: SessionOptions): SessionHandle {
    const plan = prepareSession({
      config: this.config,
      runtimeDir: options.runtimeDir,
      bridgeUrl: this.bridge.url,
      gateUrl: options.gateUrl,
      sessionId: options.runtimeConversationId,
      resume: options.resume,
      sessionIndex: options.sessionIndex,
      managerPromptFile: options.managerPromptFile,
      workerPrompt: options.workerPrompt,
      env: this.env,
    });
    const notStarted = (error: string | null, stopped: boolean): SessionResult => ({
      status: stopped ? "killed" : "failed",
      exit: null,
      error,
      streamLogPath: plan.files.streamLog,
      hookEvidencePath: plan.files.hookEvidence,
      launch: plan.description,
    });
    // Messages sent while the launch files are written wait here, bounded by the caller's own message bound.
    const queued: string[] = [];
    let running: RunningSession | null = null;
    let stopped = false;
    let closed = false;
    const result = writeLaunchFiles(plan.setup).then(
      () => {
        if (stopped) return notStarted(null, true);
        running = startSession({ plan, onEvent: options.onEvent });
        for (const text of queued.splice(0)) running.send(text);
        if (closed) running.close();
        return running.result;
      },
      (error: unknown) =>
        notStarted(`could not write the session files: ${errorMessage(error)}`, stopped),
    );
    return {
      // eslint-disable-next-line no-restricted-syntax -- a getter, so pid reads the runtime spawned after this returns
      get pid() {
        return running?.pid;
      },
      result,
      send: (text) => {
        if (stopped || closed) return false;
        if (running) return running.send(text);
        queued.push(text);
        return true;
      },
      close: () => {
        closed = true;
        running?.close();
      },
      stop: async () => {
        if (running) return running.stop();
        stopped = true;
        return "not_needed";
      },
    };
  }
}

interface RunningSession {
  pid: number | undefined;
  result: Promise<SessionResult>;
  send(text: string): boolean;
  close(): void;
  stop(): Promise<RuntimeCancellation>;
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
    launch: launchOf(plan),
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
    if (stopped) return { ...base, exit, status: "killed", error: null };
    if (spawnError)
      return { ...base, exit, status: "failed", error: `runtime process error: ${spawnError}` };
    if (exit.code === 0) return { ...base, exit, status: "ended", error: null };
    return {
      ...base,
      exit,
      status: "failed",
      error: `runtime exited with code ${exit.code} signal ${exit.signal}`,
    };
  });

  return {
    pid: child.pid,
    result,
    send: (text) => {
      if (!inputOpen || !child.stdin?.writable) return false;
      // One stream-json user message per line: the runtime reads each as the next user turn.
      child.stdin.write(
        JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n",
      );
      return true;
    },
    close: () => {
      inputOpen = false;
      child.stdin?.end();
    },
    stop: async () => {
      if (runtime.hasExited()) return cancellation;
      stopped = true;
      inputOpen = false;
      cancellation = await runtime.kill();
      return cancellation;
    },
  };
};

/**
 * The session's launch description as `runtime_started` carries it: the turn runtime's shape, so records and
 * provenance read one kind of launch event.
 */
const launchOf = (plan: SessionPlan) => ({
  model: plan.description.model,
  effort: plan.description.effort,
  session_id: plan.description.session_id,
  resume: plan.description.resume,
  builtin_tools: plan.description.builtin_tools,
  mcp_servers: plan.description.mcp_servers,
  permission_prompt_tool: "none: every call passes the gate hook",
  settings: plan.description.settings,
  mcp_config: plan.description.mcp_config,
});
