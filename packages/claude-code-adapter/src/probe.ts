import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  probeExecutableSync,
  type CredentialSource,
  type ClaudeCodeConfig,
  type StaticCapabilities,
} from "@mia/agent-adapter";
import { runtimeEnvironment } from "./launch.ts";

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
  "--append-system-prompt",
  "--append-system-prompt-file",
  "--session-id",
  "--resume",
];

/**
 * Static checks: nothing here contacts a model. `env` is the environment a launch passes on (see
 * `LaunchInput.env`): the executable is looked up on the PATH and run with the environment the launch
 * derives from it (`runtimeEnvironment`), and the credential is detected from it.
 */
export const probeClaudeCodeSync = (
  config: ClaudeCodeConfig,
  env: NodeJS.ProcessEnv,
): StaticCapabilities => {
  // The launch spawns the runtime in config.workingDirectory with this environment, so probe it the same way.
  const launchEnv = runtimeEnvironment(config, env);
  const { resolved, version, errors } = probeExecutableSync(config.executable, {
    env: launchEnv,
    cwd: config.workingDirectory,
  });
  const flags: Record<string, boolean> = {};
  if (resolved) {
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
  let credential: CredentialSource = "none_detected";
  if (env.ANTHROPIC_API_KEY) credential = "ANTHROPIC_API_KEY";
  else if (existsSync(join(env.HOME ?? "", ".claude", ".credentials.json")))
    credential = "claude_credentials_file";
  if (credential === "none_detected")
    errors.push(
      "no runtime credential source detected (ANTHROPIC_API_KEY unset, ~/.claude/.credentials.json missing)",
    );
  return {
    runtime: config.kind,
    executable_resolved: resolved,
    runtime_version: version,
    flags_present: flags,
    credential_source: credential,
    undisclosed_instructions:
      "Claude Code does not expose its effective system prompt or inherited CLAUDE.md content over stream-json",
    node_version: process.version,
    adapter_version: ADAPTER_VERSION,
    errors,
  };
};
