import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@mia/agent-adapter";
import { parseCodexLine, ThreadResultSchema } from "./protocol.ts";
import { CodexTranslator, workerEndOf } from "./translate.ts";

const at = "2026-01-01T00:00:00.000Z";
const now = () => at;

/**
 * Replays a transcript recorded from a real gpt-6-luna session through the live lane (Codex 0.159.3, retained by
 * Mia, so redacted): the manager agent's thread is the one the thread/start response names, as the session adopts it.
 */
const replay = (name: string) => {
  const translator = new CodexTranslator();
  const events: SessionEvent[] = [];
  const hookStarts: string[] = [];
  const text = readFileSync(join(import.meta.dirname, "fixtures", `${name}.jsonl`), "utf8");
  for (const line of text.split("\n")) {
    const parsed = parseCodexLine(line);
    if (!parsed?.ok) continue;
    const { message } = parsed;
    if (message.kind === "response") {
      const thread = ThreadResultSchema.safeParse(message.result);
      if (thread.success && translator.managerThreadId === null)
        translator.adopt({ threadId: thread.data.thread.id, model: thread.data.model });
    }
    if (message.kind !== "notification") continue;
    const hookCall = translator.managerHookStart(message);
    if (hookCall !== null) hookStarts.push(hookCall);
    events.push(...translator.translate(message, now));
  }
  const ofType = <T extends SessionEvent["type"]>(type: T) =>
    events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
  return { translator, events, hookStarts, ofType };
};

describe("CodexTranslator on a recorded session", () => {
  it("attributes a worker agent's call, result and text to the delegation that started it", () => {
    const { ofType, hookStarts } = replay("allowed");
    const [started] = ofType("worker_started");
    // The manager agent's spawn_agent call: the hook run Codex reported before asking the gate.
    expect(started?.delegationCallId).toBe(hookStarts[0]);
    expect(ofType("tool_proposed")).toEqual([
      expect.objectContaining({
        toolIdentity: "mcp__fixture__read",
        parentCallId: started?.delegationCallId,
      }),
    ]);
    expect(ofType("tool_result")).toEqual([
      expect.objectContaining({ parentCallId: started?.delegationCallId, isError: false }),
    ]);
    // Only the manager agent's own text is reply text.
    const reply = ofType("text_delta")
      .filter((delta) => delta.parentCallId === null)
      .map((delta) => delta.text)
      .join("");
    const finals = ofType("turn_result").map((result) => result.summary.finalText);
    expect(reply).toBe(finals.join(""));
  });

  it("reports Mia's message id when a turn takes it, and none for a turn reporting a worker agent's end", () => {
    const { events, ofType } = replay("allowed");
    expect(ofType("input_taken")).toHaveLength(1);
    const firstInit = events.findIndex((event) => event.type === "runtime_init");
    expect(events.findIndex((event) => event.type === "input_taken")).toBe(firstInit + 1);
    expect(ofType("runtime_init")).toHaveLength(ofType("turn_result").length);
  });

  it("ends a worker agent with its final message even when Codex reports the end before the worker's turn", () => {
    const { ofType } = replay("allowed");
    expect(ofType("worker_ended")).toEqual([
      expect.objectContaining({
        end: "completed",
        runtimeStatus: "completed",
        summary: "Called `fixture.read` once. The counter is 0.",
      }),
    ]);
  });

  it("ends an interrupted worker agent as stopped, and resolves the agent path interrupt_agent names", () => {
    const { ofType, translator, hookStarts } = replay("interrupt-task");
    const [started] = ofType("worker_started");
    expect(ofType("worker_ended")).toEqual([
      expect.objectContaining({
        runtimeTaskId: started?.runtimeTaskId,
        end: "stopped",
        runtimeStatus: "interrupted",
      }),
    ]);
    expect(translator.taskIdOf("/root/call_fixture")).toBe(started?.runtimeTaskId);
    expect(translator.taskIdOf(started?.runtimeTaskId ?? "")).toBe(started?.runtimeTaskId);
    expect(translator.taskIdOf("/root/elsewhere")).toBe(null);
    // spawn_agent, then interrupt_agent: both of the manager agent's calls were announced.
    expect(hookStarts).toHaveLength(2);
    expect(translator.runningWorkers).toBe(0);
  });

  it("keeps two worker agents' calls apart", () => {
    const { ofType } = replay("approve-reject");
    const delegations = ofType("worker_started").map((started) => started.delegationCallId);
    expect(new Set(delegations).size).toBe(2);
    // The user rejected the second worker agent's call, so the hook denied it and Codex reports no item for it.
    const parents = ofType("tool_proposed").map((proposed) => proposed.parentCallId);
    expect(parents).toEqual([delegations[0]]);
    expect(ofType("worker_ended").map((ended) => ended.delegationCallId)).toEqual(delegations);
  });

  it("reports nothing from a thread it does not know", () => {
    const translator = new CodexTranslator();
    translator.adopt({ threadId: "manager", model: "m" });
    const delta = { method: "item/agentMessage/delta", params: { threadId: "other", delta: "hi" } };
    expect(translator.translate(delta, now)).toEqual([]);
  });
});

describe("workerEndOf", () => {
  it.each([
    ["completed", "completed", "completed"],
    ["completed", null, "completed"],
    ["completed", "failed", "failed"],
    ["completed", "interrupted", "stopped"],
    ["interrupted", null, "stopped"],
    ["completed", "paused", "failed"],
    ["vanished", null, "failed"],
  ] as const)("maps activity %s with turn status %s to %s", (activity, turnStatus, end) => {
    expect(workerEndOf(activity, turnStatus)).toBe(end);
  });
});
