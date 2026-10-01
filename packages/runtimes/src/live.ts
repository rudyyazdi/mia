import { match } from "ts-pattern";
import type { RuntimeConfig, RuntimeKind } from "@mia/agent-adapter";
import type { Effort } from "@mia/protocol";

/** What a live run picks with `--runtime`: the runtime, and what it runs unless the run asks for another. */
export interface LiveRuntime {
  kind: RuntimeKind;
  /** The executable a profile written for another runtime gets, looked up on PATH. */
  executable: string;
  /**
   * The model a live run uses unless it passes `--model`. For Codex it is the cheapest model, so a stronger one costs
   * an explicit opt-in on each run.
   */
  model: string;
  effort: Effort;
}

/**
 * The runtimes the probe tool and the live lane can run, by the name `--runtime` takes. Both read their defaults
 * here, so the two live runs cost the same.
 */
const LIVE_RUNTIMES: Record<string, LiveRuntime> = {
  claude: { kind: "claude-code", executable: "claude", model: "claude-sonnet-5", effort: "medium" },
  codex: { kind: "codex", executable: "codex", model: "gpt-6-luna", effort: "low" },
};

const BY_NAME = new Map<string, LiveRuntime>(Object.entries(LIVE_RUNTIMES));

/** The names `--runtime` takes, for its help and its check. */
export const LIVE_RUNTIME_NAMES: readonly string[] = [...BY_NAME.keys()];

/** The runtime `--runtime` named, or null for a name it does not take. */
export const liveRuntimeOf = (name: string): LiveRuntime | null => BY_NAME.get(name) ?? null;

/**
 * `config` run on the runtime `live` names: a config already of that kind is returned as it is; any other keeps the
 * fields every runtime shares and takes `live.executable` and the runtime's own fields' empty values.
 */
export const onRuntime = (config: RuntimeConfig, live: LiveRuntime): RuntimeConfig => {
  if (config.kind === live.kind) return config;
  const shared = match(config)
    .with(
      { kind: "claude-code" },
      ({ kind: _, executable: _old, extraSettings: _own, ...rest }) => rest,
    )
    .with({ kind: "codex" }, ({ kind: _, executable: _old, ...rest }) => rest)
    .exhaustive();
  return match(live.kind)
    .returnType<RuntimeConfig>()
    .with("claude-code", (kind) => ({
      ...shared,
      kind,
      executable: live.executable,
      extraSettings: {},
    }))
    .with("codex", (kind) => ({ ...shared, kind, executable: live.executable }))
    .exhaustive();
};
