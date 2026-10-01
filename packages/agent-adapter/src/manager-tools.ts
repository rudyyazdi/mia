import { z } from "zod";

/**
 * The manager agent's own tools, named once in Mia's vocabulary, which follows Claude Code's names: `Task` starts a
 * worker agent (Claude Code streams and gates its calls under the name `Agent`), `TaskStop` stops one. An adapter
 * whose runtime names them otherwise reports its calls under these names. A worker agent's tool list leaves both out.
 */
export const DELEGATE_TOOLS: readonly string[] = ["Task", "Agent"];
export const STOP_TOOL = "TaskStop";
/** The tools a manager agent's session enables. */
export const MANAGER_TOOLS = ["Task", STOP_TOOL] as const;

/** The name of the worker agent Mia defines; a delegation names it as `subagent_type`. */
export const WORKER_AGENT_NAME = "mia-worker";

const DelegationInputSchema = z.looseObject({
  subagent_type: z.string().optional(),
  run_in_background: z.boolean().optional(),
});
const StopInputSchema = z.looseObject({
  task_id: z.string().optional(),
  shell_id: z.string().optional(),
});

/**
 * A call the manager agent asked the gate about, read once at the boundary: a delegation (with the worker agent it
 * names and whether it runs in the background), a stop of a worker agent, or anything else.
 */
export type ManagerCall =
  | { kind: "delegate"; subagentType: string | null; background: boolean }
  | { kind: "stop"; runtimeTaskId: string | null }
  | { kind: "other" };

export const readManagerCall = (toolName: string, input: unknown): ManagerCall => {
  if (DELEGATE_TOOLS.includes(toolName)) {
    const parsed = DelegationInputSchema.safeParse(input);
    return {
      kind: "delegate",
      subagentType: parsed.success ? (parsed.data.subagent_type ?? null) : null,
      background: parsed.success && parsed.data.run_in_background === true,
    };
  }
  if (toolName === STOP_TOOL) {
    const parsed = StopInputSchema.safeParse(input);
    return {
      kind: "stop",
      runtimeTaskId: parsed.success ? (parsed.data.task_id ?? parsed.data.shell_id ?? null) : null,
    };
  }
  return { kind: "other" };
};

/** Whether a tool is one of the manager agent's own, which a worker agent may never call. */
export const isManagerTool = (toolName: string): boolean =>
  DELEGATE_TOOLS.includes(toolName) || toolName === STOP_TOOL;
