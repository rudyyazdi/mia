import { resolve } from "node:path";
import type { GateDecision, RuntimeConfig } from "@mia/agent-adapter";
import { log, type ProbeContext } from "./context.ts";
import type { GateDecider, SessionRecord } from "./record.ts";
import {
  workerBackgroundChecks,
  workerGateChecks,
  workerInterruptChecks,
  workerStopChecks,
} from "./worker-checks.ts";

// The worker-agent sessions (D2, issue #200): the same fixture, a manager agent's session with Mia's worker agent
// defined, and every tool call decided through the gate.

const REJECTED: GateDecision = { behavior: "deny", message: "The user rejected this call." };

const workerConfig = (context: ProbeContext): RuntimeConfig =>
  context.baseConfig({
    agentPromptFile: resolve("prompts/manager-v1.md"),
    workerAgent: {
      description:
        "Runs one task that needs tools, calling exactly the tools the task names. Use it for every tool call.",
      promptFile: resolve("prompts/worker-v1.md"),
    },
  });

/**
 * Allows the manager agent's delegation, and `managerTools` besides; `worker` decides every worker agent's call.
 */
const managerDelegates =
  (worker: GateDecider, managerTools: string[] = []): GateDecider =>
  (request, session) => {
    if (request.agentId === null)
      return ["Agent", "Task", ...managerTools].includes(request.toolName)
        ? { behavior: "allow" }
        : { behavior: "deny", message: "The manager agent makes no tool calls itself." };
    return worker(request, session);
  };

const turnResults = (session: SessionRecord): number =>
  session.events.filter((event) => event.type === "turn_result").length;

/** Checks 1, 2 and 4: a worker agent's allowed, rejected and denied calls, and their attribution. */
export const workerGate = async (context: ProbeContext): Promise<void> => {
  await context.harness.reset();
  const session = await context.runSession({
    name: "worker-gate",
    config: workerConfig(context),
    decide: managerDelegates((request) =>
      request.toolName === "mcp__d1__read" ? { behavior: "allow" } : REJECTED,
    ),
    drive: async (handle, session) => {
      handle.send(
        "Start one worker agent whose task is: call d1.read once, then d1.change with delta 1 exactly once, then d1.forbidden once, and report what happened to each call.",
      );
      // The worker agent's end starts a second manager turn, which reports it.
      await context.waitUntil(
        () =>
          session.events.some((event) => event.type === "worker_ended") &&
          turnResults(session) >= 2,
        context.deadlines.sessionSettled(),
      );
    },
  });
  Object.assign(session.checks, workerGateChecks(session));
  log("checks", session.checks);
  context.save("worker-gate-checks", session.checks);
};

/** Check 3: stopping the session while a worker agent's call is held for approval. */
export const workerInterrupt = async (context: ProbeContext): Promise<void> => {
  await context.harness.reset();
  const session = await context.runSession({
    name: "worker-interrupt",
    config: workerConfig(context),
    decide: managerDelegates(async (request) => {
      if (request.toolName !== "mcp__d1__change") return REJECTED;
      // Never answered: stopping the session abandons the held call.
      const abandoned = Promise.withResolvers<GateDecision>();
      request.abandoned.addEventListener("abort", () => abandoned.resolve(REJECTED), {
        once: true,
      });
      return abandoned.promise;
    }),
    drive: async (handle, session) => {
      handle.send(
        "Start one worker agent whose task is: call d1.change with delta 1 exactly once and report the result.",
      );
      const held = await context.waitUntil(
        () => session.notes.some((note) => note.startsWith("gate asked: mcp__d1__change")),
        context.deadlines.slowEntered(),
      );
      session.notes.push(`worker change held: ${held}`);
      session.notes.push(`stop -> ${await handle.stop()}`);
    },
  });
  Object.assign(session.checks, workerInterruptChecks(session));
  log("checks", session.checks, session.notes);
  context.save("worker-interrupt-checks", { checks: session.checks, notes: session.notes });
};

/**
 * Check 5: a background worker agent's slow call outlives the manager agent's turn; a second message is answered
 * while it is held; its end starts a manager turn.
 */
export const workerBackground = async (context: ProbeContext): Promise<void> => {
  await context.harness.reset();
  const observed = { eventsAtSecondAnswer: 0, eventsAtRelease: 0 };
  const session = await context.runSession({
    name: "worker-background",
    config: workerConfig(context),
    decide: managerDelegates(() => ({ behavior: "allow" })),
    drive: async (handle, session) => {
      handle.send(
        "Start one worker agent whose task is: call d1.slow with mode cancellable exactly once and report the result.",
      );
      const entered = await context.harness.waitEntered({
        signal: context.deadlines.slowEntered(),
      });
      session.notes.push(`slow entered ${entered.call_id}; turn results ${turnResults(session)}`);
      await context.waitUntil(
        () => turnResults(session) >= 1,
        context.deadlines.managerTurnEnded(),
      );
      handle.send("Separate question, answer directly without any worker agent: what is 2+2?");
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
 * The manager agent stops one worker agent while its cancellable call is in flight: `TaskStop` passes the gate as a
 * manager call, the runtime reports the worker agent stopped, and the step records what became of the call.
 */
export const workerStop = async (context: ProbeContext): Promise<void> => {
  await context.harness.reset();
  const observed = { pendingAfterStop: false };
  const session = await context.runSession({
    name: "worker-stop",
    config: workerConfig(context),
    decide: managerDelegates(() => ({ behavior: "allow" }), ["TaskStop"]),
    drive: async (handle, session) => {
      handle.send(
        "Start one worker agent whose task is: call d1.slow with mode cancellable exactly once and report the result.",
      );
      const entered = await context.harness.waitEntered({
        signal: context.deadlines.slowEntered(),
      });
      await context.waitUntil(
        () => turnResults(session) >= 1,
        context.deadlines.managerTurnEnded(),
      );
      handle.send("Stop that worker agent now with TaskStop. Do not start another one.");
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
