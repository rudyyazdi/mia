import { readManagerCall, type SessionEvent } from "@mia/agent-adapter";
import type { SessionRecord } from "./record.ts";

// Pure readings of the probe's sessions: delegation, gating inside worker agents, attribution, policy denial,
// interruption, stopping a worker agent, a background worker agent outliving the manager agent's turn, and resume.

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

/** How many distinct calls of `tool` reached the fixture at all: entered it, ran, or were refused there. */
const fixtureRunsOf = (session: SessionRecord, tool: string): number =>
  new Set(
    ledgerOf(session)
      .filter((entry) => entry.tool === tool)
      .map((entry) => entry.call_id),
  ).size;

/**
 * No call reached the fixture that the gate had not allowed: for each tool, at most as many calls ran as the gate
 * allowed. A call that bypassed the hook, or a call sent again after it was allowed once, would break it.
 */
const everyFixtureRunAllowed = (session: SessionRecord): boolean =>
  ["read", "change", "slow", "artifact", "forbidden"].every(
    (tool) =>
      fixtureRunsOf(session, tool) <=
      gateRequestsFor(session, tool).filter((entry) => entry.decision.behavior === "allow").length,
  );

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
 * The fixture calls the gate saw that the stream also proposed, as "streamed/asked". Claude Code streams every call
 * before its hook runs. Codex reports a call only once its hook has let it run, so a call the gate refused is never
 * streamed there; the gate's `agent_id` alone attributes it.
 */
const streamedOfAsked = (session: SessionRecord): string => {
  const proposed = new Set(proposalsOf(session).map((proposal) => proposal.runtimeCallId));
  const asked = fixtureRequestsOf(session);
  const streamed = asked.filter((entry) => proposed.has(entry.request.toolUseId ?? ""));
  return `${streamed.length}/${asked.length}`;
};

/**
 * Every fixture call the stream proposed names the delegation call that started the worker agent the gate saw make
 * it, so the stream and the gate agree on which worker agent made it; at least one call was streamed.
 */
const streamAttributionAgrees = (session: SessionRecord): boolean => {
  const delegationOf = new Map(
    workersOf(session).map((worker) => [worker.runtimeTaskId, worker.delegationCallId]),
  );
  const proposals = proposalsOf(session);
  const streamed = fixtureRequestsOf(session).flatMap((entry) =>
    proposals
      .filter((proposal) => proposal.runtimeCallId === entry.request.toolUseId)
      .map((proposal) => ({ entry, proposal })),
  );
  return (
    streamed.length > 0 &&
    streamed.every(
      ({ entry, proposal }) =>
        proposal.parentCallId === delegationOf.get(entry.request.agentId ?? ""),
    )
  );
};

/** Hook gating inside a worker agent: its calls reach the gate, the gate's decisions hold, and each is attributed. */
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
    allow_ran_worker_read_over_mcp:
      gateRequestsFor(session, "read").some((entry) => entry.decision.behavior === "allow") &&
      ledger.some((entry) => entry.tool === "read" && entry.kind === "returned"),
    every_fixture_run_allowed_by_gate: everyFixtureRunAllowed(session),
    every_fixture_call_attributed_to_a_worker: everyFixtureCallFromAWorker(session),
    stream_attribution_matches_gate: streamAttributionAgrees(session),
    fixture_calls_streamed_of_asked: streamedOfAsked(session),
    worker_end_reported: session.events.some((event) => event.type === "worker_ended"),
  };
};

/**
 * A worker agent's call of a policy-denied tool: it was attempted (proposed on the stream, or asked at the gate),
 * every gate decision on it was a denial, and it never ran.
 */
export const workerDenyChecks = (session: SessionRecord): Checks => {
  const asked = gateRequestsFor(session, "forbidden");
  return {
    worker_attempted_denied_call:
      asked.length > 0 ||
      proposalsOf(session).some((proposal) => proposal.toolIdentity === "mcp__fixture__forbidden"),
    denied_by: asked.length > 0 ? "gate" : "runtime rule (never reached the gate)",
    gate_denied_every_ask: asked.every((entry) => entry.decision.behavior === "deny"),
    denied_call_never_ran: fixtureRunsOf(session, "forbidden") === 0,
    every_fixture_call_attributed_to_a_worker:
      asked.length === 0 || asked.every((entry) => entry.request.agentId !== null),
  };
};

/**
 * Stopping the session while one worker agent's call is held at the gate and another's is in flight at the fixture:
 * the held call is abandoned and never runs, and neither call is asked or sent a second time.
 */
export const workerInterruptChecks = (session: SessionRecord): Checks => {
  const ledger = ledgerOf(session);
  return {
    held_change_abandoned: gateRequestsFor(session, "change").some((entry) => entry.abandoned),
    held_change_never_ran: fixtureRunsOf(session, "change") === 0,
    held_change_asked_once: gateRequestsFor(session, "change").length === 1,
    in_flight_slow_entered_once:
      ledger.filter((entry) => entry.tool === "slow" && entry.kind === "entered").length === 1,
    in_flight_slow_asked_once: gateRequestsFor(session, "slow").length === 1,
    in_flight_slow_never_committed: !ledger.some(
      (entry) => entry.tool === "slow" && entry.kind === "committed",
    ),
    session_status: session.result?.status ?? "no result",
  };
};

/**
 * A background worker agent outlives the manager agent's turn. `observed` holds how many events the session had
 * recorded when the second message was answered and when the held call was released (0: not answered).
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
    stop_passed_gate_as_manager_call: session.gate_requests.some(
      (entry) =>
        entry.request.agentId === null &&
        readManagerCall(entry.request.toolName, entry.request.input).kind === "stop" &&
        entry.decision.behavior === "allow",
    ),
    worker_end: ended ? `${ended.end} (runtime: ${ended.runtimeStatus})` : "no end reported",
    worker_reported_stopped: ended?.end === "stopped",
    in_flight_call_left_running_after_stop: observed.pendingAfterStop,
    in_flight_call_cancelled: ledger.some(
      (entry) => entry.tool === "slow" && entry.kind === "cancelled",
    ),
    in_flight_call_never_committed: !ledger.some(
      (entry) => entry.tool === "slow" && entry.kind === "committed",
    ),
  };
};

/** The manager agent's own text in a session: its streamed text, else its turns' closing text. */
export const managerTextOf = (session: SessionRecord): string => {
  const streamed = session.events
    .map((event) => (event.type === "text_delta" && event.parentCallId === null ? event.text : ""))
    .join("");
  if (streamed !== "") return streamed;
  return session.events
    .map((event) => (event.type === "turn_result" ? (event.summary.finalText ?? "") : ""))
    .join("\n");
};

/** The resumed session, on a fresh runtime, answered with the code word the killed session was told. */
export const resumeChecks = (after: SessionRecord, word: string): Checks => ({
  resumed_session_answered: after.events.some((event) => event.type === "turn_result"),
  resumed_session_knew_the_word: managerTextOf(after).includes(word),
});
