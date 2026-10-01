import type { SessionEvent } from "@mia/agent-adapter";
import type { SessionRecord } from "./record.ts";

// Pure readings of the probe's sessions: delegation, gating inside worker agents, attribution, and a background
// worker agent outliving the manager agent's turn.

/** What one session's checks found, by name. */
export type Checks = SessionRecord["checks"];

type Proposal = Extract<SessionEvent, { type: "tool_proposed" }>;
type WorkerStarted = Extract<SessionEvent, { type: "worker_started" }>;

const proposalsOf = (session: SessionRecord): Proposal[] =>
  session.events.filter((event): event is Proposal => event.type === "tool_proposed");

const workersOf = (session: SessionRecord): WorkerStarted[] =>
  session.events.filter((event): event is WorkerStarted => event.type === "worker_started");

const turnResults = (session: SessionRecord, before = session.events.length): number =>
  session.events.slice(0, before).filter((event) => event.type === "turn_result").length;

const ledgerOf = (session: SessionRecord) => session.ledger_after?.ledger ?? [];

const gateRequestsFor = (session: SessionRecord, tool: string) =>
  session.gate_requests.filter((entry) => entry.request.toolName === `mcp__fixture__${tool}`);

const fixtureRequestsOf = (session: SessionRecord) =>
  session.gate_requests.filter((entry) => entry.request.toolName.startsWith("mcp__fixture__"));

/** Every fixture call the gate saw came from a worker agent the runtime reported starting. */
const everyFixtureCallFromAWorker = (session: SessionRecord): boolean => {
  const workers = new Set(workersOf(session).map((worker) => worker.runtimeTaskId));
  const fixtureCalls = fixtureRequestsOf(session);
  return (
    fixtureCalls.length > 0 &&
    fixtureCalls.every(
      (entry) => entry.request.agentId !== null && workers.has(entry.request.agentId),
    )
  );
};

/**
 * Every fixture call's stream proposal names the delegation call that started its worker agent, so the stream and
 * the gate agree on which worker agent made it.
 */
const streamAttributionAgrees = (session: SessionRecord): boolean => {
  const delegationOf = new Map(
    workersOf(session).map((worker) => [worker.runtimeTaskId, worker.delegationCallId]),
  );
  const proposals = proposalsOf(session);
  return fixtureRequestsOf(session).every((entry) =>
    proposals.some(
      (proposal) =>
        proposal.runtimeCallId === entry.request.toolUseId &&
        proposal.parentCallId === delegationOf.get(entry.request.agentId ?? ""),
    ),
  );
};

/** Checks 1, 2 and 4: a worker agent's calls reach the gate, policy holds inside it, and each call is attributed. */
export const workerGateChecks = (session: SessionRecord): Checks => {
  const ledger = ledgerOf(session);
  return {
    manager_delegated: workersOf(session).length > 0,
    worker_ran_in_background: workersOf(session).every((worker) => worker.background),
    manager_made_no_fixture_calls: !fixtureRequestsOf(session).some(
      (entry) => entry.request.agentId === null,
    ),
    worker_change_reached_gate: gateRequestsFor(session, "change").length > 0,
    reject_stopped_worker_change: !ledger.some(
      (entry) => entry.tool === "change" && entry.kind === "committed",
    ),
    allow_policy_ran_worker_read:
      gateRequestsFor(session, "read").some((entry) => entry.decision.behavior === "allow") &&
      ledger.some((entry) => entry.tool === "read" && entry.kind === "returned"),
    deny_policy_never_reached_gate: gateRequestsFor(session, "forbidden").length === 0,
    deny_policy_never_executed: !ledger.some((entry) => entry.tool === "forbidden"),
    every_fixture_call_attributed_to_a_worker: everyFixtureCallFromAWorker(session),
    stream_attribution_matches_gate: streamAttributionAgrees(session),
    bridge_never_asked: session.bridge_requests === 0,
    worker_end_reported: session.events.some((event) => event.type === "worker_ended"),
  };
};

/** Check 3: stopping the session while a worker agent's call is held abandons it, and nothing runs. */
export const workerInterruptChecks = (session: SessionRecord): Checks => ({
  worker_change_was_held_then_abandoned: gateRequestsFor(session, "change").some(
    (entry) => entry.abandoned,
  ),
  held_worker_change_never_ran: !ledgerOf(session).some((entry) => entry.tool === "change"),
  session_status: session.result?.status ?? "no result",
});

/**
 * Check 5: a background worker agent outlives the manager agent's turn. `observed` holds how many events the session
 * had recorded when the second message was answered and when the held call was released (0: not answered).
 */
export const workerBackgroundChecks = (
  session: SessionRecord,
  observed: { eventsAtSecondAnswer: number; eventsAtRelease: number },
): Checks => {
  const ended = session.events.findIndex((event) => event.type === "worker_ended");
  return {
    delegated_in_background: workersOf(session).some((worker) => worker.background),
    manager_turn_ended_while_worker_held: turnResults(session, observed.eventsAtRelease) >= 1,
    second_message_answered_while_worker_held:
      observed.eventsAtSecondAnswer > 0 &&
      observed.eventsAtSecondAnswer <= observed.eventsAtRelease,
    worker_call_committed_after_release: ledgerOf(session).some(
      (entry) => entry.tool === "slow" && entry.kind === "committed",
    ),
    worker_end_started_a_manager_turn:
      ended >= 0 && session.events.slice(ended).some((event) => event.type === "turn_result"),
    turn_results_total: String(turnResults(session)),
    session_status: session.result?.status ?? "no result",
  };
};

/**
 * The manager agent stopped one worker agent through the gate. `observed.pendingAfterStop` is whether the worker
 * agent's in-flight call was still running at the fixture once the stop had been reported.
 */
export const workerStopChecks = (
  session: SessionRecord,
  observed: { pendingAfterStop: boolean },
): Checks => {
  const ledger = ledgerOf(session);
  const ended = session.events.find(
    (event): event is Extract<SessionEvent, { type: "worker_ended" }> =>
      event.type === "worker_ended",
  );
  return {
    task_stop_passed_gate_as_manager_call: session.gate_requests.some(
      (entry) => entry.request.toolName === "TaskStop" && entry.request.agentId === null,
    ),
    worker_end_status: ended?.status ?? "no end reported",
    in_flight_call_left_running_after_stop: observed.pendingAfterStop,
    in_flight_call_cancelled: ledger.some(
      (entry) => entry.tool === "slow" && entry.kind === "cancelled",
    ),
  };
};
