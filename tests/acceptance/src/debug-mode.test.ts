import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeKind } from "@mia/agent-adapter";
import { TOOL_USE_ID_META } from "@mia/mcp-http";
import { REDACTED } from "@mia/protocol";
import {
  snapshotConversation,
  type ConversationSnapshot,
  type JournalEventType,
} from "@mia/records";
import { must, startTestServer, turnWithWorker, type TestServer } from "./harness.ts";
import { ScriptedSessions } from "./scripted-session.ts";

const servers: TestServer[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

type SnapshotTables = ConversationSnapshot["tables"];

const READ_REQUEST = {
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "read", arguments: {}, _meta: { [TOOL_USE_ID_META]: "toolu_read" } },
};
const READ_RESPONSE = {
  jsonrpc: "2.0",
  id: 3,
  result: { content: [{ type: "text", text: JSON.stringify({ unread: 3 }) }], api_key: "sk-live" },
};

/** Writes body log lines as the fixture does: one JSON object per line. */
const writeBodyLog = (path: string, lines: readonly unknown[]): void =>
  writeFileSync(path, lines.map((line) => JSON.stringify(line) + "\n").join(""));

/**
 * A fresh server with debug mode on or off whose fixture server names a body log in a fresh directory (none with
 * `bodyLog` "unconfigured"), and a message whose turn has started worker agent a1.
 */
const startWork = async (
  debugMode: boolean,
  bodyLog: "configured" | "unconfigured",
  runtime: RuntimeKind = "claude-code",
) => {
  const logDirectory = mkdtempSync(join(tmpdir(), "mia-body-log-"));
  directories.push(logDirectory);
  const bodyLogFile = join(logDirectory, "mcp-bodies.jsonl");
  const sessions = new ScriptedSessions();
  const server = await startTestServer(
    sessions,
    {
      kind: runtime,
      ...(bodyLog === "unconfigured"
        ? {}
        : {
            mcpServers: {
              fixture: { type: "http", url: "http://127.0.0.1:1/mcp", bodyLog: bodyLogFile },
            },
          }),
    },
    { debugMode },
  );
  servers.push(server);
  const client = await server.connect("client-A");
  await client.startConversation();
  const session = await turnWithWorker(
    { sessions, server, client },
    { text: "summarise my inbox", runtimeTaskId: "a1" },
  );
  return { server, client, session, bodyLogFile };
};

const tablesOf = (server: TestServer, conversationId: string | null): SnapshotTables => {
  const catalog = server.catalog();
  try {
    return snapshotConversation(catalog, must(conversationId, "conversation id")).tables;
  } finally {
    catalog.close();
  }
};

const eventsOf = (tables: SnapshotTables, type: JournalEventType) =>
  tables.events.filter((event) => event.type === type);
const mcpBodiesOf = (tables: SnapshotTables) =>
  tables.events.filter((event) => event.type === "mcp_request" || event.type === "mcp_response");
const payloadOf = (event: { payload: string }): unknown => JSON.parse(event.payload);

/** Runs worker agent a1's allowed read call to its result, with its body log `bodyLog` as the test asks. */
const readCall = async (
  work: Awaited<ReturnType<typeof startWork>>,
  bodyLog: "written" | "missing" | "expired",
): Promise<SnapshotTables> => {
  const { server, client, session, bodyLogFile } = work;
  expect(
    await session.ask({ toolName: "mcp__fixture__read", toolUseId: "toolu_read", agentId: "a1" }),
  ).toEqual({
    behavior: "allow",
  });
  if (bodyLog !== "missing")
    writeBodyLog(bodyLogFile, [
      { tool_use_id: "toolu_read", direction: "request", body: READ_REQUEST },
      { tool_use_id: "toolu_other", direction: "request", body: {} },
      { tool_use_id: "toolu_read", direction: "response", body: READ_RESPONSE },
    ]);
  const held = bodyLog === "expired" ? server.holdEvidenceRead(bodyLogFile) : null;
  const result = session.toolResult({
    runtimeCallId: "toolu_read",
    workerTaskId: "a1",
    content: "{}",
  });
  if (held) {
    await held.started;
    server.expireEvidenceReads();
  }
  await result;
  await session.endWorker("a1");
  await client.waitFor("task_finished");
  return tablesOf(server, client.conversationId);
};

describe("debug mode", () => {
  it("reports unsupported Codex correlation without reading the body log", async () => {
    const work = await startWork(true, "configured", "codex");
    const held = work.server.holdEvidenceRead(work.bodyLogFile);
    try {
      const result = readCall(work, "missing");
      const first = await Promise.race([
        result.then((tables) => ({ kind: "result" as const, tables })),
        held.started.then(() => ({ kind: "read" as const })),
      ]);
      held.release();
      await result;
      expect(first.kind).toBe("result");
      if (first.kind === "result")
        expect(mcpBodiesOf(first.tables).map(payloadOf)).toEqual([
          expect.objectContaining({
            unrecorded: expect.stringContaining("without call attribution"),
          }),
          expect.objectContaining({
            unrecorded: expect.stringContaining("without call attribution"),
          }),
        ]);
    } finally {
      held.release();
    }
  });

  it("records that the conversation was captured in debug mode, once, right after it started", async () => {
    const work = await startWork(true, "configured");
    const tables = tablesOf(work.server, work.client.conversationId);
    const flags = eventsOf(tables, "captured_in_debug_mode");
    expect(flags).toHaveLength(1);
    const started = must(eventsOf(tables, "conversation_started")[0], "conversation_started");
    expect(must(flags[0], "flag").sequence).toBe(started.sequence + 1);
  });

  it("records a released call's request and response bodies, redacted, under the call, after its result", async () => {
    const tables = await readCall(await startWork(true, "configured"), "written");
    const call = must(
      tables.tool_calls.find((row) => row.runtime_call_id === "toolu_read"),
      "call",
    );
    const result = must(eventsOf(tables, "tool_result")[0], "tool_result");
    const bodies = mcpBodiesOf(tables);
    expect(bodies.map((event) => [event.type, payloadOf(event)])).toEqual([
      ["mcp_request", { tool_call_id: call.id, runtime_call_id: "toolu_read", body: READ_REQUEST }],
      [
        "mcp_response",
        {
          tool_call_id: call.id,
          runtime_call_id: "toolu_read",
          body: { ...READ_RESPONSE, result: { ...READ_RESPONSE.result, api_key: REDACTED } },
        },
      ],
    ]);
    for (const event of bodies)
      expect(event).toMatchObject({ caused_by_event_id: result.id, task_id: result.task_id });
  });

  it.each(["missing", "expired"] as const)(
    "records why a call's bodies are missing when its body log is %s",
    async (bodyLog) => {
      const tables = await readCall(await startWork(true, "configured"), bodyLog);
      expect(mcpBodiesOf(tables).map(payloadOf)).toEqual([
        expect.objectContaining({ unrecorded: expect.any(String) }),
        expect.objectContaining({ unrecorded: expect.any(String) }),
      ]);
    },
  );

  it("records no bodies for a call to a server that names no body log, nor with debug mode off", async () => {
    expect(mcpBodiesOf(await readCall(await startWork(true, "unconfigured"), "written"))).toEqual(
      [],
    );
    expect(mcpBodiesOf(await readCall(await startWork(false, "configured"), "written"))).toEqual(
      [],
    );
  });

  it("records, at the session's end, the bodies of a released call whose result never arrived", async () => {
    const work = await startWork(true, "configured");
    const { session, client, server, bodyLogFile } = work;
    await session.ask({ toolName: "mcp__fixture__read", toolUseId: "toolu_read", agentId: "a1" });
    writeBodyLog(bodyLogFile, [
      { tool_use_id: "toolu_read", direction: "request", body: READ_REQUEST },
    ]);
    await client.interruptAll();
    await client.waitFor("interruption_outcome");
    const bodies = mcpBodiesOf(tablesOf(server, client.conversationId)).map(payloadOf);
    expect(bodies).toEqual([
      expect.objectContaining({ runtime_call_id: "toolu_read", body: READ_REQUEST }),
      expect.objectContaining({ runtime_call_id: "toolu_read", unrecorded: expect.any(String) }),
    ]);
  });

  it("records the same rows with debug mode off as on, but for its flag and the bodies", async () => {
    const typesOf = async (debugMode: boolean) => {
      const tables = await readCall(await startWork(debugMode, "configured"), "written");
      return tables.events
        .map((event) => event.type)
        .filter(
          (type) => !["captured_in_debug_mode", "mcp_request", "mcp_response"].includes(type),
        );
    };
    expect(await typesOf(true)).toEqual(await typesOf(false));
  });
});
