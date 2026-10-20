import { describe, expect, it } from "vitest";
import type { CodexConfig } from "@mia/agent-adapter";
import { prepareCodexSession } from "./launch.ts";

const config: CodexConfig = {
  kind: "codex",
  executable: "codex",
  model: "gpt-6-luna",
  effort: "low",
  workingDirectory: "/work",
  mcpServers: {
    fixture: {
      type: "http",
      url: "http://127.0.0.1:1/mcp",
      headers: { authorization: "Bearer secret" },
      bodyLog: "/fixture/bodies.jsonl",
    },
    "local-tool": { type: "stdio", command: "local", args: ["--x"] },
  },
  toolPolicy: { mcp__fixture__read: "allow", mcp__fixture__change: "ask" },
  agentPromptFile: "/manager.md",
  workerAgent: { description: "does tool work", promptFile: "/worker.md" },
  exclusiveTools: [],
  outputDirectories: [],
  env: {},
};

const plan = (workerPrompt = "Do the task.", toolPolicy = config.toolPolicy) =>
  prepareCodexSession({
    config: { ...config, toolPolicy },
    codexHome: "/state/codex-home",
    runtimeDir: "/conversation/runtime",
    gateUrl: "http://127.0.0.1:2/gate/token",
    sessionId: "session",
    resume: false,
    sessionIndex: 1,
    workerPrompt,
    env: { HOME: "/home/user", PATH: "/bin" },
  });

const file = (name: string, workerPrompt?: string): string =>
  plan(workerPrompt).setup.files.find((entry) => entry.path === `/state/codex-home/${name}`)
    ?.content ?? "";

describe("prepareCodexSession", () => {
  it("gates every call through the hook, which allows silently, and lets Codex itself ask for nothing", () => {
    const hooks = JSON.parse(file("hooks.json"));
    expect(hooks.hooks.PreToolUse).toEqual([
      { matcher: "", hooks: [expect.objectContaining({ command: plan().hookCommand })] },
    ]);
    expect(plan().hookCommand).toContain("'--allow-silently'");
    const toml = file("config.toml");
    expect(toml).toContain('approval_policy = "never"');
    expect(toml).toContain('sandbox_mode = "read-only"');
    expect(toml).toContain("project_doc_max_bytes = 0");
    expect(toml).toMatch(/\[features\]\nhooks = true\nmulti_agent = true\nshell_tool = false\n/);
  });

  it("hands Codex each MCP server without the fields only Mia reads, its tools approved for the hook to decide", () => {
    const toml = file("config.toml");
    expect(toml).toContain(
      '[mcp_servers.fixture]\nurl = "http://127.0.0.1:1/mcp"\nhttp_headers = { authorization = "Bearer secret" }\ndefault_tools_approval_mode = "approve"',
    );
    expect(toml).toContain('[mcp_servers.local-tool]\ncommand = "local"\nargs = ["--x"]');
    expect(toml).not.toContain("bodies.jsonl");
    expect(JSON.stringify(plan().description)).not.toContain("Bearer secret");
  });

  it("writes the worker agent's instructions as one TOML string, whatever characters they hold", () => {
    const prompt = 'Say "hi" \\ then\nstop.\u007f';
    expect(file("agents/mia-worker.toml", prompt)).toContain(
      `developer_instructions = "Say \\"hi\\" \\\\ then\\nstop.\\u007F\\n\\n`,
    );
  });

  it("tells the worker agent the exact name of each tool in the policy", () => {
    const worker = file("agents/mia-worker.toml");
    expect(worker).toMatch(
      /developer_instructions = "Do the task\.\\n\\nYour tools are exactly: mcp__fixture__read, mcp__fixture__change\. Mia's policy may still refuse/,
    );
  });

  it("tells a worker agent with an empty policy that it has no tools, not an empty list", () => {
    const worker =
      plan("Do the task.", {}).setup.files.find((entry) => entry.path.endsWith("mia-worker.toml"))
        ?.content ?? "";
    expect(worker).toContain('developer_instructions = "Do the task.\\n\\nYou have no tools.');
    expect(worker).not.toContain("exactly: .");
  });

  it("links the user's own login into Mia's Codex home", () => {
    expect(plan().auth).toEqual({
      source: "/home/user/.codex/auth.json",
      link: "/state/codex-home/auth.json",
    });
    expect(plan().env.CODEX_HOME).toBe("/state/codex-home");
  });
});
