import { spawn, type ChildProcess } from "node:child_process";
import { errorMessage, redactString, type RuntimeCancellation } from "@mia/protocol";
import { untilAborted } from "./deadline.ts";
import type { SessionPlan } from "./launch.ts";
import type { RuntimeEvent } from "./runtime-events.ts";
import { parseStreamLine, redactLine, type RuntimeMessage } from "./stream.ts";
import { retainStdout } from "./transcript.ts";

export interface RuntimeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** A spawned runtime process, as a turn and a manager agent's session both follow it. */
export interface RuntimeProcess {
  readonly child: ChildProcess;
  /** Settles once the process is gone and every stdout line is handled, or once a kill gave up waiting for it. */
  readonly exited: Promise<RuntimeExit>;
  /** Why the process failed to run, once its `error` event fired; null otherwise. */
  spawnError(): string | null;
  /** The process has exited or been killed by a signal. */
  hasExited(): boolean;
  /**
   * SIGKILLs the runtime's whole process group and waits for its exit: "forced_kill" once observed, or "unknown" once
   * `deadline` aborts first, when the process is abandoned and its output no longer read so nothing waits on it
   * forever. The entry point builds the deadline.
   * SIGKILL, deliberately not SIGTERM: see `TurnHandle.interrupt` for the runtime behaviour this avoids.
   */
  kill(deadline: AbortSignal): Promise<RuntimeCancellation>;
}

/**
 * Spawns the runtime and follows it: retains its stdout as the transcript, parses each line and hands its message
 * to `onMessage` one at a time in stdout order (a malformed line becomes a `malformed_event`), forwards stderr, and
 * reports the spawn. Returns the reason instead when the process cannot even be created.
 */
export const spawnRuntime = (input: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  streamLogPath: string;
  launch: SessionPlan["description"];
  onMessage: (message: RuntimeMessage) => Promise<void>;
  emit: (event: RuntimeEvent) => Promise<void>;
}): RuntimeProcess | { spawnFailed: string } => {
  const now = () => new Date().toISOString();
  const { emit } = input;
  /**
   * Hands over an event that nothing waits on. `emit` must not reject, so nothing is left to handle; a handler that
   * breaks that contract loses only this event, where on the stdout path its rejection stops the runtime.
   */
  const report = (event: RuntimeEvent): void => {
    emit(event).catch(() => undefined);
  };
  let child: ChildProcess;
  try {
    // detached: the runtime becomes a process-group leader so an interruption can kill it and any helper
    // processes it spawned (e.g. stdio MCP servers) in one signal.
    child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
  } catch (error) {
    return { spawnFailed: `failed to spawn runtime: ${errorMessage(error)}` };
  }
  let spawnError: string | null = null;
  child.once("spawn", () =>
    report({ type: "runtime_started", pid: child.pid ?? -1, launch: input.launch, at: now() }),
  );
  child.once("error", (error) => {
    spawnError = error.message;
  });
  child.stdin?.on("error", () => undefined);

  /** Hands over one stdout line's message, once the last is handled; returns the line's redacted text. */
  const handleLine = async (line: string): Promise<string | null> => {
    const parsed = parseStreamLine(line);
    if (!parsed) return null;
    const retained = redactLine(parsed);
    if (parsed.ok) await input.onMessage(parsed.message);
    else
      await emit({
        type: "malformed_event",
        raw: retained.slice(0, 2000),
        error: parsed.error,
        at: now(),
      });
    return retained;
  };
  const signalGroup = (): void => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  /** Aborted when a stuck runtime is given up on, so its output stops being read. */
  const stopReading = new AbortController();
  const stdoutRead = child.stdout
    ? retainStdout({
        stdout: child.stdout,
        file: input.streamLogPath,
        handleLine,
        signal: stopReading.signal,
        reportFailure: (error) =>
          report({
            type: "runtime_stderr",
            text: `[mia] could not retain the transcript: ${errorMessage(error)}`,
            at: now(),
          }),
      }).catch((error: unknown) => {
        if (stopReading.signal.aborted) return;
        // A runtime whose output Mia no longer reads could keep acting unobserved, so it is stopped; it then ends
        // as failed when the process closes.
        signalGroup();
        report({
          type: "runtime_stderr",
          text: `[mia] stopped reading runtime output, so the runtime was stopped: ${errorMessage(error)}`,
          at: now(),
        });
      })
    : Promise.resolve();
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) =>
    report({ type: "runtime_stderr", text: redactString(chunk), at: now() }),
  );

  /**
   * Settles once the process is gone; a kill judges itself by it. On `exit`, not `close`: `close` also waits for
   * stdout to end, which a slow event handler can hold back after the process has died.
   */
  const processGone = Promise.withResolvers<undefined>();
  child.once("exit", () => processGone.resolve(undefined));
  const exitSettled = Promise.withResolvers<RuntimeExit>();
  // The process counts as exited only once every stdout line has been handled and retained.
  child.once("close", (code, signal) => {
    processGone.resolve(undefined);
    const settle = () => exitSettled.resolve({ code, signal });
    void stdoutRead.then(settle, settle);
  });
  child.once("error", () => {
    processGone.resolve(undefined);
    exitSettled.resolve({ code: null, signal: null });
  });

  return {
    child,
    exited: exitSettled.promise,
    spawnError: () => spawnError,
    hasExited: () => child.exitCode !== null || child.signalCode !== null,
    kill: async (deadline) => {
      signalGroup();
      const outcome = await untilAborted(
        () => processGone.promise.then(() => "exited" as const),
        deadline,
        () => "timeout" as const,
      );
      if (outcome === "exited") return "forced_kill";
      // Do not let a stuck process hold its turn or session open forever: finish it and report uncertainty.
      child.unref();
      stopReading.abort();
      exitSettled.resolve({ code: null, signal: null });
      return "unknown";
    },
  };
};
