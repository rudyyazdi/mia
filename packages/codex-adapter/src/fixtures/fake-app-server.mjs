#!/usr/bin/env node
// A scripted stand-in for `codex app-server` (the agent runtime, which tests may fake): it answers Mia's handshake,
// trusts the hook Mia wrote, and plays each turn by FAKE_PLAN, logging every line it receives to FAKE_LOG. It exits at
// the end of its input, as Codex does. Plain JS so it runs as the executable a profile names.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const plan = JSON.parse(process.env.FAKE_PLAN ?? "{}");
const hooksFile = `${process.env.CODEX_HOME}/hooks.json`;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const item = (threadId, value) => {
  notify("item/started", { threadId, item: value });
  notify("item/completed", { threadId, item: value });
};

/** The manager agent writes reply text, as a turn that read its input does. */
const reply = (threadId, text) => notify("item/agentMessage/delta", { threadId, delta: text });

/**
 * With FAKE_PLAN.steer, the first turn stays open after its worker agent ends, until Mia steers that end into it; the
 * plan says how the turn takes the steer: `answer` replies after recording it, `late` records it after its last reply
 * (Codex's race at the end of a turn), and `refuse` refuses it.
 */
let openTurn = null;
const takeSteer = (message) => {
  const { threadId, turn } = openTurn;
  openTurn = null;
  const steered = {
    type: "userMessage",
    id: "steer-in",
    clientId: message.params.clientUserMessageId,
  };
  if (plan.steer === "refuse") {
    send({ id: message.id, error: { code: -32000, message: "no active turn" } });
    reply(threadId, "Started the work.");
  } else {
    send({ id: message.id, result: { turnId: turn } });
    if (plan.steer === "late") reply(threadId, "Started the work.");
    item(threadId, steered);
    if (plan.steer === "answer") reply(threadId, "The work is done.");
  }
  notify("turn/completed", { threadId, turn: { id: turn, status: "completed", items: [] } });
};

/** One manager turn: it takes the message, and on the first turn a worker agent starts and ends inside it. */
const playTurn = (threadId, turn, params) => {
  if (plan.secondWorker && turn === "turn-2") {
    item("worker-2", { type: "agentMessage", id: "second-msg", text: "second result" });
    notify("turn/completed", {
      threadId: "worker-2",
      turn: { id: "second-turn", status: "completed", items: [] },
    });
    item(threadId, {
      type: "subAgentActivity",
      id: "second-end",
      kind: "completed",
      agentThreadId: "worker-2",
      agentPath: "/root/second",
    });
  }
  notify("turn/started", { threadId, turn: { id: turn } });
  item(threadId, {
    type: "userMessage",
    id: `${turn}-in`,
    clientId: params.clientUserMessageId ?? null,
  });
  if (plan.worker && turn === "turn-1") {
    const agent = { agentThreadId: "worker-1", agentPath: "/root/work" };
    item(threadId, { type: "subAgentActivity", id: "call_spawn", kind: "started", ...agent });
    notify("turn/started", { threadId: "worker-1", turn: { id: "worker-turn" } });
    item("worker-1", { type: "agentMessage", id: "worker-msg", text: plan.worker.summary });
    notify("turn/completed", {
      threadId: "worker-1",
      turn: { id: "worker-turn", status: "completed", items: [] },
    });
    item(threadId, { type: "subAgentActivity", id: "call_done", kind: "completed", ...agent });
    if (plan.steer) {
      openTurn = { threadId, turn };
      return;
    }
  }
  if (plan.secondWorker && turn === "turn-1") {
    item(threadId, {
      type: "subAgentActivity",
      id: "second-start",
      kind: "started",
      agentThreadId: "worker-2",
      agentPath: "/root/second",
    });
    notify("turn/started", { threadId: "worker-2", turn: { id: "second-turn" } });
  }
  notify("turn/completed", { threadId, turn: { id: turn, status: "completed", items: [] } });
};

let turns = 0;
const answers = {
  initialize: () => ({}),
  "hooks/list": () => {
    const { command } = JSON.parse(readFileSync(hooksFile, "utf8")).hooks.PreToolUse[0].hooks[0];
    const hook = { key: "k", command, sourcePath: hooksFile, currentHash: "h", enabled: true };
    return { data: [{ hooks: [{ ...hook, trustStatus: "trusted" }] }] };
  },
  "thread/start": () => ({ thread: { id: "thread-1" }, model: "fake" }),
};

for await (const line of createInterface({ input: process.stdin })) {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${line}\n`);
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === "turn/steer" && openTurn) {
    takeSteer(message);
    continue;
  }
  if (message.method === "turn/start") {
    if (plan.turnStart === "reject") {
      send({ id: message.id, error: { code: -32000, message: "busy" } });
      continue;
    }
    turns += 1;
    send({ id: message.id, result: { turn: { id: `turn-${turns}` } } });
    playTurn(message.params.threadId, `turn-${turns}`, message.params);
    continue;
  }
  const answer = answers[message.method];
  if (answer) send({ id: message.id, result: answer() });
  else send({ id: message.id, error: { code: -32601, message: `fake has no ${message.method}` } });
}
