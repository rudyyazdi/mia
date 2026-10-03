import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ToolGate,
  type SessionEvent,
  type SessionHandle,
  type SessionOptions,
} from "@mia/agent-adapter";
import { CodexRuntime } from "./session.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-app-server.mjs");

let dir: string;
let gate: ToolGate;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mia-codex-session-"));
  gate = new ToolGate();
  await gate.start();
});
afterEach(async () => {
  await gate.close();
  await rm(dir, { recursive: true, force: true });
});

/** Opens one session against the fake app-server playing `plan`; `onEvent` sees each event with the handle. */
const open = async (
  plan: unknown,
  onEvent: (event: SessionEvent, handle: SessionHandle) => Promise<void> = async () => undefined,
) => {
  const log = join(dir, "received.jsonl");
  await writeFile(join(dir, "manager.md"), "Delegate.");
  const runtime = await CodexRuntime.start({
    config: {
      kind: "codex",
      executable: FAKE,
      model: "fake",
      effort: "low",
      workingDirectory: join(dir, "work"),
      mcpServers: {},
      toolPolicy: {},
      agentPromptFile: join(dir, "manager.md"),
      workerAgent: { description: "works", promptFile: join(dir, "worker.md") },
      exclusiveTools: [],
      outputDirectories: [],
      env: { FAKE_PLAN: JSON.stringify(plan), FAKE_LOG: log },
    },
    gate,
    // The fake runs on the node running this test.
    env: { PATH: dirname(process.execPath), HOME: dir },
    codexHome: join(dir, "codex-home"),
    replyDeadline: () => new AbortController().signal,
  });
  const events: SessionEvent[] = [];
  let handle: SessionHandle | null = null;
  const options: SessionOptions = {
    runtimeConversationId: "conversation",
    resume: false,
    runtimeDir: join(dir, "runtime"),
    sessionIndex: 1,
    managerPromptFile: join(dir, "manager.md"),
    workerPrompt: "Work.",
    decide: async () => ({ behavior: "deny", message: "no calls" }),
    onEvent: async (event) => {
      events.push(event);
      if (handle) await onEvent(event, handle);
    },
  };
  handle = runtime.sessions.open(options);
  const received = async () =>
    (await readFile(log, "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line): unknown => JSON.parse(line));
  const turnStarts = async () =>
    (await received()).filter(
      (line) =>
        typeof line === "object" &&
        line !== null &&
        "method" in line &&
        line.method === "turn/start",
    );
  return { handle, events, turnStarts };
};

describe("a Codex session", () => {
  it("reports the batch selected for each turn even when another worker ends before that turn starts", async () => {
    const { handle, events } = await open({
      worker: { summary: "first result" },
      secondWorker: true,
    });
    handle.send("read twice", "message-1");
    handle.close();
    expect((await handle.result).status).toBe("ended");
    expect(
      events.flatMap((event) =>
        event.type === "runtime_init" ? [event.init.reportedRuntimeTaskIds] : [],
      ),
    ).toEqual([[], ["worker-1"], ["worker-2"]]);
  });
  it("ends as failed when Codex refuses a turn, rather than losing the message", async () => {
    const { handle } = await open({ turnStart: "reject" });
    expect(handle.send("hello", "message-1")).toBe(true);
    const result = await handle.result;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("did not start a turn");
  });

  it("reports a worker agent's end to the manager agent as written, and records it redacted", async () => {
    const secret = "Bearer abcdefghijklmnopqrstuvwxyz123456";
    const { handle, events, turnStarts } = await open({
      worker: { summary: `done with ${secret}` },
    });
    handle.send("hello", "message-1");
    handle.close();
    expect((await handle.result).status).toBe("ended");
    const ended = events.find((event) => event.type === "worker_ended");
    expect(ended).toMatchObject({ end: "completed", runtimeTaskId: "worker-1" });
    expect(JSON.stringify(ended)).not.toContain(secret);
    const turns = await turnStarts();
    expect(turns).toHaveLength(2);
    expect(JSON.stringify(turns[1])).toContain(secret);
  });

  it("reports Mia's note on a worker agent's end ahead of the worker agent's own account", async () => {
    const note = "[Mia note] mcp__fixture__change did not run.";
    const { handle, turnStarts } = await open(
      { worker: { summary: "The change has not returned yet." } },
      async (event, session) => {
        if (event.type === "worker_ended") session.noteEnd(event.runtimeTaskId, note);
      },
    );
    handle.send("hello", "message-1");
    handle.close();
    expect((await handle.result).status).toBe("ended");
    const turns = await turnStarts();
    expect(JSON.stringify(turns[1])).toContain(
      `ended: completed. ${note} Its final message: The change has not returned yet.`,
    );
  });

  it("ends as it exited when stopped after Codex exited on its own", async () => {
    const { handle } = await open({}, async (event, session) => {
      if (event.type === "runtime_exit") await session.stop(new AbortController().signal);
    });
    handle.close();
    expect(await handle.result).toMatchObject({ status: "ended", cancellation: "not_needed" });
  });
});
