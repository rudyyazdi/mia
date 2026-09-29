import { existsSync, mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "./config.ts";
import { MCP_TOOL_TIMEOUT_MS, prepareLaunch, prepareSession } from "./launch.ts";

/** A minimal config working in `dir`, with `fields` replaced. */
const configIn = (dir: string, fields: Partial<RuntimeConfig>): RuntimeConfig => ({
  kind: "claude-code",
  executable: "claude",
  model: "m",
  effort: "medium",
  workingDirectory: join(dir, "work"),
  builtinTools: [],
  mcpServers: {},
  toolPolicy: {},
  agentPromptFile: join(dir, "agent.md"),
  outputDirectories: [],
  env: {},
  extraSettings: {},
  workerAgent: null,
  exclusiveTools: [],
  ...fields,
});

/**
 * A launch plan for a minimal config in `dir`, inheriting `env`; `configEnv` is the profile's own, and
 * `agentPromptFile` replaces the prompt file written into `dir`.
 */
const planIn = (
  dir: string,
  env: NodeJS.ProcessEnv,
  overrides: { configEnv?: Record<string, string>; agentPromptFile?: string | null } = {},
): ReturnType<typeof prepareLaunch> => {
  const { configEnv = {} } = overrides;
  const promptFile = join(dir, "agent.md");
  writeFileSync(promptFile, "prompt\n");
  return prepareLaunch({
    config: configIn(dir, {
      mcpServers: {
        d1: { type: "http", url: "http://127.0.0.1:1/mcp", bodyLog: join(dir, "bodies.jsonl") },
      },
      toolPolicy: { mcp__d1__slow: "ask" },
      agentPromptFile: promptFile,
      env: configEnv,
    }),
    runtimeDir: join(dir, "runtime"),
    bridgeUrl: "http://127.0.0.1:2/mcp",
    sessionId: "s",
    resume: false,
    turnIndex: 1,
    agentPromptFile:
      overrides.agentPromptFile === undefined ? promptFile : overrides.agentPromptFile,
    env,
  });
};

describe("launch plan", () => {
  it("inherits only the environment it is given, with the profile's env on top", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    const plan = planIn(
      directory.path,
      { LANG: "C", SHARED: "inherited", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" },
      { configEnv: { SHARED: "profile" } },
    );
    expect(plan.env).toEqual({
      LANG: "C",
      SHARED: "profile",
      MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
      CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
    });
    // A held approval prompt gets the 24h budget under both runtime timeouts (capability record F4): 2.1.278
    // aborts a call with no response or progress for 300s regardless of MCP_TOOL_TIMEOUT.
    expect(MCP_TOOL_TIMEOUT_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("writes nothing itself, and plans the directories and files its arguments refer to", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    const plan = planIn(directory.path, {});
    const runtimeDir = join(directory.path, "runtime");
    const workingDirectory = join(directory.path, "work");
    expect(existsSync(runtimeDir)).toBe(false);
    expect(existsSync(workingDirectory)).toBe(false);

    expect(plan.cwd).toBe(workingDirectory);
    expect(plan.setup.directories).toEqual([runtimeDir, workingDirectory]);
    const argAfter = (flag: string): string => plan.args[plan.args.indexOf(flag) + 1] ?? "";
    const planned = new Map(plan.setup.files.map((file) => [file.path, JSON.parse(file.content)]));
    expect(planned.get(argAfter("--mcp-config"))).toEqual(plan.description.mcp_config);
    expect(planned.get(argAfter("--settings"))).toEqual(plan.description.settings);
  });

  it("hands the runtime each MCP server without the body log only Mia reads", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    const plan = planIn(directory.path, {});
    const [written] = plan.setup.files;
    expect(JSON.parse(written?.content ?? "{}")).toMatchObject({
      mcpServers: { d1: { type: "http", url: "http://127.0.0.1:1/mcp" } },
    });
    expect(written?.content).not.toContain("bodyLog");
  });

  it("appends the prompt file it is given, and no prompt when given none", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    const retained = join(directory.path, "objects", "digest");
    const withPrompt = planIn(directory.path, {}, { agentPromptFile: retained });
    const at = withPrompt.args.indexOf("--append-system-prompt-file");
    expect(withPrompt.args.slice(at, at + 2)).toEqual(["--append-system-prompt-file", retained]);
    const withoutPrompt = planIn(directory.path, {}, { agentPromptFile: null });
    expect(withoutPrompt.args).not.toContain("--append-system-prompt-file");
    expect(withoutPrompt.args).toContain("--session-id");
  });

  it("turns on runtime debug logging only when the given environment sets MIA_RUNTIME_DEBUG", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    expect(planIn(directory.path, {}).args).not.toContain("--debug");
    const plan = planIn(directory.path, { MIA_RUNTIME_DEBUG: "mcp" });
    const at = plan.args.indexOf("--debug");
    expect(plan.args.slice(at, at + 4)).toEqual([
      "--debug",
      "mcp",
      "--debug-file",
      join(directory.path, "runtime", "runtime-debug.log"),
    ]);
  });
});

describe("session plan", () => {
  const sessionIn = (dir: string) =>
    prepareSession({
      config: configIn(dir, {
        mcpServers: { d1: { type: "http", url: "http://127.0.0.1:1/mcp" } },
        toolPolicy: { mcp__d1__slow: "ask", mcp__d1__read: "allow", mcp__d1__forbidden: "deny" },
        agentPromptFile: join(dir, "manager.md"),
        workerAgent: { description: "does tool work", promptFile: join(dir, "worker.md") },
      }),
      runtimeDir: join(dir, "runtime"),
      bridgeUrl: "http://127.0.0.1:2/mcp",
      gateUrl: "http://127.0.0.1:3/gate/token",
      sessionId: "s",
      resume: false,
      sessionIndex: 2,
      managerPromptFile: join(dir, "manager.md"),
      workerPrompt: "work carefully",
      env: {},
    });
  const fileOf = (plan: ReturnType<typeof sessionIn>, suffix: string): unknown => {
    const file = plan.setup.files.find((entry) => entry.path.endsWith(suffix));
    if (!file) throw new Error(`no ${suffix} in the plan`);
    return JSON.parse(file.content);
  };

  it("reads messages from stdin as stream-json and gives the manager agent only delegation tools", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-session-"));
    const plan = sessionIn(directory.path);
    const flag = (name: string) => plan.args[plan.args.indexOf(name) + 1];
    expect(flag("--input-format")).toBe("stream-json");
    expect(flag("--tools")).toBe("Task,TaskStop");
    expect(flag("--agents")).toMatch(/session-002\.agents\.json$/);
  });

  it("lets the worker agent use every listed tool and neither manager tool", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-session-"));
    expect(fileOf(sessionIn(directory.path), ".agents.json")).toEqual({
      "mia-worker": {
        description: "does tool work",
        prompt: "work carefully",
        tools: ["mcp__d1__slow", "mcp__d1__read", "mcp__d1__forbidden"],
      },
    });
  });

  it("leaves every call but a denied one to the gate hook, which may hold it as long as an approval", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-session-"));
    const settings = fileOf(sessionIn(directory.path), ".settings.json");
    expect(settings).toMatchObject({
      permissions: { deny: ["mcp__d1__forbidden"], ask: [], allow: [] },
      hooks: {
        PreToolUse: [
          {
            matcher: "",
            hooks: [{ type: "command", timeout: 86_400 }],
          },
        ],
      },
    });
    expect(JSON.stringify(settings)).toContain("http://127.0.0.1:3/gate/token");
  });

  it("keeps the worker prompt out of the retained description", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-session-"));
    expect(JSON.stringify(sessionIn(directory.path).description)).not.toContain("work carefully");
  });
});
