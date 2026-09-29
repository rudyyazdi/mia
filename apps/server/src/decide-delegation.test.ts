import { match } from "ts-pattern";
import { describe, expect, it } from "vitest";
import {
  decideDelegation,
  type DelegationEvent,
  type GateRequestEvent,
} from "./decide-delegation.ts";
import type { DelegationEffect } from "./delegation-effects.ts";
import type { DelegationState } from "./delegation-state.ts";
import { recordLabels, type EngineRecord } from "./engine-records.ts";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const ORIGIN = { clientId: "client_owner", connectionId: "conn_1" };
const REQUESTED = { model: "m", effort: "medium" as const };

let drawn = 0;
/** Fresh id suffixes for one event, as the engine draws them. */
const ids = (): string[] => Array.from({ length: 64 }, () => String((drawn += 1)));

/** What the machine decided: the next state, the records it commits and the effects it performs. */
interface Step {
  next: DelegationState;
  records: readonly EngineRecord[];
  effects: readonly DelegationEffect[];
}

const decide = (state: DelegationState | null, event: DelegationEvent) =>
  decideDelegation({ state, event, now: NOW });

const accepted = (state: DelegationState | null, event: DelegationEvent): Step => {
  const decision = decide(state, event);
  if (decision.kind !== "accepted") throw new Error(`rejected: ${decision.rejection.kind}`);
  if (decision.next === null) throw new Error("accepted without a conversation");
  return { next: decision.next, records: decision.records, effects: decision.effects };
};

const rejection = (state: DelegationState, event: DelegationEvent): string => {
  const decision = decide(state, event);
  if (decision.kind !== "rejected") throw new Error("accepted");
  return decision.rejection.kind;
};

const labels = recordLabels;

const effectLabels = (effects: readonly DelegationEffect[]): string[] =>
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

const started = (): DelegationState =>
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

const message = (text: string): DelegationEvent => ({
  kind: "message_submitted",
  origin: ORIGIN,
  ids: ids(),
  text,
  clientId: "client_owner",
  requested: REQUESTED,
  fromMia: false,
});

const turnBegan = (): DelegationEvent => ({
  kind: "turn_began",
  origin: ORIGIN,
  ids: ids(),
  init: { model: "m", evidence: {} },
});

const workerStarted = (runtimeTaskId: string): DelegationEvent => ({
  kind: "worker_started",
  origin: ORIGIN,
  ids: ids(),
  runtimeTaskId,
  delegationCallId: `toolu_delegate_${runtimeTaskId}`,
  description: `task ${runtimeTaskId}`,
  clientId: "client_owner",
  requested: REQUESTED,
});

const gate = (fields: Partial<GateRequestEvent>): GateRequestEvent => ({
  kind: "gate_request",
  origin: ORIGIN,
  ids: ids(),
  runtimeCallId: `toolu_${(drawn += 1)}`,
  toolIdentity: "mcp__d1__read",
  input: {},
  agentId: "a1",
  policy: "allow",
  exclusive: false,
  heldFull: false,
  ...fields,
});

/** A conversation with an open session in a turn, running one worker agent per id in `workers`. */
const running = (...workers: string[]): DelegationState =>
  workers.reduce(
    (state, worker) => accepted(state, workerStarted(worker)).next,
    accepted(accepted(started(), message("go")).next, turnBegan()).next,
  );

const taskOf = (state: DelegationState, runtimeTaskId: string) => {
  const task = state.tasks.values().find((candidate) => candidate.runtimeTaskId === runtimeTaskId);
  if (!task) throw new Error(`no task for ${runtimeTaskId}`);
  return task;
};

describe("messages and turns", () => {
  it("accepts a message while tasks run, and opens the session only for the first", () => {
    const first = accepted(started(), message("one"));
    expect(effectLabels(first.effects)).toEqual(["open_session", "send_message"]);
    const busy = accepted(running("a1"), message("two"));
    expect(effectLabels(busy.effects)).toEqual(["send_message"]);
  });

  it("refuses a message only once the queue is full or every task is being stopped", () => {
    let state = accepted(started(), message("0")).next;
    for (let index = 1; index < 16; index += 1)
      state = accepted(state, message(String(index))).next;
    expect(rejection(state, message("one too many"))).toBe("busy");
    const stopping = accepted(running("a1"), {
      kind: "stop_all",
      origin: ORIGIN,
      ids: ids(),
      by: "client",
    }).next;
    expect(rejection(stopping, message("now"))).toBe("stopping");
  });

  it("starts the next turn for the oldest unreported task end before any queued message", () => {
    let state = accepted(running("a1"), message("later")).next;
    state = accepted(state, {
      kind: "turn_ended",
      origin: ORIGIN,
      ids: ids(),
      summary: { isError: false, outcome: "success", evidence: {} },
    }).next;
    const ended = accepted(state, {
      kind: "worker_ended",
      origin: ORIGIN,
      ids: ids(),
      runtimeTaskId: "a1",
      status: "completed",
      summary: "done",
    });
    const taskId = ended.next.endedTasks[0];
    const next = accepted(ended.next, turnBegan()).next;
    expect(next.turn).toMatchObject({ cause: "task_end", causedByTaskId: taskId });
    expect(next.queuedInputs).toHaveLength(1);
    const after = accepted(
      accepted(next, {
        kind: "turn_ended",
        origin: ORIGIN,
        ids: ids(),
        summary: { isError: false, outcome: "success", evidence: {} },
      }).next,
      turnBegan(),
    ).next;
    expect(after.turn).toMatchObject({ cause: "user_input", causedByTaskId: null });
    expect(after.queuedInputs).toHaveLength(0);
  });
});

describe("the manager agent's calls", () => {
  it("allows only background delegation to Mia's worker agent", () => {
    const state = running();
    expect(
      gateAnswer(
        accepted(
          state,
          gate({
            agentId: null,
            toolIdentity: "Agent",
            input: { subagent_type: "mia-worker", run_in_background: true },
          }),
        ),
      ),
    ).toBe("allow");
    expect(
      gateAnswer(
        accepted(
          state,
          gate({ agentId: null, toolIdentity: "Agent", input: { subagent_type: "mia-worker" } }),
        ),
      ),
    ).toBe("deny");
  });

  it("denies every other call the manager agent makes itself", () => {
    const step = accepted(running(), gate({ agentId: null, toolIdentity: "mcp__d1__read" }));
    expect(gateAnswer(step)).toBe("deny");
    expect(labels(step.records)).toEqual(["tool_refused"]);
  });

  it("closes a task's gate when the manager agent stops its worker agent, and invalidates its approvals", () => {
    const asked = accepted(
      running("a1"),
      gate({ policy: "ask", toolIdentity: "mcp__d1__change" }),
    ).next;
    const stop = accepted(
      asked,
      gate({ agentId: null, toolIdentity: "TaskStop", input: { task_id: "a1" } }),
    );
    expect(gateAnswer(stop)).toBe("allow");
    expect(taskOf(stop.next, "a1")).toMatchObject({ gateOpen: false, status: "interrupting" });
    expect(effectLabels(stop.effects)).toContain("answer held deny");
    expect(gateAnswer(accepted(stop.next, gate({ toolIdentity: "mcp__d1__read" })))).toBe("deny");
  });
});

describe("worker agents' calls", () => {
  it("denies a call from no running task and records it unattributed", () => {
    const step = accepted(running("a1"), gate({ agentId: "a_unknown" }));
    expect(gateAnswer(step)).toBe("deny");
    expect(labels(step.records)).toEqual(["tool_unattributed"]);
  });

  it("refuses a worker agent that tries to start or stop a worker agent", () => {
    expect(gateAnswer(accepted(running("a1"), gate({ toolIdentity: "Agent" })))).toBe("deny");
    expect(gateAnswer(accepted(running("a1"), gate({ toolIdentity: "TaskStop" })))).toBe("deny");
  });

  it("releases an allowed call, denies a denied one, and holds only the asking task's call", () => {
    const state = running("a1", "a2");
    expect(gateAnswer(accepted(state, gate({ policy: "allow" })))).toBe("allow");
    expect(gateAnswer(accepted(state, gate({ policy: "deny" })))).toBe("deny");
    const asked = accepted(state, gate({ policy: "ask", toolIdentity: "mcp__d1__change" }));
    expect(gateAnswer(asked)).toBe("hold");
    expect(taskOf(asked.next, "a1").status).toBe("awaiting_approval");
    expect(taskOf(asked.next, "a2").status).toBe("running");
  });

  it("refuses a second concurrent call to an exclusive tool until the first returns", () => {
    const tool = { toolIdentity: "mcp__desk__click", exclusive: true, policy: "allow" as const };
    const first = accepted(running("a1", "a2"), gate({ ...tool, runtimeCallId: "toolu_first" }));
    expect(gateAnswer(first)).toBe("allow");
    expect(first.next.leases.has("mcp__desk__click")).toBe(true);
    expect(gateAnswer(accepted(first.next, gate({ ...tool, agentId: "a2" })))).toBe("deny");
    const returned = accepted(first.next, {
      kind: "tool_result",
      origin: ORIGIN,
      ids: ids(),
      runtimeCallId: "toolu_first",
      isError: false,
      content: "ok",
    }).next;
    expect(returned.leases.size).toBe(0);
    expect(gateAnswer(accepted(returned, gate({ ...tool, agentId: "a2" })))).toBe("allow");
  });
});

describe("approvals", () => {
  const pending = () => {
    const asked = accepted(
      running("a1"),
      gate({ policy: "ask", toolIdentity: "mcp__d1__change" }),
    ).next;
    const task = taskOf(asked, "a1");
    const approvalId = [...task.pendingApprovals.keys()][0] ?? "";
    return { asked, task, approvalId };
  };

  it("denies a rejected call and resumes its task", () => {
    const { asked, task, approvalId } = pending();
    const step = accepted(asked, {
      kind: "approval_decision",
      origin: ORIGIN,
      ids: ids(),
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
        origin: ORIGIN,
        ids: ids(),
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
  it("stops every task through the engine, and leaves a call in flight unknown when the session ends", () => {
    const dispatched = accepted(running("a1", "a2"), gate({ policy: "allow" })).next;
    const stop = accepted(dispatched, {
      kind: "stop_all",
      origin: ORIGIN,
      ids: ids(),
      by: "client",
    });
    expect(stop.next.epoch).toBe(dispatched.epoch + 1);
    expect([...stop.next.tasks.values()].every((task) => !task.gateOpen)).toBe(true);
    expect(effectLabels(stop.effects)).toContain("stop_session");
    const ended = accepted(stop.next, {
      kind: "session_ended",
      origin: ORIGIN,
      ids: ids(),
      status: "killed",
      error: null,
      runtimeCancellation: "forced_kill",
    });
    expect(ended.next.tasks.size).toBe(0);
    expect(ended.next.session).toBeNull();
    expect(effectLabels(ended.effects)).toContain("notify unknown");
    expect(ended.next.pendingNote).toContain("outcome is unknown");
  });

  it("reports a worker agent that ended with a released call as outcome unknown", () => {
    const dispatched = accepted(running("a1"), gate({ policy: "allow" })).next;
    const ended = accepted(dispatched, {
      kind: "worker_ended",
      origin: ORIGIN,
      ids: ids(),
      runtimeTaskId: "a1",
      status: "completed",
      summary: null,
    });
    const finished = ended.records.find(
      (record) => record.kind === "update_task" && record.fields.finishedAt !== undefined,
    );
    expect(finished).toMatchObject({ fields: { status: "outcome_unknown" } });
  });
});
