import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@mia/agent-adapter";
import type { SessionRecord } from "./record.ts";
import { workerBackgroundChecks, workerGateChecks } from "./checks.ts";

const at = "2026-01-01T00:00:00.000Z";

const session = (fields: Partial<SessionRecord>): SessionRecord => ({
  name: "s",
  session_id: "s",
  events: [],
  gate_requests: [],
  dropped: 0,
  bridge_requests: 0,
  result: null,
  ledger_after: null,
  notes: [],
  checks: {},
  ...fields,
});

const started: SessionEvent = {
  type: "worker_started",
  runtimeTaskId: "a1",
  delegationCallId: "toolu_delegation",
  description: "",
  prompt: "",
  background: true,
  at,
};

const proposal = (parentCallId: string | null): SessionEvent => ({
  type: "tool_proposed",
  runtimeCallId: "toolu_change",
  toolIdentity: "mcp__fixture__change",
  parentCallId,
  arguments: {},
  complete: true,
  at,
});

const changeRequest = (agentId: string | null) => ({
  request: {
    toolName: "mcp__fixture__change",
    input: {},
    toolUseId: "toolu_change",
    agentId,
    agentType: agentId === null ? null : "mia-worker",
    raw: {},
    receivedAt: at,
  },
  decision: { behavior: "deny" as const, message: "rejected" },
  abandoned: false,
  event_index: 2,
});

describe("workerGateChecks", () => {
  it("attributes a call only when the gate's worker agent and the stream's delegation call agree", () => {
    const agreeing = workerGateChecks(
      session({
        events: [started, proposal("toolu_delegation")],
        gate_requests: [changeRequest("a1")],
      }),
    );
    expect(agreeing).toMatchObject({
      every_fixture_call_attributed_to_a_worker: true,
      stream_attribution_matches_gate: true,
      manager_made_no_fixture_calls: true,
    });
    const disagreeing = workerGateChecks(
      session({ events: [started, proposal("toolu_other")], gate_requests: [changeRequest("a1")] }),
    );
    expect(disagreeing.stream_attribution_matches_gate).toBe(false);
  });

  it("counts a call the gate saw with no worker agent as the manager agent's own", () => {
    const checks = workerGateChecks(
      session({ events: [started, proposal(null)], gate_requests: [changeRequest(null)] }),
    );
    expect(checks).toMatchObject({
      manager_made_no_fixture_calls: false,
      every_fixture_call_attributed_to_a_worker: false,
    });
  });
});

describe("workerBackgroundChecks", () => {
  const result: SessionEvent = {
    type: "turn_result",
    summary: { isError: false, outcome: "success", evidence: {} },
    at,
  };
  const ended: SessionEvent = {
    type: "worker_ended",
    runtimeTaskId: "a1",
    delegationCallId: "toolu_delegation",
    end: "completed",
    runtimeStatus: "completed",
    summary: null,
    at,
  };

  it("passes only for turns that ended before the held call was released", () => {
    const events = [started, result, result, ended, result];
    expect(
      workerBackgroundChecks(session({ events }), { eventsAtSecondAnswer: 3, eventsAtRelease: 3 }),
    ).toMatchObject({
      manager_turn_ended_while_worker_held: true,
      second_message_answered_while_worker_held: true,
      worker_end_started_a_manager_turn: true,
    });
    expect(
      workerBackgroundChecks(session({ events }), { eventsAtSecondAnswer: 0, eventsAtRelease: 1 }),
    ).toMatchObject({
      manager_turn_ended_while_worker_held: false,
      second_message_answered_while_worker_held: false,
    });
  });
});
