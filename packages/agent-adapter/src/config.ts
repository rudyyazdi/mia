import { match } from "ts-pattern";
import { z } from "zod";
import {
  EffortSchema,
  isSensitiveKey,
  isTokenCount,
  ToolPolicySchema,
  type ToolCallPolicy,
} from "@mia/protocol";

/** The two network transports differ only in their discriminator; the shape they accept is one definition. */
const remoteMcpServerSchema = <Transport extends "http" | "sse">(transport: Transport) =>
  z
    .object({
      type: z.literal(transport),
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).optional(),
      /**
       * Mia's own field, never handed to the runtime: the body log this server writes, keyed by tool-use id. Only
       * the controlled MCP fixture writes one (issue #6); a server in debug mode records each of its calls' lines.
       */
      bodyLog: z.string().min(1).optional(),
    })
    .strict();

export const McpServerConfigSchema = z.discriminatedUnion("type", [
  remoteMcpServerSchema("http"),
  remoteMcpServerSchema("sse"),
  z
    .object({
      type: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** A server's entry as the runtime's MCP configuration gets it: without the fields only Mia reads. */
export const runtimeMcpServer = (server: McpServerConfig): Record<string, unknown> =>
  match(server)
    .with({ type: "stdio" }, (stdio) => stdio)
    .with({ type: "http" }, { type: "sse" }, ({ bodyLog: _, ...remote }) => remote)
    .exhaustive();

/**
 * What every runtime's configuration holds. Nothing here has a default: a profile must state model, effort, tool
 * surface, MCP wiring and per-tool policy explicitly.
 */
const runtimeFields = {
  /** Executable name or absolute path; resolved on PATH at launch. */
  executable: z.string().min(1),
  model: z.string().min(1),
  effort: EffortSchema,
  /** Agent working directory (created if missing). Never a personal path in committed examples. */
  workingDirectory: z.string().min(1),
  mcpServers: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), McpServerConfigSchema),
  /**
   * Mia policy per fully qualified tool identity (mcp__<server>__<tool>).
   * allow: permitted without prompting, still refused once its task is being stopped.
   * ask: requires an explicit per-call user decision.
   * deny: rejected before any prompt.
   * Tools not listed are denied with a visible error.
   */
  toolPolicy: z.record(
    z.string().regex(/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.-]+$/),
    ToolPolicySchema,
  ),
  /** Mia-owned manager-agent instructions appended to the runtime's system prompt. */
  agentPromptFile: z.string().min(1),
  /**
   * The worker agent the manager agent delegates every tool call to. It may use every tool the policy lists and
   * cannot start or stop a worker agent.
   */
  workerAgent: z
    .object({
      /** When the manager agent should delegate to it, as the runtime shows the manager agent. */
      description: z.string().min(1),
      /** Mia-owned worker-agent instructions. */
      promptFile: z.string().min(1),
    })
    .strict(),
  /**
   * Tools only one worker agent may use at a time, such as computer use: the engine refuses a second concurrent
   * call to one. Each must be a tool the policy lists.
   */
  exclusiveTools: z.array(z.string()).default([]),
  /** Directories from which tool-result-declared artifacts may be collected. */
  outputDirectories: z.array(z.string()),
  /** Extra environment for the runtime process (never credentials). */
  env: z.record(z.string(), z.string()).default({}),
};

/**
 * The MCP server name Claude Code's approval bridge takes (`--permission-prompt-tool`), so a profile may not use it.
 * Declared with the Claude Code variant, the only one that has a bridge.
 */
const CLAUDE_BRIDGE_SERVER = "mia_approval";

const ClaudeCodeConfigSchema = z
  .object({
    kind: z.literal("claude-code"),
    ...runtimeFields,
    /** Extra Claude Code settings layer (used by tests to inject conflicting inherited settings). */
    extraSettings: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .refine((config) => !Object.hasOwn(config.mcpServers, CLAUDE_BRIDGE_SERVER), {
    message: `mcpServers may not define "${CLAUDE_BRIDGE_SERVER}"; that name is reserved for the approval bridge`,
    path: ["mcpServers"],
  });

/** Codex reaches a remote MCP server over streamable HTTP only, so a server it gets is stdio or http. */
const CodexConfigSchema = z
  .object({ kind: z.literal("codex"), ...runtimeFields })
  .strict()
  .refine((config) => Object.values(config.mcpServers).every((server) => server.type !== "sse"), {
    message: "Codex has no SSE transport; give each MCP server as http (streamable HTTP) or stdio",
    path: ["mcpServers"],
  });

/** Everything an adapter needs to launch its runtime, by the runtime a profile runs (`kind`). */
export const RuntimeConfigSchema = z.discriminatedUnion("kind", [
  ClaudeCodeConfigSchema,
  CodexConfigSchema,
]);
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type ClaudeCodeConfig = z.infer<typeof ClaudeCodeConfigSchema>;
export type CodexConfig = z.infer<typeof CodexConfigSchema>;
/** Which agent runtime a profile runs, named once by its configuration's `kind`. */
export type RuntimeKind = RuntimeConfig["kind"];

/** The MCP server a fully qualified tool identity (mcp__<server>__<tool>) names, or null when it names none. */
export const serverOf = (identity: string): string | null =>
  /^mcp__([A-Za-z0-9_-]+)__/.exec(identity)?.[1] ?? null;

/**
 * The body log of the server a tool identity names, or null when that server writes none. Own keys only, like
 * `policyFor`: the identity comes unchecked from the runtime.
 */
export const bodyLogFor = (config: RuntimeConfig, identity: string): string | null => {
  const server = serverOf(identity);
  if (server === null || !Object.hasOwn(config.mcpServers, server)) return null;
  const entry = config.mcpServers[server];
  return entry && entry.type !== "stdio" ? (entry.bodyLog ?? null) : null;
};

/**
 * The policy for a tool identity, or "unlisted" when the profile names none. Own keys only: the identity comes
 * unchecked from the runtime, and indexing would resolve `constructor` or `__proto__` through Object.prototype.
 */
export const policyFor = (config: RuntimeConfig, identity: string): ToolCallPolicy => {
  const policy = Object.hasOwn(config.toolPolicy, identity)
    ? config.toolPolicy[identity]
    : undefined;
  return policy ?? "unlisted";
};

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

/**
 * Validate policy against wiring: every policy entry must name a configured MCP server.
 * Server lookups check own keys only: `in` would also find Object.prototype names such as
 * `constructor` and accept a policy for a server nobody configured.
 */
export const validateRuntimeConfig = (config: RuntimeConfig): void => {
  for (const identity of Object.keys(config.toolPolicy)) {
    const server = serverOf(identity);
    if (!server || !Object.hasOwn(config.mcpServers, server)) {
      throw new ConfigurationError(
        `toolPolicy names ${identity} but no MCP server "${server}" is configured`,
      );
    }
  }
  for (const identity of config.exclusiveTools) {
    if (!Object.hasOwn(config.toolPolicy, identity))
      throw new ConfigurationError(
        `exclusiveTools names ${identity}, which toolPolicy does not list`,
      );
  }
  for (const [key, value] of Object.entries(config.env)) {
    if (isSensitiveKey(key) && !isTokenCount(key, value))
      throw new ConfigurationError(`env must not carry credentials (found key ${key})`);
  }
};
