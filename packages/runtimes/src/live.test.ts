import { describe, expect, it } from "vitest";
import { RuntimeConfigSchema, type ClaudeCodeConfig } from "@mia/agent-adapter";
import { liveRuntimeOf, onRuntime } from "./live.ts";

const claude: ClaudeCodeConfig = {
  kind: "claude-code",
  executable: "/opt/claude",
  model: "claude-sonnet-5",
  effort: "medium",
  workingDirectory: "/work",
  mcpServers: { fixture: { type: "http", url: "http://127.0.0.1:1/mcp" } },
  toolPolicy: { mcp__fixture__read: "allow" },
  agentPromptFile: "/prompts/manager.md",
  workerAgent: { description: "works", promptFile: "/prompts/worker.md" },
  exclusiveTools: [],
  outputDirectories: [],
  env: {},
  extraSettings: { permissions: { allow: ["Bash"] } },
};

const live = (name: string) => {
  const runtime = liveRuntimeOf(name);
  if (runtime === null) throw new Error(`no live runtime ${name}`);
  return runtime;
};

describe("onRuntime", () => {
  it("moves a Claude Code profile onto Codex as a config Codex's strict schema accepts", () => {
    const { extraSettings: _, ...shared } = claude;
    expect(RuntimeConfigSchema.parse(onRuntime(claude, live("codex")))).toStrictEqual({
      ...shared,
      kind: "codex",
      executable: "codex",
    });
  });

  it("keeps a profile already on the runtime, with its own executable and settings", () => {
    expect(onRuntime(claude, live("claude"))).toBe(claude);
  });
});
