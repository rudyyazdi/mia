import { Command, Option } from "commander";
import { LIVE_RUNTIME_NAMES, liveRuntimeOf } from "@mia/runtimes";
import { runProbe, type ProbeDeadlines } from "./probe.ts";

const deadlines: ProbeDeadlines = {
  slowEntered: () => AbortSignal.timeout(120_000),
  ledgerSettled: () => AbortSignal.timeout(5_000),
  managerTurnEnded: () => AbortSignal.timeout(90_000),
  sessionSettled: () => AbortSignal.timeout(180_000),
  stopped: () => AbortSignal.timeout(5_000),
  attribution: () => AbortSignal.timeout(15_000),
};

const program = new Command()
  .name("probe")
  .addOption(
    new Option("--runtime <name>", "runtime to probe")
      .choices(LIVE_RUNTIME_NAMES)
      .default("claude"),
  )
  .option(
    "--model <model>",
    "runtime model (default: the runtime's live default, gpt-6-luna for codex)",
  )
  .option(
    "--out <dir>",
    "evidence directory (a timestamped subdirectory is created)",
    ".mia-state/probe",
  )
  .option("--only <names>", "comma-separated step names to run");
program.parse();
const options = program.opts<{ runtime: string; model?: string; out: string; only?: string }>();
const runtime =
  liveRuntimeOf(options.runtime) ?? program.error(`--runtime: unknown runtime ${options.runtime}`);
process.exit(
  await runProbe(
    { ...options, runtime, model: options.model ?? runtime.model },
    process.env,
    deadlines,
  ),
);
