import { describe, expect, it } from "vitest";
import { untilAborted } from "./deadline.ts";

describe("untilAborted", () => {
  const abandoned = (reason: unknown) => `abandoned: ${String(reason)}`;

  it("gives up on work that never settles once the signal aborts", async () => {
    const controller = new AbortController();
    const outcome = untilAborted(
      () => new Promise<string>(() => undefined),
      controller.signal,
      abandoned,
    );
    controller.abort("deadline");
    await expect(outcome).resolves.toBe("abandoned: deadline");
  });

  it("never starts work under a signal that has already aborted", async () => {
    let started = false;
    const start = () => {
      started = true;
      return Promise.resolve("read");
    };
    await expect(untilAborted(start, AbortSignal.abort("shutdown"), abandoned)).resolves.toBe(
      "abandoned: shutdown",
    );
    expect(started).toBe(false);
  });
});
