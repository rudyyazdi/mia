import { describe, expect, it } from "vitest";
import { CodexConnection } from "./connection.ts";

describe("CodexConnection", () => {
  it("fails a request once its deadline passes, and ignores the answer that comes after", async () => {
    const written: string[] = [];
    const connection = new CodexConnection((line) => written.push(line) > 0);
    const deadline = new AbortController();
    const answered = connection.request("thread/start", {}, deadline.signal);
    deadline.abort();
    await expect(answered).rejects.toThrow("thread/start: no answer in time");
    connection.settle({ id: 1, result: {}, error: null });
    expect(written).toEqual([JSON.stringify({ id: 1, method: "thread/start", params: {} })]);
  });
});
