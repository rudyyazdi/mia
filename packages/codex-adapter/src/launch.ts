import { join } from "node:path";
import { match } from "ts-pattern";
import { redactValue } from "@mia/protocol";
import {
  gateHookCommand,
  MANAGER_TOOLS,
  overlaidEnvironment,
  WORKER_AGENT_NAME,
  type CodexConfig,
  type LaunchDescription,
  type LaunchSetup,
  type McpServerConfig,
} from "@mia/agent-adapter";

/** How long the gate hook and an MCP call may take, in seconds: as long as a held approval may wait. */
const HELD_CALL_TIMEOUT_S = 24 * 60 * 60;

/**
 * Codex's own tools that Mia switches off, so the manager agent and worker agents have only the multi-agent tools
 * and the profile's MCP servers. Codex 0.159.3 keys; `--strict-config` refuses a key it does not know, so a renamed
 * switch fails the launch instead of leaving its tool on.
 */
const FEATURES_OFF = [
  "shell_tool",
  "unified_exec",
  "view_image",
  "standalone_web_search",
  "apps",
  "plugins",
  "browser_use",
  "computer_use",
  "image_generation",
  "goals",
  "memories",
  "skill_search",
  "tool_suggest",
  "sleep_tool",
  "in_app_browser",
  "skill_mcp_dependency_install",
] as const;

/**
 * What Codex still offers once those are off, recorded with each launch: the hook gates each of them that it sees
 * (Mia refuses every one but delegation and stop), and `exec` itself is not hooked. Code-mode models such as
 * gpt-6-luna call every tool from inside `exec`, and the hook gates each call `exec` makes.
 */
export const LEFTOVER_TOOLS = [
  "exec (code mode; not hooked itself, each call it makes is)",
  "wait (code mode)",
  "request_user_input_async",
  "collaboration.wait_agent",
  "collaboration.list_agents",
  "collaboration.send_message",
  "collaboration.followup_task",
] as const;

/**
 * How the manager agent delegates, stops and reports work in Codex, appended to Mia's instructions, which name no tool
 * and no runtime's way of reporting an end. Codex shows the manager agent a worker agent's own final message at any
 * point in a turn, so the rule for reporting ends lives here, once; reportOf only names each turn's batch.
 */
export const DELEGATION_INSTRUCTIONS = `To start a worker agent, call spawn_agent directly (never from inside exec) with agent_type \`${WORKER_AGENT_NAME}\`, a short task_name, and the task as its message. A worker agent runs in the background: never call wait_agent, list_agents, send_message or followup_task. To stop a worker agent, call interrupt_agent with its id or its path as target. Report a worker agent's outcome only in a turn with a "[Mia] Worker agent <path> ..." line for it, and in such a turn report exactly the worker agents it lists. Codex may also show you a worker agent's final message itself, at any time, as "Message Type: FINAL_ANSWER", "Sender: <its path>", "Payload: ...". If the current turn does not list that path, do not report or act on the message's content now: Mia lists most ends in a later turn, where you report them; ends beyond what one turn lists are only counted, in a "[Mia] <count> more worker agent(s) ended" line, and you report that count, never their outcomes. If the user asks about a worker agent whose end Mia has not listed, you may say it has ended (never that it is still running), but not how.`;

// ---------------------------------------------------------------- TOML

type TomlValue = string | number | boolean | readonly string[] | Readonly<Record<string, string>>;

/** A TOML basic string: JSON's escapes are TOML's, except that TOML also needs DEL escaped. */
const tomlString = (text: string): string => JSON.stringify(text).replaceAll("\u007f", "\\u007F");
const tomlKey = (key: string): string => (/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key));

const tomlValue = (value: TomlValue): string => {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlString).join(", ")}]`;
  const entries = Object.entries(value).map(
    ([key, item]) => `${tomlKey(key)} = ${tomlString(item)}`,
  );
  return `{ ${entries.join(", ")} }`;
};

/** One TOML table: its header (none for the root) and its entries. */
interface TomlTable {
  path: readonly string[];
  entries: Readonly<Record<string, TomlValue>>;
}

const tomlDocument = (tables: readonly TomlTable[]): string =>
  tables
    .map(({ path, entries }) =>
      [
        ...(path.length === 0 ? [] : [`[${path.map(tomlKey).join(".")}]`]),
        ...Object.entries(entries).map(([key, value]) => `${tomlKey(key)} = ${tomlValue(value)}`),
      ].join("\n"),
    )
    .join("\n\n")
    .concat("\n");

// ---------------------------------------------------------------- the plan

/**
 * An MCP server as Codex's config takes it, without the fields only Mia reads: a URL is streamable HTTP. Its tools run without Codex asking (`approve`),
 * because the gate hook has already decided each call; with approval policy `never`, any other mode fails the call.
 */
const mcpServerTable = (name: string, server: McpServerConfig): TomlTable => {
  const common = {
    default_tools_approval_mode: "approve",
    tool_timeout_sec: HELD_CALL_TIMEOUT_S,
  };
  const entries = match(server)
    .with({ type: "stdio" }, (stdio) => ({
      command: stdio.command,
      args: stdio.args,
      ...(stdio.env === undefined ? {} : { env: stdio.env }),
      ...common,
    }))
    .with({ type: "http" }, { type: "sse" }, (remote) => ({
      url: remote.url,
      ...(remote.headers === undefined ? {} : { http_headers: remote.headers }),
      ...common,
    }))
    .exhaustive();
  return { path: ["mcp_servers", name], entries };
};

/** The user's own Codex home: `$CODEX_HOME`, else `~/.codex`. */
export const userCodexHome = (env: NodeJS.ProcessEnv): string =>
  env.CODEX_HOME ?? join(env.HOME ?? "", ".codex");

/** Where the user's Codex login lives, which Mia's Codex home links to. */
export const userAuthFile = (env: NodeJS.ProcessEnv): string =>
  join(userCodexHome(env), "auth.json");

/** The environment Codex runs with: `env` overlaid with `config.env`, and Mia's Codex home. */
export const codexEnvironment = (
  config: CodexConfig,
  env: NodeJS.ProcessEnv,
  codexHome: string,
): Record<string, string> => ({ ...overlaidEnvironment(env, config.env), CODEX_HOME: codexHome });

export interface CodexSessionInput {
  config: CodexConfig;
  /** Mia's own Codex home: one directory for the server's sessions, its files rewritten at each launch. */
  codexHome: string;
  runtimeDir: string;
  /** The tool gate the session's PreToolUse hook asks (see `ToolGate`). */
  gateUrl: string;
  /** Mia's id for the conversation's runtime session; Codex names its thread itself (see `threadRecord`). */
  sessionId: string;
  resume: boolean;
  /** Numbers this session's files, so a session reopened after a stop keeps the earlier one's evidence. */
  sessionIndex: number;
  /** The worker agent's instructions as text, read by the caller. */
  workerPrompt: string;
  /** The environment Codex inherits before `config.env`; the entry point passes its own. */
  env: NodeJS.ProcessEnv;
}

export interface CodexSessionPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  files: {
    streamLog: string;
    hookEvidence: string;
    /** The hooks file Codex loads, which `hooks/list` reports as the hook's source. */
    hooks: string;
    /** Records which Codex thread holds the conversation, so a later session resumes it. */
    threadRecord: string;
  };
  /** The exact hook command, by which the session finds its hook among those Codex loaded. */
  hookCommand: string;
  /** The user's login, linked into Mia's Codex home so a token refresh writes back to it. */
  auth: { source: string; link: string };
  setup: LaunchSetup;
  description: LaunchDescription & {
    codex_home: string;
    worker_agents: Record<string, { description: string; tools: string[] }>;
    gate: "pre_tool_use_hook";
    delegation_instructions: string;
    leftover_tools: readonly string[];
    config: unknown;
  };
}

/**
 * Plans a manager agent's session: one `codex app-server` speaking JSON-RPC on stdio, whose Codex home is Mia's own,
 * so none of the user's plugins, skills, AGENTS.md or MCP servers load. Its config switches off Codex's own tools,
 * runs every tool under approval policy `never` in a read-only sandbox, and gates every call, the manager agent's and
 * each worker agent's, through the PreToolUse hook. The worker agent is a custom agent role. It does no I/O: the
 * files it names are returned in `setup`.
 */
export const prepareCodexSession = (input: CodexSessionInput): CodexSessionPlan => {
  const { config, codexHome, runtimeDir } = input;
  const stem = `session-${String(input.sessionIndex).padStart(3, "0")}`;
  const hookEvidence = join(runtimeDir, `${stem}.hooks.jsonl`);
  const hooks = join(codexHome, "hooks.json");
  const hookCommand = gateHookCommand({
    gateUrl: input.gateUrl,
    evidence: hookEvidence,
    allowSilently: true,
  });
  const tools = Object.keys(config.toolPolicy);
  const tables: TomlTable[] = [
    {
      path: [],
      entries: {
        model: config.model,
        model_reasoning_effort: config.effort,
        approval_policy: "never",
        sandbox_mode: "read-only",
        web_search: "disabled",
        include_apps_instructions: false,
        check_for_update_on_startup: false,
        // Codex reads the AGENTS.md of the working directory's project, which may be any repository the profile names.
        project_doc_max_bytes: 0,
      },
    },
    {
      path: ["features"],
      entries: {
        hooks: true,
        multi_agent: true,
        ...Object.fromEntries(FEATURES_OFF.map((feature) => [feature, false])),
      },
    },
    { path: ["tools", "update_plan"], entries: { enabled: false } },
    { path: ["tools", "experimental_request_user_input"], entries: { enabled: false } },
    { path: ["skills"], entries: { include_instructions: false } },
    { path: ["skills", "bundled"], entries: { enabled: false } },
    { path: ["agents"], entries: { max_depth: 1 } },
    ...Object.entries(config.mcpServers).map(([name, server]) => mcpServerTable(name, server)),
  ];
  const worker = tomlDocument([
    {
      path: [],
      entries: {
        name: WORKER_AGENT_NAME,
        description: config.workerAgent.description,
        developer_instructions: input.workerPrompt,
        model: config.model,
        model_reasoning_effort: config.effort,
      },
    },
  ]);
  const hooksFile = {
    hooks: {
      PreToolUse: [
        {
          matcher: "",
          hooks: [{ type: "command", command: hookCommand, timeout: HELD_CALL_TIMEOUT_S }],
        },
      ],
    },
  };
  return {
    command: config.executable,
    args: ["app-server", "--strict-config"],
    env: codexEnvironment(config, input.env, codexHome),
    cwd: config.workingDirectory,
    files: {
      streamLog: join(runtimeDir, `${stem}.stream.jsonl`),
      hookEvidence,
      hooks,
      threadRecord: join(runtimeDir, "codex-thread.json"),
    },
    hookCommand,
    auth: { source: userAuthFile(input.env), link: join(codexHome, "auth.json") },
    setup: {
      directories: [codexHome, join(codexHome, "agents"), runtimeDir, config.workingDirectory],
      files: [
        { path: join(codexHome, "config.toml"), content: tomlDocument(tables) },
        { path: hooks, content: JSON.stringify(hooksFile, null, 2) },
        { path: join(codexHome, "agents", `${WORKER_AGENT_NAME}.toml`), content: worker },
      ],
    },
    description: {
      model: config.model,
      effort: config.effort,
      session_id: input.sessionId,
      resume: input.resume,
      builtin_tools: [...MANAGER_TOOLS],
      mcp_servers: Object.keys(config.mcpServers),
      codex_home: codexHome,
      worker_agents: {
        [WORKER_AGENT_NAME]: { description: config.workerAgent.description, tools },
      },
      gate: "pre_tool_use_hook",
      delegation_instructions: DELEGATION_INSTRUCTIONS,
      leftover_tools: LEFTOVER_TOOLS,
      config: redactValue(tables),
    },
  };
};
