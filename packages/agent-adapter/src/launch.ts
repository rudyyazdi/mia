import { join, resolve } from "node:path";
import type { Effort } from "@mia/protocol";
import { runtimeMcpServer, type RuntimeConfig } from "./config.ts";
import { BRIDGE_SERVER_NAME, BRIDGE_TOOL_IDENTITY } from "./bridge.ts";
import { GATE_HOOK_PATH } from "./gate.ts";
import { MANAGER_TOOLS, WORKER_AGENT_NAME } from "./manager-tools.ts";

/** Directories (owner-only) to create, in order, then files (owner-only) to write into them. */
export interface LaunchSetup {
  directories: string[];
  files: { path: string; content: string }[];
}

/** How long the gate hook may hold a call, in seconds (the runtime's unit for hooks): as long as a held approval. */
const GATE_HOOK_TIMEOUT_S = 24 * 60 * 60;

/** Timeout for a held permission prompt or long tool call: 24h, so a human decision is never timed out by the runtime. */
export const MCP_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * The environment the runtime runs with: `env` (see `SessionInput.env`) overlaid with `config.env` and Mia's own
 * settings. The session and the startup probe both use it, so the probe finds and runs the same executable.
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

/** The MCP servers the runtime gets: the profile's, without the fields only Mia reads, and the approval bridge. */
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

export interface SessionInput {
  config: RuntimeConfig;
  runtimeDir: string;
  /** The approval bridge, the session's prompt tool: a backstop that denies any call the hook left undecided. */
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
  /**
   * The environment the runtime inherits before `config.env` is applied; the entry point passes its own.
   * `MIA_RUNTIME_DEBUG` in it turns on the runtime's debug logging.
   */
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
 * Build the invocation of a manager agent's session: one long-lived runtime that reads the user's messages as
 * stream-json on stdin, so a message reaches the manager agent while its worker agents run, and writes one result
 * per turn. Every tool call, the manager agent's and each worker agent's, passes the gate hook, which blocks until
 * Mia decides; policy has no ask or allow rules, only deny, because an ask rule refuses a call the hook allowed
 * (see the capability record). A call the hook fails to decide (it timed out, or crashed without blocking) falls
 * back to the runtime's own evaluation: no setting source is loaded (`--setting-sources ""`), so no inherited rule
 * allows it, and the prompt it needs reaches the approval bridge, which denies it. The manager agent's own tools need
 * no permission, so a hook that never ran lets them through (see the capability record). Each user message carries a UUID that the runtime
 * replays when a turn takes it (`--replay-user-messages`). It does no I/O: the files it names are returned in `setup`.
 */
export const prepareSession = (input: SessionInput): SessionPlan => {
  const { config, runtimeDir } = input;
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
              command: [
                process.execPath,
                GATE_HOOK_PATH,
                "--gate",
                input.gateUrl,
                "--evidence",
                hookEvidence,
              ]
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
    "--replay-user-messages",
    "--setting-sources",
    "",
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
