import { Command, Option } from "commander";
import { LIVE_RUNTIME_NAMES, liveRuntimeOf } from "@mia/runtimes";
import { runLive } from "./live.ts";
import { readScenarioList, type ScenarioName } from "./scenarios.ts";

const program: Command = new Command()
  .name("live")
  .option("--repeat <N>", "promptfoo repeat count", "2")
  // Checked before anything starts: promptfoo would silently match none.
  .option(
    "--scenarios <names>",
    "comma-separated scenario names to run",
    (value: string): ScenarioName[] => {
      const read = readScenarioList(value);
      return read.ok ? read.names : program.error(`--scenarios: ${read.error}`, { exitCode: 2 });
    },
  )
  .option(
    "--manager-prompt <path>",
    "manager agent prompt file, relative to the repo root",
    "prompts/manager-v2.md",
  )
  .addOption(
    new Option("--runtime <name>", "runtime both fixture profiles run on")
      .choices(LIVE_RUNTIME_NAMES)
      .default("claude"),
  )
  .option(
    "--model <model>",
    "runtime model (default: the runtime's live default, gpt-6-luna for codex)",
  )
  .option("--out <dir>", "evidence directory (default: .mia-state/live/<timestamp>)");
program.parse();
const options = program.opts<{
  repeat: string;
  scenarios?: ScenarioName[];
  managerPrompt: string;
  runtime: string;
  model?: string;
  out?: string;
}>();
const runtime =
  liveRuntimeOf(options.runtime) ?? program.error(`--runtime: unknown runtime ${options.runtime}`);

runLive({ ...options, runtime, model: options.model ?? runtime.model }, process.env).then(
  (code) => process.exit(code),
  (error: unknown) => {
    // The whole error, not just its message: a failed close during cleanup arrives as a
    // SuppressedError whose message hides both the run's error and the close's.
    console.error("live:", error);
    process.exit(1);
  },
);
