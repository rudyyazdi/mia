import { z } from "zod";
import { DELEGATE_TOOL, STOP_TOOL, type GateRequest } from "@mia/agent-adapter";

/**
 * Codex's multi-agent tools as its PreToolUse hook names them (Codex 0.159.3, multi-agent v2): the tool's namespace
 * and name run together. Codex starts every worker agent in the background.
 */
const SPAWN_TOOL = "collaborationspawn_agent";
const INTERRUPT_TOOL = "collaborationinterrupt_agent";

const SpawnInputSchema = z.looseObject({
  agent_type: z.string().optional(),
  task_name: z.string().optional(),
});
const InterruptInputSchema = z.looseObject({ target: z.string().optional() });

/**
 * A gate request in Mia's vocabulary: Codex's spawn_agent is a background delegation (`Task`) naming its agent type
 * as `subagent_type`, and interrupt_agent is `TaskStop` naming the worker agent by the task id Mia knows it by,
 * which `taskIdOf` resolves from Codex's target (a thread id or an agent path). Every other call is unchanged, and
 * the runtime's own request stays in `raw`.
 */
export const miaGateRequest = (
  request: GateRequest,
  taskIdOf: (target: string) => string | null,
): GateRequest => {
  if (request.toolName === SPAWN_TOOL) {
    const parsed = SpawnInputSchema.safeParse(request.input);
    return {
      ...request,
      toolName: DELEGATE_TOOL,
      input: {
        subagent_type: parsed.success ? parsed.data.agent_type : undefined,
        description: parsed.success ? parsed.data.task_name : undefined,
        run_in_background: true,
      },
    };
  }
  if (request.toolName === INTERRUPT_TOOL) {
    const parsed = InterruptInputSchema.safeParse(request.input);
    const target = parsed.success ? parsed.data.target : undefined;
    return {
      ...request,
      toolName: STOP_TOOL,
      input: { task_id: target === undefined ? undefined : (taskIdOf(target) ?? target) },
    };
  }
  return request;
};
