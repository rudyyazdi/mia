import { afterEach, describe, expect, it } from "vitest";
import { MAX_GATE_PAYLOAD_BYTES, ToolGate, type GateDecision, type GateRequest } from "./gate.ts";

const gates: ToolGate[] = [];
afterEach(async () => {
  await Promise.all(gates.splice(0).map((gate) => gate.close()));
});

const started = async (): Promise<ToolGate> => {
  const gate = new ToolGate();
  gates.push(gate);
  await gate.start();
  return gate;
};

const ask = (url: string, body: string, signal?: AbortSignal) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal,
  }).then((response) => response.json());

const call = JSON.stringify({
  tool_name: "mcp__fixture__change",
  tool_input: { delta: 1 },
  tool_use_id: "toolu_1",
  agent_id: "a1",
  agent_type: "mia-worker",
});

describe("ToolGate", () => {
  it("denies every call while no handler is set", async () => {
    const gate = await started();
    expect(await ask(gate.url, call)).toMatchObject({ behavior: "deny" });
  });

  it("hands the handler the call and its worker agent, and answers with its decision", async () => {
    const gate = await started();
    const seen: GateRequest[] = [];
    gate.setHandler(async (request) => {
      seen.push(request);
      return { behavior: "allow" };
    });
    expect(await ask(gate.url, call)).toEqual({ behavior: "allow" });
    expect(seen[0]).toMatchObject({
      toolName: "mcp__fixture__change",
      input: { delta: 1 },
      toolUseId: "toolu_1",
      agentId: "a1",
      agentType: "mia-worker",
    });
  });

  it("reports the manager agent's own call with no worker agent", async () => {
    const gate = await started();
    const agents: (string | null)[] = [];
    gate.setHandler(async (request) => {
      agents.push(request.agentId);
      return { behavior: "allow" };
    });
    await ask(gate.url, JSON.stringify({ tool_name: "Agent", tool_use_id: "toolu_2" }));
    expect(agents).toEqual([null]);
  });

  it("keeps a later claim when an earlier one with the same handler is released", async () => {
    const gate = await started();
    const handler = async (): Promise<GateDecision> => ({ behavior: "allow" });
    const releaseEnded = gate.setHandler(handler);
    const releaseCurrent = gate.setHandler(handler);
    releaseEnded();
    expect(await ask(gate.url, call)).toEqual({ behavior: "allow" });
    releaseCurrent();
    expect(await ask(gate.url, call)).toMatchObject({ behavior: "deny" });
  });

  it("denies malformed and oversized calls without asking the handler", async () => {
    const gate = await started();
    let asked = 0;
    gate.setHandler(async () => {
      asked += 1;
      return { behavior: "allow" };
    });
    expect(await ask(gate.url, "not json")).toMatchObject({ behavior: "deny" });
    expect(await ask(gate.url, "x".repeat(MAX_GATE_PAYLOAD_BYTES + 1))).toMatchObject({
      behavior: "deny",
    });
    expect(asked).toBe(0);
  });

  it("refuses a path without its token", async () => {
    const gate = await started();
    const response = await fetch(gate.url.replace(/[0-9a-f]+$/, "wrong"), {
      method: "POST",
      body: call,
    });
    expect(response.status).toBe(404);
  });

  it("aborts a held call's signal once the hook goes away", async () => {
    const gate = await started();
    const held = Promise.withResolvers<AbortSignal>();
    const abandoned = Promise.withResolvers<undefined>();
    gate.setHandler(async (request) => {
      held.resolve(request.abandoned);
      request.abandoned.addEventListener("abort", () => abandoned.resolve(undefined), {
        once: true,
      });
      await abandoned.promise;
      return { behavior: "deny", message: "abandoned" };
    });
    const hook = new AbortController();
    const answer = ask(gate.url, call, hook.signal).catch(() => "hook gone");
    const signal = await held.promise;
    expect(signal.aborted).toBe(false);
    hook.abort();
    await abandoned.promise;
    expect(signal.aborted).toBe(true);
    expect(await answer).toBe("hook gone");
  });
});
