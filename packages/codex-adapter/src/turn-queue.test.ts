import { describe, expect, it } from "vitest";
import { MAX_LISTED_ENDS, reportOf, TurnQueue, type EndReport } from "./turn-queue.ts";

const ended = (threadId: string): EndReport => ({
  path: `/root/${threadId}`,
  threadId,
  end: "completed",
  summary: null,
});

describe("TurnQueue", () => {
  it("reports every waiting end in the next turn, ahead of a waiting message", () => {
    const queue = new TurnQueue();
    queue.end(ended("a"));
    queue.message("next", "m1");
    queue.end(ended("b"));
    expect(queue.take()).toEqual({ kind: "ends", ends: [ended("a"), ended("b")], unlisted: 0 });
    expect(queue.take()).toEqual({ kind: "message", text: "next", runtimeMessageId: "m1" });
    expect(queue.take()).toBe(undefined);
  });

  it("counts the ends past its bound instead of listing them", () => {
    const queue = new TurnQueue();
    for (const index of Array.from({ length: MAX_LISTED_ENDS + 2 }, (_, at) => at))
      queue.end(ended(`w${index}`));
    const turn = queue.take();
    expect(turn).toMatchObject({ kind: "ends", unlisted: 2 });
    expect(turn?.kind === "ends" ? turn.ends : []).toHaveLength(MAX_LISTED_ENDS);
    expect(reportOf([], 2)).toBe(
      "[Mia] 2 more worker agents ended; their results are in Mia's records.",
    );
  });
});
