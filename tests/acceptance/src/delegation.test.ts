import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { ExecutionRow, TaskRow, ToolCallRow, TurnRow } from "@mia/records";
import type { MiaClient } from "@mia/text-client";
import {
  ackError,
  ackResult,
  must,
  turnWithWorker,
  useScripted,
  type Scripted,
  type TestServer,
} from "./harness.ts";
import type { ScriptedSessions } from "./scripted-session.ts";

// The manager agent's user acceptance journey, against the real server, gateway, records and client,
// with only the runtime scripted: two independent requests, one needing approval, and a long-running background
// task; a third question answered while the approval is pending; a rejection; the manager agent stopping one
// worker agent; the interrupt control stopping the rest; and the record of all of it.

const EXCLUSIVE = "mcp__fixture__slow";

let scripted: Scripted;
let server: TestServer;
let sessions: ScriptedSessions;
let client: MiaClient;
const restart = useScripted((started) => {
  scripted = started;
  ({ server, sessions, client } = started);
});

const rows = <Row>(sql: string, ...params: string[]): Row[] => {
  const catalog = server.catalog();
  try {
    return catalog.all<Row>(sql, ...params);
  } finally {
    catalog.close();
  }
};

const conversationId = (): string => must(client.conversationId, "conversation id");

describe("a manager agent that never blocks", () => {
  it("runs the plan's acceptance journey and records it", async () => {
    await restart({
      exclusiveTools: [EXCLUSIVE],
      toolPolicy: { ...server.profile.runtime.toolPolicy, [EXCLUSIVE]: "allow" },
    });
    // Two independent things, one needing approval, and a long-running background task.
    const session = await turnWithWorker(scripted, {
      text: "read, change and run the slow job",
      runtimeTaskId: "a_read",
    });
    for (const worker of ["a_change", "a_slow"])
      expect(await session.delegate(worker)).toEqual({ behavior: "allow" });
    await session.reply("Started three tasks.");
    await session.endTurn();

    expect(
      await session.ask({
        toolName: "mcp__fixture__read",
        toolUseId: "toolu_read",
        agentId: "a_read",
      }),
    ).toEqual({ behavior: "allow" });
    expect(
      await session.ask({ toolName: EXCLUSIVE, toolUseId: "toolu_slow", agentId: "a_slow" }),
    ).toEqual({ behavior: "allow" });
    const changeAnswer = session.ask({
      toolName: "mcp__fixture__change",
      input: { delta: 1 },
      toolUseId: "toolu_change",
      agentId: "a_change",
    });
    const approval = await client.waitFor("approval_requested");

    // While the approval is pending and the slow task runs, a third question is taken and answered.
    ackResult(await client.submitText("what is 2+2?"));
    await session.beginTurn(1);
    await session.reply("4");
    await session.endTurn();
    const answered = await client.waitFor("reply_delta", (event) => event.payload.text === "4");
    expect(answered.payload.turn_id).toBeDefined();

    // A second concurrent call to the exclusive tool is refused while the slow task holds it.
    expect(
      await session.ask({ toolName: EXCLUSIVE, toolUseId: "toolu_slow_2", agentId: "a_read" }),
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

    // The task ends start a turn recorded as caused by them.
    await session.beginTurn();
    await session.reply("The change was rejected and did not run.");
    await session.endTurn();

    // The manager agent stops one worker agent, then the interrupt control stops the rest.
    expect(
      await session.ask({
        toolName: "TaskStop",
        input: { task_id: "a_slow" },
        toolUseId: "toolu_stop",
        agentId: null,
      }),
    ).toEqual({ behavior: "allow" });
    await client.waitFor("interruption_requested");
    expect(
      await session.ask({
        toolName: "mcp__fixture__read",
        toolUseId: "toolu_after",
        agentId: "a_slow",
      }),
    ).toMatchObject({ behavior: "deny" });
    ackResult(await client.interruptAll());
    const outcome = await client.waitFor("interruption_outcome");
    expect(session.stopped).toBe(true);
    expect(outcome.payload.actions).toContainEqual(
      expect.objectContaining({ tool_identity: EXCLUSIVE, status: "unknown" }),
    );

    const executions = rows<Pick<ExecutionRow, "agent_role" | "task_id">>(
      "SELECT agent_role, task_id FROM executions WHERE conversation_id = ?",
      conversationId(),
    );
    expect(executions.filter((row) => row.agent_role === "manager")).toEqual([
      { agent_role: "manager", task_id: null },
    ]);
    expect(executions.filter((row) => row.agent_role === "worker")).toHaveLength(3);
    const tasks = rows<Pick<TaskRow, "turn_id">>(
      "SELECT turn_id FROM tasks WHERE conversation_id = ?",
      conversationId(),
    );
    expect(tasks.every((task) => task.turn_id !== null)).toBe(true);
    const turns = rows<Pick<TurnRow, "cause" | "caused_by_task_id">>(
      "SELECT cause, caused_by_task_id FROM turns WHERE conversation_id = ? ORDER BY started_at, rowid",
      conversationId(),
    );
    expect(turns.map((turn) => turn.cause)).toEqual(["user_input", "user_input", "task_end"]);
    expect(turns[2]?.caused_by_task_id).toBe(approval.payload.task_id);
    const calls = rows<Pick<ToolCallRow, "tool_identity" | "status">>(
      "SELECT tool_identity, status FROM tool_calls WHERE conversation_id = ?",
      conversationId(),
    );
    expect(calls).toContainEqual({ tool_identity: "mcp__fixture__change", status: "denied" });
  });

  it("refuses a call it cannot attribute, a worker agent that delegates, and the manager agent's own tool call", async () => {
    const session = await turnWithWorker(scripted, { text: "go", runtimeTaskId: "a1" });
    server.expireAttributionWaits();
    expect(
      await session.ask({
        toolName: "mcp__fixture__read",
        toolUseId: "toolu_x",
        agentId: "a_nobody",
      }),
    ).toMatchObject({ behavior: "deny" });
    expect(
      await session.ask({ toolName: "Agent", toolUseId: "toolu_nested", agentId: "a1" }),
    ).toMatchObject({ behavior: "deny" });
    expect(
      await session.ask({ toolName: "mcp__fixture__read", toolUseId: "toolu_own", agentId: null }),
    ).toMatchObject({ behavior: "deny" });
    const events = rows<{ type: string }>(
      "SELECT type FROM events WHERE conversation_id = ? AND type IN ('tool_unattributed','tool_refused') ORDER BY sequence",
      conversationId(),
    ).map((row) => row.type);
    expect(events).toEqual(["tool_unattributed", "tool_refused", "tool_refused"]);
  });

  it("decides a worker agent's call that arrives before the runtime reports its start, once the start arrives", async () => {
    const session = await turnWithWorker(scripted, { text: "go" });
    expect(
      await session.ask({
        toolName: "Agent",
        input: { subagent_type: "mia-worker", run_in_background: true },
        toolUseId: "toolu_delegate_a1",
        agentId: null,
      }),
    ).toEqual({ behavior: "allow" });
    const early = session.ask({
      toolName: "mcp__fixture__read",
      toolUseId: "toolu_early",
      agentId: "a1",
    });
    await session.emit({
      type: "worker_started",
      runtimeTaskId: "a1",
      delegationCallId: "toolu_delegate_a1",
      description: "a1",
      prompt: "a1",
      background: true,
      at: new Date().toISOString(),
    });
    expect(await early).toEqual({ behavior: "allow" });
  });

  it("stops one task at the person's request, then asks the manager agent to stop its worker agent", async () => {
    const session = await turnWithWorker(scripted, { text: "go", runtimeTaskId: "a1" });
    await session.endTurn();
    const started = await client.waitFor("task_started");
    expect(ackResult(await client.interrupt(started.payload.task_id))).toMatchObject({
      gate_closed: true,
      manager_asked: true,
    });
    expect(
      await session.ask({ toolName: "mcp__fixture__read", toolUseId: "toolu_late", agentId: "a1" }),
    ).toMatchObject({ behavior: "deny" });
    expect((await session.waitForMessages(2))[1]).toContain("TaskStop");
  });

  it("asks the manager agent again when a task is stopped again after the first ask failed", async () => {
    const session = await turnWithWorker(scripted, { text: "go", runtimeTaskId: "a1" });
    for (let index = 0; index < 16; index += 1)
      ackResult(await client.submitText(`message ${index}`));
    const started = await client.waitFor("task_started");
    expect(ackResult(await client.interrupt(started.payload.task_id))).toMatchObject({
      gate_closed: true,
      manager_asked: false,
    });
    await session.endTurn();
    await session.beginTurn(session.messages.length - 1);
    expect(ackResult(await client.interrupt(started.payload.task_id))).toMatchObject({
      already_stopping: true,
      manager_asked: true,
    });
    expect(session.messages.at(-1)?.text).toContain("TaskStop");
  });

  it("makes a turn the user's when its delegation reaches the gate before stdout replays the message", async () => {
    const session = await turnWithWorker(scripted, { text: "go", runtimeTaskId: "a1" });
    await session.endTurn();
    await session.endWorker("a1");
    ackResult(await client.submitText("second"));
    await session.beginTurn();
    const message = must(session.messages.at(-1), "the second message");
    const asked = session.ask({
      toolName: "Agent",
      input: { subagent_type: "mia-worker", run_in_background: true },
      toolUseId: "toolu_delegate_a2",
      agentId: null,
      unproposed: true,
    });
    // Every pending callback runs first, so the gate request gets as far as it can before stdout catches up.
    await setImmediate();
    await session.emit({
      type: "input_taken",
      runtimeMessageId: message.runtimeMessageId,
      at: new Date().toISOString(),
    });
    await session.emit({
      type: "tool_proposed",
      runtimeCallId: "toolu_delegate_a2",
      parentCallId: null,
      toolIdentity: "Agent",
      arguments: {},
      complete: false,
      at: new Date().toISOString(),
    });
    expect(await asked).toEqual({ behavior: "allow" });
    const turns = rows<Pick<TurnRow, "cause">>(
      "SELECT cause FROM turns WHERE conversation_id = ? ORDER BY started_at, rowid",
      conversationId(),
    );
    expect(turns.at(-1)?.cause).toBe("user_input");
  });

  it("records a kill whose exit was never seen as unknown, not as confirmed", async () => {
    const session = await turnWithWorker(scripted, { text: "go", runtimeTaskId: "a1" });
    session.cancellation = "unknown";
    ackResult(await client.interruptAll());
    const outcome = await client.waitFor("interruption_outcome");
    expect(outcome.payload.runtime_cancellation).toBe("unknown");
  });

  it("starts a new conversation over an idle session, which is closed", async () => {
    const session = await turnWithWorker(scripted, { text: "hello" });
    await session.reply("hi");
    await session.endTurn();
    const first = conversationId();
    expect(await client.startConversation()).not.toBe(first);
    // Closed: the idle session takes no more input.
    expect(session.handle.send("more", "uuid-more")).toBe(false);
  });

  it("records a replaced conversation's late reply without sending it to the new conversation's client", async () => {
    const session = await turnWithWorker(scripted, { text: "hello" });
    await session.endTurn();
    const first = conversationId();
    await client.startConversation();
    await session.beginTurn();
    await session.reply("late");
    // Acknowledged after anything sent before it on the same connection.
    expect((await client.sendDiagnostics()).disposition).toBe("accepted");
    expect(
      client.events.filter(
        (event) => event.type === "reply_delta" && event.payload.conversation_id === first,
      ),
    ).toEqual([]);
    expect(
      rows("SELECT id FROM events WHERE conversation_id = ? AND type = 'reply_delta'", first),
    ).toHaveLength(1);
  });

  it("keeps accepting messages while tasks run, up to its queue's bound", async () => {
    for (let index = 0; index < 16; index += 1)
      ackResult(await client.submitText(`message ${index}`));
    expect(ackError(await client.submitText("one too many")).code).toBe("busy");
  });

  it("does not reopen a session whose end it could not record: the next message opens a new one", async () => {
    const session = await turnWithWorker(scripted, { text: "go" });
    server.server.catalog.db.exec(`CREATE TRIGGER fail_session_end BEFORE INSERT ON events
      WHEN NEW.type = 'runtime_exit' BEGIN SELECT RAISE(ABORT, 'simulated commit failure'); END`);
    session.finish("ended");
    await server.waitForLog((line) => line.includes("letting it go"));
    ackResult(await client.submitText("again"));
    await sessions.session(1);
    server.server.catalog.db.exec("DROP TRIGGER fail_session_end");
  });
});
