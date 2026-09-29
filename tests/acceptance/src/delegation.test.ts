import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutionRow, TaskRow, ToolCallRow, TurnRow } from "@mia/records";
import type { MiaClient } from "@mia/text-client";
import { ackError, ackResult, startTestServer, type TestServer } from "./harness.ts";
import { ScriptedGate, ScriptedSessions, type ScriptedSession } from "./scripted-session.ts";

// D2's user acceptance test (docs/PLAN.md, Deliverable 2), against the real server, gateway, records and client,
// with only the runtime scripted: two independent requests, one needing approval, and a long-running background
// task; a third question answered while the approval is pending; a rejection; the manager agent stopping one
// worker agent; the interrupt control stopping the rest; and the record of all of it.

const EXCLUSIVE = "mcp__d1__slow";

let server: TestServer;
let sessions: ScriptedSessions;
let gate: ScriptedGate;
let client: MiaClient;

let promptDir: string;

beforeEach(async () => {
  sessions = new ScriptedSessions();
  gate = new ScriptedGate();
  promptDir = mkdtempSync(join(tmpdir(), "mia-worker-prompt-"));
  const workerPrompt = join(promptDir, "worker-v-test.md");
  writeFileSync(workerPrompt, "# worker v-test\n");
  server = await startTestServer(
    undefined,
    {
      toolPolicy: {
        mcp__d1__read: "allow",
        mcp__d1__change: "ask",
        mcp__d1__slow: "allow",
        mcp__d1__forbidden: "deny",
      },
      mcpServers: { d1: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      workerAgent: { description: "does tool work", promptFile: workerPrompt },
      exclusiveTools: [EXCLUSIVE],
    },
    { delegation: { sessions, gate } },
  );
  client = await server.connect("client-A");
  await client.startConversation();
});
afterEach(async () => {
  console.log("LOGS", server.logs.join("\n"));
  try {
    await server.close();
  } finally {
    rmSync(promptDir, { recursive: true, force: true });
  }
});

const delegate = (session: ScriptedSession, runtimeTaskId: string) =>
  gate.ask({
    toolName: "Agent",
    input: { subagent_type: "mia-worker", run_in_background: true, prompt: runtimeTaskId },
    toolUseId: `toolu_delegate_${runtimeTaskId}`,
    agentId: null,
  });

/** A message whose turn starts one worker agent, a1. */
const oneWorker = async (): Promise<ScriptedSession> => {
  ackResult(await client.submitText("go"));
  const session = await sessions.session();
  await session.beginTurn();
  await delegate(session, "a1");
  await session.startWorker("a1", "task a1");
  return session;
};

const rows = <Row>(sql: string, ...params: string[]): Row[] => {
  const catalog = server.catalog();
  try {
    return catalog.all<Row>(sql, ...params);
  } finally {
    catalog.close();
  }
};

describe("D2: a manager agent that never blocks", () => {
  it("runs the plan's acceptance journey and records it", async () => {
    // Two independent things, one needing approval, and a long-running background task.
    ackResult(await client.submitText("read the counter, change it, and run the slow job"));
    const session = await sessions.session();
    await session.beginTurn();
    for (const worker of ["a_read", "a_change", "a_slow"]) {
      expect(await delegate(session, worker)).toEqual({ behavior: "allow" });
      await session.startWorker(worker, `task ${worker}`);
    }
    await session.reply("Started three tasks.");
    await session.endTurn();

    expect(
      await gate.ask({ toolName: "mcp__d1__read", toolUseId: "toolu_read", agentId: "a_read" }),
    ).toEqual({ behavior: "allow" });
    const slow = await gate.ask({
      toolName: EXCLUSIVE,
      toolUseId: "toolu_slow",
      agentId: "a_slow",
    });
    expect(slow).toEqual({ behavior: "allow" });
    const changeAnswer = gate.ask({
      toolName: "mcp__d1__change",
      input: { delta: 1 },
      toolUseId: "toolu_change",
      agentId: "a_change",
    });
    const approval = await client.waitFor("approval_requested");

    // While the approval is pending and the slow task runs, a third question is taken and answered.
    ackResult(await client.submitText("what is 2+2?"));
    expect((await session.waitForMessages(2))[1]).toBe("what is 2+2?");
    await session.beginTurn();
    await session.reply("4");
    await session.endTurn();
    const answered = await client.waitFor("reply_delta", (event) => event.payload.text === "4");
    expect(answered.payload.turn_id).toBeDefined();

    // A second concurrent call to the exclusive tool is refused while the slow task holds it.
    expect(
      await gate.ask({ toolName: EXCLUSIVE, toolUseId: "toolu_slow_2", agentId: "a_read" }),
    ).toMatchObject({ behavior: "deny" });

    // Reject the approval: only that call is refused, and its task runs on to its end.
    ackResult(
      await client.decide({
        taskId: approval.payload.task_id,
        approvalId: approval.payload.approval_id,
        decision: "reject",
      }),
    );
    expect(await changeAnswer).toMatchObject({ behavior: "deny" });
    await session.endWorker("a_change");
    await session.toolResult({ runtimeCallId: "toolu_read", workerTaskId: "a_read", content: "0" });
    await session.endWorker("a_read");

    // Each task's end starts a turn recorded as caused by it.
    await session.beginTurn();
    await session.reply("The change was rejected and did not run.");
    await session.endTurn();
    await session.beginTurn();
    await session.endTurn();

    // The manager agent stops one worker agent, then the interrupt control stops the rest.
    const stop = await gate.ask({
      toolName: "TaskStop",
      input: { task_id: "a_slow" },
      toolUseId: "toolu_stop",
      agentId: null,
    });
    expect(stop).toEqual({ behavior: "allow" });
    await client.waitFor("interruption_requested");
    expect(
      await gate.ask({ toolName: "mcp__d1__read", toolUseId: "toolu_after", agentId: "a_slow" }),
    ).toMatchObject({ behavior: "deny" });
    ackResult(await client.interruptAll());
    const outcome = await client.waitFor("interruption_outcome");
    expect(session.stopped).toBe(true);
    expect(outcome.payload.actions).toContainEqual(
      expect.objectContaining({ tool_identity: EXCLUSIVE, status: "unknown" }),
    );

    // The record: a manager execution with no task, one worker execution per task, turns caused by task ends.
    const conversationId = client.conversationId ?? "";
    const executions = rows<Pick<ExecutionRow, "agent_role" | "task_id">>(
      "SELECT agent_role, task_id FROM executions WHERE conversation_id = ?",
      conversationId,
    );
    expect(executions.filter((row) => row.agent_role === "manager")).toEqual([
      { agent_role: "manager", task_id: null },
    ]);
    expect(executions.filter((row) => row.agent_role === "worker")).toHaveLength(3);
    const tasks = rows<Pick<TaskRow, "id" | "turn_id" | "status">>(
      "SELECT id, turn_id, status FROM tasks WHERE conversation_id = ? ORDER BY created_at, id",
      conversationId,
    );
    expect(tasks.every((task) => task.turn_id !== null)).toBe(true);
    const turns = rows<Pick<TurnRow, "cause" | "caused_by_task_id">>(
      "SELECT cause, caused_by_task_id FROM turns WHERE conversation_id = ? ORDER BY started_at, rowid",
      conversationId,
    );
    expect(
      turns.filter((turn) => turn.cause === "task_end").map((turn) => turn.caused_by_task_id),
    ).toEqual(expect.arrayContaining([approval.payload.task_id]));
    const calls = rows<Pick<ToolCallRow, "tool_identity" | "status">>(
      "SELECT tool_identity, status FROM tool_calls WHERE conversation_id = ?",
      conversationId,
    );
    expect(calls).toContainEqual({ tool_identity: "mcp__d1__change", status: "denied" });
  });

  it("refuses a call from a worker agent it cannot attribute, and a worker agent that delegates", async () => {
    await oneWorker();
    expect(
      await gate.ask({ toolName: "mcp__d1__read", toolUseId: "toolu_x", agentId: "a_nobody" }),
    ).toMatchObject({ behavior: "deny" });
    expect(
      await gate.ask({ toolName: "Agent", toolUseId: "toolu_nested", agentId: "a1" }),
    ).toMatchObject({ behavior: "deny" });
    expect(
      await gate.ask({ toolName: "mcp__d1__read", toolUseId: "toolu_own", agentId: null }),
    ).toMatchObject({ behavior: "deny" });
    const events = rows<{ type: string }>(
      "SELECT type FROM events WHERE conversation_id = ? AND type IN ('tool_unattributed','tool_refused') ORDER BY sequence",
      client.conversationId ?? "",
    ).map((row) => row.type);
    expect(events).toEqual(["tool_unattributed", "tool_refused", "tool_refused"]);
  });

  it("stops one task at the person's request, then asks the manager agent to stop its worker agent", async () => {
    const session = await oneWorker();
    await session.endTurn();
    const started = await client.waitFor("task_started");
    ackResult(await client.interrupt(started.payload.task_id));
    expect(
      await gate.ask({ toolName: "mcp__d1__read", toolUseId: "toolu_late", agentId: "a1" }),
    ).toMatchObject({ behavior: "deny" });
    expect((await session.waitForMessages(2))[1]).toContain("TaskStop");
  });

  it("keeps accepting messages while tasks run, up to its queue's bound", async () => {
    for (let index = 0; index < 16; index += 1)
      ackResult(await client.submitText(`message ${index}`));
    expect(ackError(await client.submitText("one too many")).code).toBe("busy");
  });
});
