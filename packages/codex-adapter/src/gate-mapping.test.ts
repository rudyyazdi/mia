import { describe, expect, it } from "vitest";
import { readManagerCall, type GateRequest } from "@mia/agent-adapter";
import { miaGateRequest } from "./gate-mapping.ts";

/** A gate request as Codex's hook reports it (observed from Codex 0.159.3). */
const request = (toolName: string, input: unknown): GateRequest => ({
  toolName,
  input,
  toolUseId: "call_1",
  agentId: null,
  agentType: null,
  raw: { tool_name: toolName },
  receivedAt: "2026-01-01T00:00:00.000Z",
  abandoned: new AbortController().signal,
});

const threads: Record<string, string> = { "/root/fixture_slow": "thread-1" };
const taskIdOf = (target: string) => threads[target] ?? null;

describe("miaGateRequest", () => {
  it("reads spawn_agent as a background delegation naming its agent type", () => {
    const mia = miaGateRequest(
      request("collaborationspawn_agent", {
        agent_type: "mia-worker",
        task_name: "fixture_slow",
        message: "gAAAA-encrypted",
      }),
      taskIdOf,
    );
    expect(readManagerCall(mia.toolName, mia.input)).toEqual({
      kind: "delegate",
      subagentType: "mia-worker",
      background: true,
    });
  });

  it("reads a spawn_agent without an agent type as a delegation to no worker agent Mia knows", () => {
    const mia = miaGateRequest(request("collaborationspawn_agent", {}), taskIdOf);
    expect(readManagerCall(mia.toolName, mia.input)).toMatchObject({ subagentType: null });
  });

  it.each([
    ["/root/fixture_slow", "thread-1"],
    ["thread-9", "thread-9"],
  ])("reads interrupt_agent of %s as a stop of task %s", (target, task) => {
    const mia = miaGateRequest(request("collaborationinterrupt_agent", { target }), taskIdOf);
    expect(readManagerCall(mia.toolName, mia.input)).toEqual({ kind: "stop", runtimeTaskId: task });
  });

  it.each(["collaborationwait_agent", "collaborationlist_agents", "mcp__fixture__read"])(
    "leaves %s as Codex named it",
    (toolName) => {
      const original = request(toolName, { a: 1 });
      expect(miaGateRequest(original, taskIdOf)).toBe(original);
    },
  );
});
