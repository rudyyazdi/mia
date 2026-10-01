import { describe, expect, it } from "vitest";
import { ProposalRendezvous } from "./proposals.ts";

const call = { toolName: "Task", input: { subagent_type: "mia-worker" } };

describe("ProposalRendezvous", () => {
  it("hands over a call the gate heard before stdout reported its hook", async () => {
    const rendezvous = new ProposalRendezvous();
    rendezvous.offer("call_1", call);
    expect(await rendezvous.take("call_1", new AbortController().signal)).toEqual(call);
    // Taken once: a second report of the same hook finds nothing.
    const gone = new AbortController();
    gone.abort();
    expect(await rendezvous.take("call_1", gone.signal)).toBe(null);
  });

  it("waits for the gate when stdout reported the hook first", async () => {
    const rendezvous = new ProposalRendezvous();
    const taken = rendezvous.take("call_1", new AbortController().signal);
    rendezvous.offer("call_2", { toolName: "TaskStop", input: {} });
    rendezvous.offer("call_1", call);
    expect(await taken).toEqual(call);
  });

  it("gives up once its deadline aborts, and keeps a later offer for its own report", async () => {
    const rendezvous = new ProposalRendezvous();
    const deadline = new AbortController();
    const taken = rendezvous.take("call_1", deadline.signal);
    deadline.abort();
    expect(await taken).toBe(null);
    rendezvous.offer("call_1", call);
    expect(await rendezvous.take("call_1", new AbortController().signal)).toEqual(call);
  });
});
