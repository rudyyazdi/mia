import { existsSync, mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaudeCodeConfig } from "@mia/agent-adapter";
import { DELEGATION_INSTRUCTIONS, MCP_TOOL_TIMEOUT_MS, prepareSession } from "./launch.ts";

/** A session plan for a minimal config working in `dir`, inheriting `env`, with `fields` replaced. */
const planIn = (
  dir: string,
  env: NodeJS.ProcessEnv = {},
  overrides: { fields?: Partial<ClaudeCodeConfig>; managerPromptFile?: string | null } = {},
) =>
  prepareSession({
    config: {
      kind: "claude-code",
      executable: "claude",
      model: "m",
      effort: "medium",
      workingDirectory: join(dir, "work"),
      mcpServers: {
        fixture: {
          type: "http",
          url: "http://127.0.0.1:1/mcp",
          bodyLog: join(dir, "bodies.jsonl"),
        },
      },
      toolPolicy: {
        mcp__fixture__slow: "ask",
        mcp__fixture__read: "allow",
        mcp__fixture__forbidden: "deny",
      },
      agentPromptFile: join(dir, "manager.md"),
      outputDirectories: [],
      env: {},
      extraSettings: {},
      workerAgent: { description: "does tool work", promptFile: join(dir, "worker.md") },
      exclusiveTools: [],
      ...overrides.fields,
    },
    runtimeDir: join(dir, "runtime"),
    bridgeUrl: "http://127.0.0.1:2/mcp",
    gateUrl: "http://127.0.0.1:3/gate/token",
    sessionId: "s",
    resume: false,
    sessionIndex: 2,
    managerPromptFile:
      overrides.managerPromptFile === undefined
        ? join(dir, "manager.md")
        : overrides.managerPromptFile,
    workerPrompt: "work carefully",
    env,
  });

type Plan = ReturnType<typeof planIn>;

const fileOf = (plan: Plan, suffix: string): unknown => {
  const file = plan.setup.files.find((entry) => entry.path.endsWith(suffix));
  if (!file) throw new Error(`no ${suffix} in the plan`);
  return JSON.parse(file.content);
};

const flag = (plan: Plan, name: string): string => plan.args[plan.args.indexOf(name) + 1] ?? "";

describe("session plan", () => {
  it("inherits only the environment it is given, with the profile's env on top", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    const plan = planIn(
      directory.path,
      { LANG: "C", SHARED: "inherited", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" },
      { fields: { env: { SHARED: "profile" } } },
    );
    // A held approval gets 24h under both runtime timeouts (capability record F4).
    expect(plan.env).toEqual({
      LANG: "C",
      SHARED: "profile",
      MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
      CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
    });
  });

  it("writes nothing itself, and plans the directories and files its arguments refer to", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    const plan = planIn(directory.path);
    expect(existsSync(join(directory.path, "runtime"))).toBe(false);
    expect(plan.setup.directories).toEqual([
      join(directory.path, "runtime"),
      join(directory.path, "work"),
    ]);
    const planned = new Map(plan.setup.files.map((file) => [file.path, JSON.parse(file.content)]));
    expect(planned.get(flag(plan, "--mcp-config"))).toEqual(plan.description.mcp_config);
    expect(planned.get(flag(plan, "--settings"))).toEqual(plan.description.settings);
  });

  it("hands the runtime each MCP server without the body log only Mia reads", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    const written = JSON.stringify(fileOf(planIn(directory.path), ".mcp.json"));
    expect(written).toContain("http://127.0.0.1:1/mcp");
    expect(written).not.toContain("bodyLog");
  });

  it("reads messages as stream-json and replays each, loads no setting source, and asks only the bridge", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    const plan = planIn(directory.path);
    expect(flag(plan, "--input-format")).toBe("stream-json");
    expect(plan.args).toContain("--replay-user-messages");
    // No inherited rule can allow a call the hook failed to decide (see the capability record).
    expect(flag(plan, "--setting-sources")).toBe("");
    expect(flag(plan, "--permission-prompt-tool")).toBe("mcp__mia_approval__request");
    expect(flag(plan, "--tools")).toBe("Task,TaskStop");
  });

  it("lets the worker agent use every listed tool and neither manager tool", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    expect(fileOf(planIn(directory.path), ".agents.json")).toEqual({
      "mia-worker": {
        description: "does tool work",
        prompt: "work carefully",
        tools: ["mcp__fixture__slow", "mcp__fixture__read", "mcp__fixture__forbidden"],
      },
    });
  });

  it("leaves every call but a denied one to the gate hook, which may hold it as long as an approval", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    const settings = fileOf(planIn(directory.path), ".settings.json");
    expect(settings).toMatchObject({
      permissions: { deny: ["mcp__fixture__forbidden"], ask: [], allow: [] },
      hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", timeout: 86_400 }] }] },
    });
    expect(JSON.stringify(settings)).toContain("http://127.0.0.1:3/gate/token");
  });

  it("appends the manager prompt it is given, and none when given none", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    expect(flag(planIn(directory.path), "--append-system-prompt-file")).toBe(
      join(directory.path, "manager.md"),
    );
    const without = planIn(directory.path, {}, { managerPromptFile: null });
    expect(without.args).not.toContain("--append-system-prompt-file");
    // The delegation paragraph is appended either way: the manager prompt names no runtime's tools.
    expect(flag(without, "--append-system-prompt")).toBe(DELEGATION_INSTRUCTIONS);
  });

  it("turns on runtime debug logging only when the given environment sets MIA_RUNTIME_DEBUG", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    expect(planIn(directory.path).args).not.toContain("--debug");
    expect(flag(planIn(directory.path, { MIA_RUNTIME_DEBUG: "mcp" }), "--debug")).toBe("mcp");
  });

  it("keeps the worker prompt out of the retained description", () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "mia-launch-"));
    expect(JSON.stringify(planIn(directory.path).description)).not.toContain("work carefully");
  });
});
