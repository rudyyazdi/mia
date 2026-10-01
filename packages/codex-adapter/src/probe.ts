import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  probeExecutableSync,
  type CodexConfig,
  type CredentialSource,
  type StaticCapabilities,
} from "@mia/agent-adapter";
import { codexEnvironment, userAuthFile, userCodexHome } from "./launch.ts";

export const ADAPTER_VERSION = "0.1.0";

/**
 * The Codex release this adapter was written and checked against: its app-server protocol is experimental, and its
 * config keys, hook output and tool names are Codex's own and change between releases, so the static probe reports
 * another release as an error until the adapter is checked against it.
 */
export const SUPPORTED_CODEX_VERSION = "0.159.3";

/** What the adapter runs: `codex app-server` with `--strict-config`, so a config key Codex does not know fails. */
const REQUIRED_FLAGS = ["--strict-config", "--listen"];

/** The features Mia's config turns on, which this Codex must have. */
const REQUIRED_FEATURES = ["hooks", "multi_agent", "code_mode_host"];

/** Runs Codex once and waits for it, as a static probe does before serving. */
const runSync = (executable: string, args: string[], env: Record<string, string>) =>
  spawnSync(executable, args, { encoding: "utf8", timeout: 20_000, env });

/**
 * Static checks: nothing here contacts a model. Codex is looked up and run as a launch would, with the environment
 * `codexEnvironment` derives from `env`, but with the user's own Codex home, since Mia's is written only at launch.
 */
export const probeCodexSync = (config: CodexConfig, env: NodeJS.ProcessEnv): StaticCapabilities => {
  const launchEnv = codexEnvironment(config, env, userCodexHome(env));
  const { resolved, version, errors } = probeExecutableSync(config.executable, {
    env: launchEnv,
    cwd: config.workingDirectory,
  });
  if (version !== null && version !== `codex-cli ${SUPPORTED_CODEX_VERSION}`)
    errors.push(
      `${version} is not the Codex release this adapter supports (${SUPPORTED_CODEX_VERSION})`,
    );
  const flags: Record<string, boolean> = {};
  if (resolved) {
    const help = runSync(resolved, ["app-server", "--help"], launchEnv).stdout ?? "";
    for (const flag of REQUIRED_FLAGS) flags[`app-server ${flag}`] = help.includes(flag);
    const features = (runSync(resolved, ["features", "list"], launchEnv).stdout ?? "")
      .split("\n")
      .map((line) => line.split(/\s+/)[0]);
    for (const feature of REQUIRED_FEATURES)
      flags[`features.${feature}`] = features.includes(feature);
    for (const [flag, present] of Object.entries(flags))
      if (!present) errors.push(`required ${flag} not present`);
  }
  let credential: CredentialSource = "none_detected";
  if (env.OPENAI_API_KEY) credential = "OPENAI_API_KEY";
  else if (existsSync(userAuthFile(env))) credential = "codex_auth_file";
  if (credential === "none_detected")
    errors.push(
      `no runtime credential source detected (OPENAI_API_KEY unset, ${userAuthFile(env)} missing)`,
    );
  return {
    runtime: config.kind,
    executable_resolved: resolved,
    runtime_version: version,
    flags_present: flags,
    credential_source: credential,
    undisclosed_instructions:
      "Codex does not report over app-server the base instructions, model messages or multi-agent role prompts it adds to Mia's; the thread's rollout under Mia's Codex home holds them",
    node_version: process.version,
    adapter_version: ADAPTER_VERSION,
    errors,
  };
};
