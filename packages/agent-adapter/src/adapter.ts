import { spawnSync } from "node:child_process";
import { existsSync, constants } from "node:fs";
import { mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { match } from "ts-pattern";
import { z } from "zod";
import { errorMessage, isNotFound } from "@mia/protocol";
import type { RuntimeConfig } from "./config.ts";
import { untilAborted } from "./deadline.ts";
import { runtimeEnvironment, type LaunchSetup } from "./launch.ts";
import { resolveExecutableSync } from "./resolve-executable.ts";

/** Printed verbatim as a JSON report by the probe tool, hence snake_case. */
export interface StaticCapabilities {
  executable_resolved: string | null;
  runtime_version: string | null;
  flags_present: Record<string, boolean>;
  credential_source: "ANTHROPIC_API_KEY" | "claude_credentials_file" | "none_detected";
  node_version: string;
  adapter_version: string;
  errors: string[];
}

export const ADAPTER_VERSION = "0.1.0";
const REQUIRED_FLAGS = [
  "--output-format",
  "--include-partial-messages",
  "--effort",
  "--model",
  "--strict-mcp-config",
  "--mcp-config",
  "--settings",
  "--permission-mode",
  "--permission-prompt-tool",
  "--input-format",
  "--replay-user-messages",
  "--agents",
  "--setting-sources",
  "--tools",
  "--append-system-prompt-file",
  "--session-id",
  "--resume",
];

/**
 * Static checks: nothing here contacts a model. `env` is the environment a launch passes on (see
 * `LaunchInput.env`): the executable is looked up on the PATH and run with the environment the launch
 * derives from it (`runtimeEnvironment`), and the credential is detected from it.
 */
export const probeStaticCapabilitiesSync = (
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
): StaticCapabilities => {
  const errors: string[] = [];
  // The launch spawns the runtime in config.workingDirectory with this environment, so probe it the same way.
  const launchEnv = runtimeEnvironment(config, env);
  const resolved = resolveExecutableSync(config.executable, {
    path: launchEnv.PATH,
    cwd: config.workingDirectory,
  });
  if (!resolved) errors.push(`runtime executable "${config.executable}" not found on PATH`);
  let version: string | null = null;
  const flags: Record<string, boolean> = {};
  if (resolved) {
    const versionProbe = spawnSync(resolved, ["--version"], {
      encoding: "utf8",
      timeout: 20_000,
      env: launchEnv,
    });
    version = versionProbe.status === 0 ? versionProbe.stdout.trim() : null;
    if (!version)
      errors.push(
        `"${resolved} --version" failed: ${versionProbe.stderr?.trim() || versionProbe.error?.message || "unknown"}`,
      );
    const help =
      spawnSync(resolved, ["--help"], { encoding: "utf8", timeout: 20_000, env: launchEnv })
        .stdout ?? "";
    for (const flag of REQUIRED_FLAGS) {
      // help abbreviates paired flags as --append-system-prompt[-file]
      const abbreviated = flag.replace(/-file$/, "[-file]");
      flags[flag] = help.includes(flag) || help.includes(abbreviated);
    }
    // --permission-prompt-tool is referenced in help text but not listed; presence in help is enough for the static probe.
    for (const [flag, present] of Object.entries(flags))
      if (!present) errors.push(`required flag ${flag} not present in --help`);
  }
  let credential: StaticCapabilities["credential_source"] = "none_detected";
  if (env.ANTHROPIC_API_KEY) credential = "ANTHROPIC_API_KEY";
  else if (existsSync(join(env.HOME ?? "", ".claude", ".credentials.json")))
    credential = "claude_credentials_file";
  if (credential === "none_detected")
    errors.push(
      "no runtime credential source detected (ANTHROPIC_API_KEY unset, ~/.claude/.credentials.json missing)",
    );
  return {
    executable_resolved: resolved,
    runtime_version: version,
    flags_present: flags,
    credential_source: credential,
    node_version: process.version,
    adapter_version: ADAPTER_VERSION,
    errors,
  };
};

/**
 * Creates the directories and files a session's invocation refers to (see `prepareSession`), owner-only. It
 * settles only after every write has: a conversation's turns share these file names, and a turn does not end before
 * its writes do, so no write of an earlier turn can land over a later turn's settings.
 */
export const writeLaunchFiles = async (setup: LaunchSetup): Promise<void> => {
  for (const directory of setup.directories)
    await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of setup.files) await writeFile(file.path, file.content, { mode: 0o600 });
};

/** One line of the hook evidence file written by the gate hook (gate-hook.mjs): a JSON object of runtime-reported fields. */
const HookEvidenceRecordSchema = z.record(z.string(), z.unknown());

export interface HookEvidence {
  records: Record<string, unknown>[];
  /** Lines that were not a JSON object, such as the truncated last line of a turn killed mid-write. */
  malformedLines: number;
  /** Why the file could not be read for a reason other than being absent, in which case there are no records; else null. */
  readError: string | null;
}

const parseHookLine = (line: string): Record<string, unknown> | null => {
  try {
    const parsed = HookEvidenceRecordSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * A file read while the server serves: one the runtime writes during a turn, read after it ends, or a file a
 * conversation start retains. `absent` when nothing exists at the path.
 */
export type RuntimeFileRead =
  | { status: "absent" }
  | { status: "read"; bytes: Buffer }
  | { status: "unreadable"; reason: string };

/**
 * How a read is bounded: once `signal` aborts, the read is abandoned; a file longer than `maxBytes` is unreadable,
 * and no more than one byte past the cap is ever held in memory.
 */
export interface RuntimeFileReadOptions {
  signal?: AbortSignal;
  maxBytes?: number;
}

/** Reads a file at a path while serving; `readRuntimeFile` is the real one, and a test injects its own. */
export type RuntimeFileReader = (
  path: string,
  options?: RuntimeFileReadOptions,
) => Promise<RuntimeFileRead>;

/** Why an abandoned read is unreadable: an `AbortSignal.timeout` deadline reads as `timed out`. */
const abortReason = (reason: unknown): string =>
  reason instanceof DOMException && reason.name === "TimeoutError"
    ? "timed out"
    : errorMessage(reason);

/** Reads at most `maxBytes` + 1 bytes from the start of `handle`: one more than the cap shows the file is longer. */
const readCapped = async (
  handle: FileHandle,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  const stream = handle.createReadStream({ start: 0, end: maxBytes, autoClose: false, signal });
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

/**
 * Opens without blocking and reads only a regular file. A blocking open of a FIFO waits for a writer that may
 * never come, and a read of one waits for data, each holding one of libuv's few worker threads meanwhile; a
 * runtime that leaves a FIFO on every turn would take one more each turn until every async fs call stalls.
 * O_NOCTTY keeps a terminal device at the path from becoming the server's controlling terminal.
 */
const readRegularFile = async (
  path: string,
  { signal, maxBytes }: RuntimeFileReadOptions,
): Promise<RuntimeFileRead> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { status: "unreadable", reason: "not a regular file" };
    if (maxBytes === undefined) return { status: "read", bytes: await handle.readFile({ signal }) };
    const tooLarge: RuntimeFileRead = {
      status: "unreadable",
      reason: `larger than ${maxBytes} bytes`,
    };
    if (stats.size > maxBytes) return tooLarge;
    // Capped as well, because the file can grow after the stat.
    const bytes = await readCapped(handle, maxBytes, signal);
    return bytes.byteLength > maxBytes ? tooLarge : { status: "read", bytes };
  } finally {
    // Nothing was written through this descriptor, so a failed close loses nothing the result depends on.
    await handle.close().catch(() => undefined);
  }
};

const readOrReport = async (
  path: string,
  options: RuntimeFileReadOptions,
): Promise<RuntimeFileRead> => {
  const { signal } = options;
  try {
    return await readRegularFile(path, options);
  } catch (error) {
    if (signal?.aborted) return { status: "unreadable", reason: abortReason(signal.reason) };
    if (isNotFound(error)) return { status: "absent" };
    return { status: "unreadable", reason: errorMessage(error) };
  }
};

/** Starts one read of a runtime-written file; it never rejects, reporting every failure as a result instead. */
type RuntimeFileReadStart = (
  path: string,
  options: RuntimeFileReadOptions,
) => Promise<RuntimeFileRead>;

/**
 * A reader that abandons a read the moment `signal` aborts (a read is never started under a signal that has
 * already aborted), and refuses to start one while `maxStuckReads` abandoned reads have yet to return.
 *
 * The reader owns the abandoned reads: each one leaves the count when its `read` finally settles. A read that is
 * already in flight when the count reaches the cap can still be abandoned, so the count can exceed the cap by the
 * reads started concurrently with the last abandoned one.
 */
export const boundedRuntimeFileReader = ({
  read,
  maxStuckReads,
}: {
  read: RuntimeFileReadStart;
  maxStuckReads: number;
}): RuntimeFileReader => {
  let stuckReads = 0;
  const release = (): void => {
    stuckReads -= 1;
  };
  return async (path, options = {}) => {
    const { signal } = options;
    // A signal that has already aborted reports its own reason, which `untilAborted` gives without starting.
    if (!signal?.aborted && stuckReads >= maxStuckReads)
      return { status: "unreadable", reason: "an earlier abandoned read is still blocked" };
    let started: Promise<RuntimeFileRead> | null = null;
    let settled = false;
    const markSettled = (): void => {
      settled = true;
    };
    return untilAborted(
      () => {
        started = read(path, options);
        // Neither handler can throw, so these chains never reject.
        void started.then(markSettled, markSettled);
        return started;
      },
      signal,
      (reason) => {
        // An abort landing after the read settled, before the race observed it, leaves nothing blocked to count.
        if (started && !settled) {
          stuckReads += 1;
          void started.then(release, release);
        }
        return { status: "unreadable", reason: abortReason(reason) };
      },
    );
  };
};

/**
 * Abandoned reads the process lets stay blocked before it refuses to start another. The libuv worker pool (4
 * threads by default) is per process, and every async fs call and `dns.lookup` queues behind it, so this keeps
 * threads free when a turn's two concurrent evidence reads (transcript and hook evidence) are the last to stick.
 * A conversation start's two reads (agent prompt and architecture document) share the budget, because the pool is
 * shared: a stale mount under either path can cost later turns their evidence until those reads return. So does a
 * debug-mode read of a body log at a tool result or at turn end.
 */
const MAX_STUCK_READS = 2;

/**
 * Reads a runtime-written file, or a file a conversation start retains, without throwing, because a throw after
 * the turn would keep it from being recorded as finished. Only a missing file is absent; anything that is not a regular file (a directory, a
 * FIFO) and any other failure (EACCES, ENOTDIR) is reported. Asynchronous because the server reads at turn end
 * while it serves other connections.
 *
 * A read is unreadable the moment `signal` aborts, even if the `open()` or `read()` under it is blocked (a
 * regular file on a stale mount): `readFile`'s own signal is only checked between those calls. Nothing avoids
 * that blocked call, so each such abandoned read keeps its descriptor, and a libuv worker thread, until the
 * kernel returns, and then closes the descriptor. While `MAX_STUCK_READS` of them are still blocked, every read
 * is unreadable without starting: a hung mount then costs later turns their evidence, even on a healthy path,
 * instead of stalling the whole process.
 */
export const readRuntimeFile: RuntimeFileReader = boundedRuntimeFileReader({
  read: readOrReport,
  maxStuckReads: MAX_STUCK_READS,
});

/** Counts and skips malformed lines, such as the truncated last line of a turn killed mid-write. */
const parseHookEvidence = (text: string): HookEvidence => {
  const evidence: HookEvidence = { records: [], malformedLines: 0, readError: null };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const record = parseHookLine(line);
    if (record) evidence.records.push(record);
    else evidence.malformedLines += 1;
  }
  return evidence;
};

/** Evidence is best-effort: a malformed line is skipped, and an unreadable file is reported rather than thrown. */
export const hookEvidenceFrom = (read: RuntimeFileRead): HookEvidence =>
  match(read)
    .with({ status: "absent" }, () => parseHookEvidence(""))
    .with({ status: "unreadable" }, ({ reason }) => ({
      ...parseHookEvidence(""),
      readError: reason,
    }))
    .with({ status: "read" }, ({ bytes }) => parseHookEvidence(bytes.toString("utf8")))
    .exhaustive();
