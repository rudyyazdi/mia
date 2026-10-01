import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { basename, delimiter, dirname, resolve } from "node:path";

export interface ExecutableLookup {
  /** The PATH the runtime is launched with; unset means spawn's default search path. */
  path: string | undefined;
  /** The directory the runtime is launched in: a name containing "/", and a relative PATH entry, resolve against it. */
  cwd: string;
}

/** Where `spawn` (libuv) looks a name up when the environment it is given has no PATH. */
const DEFAULT_SEARCH_PATH = "/usr/bin:/bin";

const isExecutableFileSync = (candidate: string): boolean => {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};

/**
 * Finds the file `spawn` would run for `executable`, as an absolute path, or null. Resolved in Node rather than with a
 * shell's `command -v` so the name is only ever a path, never shell code. Follows execvp: a name containing "/" is a
 * path, any other name is looked up in each PATH entry in order (an empty entry is the working directory), and an
 * unset PATH falls back to spawn's default search path.
 */
export const resolveExecutableSync = (
  executable: string,
  lookup: ExecutableLookup,
): string | null => {
  if (executable.includes("/")) {
    const candidate = resolve(lookup.cwd, executable);
    return isExecutableFileSync(candidate) ? candidate : null;
  }
  return (
    (lookup.path ?? DEFAULT_SEARCH_PATH)
      .split(delimiter)
      .map((entry) => resolve(lookup.cwd, entry, executable))
      .find(isExecutableFileSync) ?? null
  );
};

/** Whether a PATH entry is a package's `node_modules/.bin`, which npm puts first on PATH for a script it runs. */
const isPackageBin = (entry: string): boolean => {
  const directory = entry.replace(/\/+$/, "");
  return basename(directory) === ".bin" && basename(dirname(directory)) === "node_modules";
};

/**
 * The environment a runtime runs with: the defined entries of `env`, overlaid with `overlay` (a profile's `env`).
 * The inherited PATH loses its `node_modules/.bin` entries: `npm run` prepends them, and a dependency's bundled copy
 * of a runtime (promptfoo bundles a Codex CLI) would otherwise shadow the one the user installed, so the runtime
 * found, probed and launched is the same with `npm run` as without. A PATH the overlay sets is kept as it is.
 */
export const overlaidEnvironment = (
  env: NodeJS.ProcessEnv,
  overlay: Readonly<Record<string, string>>,
): Record<string, string> => {
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) merged[name] = value;
  if (merged.PATH !== undefined) {
    const kept = merged.PATH.split(delimiter).filter((entry) => !isPackageBin(entry));
    // An empty PATH would search the working directory; with nothing left, spawn's default search path applies.
    if (kept.length === 0) delete merged.PATH;
    else merged.PATH = kept.join(delimiter);
  }
  return Object.assign(merged, overlay);
};

/** What a static probe found of a runtime's executable: its absolute path and the version it prints. */
export interface ExecutableProbe {
  resolved: string | null;
  version: string | null;
  errors: string[];
}

/**
 * Finds `executable` as a launch would (in `cwd`, on `env`'s PATH) and asks it its `--version`. Blocks: a static
 * probe runs before serving.
 */
export const probeExecutableSync = (
  executable: string,
  launch: { env: Record<string, string>; cwd: string },
): ExecutableProbe => {
  const resolved = resolveExecutableSync(executable, { path: launch.env.PATH, cwd: launch.cwd });
  if (!resolved)
    return {
      resolved,
      version: null,
      errors: [`runtime executable "${executable}" not found on PATH`],
    };
  const probe = spawnSync(resolved, ["--version"], {
    encoding: "utf8",
    timeout: 20_000,
    env: launch.env,
  });
  const version = probe.status === 0 ? probe.stdout.trim() : null;
  const failure = probe.stderr?.trim() || probe.error?.message || "unknown";
  return {
    resolved,
    version,
    errors: version === null ? [`"${resolved} --version" failed: ${failure}`] : [],
  };
};
