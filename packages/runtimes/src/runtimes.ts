import { join } from "node:path";
import { match } from "ts-pattern";
import type { AgentRuntime, RuntimeConfig, StaticCapabilities, ToolGate } from "@mia/agent-adapter";
import { ClaudeCodeRuntime, probeClaudeCodeSync } from "@mia/claude-code-adapter";
import { CodexRuntime, probeCodexSync } from "@mia/codex-adapter";

/**
 * The one place that picks an adapter by a profile's `runtime.kind`, so the server and the probe tool, which may not
 * import each other, start and probe the same runtime the same way.
 */

export interface RuntimeStart {
  config: RuntimeConfig;
  /** The tool gate every session's calls are decided through; the caller owns it. */
  gate: ToolGate;
  /**
   * The environment the runtime inherits; `MIA_MCP_HTTP_LOG` in it names the file Claude Code's approval bridge logs
   * its requests to. The entry point passes its own.
   */
  env: NodeJS.ProcessEnv;
  /** Where the runtime may keep state across sessions: Codex keeps its own home (`codex-home`) here. */
  stateDirectory: string;
  /**
   * A fresh deadline for how long a session waits to pair a manager agent's call with the runtime's report of it;
   * the entry point builds it (the server passes its attribution deadline).
   */
  attributionDeadline: () => AbortSignal;
}

/** Starts the profile's runtime; close it when done. */
export const startRuntime = (input: RuntimeStart): Promise<AgentRuntime> =>
  match(input.config)
    .with({ kind: "claude-code" }, (config) =>
      ClaudeCodeRuntime.start({
        config,
        gate: input.gate,
        env: input.env,
        bridgeLog: input.env.MIA_MCP_HTTP_LOG,
      }),
    )
    .with({ kind: "codex" }, (config) =>
      CodexRuntime.start({
        config,
        gate: input.gate,
        env: input.env,
        codexHome: join(input.stateDirectory, "codex-home"),
        proposalDeadline: input.attributionDeadline,
      }),
    )
    .exhaustive();

/** The static probe of the profile's runtime: nothing here contacts a model. */
export const probeRuntimeSync = (
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
): StaticCapabilities =>
  match(config)
    // eslint-disable-next-line no-restricted-syntax -- a static probe, which runs before serving
    .with({ kind: "claude-code" }, (claude) => probeClaudeCodeSync(claude, env))
    // eslint-disable-next-line no-restricted-syntax -- a static probe, which runs before serving
    .with({ kind: "codex" }, (codex) => probeCodexSync(codex, env))
    .exhaustive();
