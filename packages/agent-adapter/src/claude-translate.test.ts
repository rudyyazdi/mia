import { REDACTED } from "@mia/protocol";
import { describe, expect, it } from "vitest";
import { ClaudeTranslator, taskEventsOf } from "./claude-translate.ts";
import { parseStreamLine, type RuntimeMessage } from "./stream.ts";

const at = "2026-01-01T00:00:00.000Z";
const now = () => at;

/** Messages go through the real stream parser, so the translator sees exactly what the adapter feeds it. */
const message = (json: unknown): RuntimeMessage => {
  const parsed = parseStreamLine(JSON.stringify(json));
  if (!parsed?.ok) throw new Error(`fixture did not parse: ${JSON.stringify(json)}`);
  return parsed.message;
};

const init = {
  type: "system",
  subtype: "init",
  session_id: "session",
  model: "claude-test",
  tools: ["mcp__d1__read"],
  mcp_servers: [{ name: "d1", status: "connected" }],
  claude_code_version: "2.1.0",
};

const toolUse = { type: "tool_use", id: "toolu_1", name: "mcp__d1__read", input: { key: 1 } };

describe("ClaudeTranslator", () => {
  it("reports the init model and keeps the whole init message as evidence", () => {
    expect(new ClaudeTranslator().translate(message(init), now)).toEqual([
      { type: "runtime_init", init: { model: "claude-test", evidence: init }, at },
    ]);
  });

  it("ignores system messages other than init and messages it does not know", () => {
    const translator = new ClaudeTranslator();
    expect(translator.translate(message({ type: "system", subtype: "compact" }), now)).toEqual([]);
    expect(translator.translate(message({ type: "rate_limit_event" }), now)).toEqual([]);
  });

  it("streams text deltas and announces a tool call as soon as its block starts", () => {
    const translator = new ClaudeTranslator();
    const delta = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
    };
    const start = {
      type: "stream_event",
      event: { type: "content_block_start", content_block: { ...toolUse, input: {} } },
    };
    expect(translator.translate(message(delta), now)).toEqual([
      { type: "text_delta", text: "hi", parentCallId: null, at },
    ]);
    expect(translator.translate(message(start), now)).toEqual([
      {
        type: "tool_proposed",
        runtimeCallId: "toolu_1",
        parentCallId: null,
        toolIdentity: "mcp__d1__read",
        arguments: {},
        complete: false,
        at,
      },
    ]);
  });

  it("reports a tool call's complete proposal once, however often the assistant repeats it", () => {
    const translator = new ClaudeTranslator();
    const assistant = message({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }, toolUse] },
    });
    const first = translator.translate(assistant, now);
    expect(first.map((event) => event.type)).toEqual(["assistant_message", "tool_proposed"]);
    expect(first[1]).toEqual({
      type: "tool_proposed",
      runtimeCallId: "toolu_1",
      parentCallId: null,
      toolIdentity: "mcp__d1__read",
      arguments: { key: 1 },
      complete: true,
      at,
    });
    expect(translator.translate(assistant, now).map((event) => event.type)).toEqual([
      "assistant_message",
    ]);
  });

  it("reports each tool result block with its call id and error flag", () => {
    const user = message({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "done", is_error: false },
          { type: "tool_result", tool_use_id: "toolu_2", content: "denied", is_error: true },
          { type: "text", text: "ignored" },
        ],
      },
      tool_use_result: { stdout: "done" },
    });
    expect(new ClaudeTranslator().translate(user, now)).toEqual([
      {
        type: "tool_result",
        runtimeCallId: "toolu_1",
        parentCallId: null,
        isError: false,
        content: "done",
        raw: { stdout: "done" },
        at,
      },
      {
        type: "tool_result",
        runtimeCallId: "toolu_2",
        parentCallId: null,
        isError: true,
        content: "denied",
        raw: { stdout: "done" },
        at,
      },
    ]);
  });

  it("redacts secret-shaped values in assistant messages and tool results", () => {
    const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const translator = new ClaudeTranslator();
    const [assistant] = translator.translate(
      message({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: `key ${secret}` }] },
      }),
      now,
    );
    expect(assistant).toEqual({
      type: "assistant_message",
      message: { role: "assistant", content: [{ type: "text", text: `key ${REDACTED}` }] },
      at,
    });
    const [result] = translator.translate(
      message({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: `got ${secret}` }],
        },
        tool_use_result: { stdout: secret },
      }),
      now,
    );
    expect(result).toMatchObject({ content: `got ${REDACTED}`, raw: { stdout: REDACTED } });
  });
});

describe("taskEventsOf", () => {
  it("reports a worker agent's start and end from the runtime's task messages", () => {
    const started = message({
      type: "system",
      subtype: "task_started",
      task_id: "a1",
      tool_use_id: "toolu_delegation",
      description: "read",
      prompt: "call d1.read",
      is_backgrounded: true,
      subagent_type: "mia-worker",
    });
    const ended = message({
      type: "system",
      subtype: "task_notification",
      task_id: "a1",
      tool_use_id: "toolu_delegation",
      status: "completed",
      summary: "read 0",
    });
    expect(taskEventsOf(started, now)).toEqual([
      {
        type: "worker_started",
        runtimeTaskId: "a1",
        delegationCallId: "toolu_delegation",
        description: "read",
        prompt: "call d1.read",
        background: true,
        at,
      },
    ]);
    expect(taskEventsOf(ended, now)).toEqual([
      {
        type: "worker_ended",
        runtimeTaskId: "a1",
        delegationCallId: "toolu_delegation",
        status: "completed",
        summary: "read 0",
        at,
      },
    ]);
  });

  it("reports nothing for other messages, including task progress", () => {
    expect(taskEventsOf(message(init), now)).toEqual([]);
    expect(
      taskEventsOf(message({ type: "system", subtype: "task_progress", task_id: "a1" }), now),
    ).toEqual([]);
  });

  it("attributes a worker agent's call to its delegation call", () => {
    const translated = new ClaudeTranslator().translate(
      message({
        type: "assistant",
        parent_tool_use_id: "toolu_delegation",
        message: { role: "assistant", content: [toolUse] },
      }),
      now,
    );
    expect(translated).toContainEqual(
      expect.objectContaining({ type: "tool_proposed", parentCallId: "toolu_delegation" }),
    );
  });
});
