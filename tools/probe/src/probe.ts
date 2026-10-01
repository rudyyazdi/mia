import { probeStaticCapabilitiesSync } from "@mia/agent-adapter";
import { log, ProbeContext } from "./context.ts";
import type { ProbeDeadlines, ProbeOptions } from "./record.ts";
import { workerBackground, workerGate, workerInterrupt, workerStop } from "./steps.ts";

/** Runs the static probe and then every wanted live session; resolves to the process exit code. */
const runSteps = async (context: ProbeContext): Promise<number> => {
  const staticReport = probeStaticCapabilitiesSync(context.baseConfig(), context.env);
  context.save("static-capabilities", staticReport);
  log("static:", JSON.stringify(staticReport, null, 1));
  if (staticReport.errors.length > 0) {
    console.error(
      "Static probe found blockers:\n" +
        staticReport.errors.map((problem) => ` - ${problem}`).join("\n"),
    );
    return 1;
  }

  if (context.wants("worker-gate")) await workerGate(context);
  if (context.wants("worker-interrupt")) await workerInterrupt(context);
  if (context.wants("worker-background")) await workerBackground(context);
  if (context.wants("worker-stop")) await workerStop(context);

  context.save("summary", {
    static: staticReport,
    sessions: context.sessions.map((session) => ({
      name: session.name,
      checks: session.checks,
      notes: session.notes,
      status: session.result?.status,
      error: session.result?.error,
    })),
    live_calls_used: context.liveCallsUsed(),
  });
  log("done. evidence in", context.dirs.out);
  return 0;
};

/**
 * Capability probe: proves, against the real installed runtime, the behaviours the adapter relies on. Every session
 * is counted against the shared live-call budget, and its evidence lands in an out directory. `env` is the
 * environment the runtime inherits and supplies the live-call budget's overrides, and `deadlines` bound each wait.
 * Resolves to the exit code once the fixture, gate and bridge are released.
 */
export const runProbe = async (
  options: ProbeOptions,
  env: NodeJS.ProcessEnv,
  deadlines: ProbeDeadlines,
): Promise<number> => {
  const context = await ProbeContext.start(options, env, deadlines);
  try {
    return await runSteps(context);
  } finally {
    await context.close();
  }
};

export type { ProbeDeadlines, ProbeOptions };
