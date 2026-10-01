import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@mia/agent-adapter";
import type { SessionRecord } from "./record.ts";
import { workerBackgroundChecks, workerDenyChecks, workerGateChecks } from "./checks.ts";

const at = "2026-01-01T00:00:00.000Z";

const session = (fields: Partial<SessionRecord>): SessionRecord => ({
  name: "s",
  session_id: "s",
  events: [],
  gate_requests: [],
  dropped: 0,
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

const changeRequest = (
  agentId: string | null,
  decision: { behavior: "allow" } | { behavior: "deny"; message: string } = {
    behavior: "deny",
    message: "rejected",
  },
  tool = "change",
) => ({
  request: {
    toolName: `mcp__fixture__${tool}`,
    input: {},
    toolUseId: "toolu_change",
    agentId,
    agentType: agentId === null ? null : "mia-worker",
    raw: {},
    receivedAt: at,
  },
  decision,
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

  it("attributes by the gate alone a call the runtime never streamed, as Codex does for a refused call", () => {
    const unstreamed = {
      ...changeRequest("a1"),
      request: { ...changeRequest("a1").request, toolUseId: "exec_change" },
    };
    const checks = workerGateChecks(
      session({
        events: [started, proposal("toolu_delegation")],
        gate_requests: [changeRequest("a1"), unstreamed],
      }),
    );
    expect(checks).toMatchObject({
      stream_attribution_matches_gate: true,
      fixture_calls_streamed_of_asked: "1/2",
      every_fixture_call_attributed_to_a_worker: true,
    });
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

const ran = (tool: string, callId: string, kind: "entered" | "committed" = "committed") => ({
  seq: 0,
  at,
  kind,
  tool,
  call_id: callId,
});

const ledger = (...entries: ReturnType<typeof ran>[]): SessionRecord["ledger_after"] => ({
  ledger: entries,
  pending: [],
  counter: 0,
});

describe("every_fixture_run_allowed_by_gate", () => {
  it("fails when more distinct calls ran at the fixture than the gate allowed", () => {
    const allowedOnce = [changeRequest("a1", { behavior: "allow" })];
    const once = ledger(ran("change", "c1", "entered"), ran("change", "c1"));
    const twice = ledger(ran("change", "c1"), ran("change", "c2"));
    expect(
      workerGateChecks(session({ gate_requests: allowedOnce, ledger_after: once }))
        .every_fixture_run_allowed_by_gate,
    ).toBe(true);
    expect(
      workerGateChecks(session({ gate_requests: allowedOnce, ledger_after: twice }))
        .every_fixture_run_allowed_by_gate,
    ).toBe(false);
  });
});

describe("workerDenyChecks", () => {
  const forbiddenProposal: SessionEvent = {
    type: "tool_proposed",
    runtimeCallId: "toolu_forbidden",
    toolIdentity: "mcp__fixture__forbidden",
    parentCallId: "toolu_delegation",
    arguments: {},
    complete: true,
    at,
  };

  it("counts a call a runtime rule refused before the gate as attempted", () => {
    expect(workerDenyChecks(session({ events: [started, forbiddenProposal] }))).toMatchObject({
      worker_attempted_denied_call: true,
      denied_by: "runtime rule (never reached the gate)",
      denied_call_never_ran: true,
    });
    expect(workerDenyChecks(session({ events: [started] })).worker_attempted_denied_call).toBe(
      false,
    );
  });

  it("fails a denied call that ran at the fixture", () => {
    const asked = [changeRequest("a1", { behavior: "deny", message: "policy" }, "forbidden")];
    expect(
      workerDenyChecks(
        session({ gate_requests: asked, ledger_after: ledger(ran("forbidden", "f1")) }),
      ),
    ).toMatchObject({
      denied_by: "gate",
      gate_denied_every_ask: true,
      denied_call_never_ran: false,
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
