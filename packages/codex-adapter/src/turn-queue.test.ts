import { describe, expect, it } from "vitest";
import { TurnQueue, type EndReport } from "./turn-queue.ts";

const ended = (threadId: string): EndReport => ({
  path: `/root/${threadId}`,
  threadId,
  end: "completed",
  summary: null,
});

describe("TurnQueue", () => {
  it("reports the ends no turn has reported yet in one turn, in order with messages", () => {
    const queue = new TurnQueue();
    queue.end(ended("a"));
    queue.end(ended("b"));
    queue.message("next", "m1");
    queue.end(ended("c"));
    expect(queue.take()).toEqual({ kind: "ends", ends: [ended("a"), ended("b")] });
    expect(queue.take()).toEqual({ kind: "message", text: "next", runtimeMessageId: "m1" });
    expect(queue.take()).toEqual({ kind: "ends", ends: [ended("c")] });
    expect(queue.take()).toBe(undefined);
  });
});
