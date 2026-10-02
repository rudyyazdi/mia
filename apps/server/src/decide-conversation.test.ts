import { match } from "ts-pattern";
import { describe, expect, it } from "vitest";
import { readManagerCall, type WorkerEnd } from "@mia/agent-adapter";
import type { NewId } from "@mia/records";
import {
  decideConversation,
  MAX_NOTED_CALLS,
  type ConversationEvent,
  type GateRequestEvent,
} from "./decide-conversation.ts";
import type { EngineEffect } from "./engine-effects.ts";
import {
  MAX_RUNNING_TASKS,
  MAX_UNSETTLED_CALLS,
  type ConversationState,
} from "./conversation-state.ts";
import { recordLabels, type EngineRecord } from "./engine-records.ts";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const ORIGIN = { clientId: "client_owner", connectionId: "conn_1" };
const REQUESTED = { runtime: "claude-code" as const, model: "m", effort: "medium" as const };

let counter = 0;
const newId: NewId = (prefix) => `${prefix}_${(counter += 1)}`;
const drawn = { origin: ORIGIN, newId };

interface Step {
  next: ConversationState;
  records: readonly EngineRecord[];
  effects: readonly EngineEffect[];
}

const decide = (state: ConversationState | null, event: ConversationEvent) =>
  decideConversation({ state, event, now: NOW });

const accepted = (state: ConversationState | null, event: ConversationEvent): Step => {
  const decision = decide(state, event);
  if (decision.kind !== "accepted") throw new Error(`rejected: ${decision.rejection.kind}`);
  if (decision.next === null) throw new Error("accepted without a conversation");
  return { next: decision.next, records: decision.records, effects: decision.effects };
};

/** The state after each event in turn, from `state`. */
const after = (state: ConversationState, ...events: ConversationEvent[]): ConversationState =>
  events.reduce((current, event) => accepted(current, event).next, state);

const rejection = (state: ConversationState, event: ConversationEvent): string => {
  const decision = decide(state, event);
  if (decision.kind !== "rejected") throw new Error("accepted");
  return decision.rejection.kind;
};

const effectLabels = (effects: readonly EngineEffect[]): string[] =>
  effects.map((effect) =>
    match(effect)
      .with({ kind: "deliver_event" }, ({ event }) => `deliver ${event.type}`)
      .with({ kind: "notify_tool_call" }, ({ payload }) => `notify ${payload.status}`)
      .with({ kind: "answer_gate" }, ({ answer }) =>
        answer.kind === "hold" ? "hold" : `answer ${answer.decision.behavior}`,
      )
      .with({ kind: "answer_held" }, ({ decision }) => `answer held ${decision.behavior}`)
      .otherwise(({ kind }) => kind),
  );

/** The gate's answer a step gave at once, or "hold". */
const gateAnswer = (step: Step): string => {
  const answer = step.effects.find((effect) => effect.kind === "answer_gate");
  if (answer?.kind !== "answer_gate") throw new Error("no gate answer");
  return answer.answer.kind === "hold" ? "hold" : answer.answer.decision.behavior;
};

const started = (): ConversationState =>
  accepted(null, {
    kind: "start_conversation",
    origin: ORIGIN,
    closes: null,
    provenance: {
      description: "test",
      setId: "prov_1",
      items: [],
      summary: {
        agent_prompt_version: null,
        configuration_digest: "d",
        architecture_revision: null,
        server_build: {
          name: "t",
          version: "0",
          commit: null,
          dirty: null,
          local_changes_digest: null,
          source_root: "/src",
        },
        runtime_version: null,
      },
    },
    managerPromptFile: null,
    workerPrompt: "work",
    conversationsRoot: "/tmp/conversations",
    debugMode: false,
    ids: {
      conversation: "conv_1",
      runtimeConversation: "rt_1",
      provenanceRecorded: "evt_p",
      started: "evt_s",
      captured: "evt_c",
    },
  }).next;

const message = (text: string, runtimeMessageId = `uuid-${text}`): ConversationEvent => ({
  kind: "message_submitted",
  ...drawn,
  text,
  clientId: "client_owner",
  requested: REQUESTED,
  fromMia: false,
  runtimeMessageId,
});

const turnBegan: ConversationEvent = {
  kind: "turn_began",
  ...drawn,
  init: { model: "m", evidence: {} },
};
const taken = (runtimeMessageId: string): ConversationEvent => ({
  kind: "input_taken",
  ...drawn,
  runtimeMessageId,
});
const turnEnded: ConversationEvent = {
  kind: "turn_ended",
  ...drawn,
  summary: { isError: false, outcome: "success", evidence: {} },
};
const workerStarted = (runtimeTaskId: string): ConversationEvent => ({
  kind: "worker_started",
  ...drawn,
  runtimeTaskId,
  delegationCallId: `toolu_delegate_${runtimeTaskId}`,
  description: `task ${runtimeTaskId}`,
  clientId: "client_owner",
  requested: REQUESTED,
});
const workerEnded = (runtimeTaskId: string, end: WorkerEnd = "completed"): ConversationEvent => ({
  kind: "worker_ended",
  ...drawn,
  runtimeTaskId,
  end,
  runtimeStatus: end,
  summary: null,
});

const gate = (fields: Partial<GateRequestEvent>): GateRequestEvent => {
  const toolIdentity = fields.toolIdentity ?? "mcp__fixture__read";
  return {
    kind: "gate_request",
    ...drawn,
    runtimeCallId: `toolu_${(counter += 1)}`,
    toolIdentity,
    input: fields.input ?? {},
    agentId: "a1",
    managerCall: readManagerCall(toolIdentity, fields.input ?? {}),
    policy: "allow",
    exclusive: false,
    heldFull: false,
    ...fields,
  };
};
const delegate = (runtimeCallId: string, input: unknown = {}): GateRequestEvent =>
  gate({
    agentId: null,
    toolIdentity: "Agent",
    runtimeCallId,
    input: { subagent_type: "mia-worker", run_in_background: true, ...Object(input) },
  });
const result = (
  runtimeCallId: string,
  parentCallId: string | null = "toolu_delegate_a1",
  isError = false,
): ConversationEvent => ({
  kind: "tool_result",
  ...drawn,
  runtimeCallId,
  parentCallId,
  isError,
  content: "ok",
  output: null,
  bodies: null,
});
const sessionEnded = (status: "ended" | "killed" | "failed"): ConversationEvent => ({
  kind: "session_ended",
  ...drawn,
  status,
  error: null,
  runtimeCancellation: status === "killed" ? "forced_kill" : "not_needed",
  transcript: null,
  hooks: { file: null, evidence: { records: [], malformedLines: 0, readError: null } },
  unresultedBodies: new Map(),
});

/** A conversation with an open session in a user's turn, running one worker agent per id in `workers`. */
const running = (...workers: string[]): ConversationState =>
  after(started(), message("go"), turnBegan, taken("uuid-go"), ...workers.map(workerStarted));

const taskOf = (state: ConversationState, runtimeTaskId: string) => {
  const task = state.tasks.values().find((candidate) => candidate.runtimeTaskId === runtimeTaskId);
  if (!task) throw new Error(`no task for ${runtimeTaskId}`);
  return task;
};

describe("messages and turns", () => {
  it("accepts a message while tasks run, and opens the session only for the first", () => {
    expect(effectLabels(accepted(started(), message("one")).effects)).toEqual([
      "open_session",
      "send_message",
    ]);
    expect(effectLabels(accepted(running("a1"), message("two")).effects)).toEqual(["send_message"]);
  });

  it("refuses a message only once the queue is full or every task is being stopped", () => {
    let state = accepted(started(), message("0")).next;
    for (let index = 1; index < 16; index += 1)
      state = accepted(state, message(String(index))).next;
    expect(rejection(state, message("one too many"))).toBe("busy");
    const stopping = after(running("a1"), { kind: "stop_all", ...drawn, by: "client" });
    expect(rejection(stopping, message("now"))).toBe("stopping");
  });

  it("removes every message a turn takes, so coalesced messages leave nothing queued", () => {
    const state = after(
      started(),
      message("a"),
      message("b"),
      turnBegan,
      taken("uuid-a"),
      taken("uuid-b"),
    );
    expect(state.queuedInputs).toEqual([]);
  });

  it("makes a turn the user's when it takes a message, caused by that message's event", () => {
    const step = accepted(after(started(), message("a"), turnBegan), taken("uuid-a"));
    expect(step.next.turn).toMatchObject({ cause: "user_input", causedByTaskId: null });
    const turnStarted = step.records.find(
      (record) => record.kind === "append_event" && record.input.type === "turn_started",
    );
    expect(turnStarted?.kind === "append_event" && turnStarted.input.causedByEventId).toMatch(
      /^evt_/,
    );
  });

  it("makes a turn that begins without a message the report of every task end not reported yet", () => {
    const ended = after(running("a1", "a2"), turnEnded, workerEnded("a1"), workerEnded("a2"));
    const reporting = after(ended, turnBegan, { kind: "reply_text", ...drawn, text: "done" });
    expect(reporting.turn).toMatchObject({
      cause: "task_end",
      causedByTaskId: ended.endedTasks[0],
    });
    expect(reporting.endedTasks).toEqual([]);
  });
});

describe("the manager agent's calls", () => {
  it("allows only background delegation to Mia's worker agent", () => {
    const state = running();
    expect(gateAnswer(accepted(state, delegate("toolu_d")))).toBe("allow");
    expect(gateAnswer(accepted(state, delegate("toolu_d", { run_in_background: false })))).toBe(
      "deny",
    );
    expect(
      gateAnswer(accepted(state, delegate("toolu_d", { subagent_type: "general-purpose" }))),
    ).toBe("deny");
  });

  it("counts delegations not yet started against the running-task limit", () => {
    let state = running();
    for (let index = 0; index < MAX_RUNNING_TASKS; index += 1)
      state = accepted(state, delegate(`toolu_d${index}`)).next;
    expect(gateAnswer(accepted(state, delegate("toolu_one_too_many")))).toBe("deny");
  });

  it("frees a delegation's place when its result comes, recording it unstarted only when it failed", () => {
    const delegated = after(running(), delegate("toolu_d"));
    // A launch's result can come before the report of the worker agent it started.
    const launched = accepted(delegated, result("toolu_d", null));
    expect(launched.next.pendingDelegations.size).toBe(0);
    expect(recordLabels(launched.records)).not.toContain("delegation_unstarted");
    const failed = accepted(delegated, result("toolu_d", null, true));
    expect(failed.next.pendingDelegations.size).toBe(0);
    expect(recordLabels(failed.records)).toContain("delegation_unstarted");
  });

  it("denies every other call the manager agent makes itself", () => {
    const step = accepted(running(), gate({ agentId: null, toolIdentity: "mcp__fixture__read" }));
    expect(gateAnswer(step)).toBe("deny");
    expect(recordLabels(step.records)).toEqual(["tool_refused"]);
  });

  it("closes a stopped task's gate once, however many times it is stopped", () => {
    const asked = after(
      running("a1"),
      gate({ policy: "ask", toolIdentity: "mcp__fixture__change" }),
    );
    const byClient = accepted(asked, {
      kind: "stop_task",
      ...drawn,
      taskId: taskOf(asked, "a1").id,
    });
    expect(effectLabels(byClient.effects)).toContain("answer held deny");
    const byManager = accepted(
      byClient.next,
      gate({ agentId: null, toolIdentity: "TaskStop", input: { task_id: "a1" } }),
    );
    expect(gateAnswer(byManager)).toBe("allow");
    expect(recordLabels(byManager.records)).not.toContain("stop_requested");
  });
});

describe("worker agents' calls", () => {
  it("denies a call from no running task and records it unattributed", () => {
    const step = accepted(running("a1"), gate({ agentId: "a_unknown" }));
    expect(gateAnswer(step)).toBe("deny");
    expect(recordLabels(step.records)).toEqual(["tool_unattributed"]);
  });

  it("refuses a worker agent that tries to start or stop a worker agent", () => {
    expect(gateAnswer(accepted(running("a1"), gate({ toolIdentity: "Agent" })))).toBe("deny");
    expect(gateAnswer(accepted(running("a1"), gate({ toolIdentity: "TaskStop" })))).toBe("deny");
  });

  it("releases an allowed call, denies a denied one, and holds only the asking task's call", () => {
    const state = running("a1", "a2");
    expect(gateAnswer(accepted(state, gate({ policy: "allow" })))).toBe("allow");
    expect(gateAnswer(accepted(state, gate({ policy: "deny" })))).toBe("deny");
    const asked = accepted(state, gate({ policy: "ask", toolIdentity: "mcp__fixture__change" }));
    expect(gateAnswer(asked)).toBe("hold");
    expect(taskOf(asked.next, "a1").status).toBe("awaiting_approval");
    expect(taskOf(asked.next, "a2").status).toBe("running");
  });

  it("refuses a second concurrent call to an exclusive tool until the first returns", () => {
    const tool = { toolIdentity: "mcp__desk__click", exclusive: true, policy: "allow" as const };
    const first = accepted(running("a1", "a2"), gate({ ...tool, runtimeCallId: "toolu_first" }));
    expect(gateAnswer(first)).toBe("allow");
    expect(gateAnswer(accepted(first.next, gate({ ...tool, agentId: "a2" })))).toBe("deny");
    const returned = after(first.next, result("toolu_first"));
    expect(returned.leases.size).toBe(0);
    expect(gateAnswer(accepted(returned, gate({ ...tool, agentId: "a2" })))).toBe("allow");
  });

  it("keeps an exclusive tool held after its worker agent ends, until the call's late result arrives", () => {
    const tool = { toolIdentity: "mcp__desk__click", exclusive: true, policy: "allow" as const };
    const ended = after(
      running("a1", "a2"),
      gate({ ...tool, runtimeCallId: "toolu_first" }),
      workerEnded("a1", "stopped"),
    );
    expect(ended.leases.has("mcp__desk__click")).toBe(true);
    expect(gateAnswer(accepted(ended, gate({ ...tool, agentId: "a2" })))).toBe("deny");
    const settled = accepted(ended, result("toolu_first"));
    expect(recordLabels(settled.records)).toContain("tool_result");
    expect(settled.next.leases.size).toBe(0);
    expect(settled.next.unsettledCalls.size).toBe(0);
  });
});

describe("approvals", () => {
  const pending = () => {
    const asked = after(
      running("a1"),
      gate({ policy: "ask", toolIdentity: "mcp__fixture__change" }),
    );
    const task = taskOf(asked, "a1");
    return { asked, task, approvalId: [...task.pendingApprovals.keys()][0] ?? "" };
  };

  it("denies a rejected call and resumes its task", () => {
    const { asked, task, approvalId } = pending();
    const step = accepted(asked, {
      kind: "approval_decision",
      ...drawn,
      taskId: task.id,
      approvalId,
      decision: "reject",
      deciderClientId: "client_owner",
      ownerClientId: "client_owner",
      exclusive: false,
    });
    expect(effectLabels(step.effects)).toContain("answer held deny");
    expect(taskOf(step.next, "a1").status).toBe("running");
  });

  it("refuses a decision from another client", () => {
    const { asked, task, approvalId } = pending();
    expect(
      rejection(asked, {
        kind: "approval_decision",
        ...drawn,
        taskId: task.id,
        approvalId,
        decision: "approve",
        deciderClientId: "client_other",
        ownerClientId: "client_owner",
        exclusive: false,
      }),
    ).toBe("not_owner");
  });
});

describe("stops and ends", () => {
  it("stops every task at once however many tasks and held calls there are", () => {
    let state = running(...Array.from({ length: MAX_RUNNING_TASKS }, (_, index) => `a${index}`));
    for (const task of state.tasks.values())
      for (let index = 0; index < 2; index += 1)
        state = after(
          state,
          gate({
            agentId: task.runtimeTaskId,
            policy: "ask",
            toolIdentity: "mcp__fixture__change",
          }),
        );
    const stop = accepted(state, { kind: "stop_all", ...drawn, by: "client" });
    expect([...stop.next.tasks.values()].every((task) => !task.gateOpen)).toBe(true);
    expect(effectLabels(stop.effects).filter((label) => label === "answer held deny")).toHaveLength(
      2 * MAX_RUNNING_TASKS,
    );
    expect(effectLabels(stop.effects)).toContain("stop_session");
  });

  it("ends a stopped session's tasks as interruptions, each released call unknown and its lease still held", () => {
    const tool = { toolIdentity: "mcp__desk__click", exclusive: true, policy: "allow" as const };
    const stopped = after(running("a1"), gate(tool), { kind: "stop_all", ...drawn, by: "client" });
    const ended = accepted(stopped, sessionEnded("killed"));
    expect(ended.next.tasks.size).toBe(0);
    expect(effectLabels(ended.effects)).toContain("deliver interruption_outcome");
    expect(effectLabels(ended.effects)).toContain("notify unknown");
    expect(ended.next.pendingNote).toContain("outcome is unknown");
    // The killed runtime's call may still run, so the next session's worker agent may not use the tool.
    expect(ended.next.leases.has("mcp__desk__click")).toBe(true);
    const next = after(
      ended.next,
      message("again"),
      turnBegan,
      taken("uuid-again"),
      workerStarted("a2"),
    );
    expect(gateAnswer(accepted(next, gate({ ...tool, agentId: "a2" })))).toBe("deny");
  });

  it("keeps an exclusive tool held when its unsettled call is given up on beyond the bound", () => {
    const tool = { toolIdentity: "mcp__desk__click", exclusive: true, policy: "allow" as const };
    let state = after(running("a1"), gate(tool));
    for (let index = 0; index < MAX_UNSETTLED_CALLS; index += 1) state = after(state, gate({}));
    const ended = after(state, workerEnded("a1", "stopped"));
    expect(ended.unsettledCalls.size).toBe(MAX_UNSETTLED_CALLS);
    expect(ended.leases.has("mcp__desk__click")).toBe(true);
  });

  it("ends a crashed session's tasks as failed, not as interruptions", () => {
    const ended = accepted(running("a1"), sessionEnded("failed"));
    expect(effectLabels(ended.effects)).toContain("deliver task_finished");
    expect(effectLabels(ended.effects)).not.toContain("deliver interruption_outcome");
  });

  it("lets a session go whose end could not be recorded, so the next message opens a new one", () => {
    const tool = { toolIdentity: "mcp__desk__click", exclusive: true, policy: "allow" as const };
    const lost = accepted(after(running("a1"), gate(tool)), { kind: "session_lost" });
    expect(lost.records).toEqual([]);
    expect(lost.next.session).toBeNull();
    // Its lease is still unreleased in the records, so memory keeps it.
    expect(lost.next.leases.has("mcp__desk__click")).toBe(true);
    const again = accepted(lost.next, message("again"));
    expect(effectLabels(again.effects)).toContain("open_session");
    // The note Mia puts before the next message is recorded with it.
    const received = again.records.find(
      (record) => record.kind === "append_event" && record.input.type === "message_received",
    );
    expect(received).toMatchObject({ input: { payload: { note: lost.next.pendingNote } } });
  });

  it("reports a worker agent that ended with a released call as outcome unknown", () => {
    const ended = accepted(after(running("a1"), gate({ policy: "allow" })), workerEnded("a1"));
    const finished = ended.records.find(
      (record) => record.kind === "update_task" && record.fields.finishedAt !== undefined,
    );
    expect(finished).toMatchObject({ fields: { status: "outcome_unknown" } });
  });

  it("notes for the manager agent what a worker agent's end settled, which the worker agent cannot know", () => {
    // Two calls to one tool, told apart by their arguments: only the one without its result is noted.
    const change = { policy: "ask" as const, toolIdentity: "mcp__fixture__change" };
    const held = gate({ ...change, input: { delta: 4 } });
    const released = gate({ policy: "allow", toolIdentity: "mcp__fixture__slow" });
    const done = gate({
      ...change,
      policy: "allow",
      input: { delta: 1 },
      runtimeCallId: "toolu_done",
    });
    const state = after(running("a1"), held, released, done, result("toolu_done"));
    const notes = accepted(state, workerEnded("a1")).effects.flatMap((effect) =>
      effect.kind === "note_end" ? [effect] : [],
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ runtimeTaskId: "a1" });
    expect(notes[0]?.note).toContain('mcp__fixture__change {"delta":4} did not run');
    expect(notes[0]?.note).toContain("mcp__fixture__slow {} has an unknown outcome");
    expect(notes[0]?.note).not.toContain('{"delta":1}');
  });

  it("notes a call a stop invalidated before its worker agent ended", () => {
    const held = gate({ policy: "ask", toolIdentity: "mcp__fixture__change" });
    const stopped = after(running("a1"), held, { kind: "stop_all", ...drawn, by: "client" });
    const ended = accepted(stopped, workerEnded("a1", "stopped"));
    expect(ended.effects).toContainEqual(
      expect.objectContaining({
        kind: "note_end",
        note: expect.stringContaining("mcp__fixture__change {} did not run"),
      }),
    );
  });

  it("notes nothing for a worker agent whose calls all had their result", () => {
    const done = gate({ policy: "allow", runtimeCallId: "toolu_done" });
    const ended = accepted(after(running("a1"), done, result("toolu_done")), workerEnded("a1"));
    expect(effectLabels(ended.effects)).not.toContain("note_end");
  });

  it("names at most a bound of calls in each note and counts the rest", () => {
    const calls = Array.from({ length: MAX_NOTED_CALLS + 2 }, (_, index) =>
      gate({ toolIdentity: "mcp__fixture__slow", input: { index } }),
    );
    const ended = accepted(after(running("a1"), ...calls), workerEnded("a1"));
    const endNotes = ended.effects.flatMap((effect) =>
      effect.kind === "note_end" ? [effect.note] : [],
    );
    expect(endNotes).toHaveLength(1);
    const { pendingNote } = accepted(ended.next, sessionEnded("ended")).next;
    for (const note of [...endNotes, pendingNote]) {
      expect(note).toContain(`{"index":${MAX_NOTED_CALLS - 1}}`);
      expect(note).not.toContain(`{"index":${MAX_NOTED_CALLS}}`);
      expect(note).toContain("; and 2 more call(s) ");
    }
  });

  it("names an unsettled call in the note after a session by its arguments, cut to a bound", () => {
    const text = `${"x".repeat(190)}${"😀".repeat(100)}`;
    const slow = gate({ toolIdentity: "mcp__fixture__slow", input: { text } });
    const state = after(running("a1"), slow, workerEnded("a1"));
    const { pendingNote } = accepted(state, sessionEnded("ended")).next;
    // 200 code points of rendered arguments, `{"text":"` and 191 of the text, so no emoji is cut in half.
    expect(pendingNote).toContain(`mcp__fixture__slow {"text":"${"x".repeat(190)}😀…`);
  });
});
