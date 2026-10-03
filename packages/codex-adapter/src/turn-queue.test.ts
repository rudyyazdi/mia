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
  });
});

describe("reportOf", () => {
  // Codex shows the manager agent a worker agent's final message itself, mid-turn; the report names exactly whose
  // outcomes the reply may give, so a later batch's end is not reported early and again when Mia reports it.
  it("names exactly its batch, then each end, then the count it does not list", () => {
    const report = reportOf(
      [
        { ...ended("a"), summary: "The counter is 6." },
        { ...ended("b"), end: "failed", note: "[Mia note] x did not run." },
      ],
      1,
    );
    expect(report.split("\n")).toEqual([
      "[Mia] Report the outcomes of exactly these worker agents in this reply: /root/a, /root/b.",
      "[Mia] Worker agent /root/a (id a) ended: completed. Its final message: The counter is 6.",
      "[Mia] Worker agent /root/b (id b) ended: failed. [Mia note] x did not run.",
      "[Mia] 1 more worker agent ended; Mia will not list that end, so report only this count, not their outcomes.",
    ]);
  });

  it("leaves an end past the bound out of the batch it names, and promises no later listing of it", () => {
    const queue = new TurnQueue();
    for (const index of Array.from({ length: MAX_LISTED_ENDS + 1 }, (_, at) => at))
      queue.end(ended(`w${index}`));
    const turn = queue.take();
    if (turn?.kind !== "ends") throw new Error("expected an ends turn");
    const lines = reportOf(turn.ends, turn.unlisted).split("\n");
    const listed = Array.from({ length: MAX_LISTED_ENDS }, (_, at) => `/root/w${at}`);
    expect(lines[0]).toBe(
      `[Mia] Report the outcomes of exactly these worker agents in this reply: ${listed.join(", ")}.`,
    );
    expect(lines.filter((line) => line.includes(`/root/w${MAX_LISTED_ENDS}`))).toEqual([]);
    expect(lines.at(-1)).toBe(
      "[Mia] 1 more worker agent ended; Mia will not list that end, so report only this count, not their outcomes.",
    );
  });
});
