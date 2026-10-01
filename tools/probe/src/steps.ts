import { randomUUID } from "node:crypto";
import { readManagerCall, type GateDecision, type ManagerCall } from "@mia/agent-adapter";
import { log, type ProbeContext } from "./context.ts";
import type { GateDecider, SessionRecord } from "./record.ts";
import {
  managerTextOf,
  resumeChecks,
  workerBackgroundChecks,
  workerDenyChecks,
  workerGateChecks,
  workerInterruptChecks,
  workerStopChecks,
} from "./checks.ts";

// The probe's sessions: the controlled fixture, a manager agent's session with Mia's worker agent defined, and every
// tool call decided through the gate. The messages name no runtime's tools, so each step runs on every runtime.

const REJECTED: GateDecision = { behavior: "deny", message: "The user rejected this call." };
const ALLOWED: GateDecision = { behavior: "allow" };

/**
 * Allows the manager agent's delegations, and its calls of the kinds in `managerMay` besides; `worker` decides every
 * worker agent's call.
 */
const managerDelegates =
  (worker: GateDecider, managerMay: readonly ManagerCall["kind"][] = []): GateDecider =>
  (request, session) => {
    if (request.agentId === null)
      return ["delegate", ...managerMay].includes(
        readManagerCall(request.toolName, request.input).kind,
      )
        ? ALLOWED
        : { behavior: "deny", message: "The manager agent makes no tool calls itself." };
    return worker(request, session);
  };

/** Holds a call until its session abandons it, then rejects it: stopping the session is its only answer. */
const holdUntilAbandoned = (abandoned: AbortSignal): Promise<GateDecision> => {
  const held = Promise.withResolvers<GateDecision>();
  abandoned.addEventListener("abort", () => held.resolve(REJECTED), { once: true });
  return held.promise;
};

const turnResults = (session: SessionRecord): number =>
  session.events.filter((event) => event.type === "turn_result").length;

/** Waits for a worker agent's end and the manager turn that reports it. */
const untilWorkerReported = (context: ProbeContext, session: SessionRecord): Promise<boolean> =>
  context.waitUntil(
    () =>
      session.events.some((event) => event.type === "worker_ended") && turnResults(session) >= 2,
    context.deadlines.sessionSettled(),
  );

/** Hook gating inside a worker agent: its allowed and rejected calls, and their attribution. */
export const workerGate = async (context: ProbeContext): Promise<void> => {
  await context.harness.reset();
  const session = await context.runSession({
    name: "worker-gate",
    config: context.baseConfig(),
    decide: managerDelegates((request) =>
      request.toolName === "mcp__fixture__read" ? ALLOWED : REJECTED,
    ),
    drive: async ({ send }, session) => {
      send(
        "Start one worker agent whose task is: call fixture.read once, then fixture.change with delta 1 exactly once, and report what happened to each call.",
      );
      await untilWorkerReported(context, session);
    },
  });
  Object.assign(session.checks, workerGateChecks(session));
  log("checks", session.checks);
  context.save("worker-gate-checks", session.checks);
};

/**
 * A worker agent asked to call a tool the policy denies: Claude Code's deny rule withholds the tool from it, and on a
 * runtime without such a rule the gate denies the call (see `runSession`). Either way it never runs.
 */
export const workerDeny = async (context: ProbeContext): Promise<void> => {
  await context.harness.reset();
  const session = await context.runSession({
    name: "worker-deny",
    config: context.baseConfig(),
    decide: managerDelegates(() => REJECTED),
    drive: async ({ send }, session) => {
      send(
        "Start one worker agent whose task is: call fixture.forbidden exactly once (Mia's policy decides whether it runs, so make the call) and report what happened.",
      );
      await untilWorkerReported(context, session);
    },
  });
  Object.assign(session.checks, workerDenyChecks(session));
  log("checks", session.checks);
  context.save("worker-deny-checks", session.checks);
};

/**
 * Stopping the session while one worker agent's call is held for approval and another's is in flight at the fixture:
 * the held call is abandoned, and neither call is ever sent again.
 */
export const workerInterrupt = async (context: ProbeContext): Promise<void> => {
  await context.harness.reset();
  const session = await context.runSession({
    name: "worker-interrupt",
    config: context.baseConfig(),
    decide: managerDelegates((request) => {
      if (request.toolName === "mcp__fixture__slow") return ALLOWED;
      if (request.toolName === "mcp__fixture__change") return holdUntilAbandoned(request.abandoned);
      return REJECTED;
    }),
    drive: async ({ handle, send }, session) => {
      send(
        "Start two worker agents at once. The first one's task is: call fixture.slow with mode cancellable exactly once and report the result. The second one's task is: call fixture.change with delta 1 exactly once and report the result.",
      );
      const entered = await context.harness
        .waitEntered({ signal: context.deadlines.slowEntered() })
        .then(
          () => true,
          () => false,
        );
      const held = await context.waitUntil(
        () => session.notes.some((note) => note.startsWith("gate asked: mcp__fixture__change")),
        context.deadlines.slowEntered(),
      );
      session.notes.push(`worker slow in flight: ${entered}; worker change held: ${held}`);
      session.notes.push(`stop -> ${await handle.stop(context.deadlines.stopped())}`);
    },
  });
  Object.assign(session.checks, workerInterruptChecks(session));
  log("checks", session.checks, session.notes);
  context.save("worker-interrupt-checks", { checks: session.checks, notes: session.notes });
};

/**
 * A background worker agent's slow call outlives the manager agent's turn; a second message is answered while it is
 * held; its end starts a manager turn.
 */
export const workerBackground = async (context: ProbeContext): Promise<void> => {
  await context.harness.reset();
  const observed = { eventsAtSecondAnswer: 0, eventsAtRelease: 0 };
  const session = await context.runSession({
    name: "worker-background",
    config: context.baseConfig(),
    decide: managerDelegates(() => ALLOWED),
    drive: async ({ send }, session) => {
      send(
        "Start one worker agent whose task is: call fixture.slow with mode cancellable exactly once and report the result.",
      );
      const entered = await context.harness.waitEntered({
        signal: context.deadlines.slowEntered(),
      });
      session.notes.push(`slow entered ${entered.call_id}; turn results ${turnResults(session)}`);
      await context.waitUntil(
        () => turnResults(session) >= 1,
        context.deadlines.managerTurnEnded(),
      );
      send("Separate question, answer directly without any worker agent: what is 2+2?");
      const answered = await context.waitUntil(
        () => turnResults(session) >= 2,
        context.deadlines.managerTurnEnded(),
      );
      if (answered) observed.eventsAtSecondAnswer = session.events.length;
      observed.eventsAtRelease = session.events.length;
      session.notes.push(`before release: turn results ${turnResults(session)}`);
      await context.harness.release(entered.call_id);
      await context.waitUntil(
        () =>
          session.events.some((event) => event.type === "worker_ended") &&
          turnResults(session) >= 3,
        context.deadlines.sessionSettled(),
      );
    },
  });
  Object.assign(session.checks, workerBackgroundChecks(session, observed));
  log("checks", session.checks, session.notes);
  context.save("worker-background-checks", { checks: session.checks, notes: session.notes });
};

/**
 * The manager agent stops one worker agent while its cancellable call is in flight: the stop passes the gate as a
 * manager call, the runtime reports the worker agent stopped, and the step records what became of the call.
 */
export const workerStop = async (context: ProbeContext): Promise<void> => {
  await context.harness.reset();
  const observed = { pendingAfterStop: false };
  const session = await context.runSession({
    name: "worker-stop",
    config: context.baseConfig(),
    decide: managerDelegates(() => ALLOWED, ["stop"]),
    drive: async ({ send }, session) => {
      send(
        "Start one worker agent whose task is: call fixture.slow with mode cancellable exactly once and report the result.",
      );
      const entered = await context.harness.waitEntered({
        signal: context.deadlines.slowEntered(),
      });
      await context.waitUntil(
        () => turnResults(session) >= 1,
        context.deadlines.managerTurnEnded(),
      );
      send("Stop that worker agent now. Do not start another one.");
      const ended = await context.waitUntil(
        () => session.events.some((event) => event.type === "worker_ended"),
        context.deadlines.sessionSettled(),
      );
      session.notes.push(`worker ended: ${ended}`);
      await context.waitUntil(
        () => turnResults(session) >= 2,
        context.deadlines.managerTurnEnded(),
      );
      const state = await context.harness.state();
      observed.pendingAfterStop = state.pending.some(
        (pending) => pending.call_id === entered.call_id,
      );
      session.notes.push(`slow pending after the stop: ${observed.pendingAfterStop}`);
    },
  });
  Object.assign(session.checks, workerStopChecks(session, observed));
  log("checks", session.checks, session.notes);
  context.save("worker-stop-checks", { checks: session.checks, notes: session.notes });
};

/**
 * Resume after a restart: the first session is told a code word, then stopped and its runtime closed; a fresh
 * runtime resumes the same conversation, as the server does after a stop, and is asked for the word.
 */
export const resumeAfterRestart = async (context: ProbeContext): Promise<void> => {
  await context.harness.reset();
  const word = `probe-${randomUUID().slice(0, 8)}`;
  const conversationId = randomUUID();
  const noTools = managerDelegates(() => REJECTED);
  await context.runSession({
    name: "resume-before",
    config: context.baseConfig(),
    conversation: { id: conversationId, sessionIndex: 1, resume: false },
    decide: noTools,
    drive: async ({ handle, send }, session) => {
      send(
        `Remember this code word for later: ${word}. Reply only with OK, without any worker agent.`,
      );
      await context.waitUntil(
        () => turnResults(session) >= 1,
        context.deadlines.managerTurnEnded(),
      );
      session.notes.push(`stop -> ${await handle.stop(context.deadlines.stopped())}`);
    },
  });
  const after = await context.runSession({
    name: "resume-after",
    config: context.baseConfig(),
    conversation: { id: conversationId, sessionIndex: 2, resume: true },
    decide: noTools,
    drive: async ({ send }, session) => {
      send(
        "What was the code word I gave you? Reply with the word only, without any worker agent.",
      );
      await context.waitUntil(
        () => turnResults(session) >= 1,
        context.deadlines.managerTurnEnded(),
      );
    },
  });
  after.notes.push(`manager said: ${managerTextOf(after).slice(0, 200)}`);
  Object.assign(after.checks, resumeChecks(after, word));
  log("checks", after.checks, after.notes);
  context.save("resume-checks", { checks: after.checks, notes: after.notes });
};
