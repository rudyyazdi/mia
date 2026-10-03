import { describe, expect, it } from "vitest";
import { REDACTED } from "@mia/protocol";
import { mcpBodiesFrom } from "./mcp-bodies.ts";

const logOf = (...lines: unknown[]) => ({
  status: "read" as const,
  bytes: Buffer.from(lines.map((line) => JSON.stringify(line) + "\n").join("")),
});

describe("mcpBodiesFrom", () => {
  it("does not attribute uncorrelated Codex exchanges to a call with identical arguments", () => {
    const read = logOf(
      {
        tool_use_id: null,
        exchange_id: "exchange-1",
        direction: "request",
        body: { id: 1, params: { arguments: {} } },
      },
      {
        tool_use_id: null,
        exchange_id: "exchange-1",
        direction: "response",
        body: { id: 1, result: "other call" },
      },
    );
    expect(
      mcpBodiesFrom(read, "exec-current", { readAt: "tool_result", runtime: "codex" }),
    ).toEqual(
      ["request", "response"].map((direction) => ({
        direction,
        status: "unrecorded",
        reason: expect.stringContaining("without call attribution"),
      })),
    );
  });
  it("records a call's lines in log order, redacted, and ignores other calls' lines", () => {
    const read = logOf(
      { tool_use_id: "toolu_a", direction: "request", body: { params: { api_key: "k" } } },
      { tool_use_id: "toolu_b", direction: "request", body: 2 },
      { tool_use_id: "toolu_a", direction: "response", body: { result: "sk-ant-abcdefghijk" } },
    );
    expect(
      mcpBodiesFrom(read, "toolu_a", { readAt: "tool_result", runtime: "claude-code" }),
    ).toEqual([
      { direction: "request", status: "recorded", body: { params: { api_key: REDACTED } } },
      { direction: "response", status: "recorded", body: { result: REDACTED } },
    ]);
  });

  it("records every request of a call the runtime sent twice, and why its response is missing", () => {
    const read = logOf(
      { tool_use_id: "toolu_a", direction: "request", body: 1 },
      { tool_use_id: "toolu_a", direction: "request", body: 2 },
    );
    expect(
      mcpBodiesFrom(read, "toolu_a", { readAt: "tool_result", runtime: "claude-code" }),
    ).toEqual([
      { direction: "request", status: "recorded", body: 1 },
      { direction: "request", status: "recorded", body: 2 },
      {
        direction: "response",
        status: "unrecorded",
        reason: "the body log has no response for this call",
      },
    ]);
  });

  it("says at session end only that a missing line was not written yet, as the server may still be handling it", () => {
    const read = logOf({ tool_use_id: "toolu_a", direction: "request", body: 1 });
    expect(
      mcpBodiesFrom(read, "toolu_a", { readAt: "session_end", runtime: "claude-code" }),
    ).toEqual([
      { direction: "request", status: "recorded", body: 1 },
      {
        direction: "response",
        status: "unrecorded",
        reason: "the body log had no response for this call when its session ended",
      },
    ]);
  });

  it.each([
    { read: { status: "absent" as const }, reason: "the body log does not exist" },
    {
      read: { status: "unreadable" as const, reason: "EACCES" },
      reason: "the body log is unreadable: EACCES",
    },
    { read: logOf(), reason: undefined },
  ])("records why both bodies are missing when the log is $read.status", ({ read, reason }) => {
    const bodies = mcpBodiesFrom(read, "toolu_a", {
      readAt: "tool_result",
      runtime: "claude-code",
    });
    expect(bodies.map((body) => body.direction)).toEqual(["request", "response"]);
    for (const body of bodies)
      expect(body).toEqual({
        direction: body.direction,
        status: "unrecorded",
        reason: reason ?? `the body log has no ${body.direction} for this call`,
      });
  });
});
