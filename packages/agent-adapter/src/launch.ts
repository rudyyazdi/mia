import { join, resolve } from "node:path";
import { BRIDGE_SERVER_NAME, BRIDGE_TOOL_IDENTITY } from "./bridge.ts";
import type { Effort } from "@mia/protocol";
import { runtimeMcpServer, type RuntimeConfig } from "./config.ts";
import { GATE_HOOK_PATH } from "./gate.ts";

export interface LaunchPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  files: { mcpConfig: string; settings: string; hookEvidence: string };
  /** What must exist before the runtime starts; `prepareLaunch` writes nothing, `writeLaunchFiles` creates it. */
  setup: LaunchSetup;
  /** Redacted, retained description of what was launched (no secrets, no argv prompt). */
  description: {
    model: string;
    effort: Effort;
    session_id: string;
    resume: boolean;
    builtin_tools: string[];
    mcp_servers: string[];
    permission_prompt_tool: string;
    settings: unknown;
    mcp_config: unknown;
  };
}

/** Directories (owner-only) to create, in order, then files (owner-only) to write into them. */
export interface LaunchSetup {
  directories: string[];
  files: { path: string; content: string }[];
}

export const HOOK_SCRIPT_PATH = join(import.meta.dirname, "hook-capture.mjs");

/** The runtime's name for the worker agent Mia defines; the manager agent's delegation names it as `subagent_type`. */
export const WORKER_AGENT_NAME = "mia-worker";

/**
 * The built-in tools a manager agent's session enables: `Task` starts a worker agent (it streams as `Agent`) and
 * `TaskStop` stops one. A worker agent's own tool list leaves both out, so it cannot start or stop worker agents.
 */
export const MANAGER_TOOLS = ["Task", "TaskStop"] as const;

/** How long the gate hook may hold a call, in seconds (the runtime's unit for hooks): as long as a held approval. */
const GATE_HOOK_TIMEOUT_S = 24 * 60 * 60;

/** Timeout for a held permission prompt or long tool call: 24h, so a human decision is never timed out by the runtime. */
export const MCP_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface LaunchInput {
  config: RuntimeConfig;
  runtimeDir: string;
  bridgeUrl: string;
  sessionId: string;
  resume: boolean;
  turnIndex: number;
  /**
   * Prompt file to append, or null to append none; the engine passes the conversation's retained prompt object so
   * every turn uses the same bytes.
   */
  agentPromptFile: string | null;
  /**
   * The environment the runtime inherits before `config.env` is applied; the entry point passes its own.
   * `MIA_RUNTIME_DEBUG` in it turns on the runtime's debug logging.
   */
  env: NodeJS.ProcessEnv;
}

/**
 * The environment the runtime runs with: `env` (see `LaunchInput.env`) overlaid with `config.env` and Mia's own
 * settings. The launch and the startup probe both use it, so the probe finds and runs the same executable.
 */
export const runtimeEnvironment = (
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
): Record<string, string> => {
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) merged[name] = value;
  Object.assign(merged, config.env);
  merged.MCP_TOOL_TIMEOUT = String(MCP_TOOL_TIMEOUT_MS);
  // Claude Code 2.1.278 adds a separate idle timeout: a call with "no response or progress" for 300s is aborted. A held
  // approval prompt is exactly that, so it gets the same 24h (capability record F4). 0 would disable it entirely.
  merged.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = String(MCP_TOOL_TIMEOUT_MS);
  // Never let a nested Claude Code session inherit this process's session context.
  delete merged.CLAUDECODE;
  delete merged.CLAUDE_CODE_ENTRYPOINT;
  return merged;
};

/** The MCP servers the runtime gets: the profile's, without Mia-only fields, and the approval bridge. */
const mcpConfigOf = (config: RuntimeConfig, bridgeUrl: string) => ({
  mcpServers: {
    ...Object.fromEntries(
      Object.entries(config.mcpServers).map(([name, server]) => [name, runtimeMcpServer(server)]),
    ),
    [BRIDGE_SERVER_NAME]: { type: "http", url: bridgeUrl },
  },
});

/** A launch file holding `value` as JSON. */
const jsonFile = (path: string, value: unknown) => ({
  path,
  content: JSON.stringify(value, null, 2),
});

/** The tools the runtime refuses by rule before any hook or prompt: every tool whose policy is deny. */
const denyRulesOf = (config: RuntimeConfig): string[] =>
  Object.entries(config.toolPolicy)
    .filter(([, policy]) => policy === "deny")
    .map(([identity]) => identity);

/**
 * Build the exact runtime invocation. Mia decides everything explicitly: model, effort, tool surface,
 * MCP wiring, permission rules and the approval tool. The prompt text goes on stdin, never argv. It does no I/O:
 * the directories and config files the invocation refers to are returned in `setup` for the caller to write.
 */
export const prepareLaunch = (input: LaunchInput): LaunchPlan => {
  const { config, runtimeDir, bridgeUrl, sessionId, resume } = input;

  const mcpConfig = mcpConfigOf(config, bridgeUrl);
  const denyRules = denyRulesOf(config);
  const askRules = Object.entries(config.toolPolicy)
    .filter(([, policy]) => policy !== "deny")
    .map(([identity]) => identity);
  const allowRules: string[] = [];
  const hookEvidence = join(
    runtimeDir,
    `turn-${String(input.turnIndex).padStart(3, "0")}.hooks.jsonl`,
  );
  const settings = {
    ...config.extraSettings,
    permissions: {
      // Mia's own layer: deny is enforced by the runtime before any prompt; everything else must prompt
      // (ask wins over any inherited allow) so the bridge sees every call and the action gate applies.
      deny: denyRules,
      ask: askRules,
      allow: allowRules,
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: `${JSON.stringify(process.execPath)} ${JSON.stringify(HOOK_SCRIPT_PATH)} ${JSON.stringify(hookEvidence)}`,
            },
          ],
        },
      ],
    },
  };
  const mcpConfigPath = join(runtimeDir, "mcp.json");
  const settingsPath = join(runtimeDir, "settings.json");

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    config.model,
    "--effort",
    config.effort,
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--settings",
    settingsPath,
    "--permission-mode",
    "default",
    "--permission-prompt-tool",
    BRIDGE_TOOL_IDENTITY,
    "--tools",
    config.builtinTools.length === 0 ? "" : config.builtinTools.join(","),
    ...(input.agentPromptFile === null
      ? []
      : ["--append-system-prompt-file", resolve(input.agentPromptFile)]),
    resume ? "--resume" : "--session-id",
    sessionId,
  ];
  // Diagnostics only: MIA_RUNTIME_DEBUG=mcp adds the runtime's own debug logging (stderr) for that category.
  if (input.env.MIA_RUNTIME_DEBUG)
    args.push(
      "--debug",
      input.env.MIA_RUNTIME_DEBUG,
      "--debug-file",
      join(runtimeDir, "runtime-debug.log"),
    );
  const env = runtimeEnvironment(config, input.env);

  return {
    command: config.executable,
    args,
    env,
    cwd: config.workingDirectory,
    files: { mcpConfig: mcpConfigPath, settings: settingsPath, hookEvidence },
    setup: {
      directories: [runtimeDir, config.workingDirectory],
      files: [jsonFile(mcpConfigPath, mcpConfig), jsonFile(settingsPath, settings)],
    },
    description: {
      model: config.model,
      effort: config.effort,
      session_id: sessionId,
      resume,
      builtin_tools: config.builtinTools,
      mcp_servers: Object.keys(mcpConfig.mcpServers),
      permission_prompt_tool: BRIDGE_TOOL_IDENTITY,
      settings,
      mcp_config: mcpConfig,
    },
  };
};

export interface SessionInput {
  config: RuntimeConfig;
  runtimeDir: string;
  bridgeUrl: string;
  /** The tool gate the session's PreToolUse hook asks (see `ToolGate`). */
  gateUrl: string;
  sessionId: string;
  resume: boolean;
  /** Numbers this session's files, so a session reopened after a stop keeps the earlier one's evidence. */
  sessionIndex: number;
  /** The manager agent's instructions file, or null to append none; the engine passes the retained prompt object. */
  managerPromptFile: string | null;
  /** The worker agent's instructions as text, read by the caller: the runtime takes a subagent's prompt as text. */
  workerPrompt: string;
  /** As `LaunchInput.env`. */
  env: NodeJS.ProcessEnv;
}

/** One subagent as Claude Code's `--agents` takes it. */
export interface WorkerAgentDefinition {
  description: string;
  prompt: string;
  /** The tools the worker agent may use: every tool the policy lists, and neither manager tool. */
  tools: string[];
}

export interface SessionPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  files: { streamLog: string; hookEvidence: string };
  setup: LaunchSetup;
  /** Redacted, retained description of what was launched (no secrets, no prompts). */
  description: {
    model: string;
    effort: Effort;
    session_id: string;
    resume: boolean;
    builtin_tools: string[];
    worker_agents: Record<string, Omit<WorkerAgentDefinition, "prompt">>;
    mcp_servers: string[];
    gate: "pre_tool_use_hook";
    settings: unknown;
    mcp_config: unknown;
  };
}

/**
 * Build the invocation of a manager agent's session (D2): one long-lived runtime that reads the user's messages as
 * stream-json on stdin, so a message reaches the manager agent while its worker agents run, and writes one result
 * per turn. Every tool call, the manager agent's and each worker agent's, passes the gate hook, which blocks until
 * Mia decides; no call is left to the runtime's own prompt, so policy has no ask or allow rules, only deny. The
 * approval bridge stays configured as the prompt tool so that a call the hook fails to decide is denied by a bridge
 * with no handler rather than allowed. Like `prepareLaunch`, it does no I/O.
 */
export const prepareSession = (input: SessionInput): SessionPlan => {
  const { config, runtimeDir } = input;
  if (config.workerAgent === null)
    throw new Error("a manager agent's session needs a config that defines a worker agent");
  const mcpConfig = mcpConfigOf(config, input.bridgeUrl);
  const stem = `session-${String(input.sessionIndex).padStart(3, "0")}`;
  const hookEvidence = join(runtimeDir, `${stem}.hooks.jsonl`);
  const settings = {
    ...config.extraSettings,
    permissions: { deny: denyRulesOf(config), ask: [], allow: [] },
    hooks: {
      PreToolUse: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: [process.execPath, GATE_HOOK_PATH, input.gateUrl, hookEvidence]
                .map((part) => JSON.stringify(part))
                .join(" "),
              timeout: GATE_HOOK_TIMEOUT_S,
            },
          ],
        },
      ],
    },
  };
  const workers: Record<string, WorkerAgentDefinition> = {
    [WORKER_AGENT_NAME]: {
      description: config.workerAgent.description,
      prompt: input.workerPrompt,
      tools: Object.keys(config.toolPolicy),
    },
  };
  const mcpConfigPath = join(runtimeDir, `${stem}.mcp.json`);
  const settingsPath = join(runtimeDir, `${stem}.settings.json`);
  const agentsPath = join(runtimeDir, `${stem}.agents.json`);
  const builtinTools = [...MANAGER_TOOLS];
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    config.model,
    "--effort",
    config.effort,
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--settings",
    settingsPath,
    "--permission-mode",
    "default",
    "--permission-prompt-tool",
    BRIDGE_TOOL_IDENTITY,
    "--tools",
    builtinTools.join(","),
    "--agents",
    agentsPath,
    ...(input.managerPromptFile === null
      ? []
      : ["--append-system-prompt-file", resolve(input.managerPromptFile)]),
    input.resume ? "--resume" : "--session-id",
    input.sessionId,
  ];
  if (input.env.MIA_RUNTIME_DEBUG)
    args.push(
      "--debug",
      input.env.MIA_RUNTIME_DEBUG,
      "--debug-file",
      join(runtimeDir, `${stem}.debug.log`),
    );
  return {
    command: config.executable,
    args,
    env: runtimeEnvironment(config, input.env),
    cwd: config.workingDirectory,
    files: { streamLog: join(runtimeDir, `${stem}.stream.jsonl`), hookEvidence },
    setup: {
      directories: [runtimeDir, config.workingDirectory],
      files: [
        jsonFile(mcpConfigPath, mcpConfig),
        jsonFile(settingsPath, settings),
        jsonFile(agentsPath, workers),
      ],
    },
    description: {
      model: config.model,
      effort: config.effort,
      session_id: input.sessionId,
      resume: input.resume,
      builtin_tools: builtinTools,
      worker_agents: Object.fromEntries(
        Object.entries(workers).map(([name, { prompt: _, ...rest }]) => [name, rest]),
      ),
      mcp_servers: Object.keys(mcpConfig.mcpServers),
      gate: "pre_tool_use_hook",
      settings,
      mcp_config: mcpConfig,
    },
  };
};
