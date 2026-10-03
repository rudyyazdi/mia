import { describe, expect, it } from "vitest";
import { MAX_LISTED_ENDS, reportOf, TurnQueue, type EndReport } from "./turn-queue.ts";

const ended = (threadId: string): EndReport => ({
  path: `/root/${threadId}`,
  threadId,
  end: "completed",
  summary: null,
  note: null,
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
    expect(
      reportOf([ended("a")], 2)
        .split("\n")
        .at(-1),
    ).toBe(
      "[Mia] 2 more worker agents ended; their results are in Mia's records but are not included in this turn's attributed batch.",
    );
  });
});

describe("reportOf", () => {
  // Codex shows the manager agent a worker agent's final message itself, mid-turn, as "Message Type: FINAL_ANSWER"
  // with "Sender: <path>"; a report that did not say which senders it covers had the manager agent report a later
  // batch's end early, and then again when Mia reported it.
  it("scopes the reply to the senders it lists and defers Codex's own final message from any other", () => {
    const [scope = ""] = reportOf([ended("a"), ended("b")], 0).split("\n");
    expect(scope).toContain("only: /root/a, /root/b.");
    expect(scope).toContain('"Message Type: FINAL_ANSWER" message from any other Sender');
    expect(scope).toContain("leave it out of this reply");
  });
});
