import { describe, expect, it } from "vitest";
import type { GateRequest } from "@mia/agent-adapter";
import { ProposalRendezvous } from "./proposals.ts";

const call = (toolName: string): GateRequest => ({
  toolName,
  input: {},
  toolUseId: "call_1",
  agentId: null,
  agentType: null,
  raw: {},
  receivedAt: "2026-01-01T00:00:00.000Z",
  abandoned: new AbortController().signal,
});
const open = () => new AbortController().signal;

describe("ProposalRendezvous", () => {
  it("reads a call the gate heard first only once stdout reaches its hook", async () => {
    const rendezvous = new ProposalRendezvous();
    // What the call reads as depends on what stdout has reported by then, such as a worker agent's start.
    let known = "before";
    const offered = rendezvous.offer("call_1", () => call(known), open());
    known = "after";
    expect((await rendezvous.take("call_1", open()))?.toolName).toBe("after");
    expect((await offered).toolName).toBe("after");
  });

  it("hands a call over when stdout reported its hook first", async () => {
    const rendezvous = new ProposalRendezvous();
    const taken = rendezvous.take("call_1", open());
    await rendezvous.offer("call_2", () => call("other"), AbortSignal.abort());
    expect((await rendezvous.offer("call_1", () => call("Task"), open())).toolName).toBe("Task");
    expect((await taken)?.toolName).toBe("Task");
  });

  it("reads a call on its own once its deadline passes, and stdout then finds nothing", async () => {
    const rendezvous = new ProposalRendezvous();
    const deadline = new AbortController();
    const offered = rendezvous.offer("call_1", () => call("Task"), deadline.signal);
    deadline.abort();
    expect((await offered).toolName).toBe("Task");
    expect(await rendezvous.take("call_1", AbortSignal.abort())).toBe(null);
  });
});
