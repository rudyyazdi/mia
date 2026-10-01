import { match } from "ts-pattern";
import { z } from "zod";
import { redactString, redactValue } from "@mia/protocol";
import type { RuntimeEvent, RuntimeInit, TaskEvent, TurnSummary } from "@mia/agent-adapter";
import {
  InitMessageSchema,
  type InitMessage,
  type ResultMessage,
  type RuntimeMessage,
} from "./stream.ts";

const initOf = (message: InitMessage): RuntimeInit => ({ model: message.model, evidence: message });

const summaryOf = (message: ResultMessage): TurnSummary => ({
  isError: message.is_error,
  outcome: message.subtype,
  finalText: message.result,
  usage: message.usage,
  totalCostUsd: message.total_cost_usd,
  durationMs: message.duration_ms,
  durationApiMs: message.duration_api_ms,
  numTurns: message.num_turns,
  permissionDenials: message.permission_denials,
  evidence: message,
});

/** How many reported proposals a translator remembers; see `ClaudeTranslator`. */
export const MAX_REMEMBERED_PROPOSALS = 1024;

/**
 * Translates Claude Code stream-json messages into runtime events. It owns one piece of turn state:
 * a tool call's complete proposal is reported once, however many assistant messages repeat it.
 */
export class ClaudeTranslator {
  /**
   * The calls whose complete proposal was reported, newest last, bounded by MAX_REMEMBERED_PROPOSALS: the runtime
   * repeats a call only in the assistant messages right after it, so forgetting the oldest loses nothing.
   */
  readonly #completedProposals = new Set<string>();

  #remember(id: string): void {
    this.#completedProposals.add(id);
    if (this.#completedProposals.size <= MAX_REMEMBERED_PROPOSALS) return;
    const oldest = this.#completedProposals.values().next();
    if (!oldest.done) this.#completedProposals.delete(oldest.value);
  }

  /** `now` stamps each event as it is produced. */
  translate(message: RuntimeMessage, now: () => string): RuntimeEvent[] {
    return match(message)
      .with({ type: "system" }, (systemMessage): RuntimeEvent[] => {
        if (systemMessage.subtype !== "init") return [];
        // OtherSystemMessageSchema refuses subtype init, so a system/init message that parsed satisfies InitMessageSchema.
        const parsedInit = InitMessageSchema.safeParse(systemMessage);
        return parsedInit.success
          ? [{ type: "runtime_init", init: initOf(parsedInit.data), at: now() }]
          : [];
      })
      .with({ type: "stream_event" }, ({ event, parent_tool_use_id }): RuntimeEvent[] => {
        const parentCallId = parent_tool_use_id ?? null;
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          event.delta.text
        )
          return [{ type: "text_delta", text: event.delta.text, parentCallId, at: now() }];
        if (
          event.type === "content_block_start" &&
          event.content_block?.type === "tool_use" &&
          event.content_block.id &&
          event.content_block.name
        )
          return [
            {
              type: "tool_proposed",
              runtimeCallId: event.content_block.id,
              toolIdentity: event.content_block.name,
              parentCallId,
              arguments: event.content_block.input ?? {},
              complete: false,
              at: now(),
            },
          ];
        return [];
      })
      .with({ type: "assistant" }, (assistantMessage): RuntimeEvent[] => {
        const events: RuntimeEvent[] = [
          { type: "assistant_message", message: redactValue(assistantMessage.message), at: now() },
        ];
        for (const block of assistantMessage.message.content) {
          if (block.type !== "tool_use" || !block.id || !block.name) continue;
          if (this.#completedProposals.has(block.id)) continue;
          this.#remember(block.id);
          events.push({
            type: "tool_proposed",
            runtimeCallId: block.id,
            toolIdentity: block.name,
            parentCallId: assistantMessage.parent_tool_use_id ?? null,
            arguments: block.input ?? {},
            complete: true,
            at: now(),
          });
        }
        return events;
      })
      .with({ type: "user" }, (userMessage): RuntimeEvent[] => {
        if (userMessage.isReplay === true)
          return userMessage.uuid === undefined
            ? []
            : [{ type: "input_taken", runtimeMessageId: userMessage.uuid, at: now() }];
        const content = userMessage.message.content;
        if (!Array.isArray(content)) return [];
        return content.flatMap((block): RuntimeEvent[] =>
          block.type === "tool_result" && block.tool_use_id
            ? [
                {
                  type: "tool_result",
                  runtimeCallId: block.tool_use_id,
                  parentCallId: userMessage.parent_tool_use_id ?? null,
                  isError: block.is_error === true,
                  content: redactValue(block.content ?? null),
                  raw: redactValue(userMessage.tool_use_result ?? null),
                  at: now(),
                },
              ]
            : [],
        );
      })
      .with({ type: "result" }, (resultMessage): RuntimeEvent[] => [
        { type: "turn_result", summary: summaryOf(resultMessage), at: now() },
      ])
      .with({ type: "other" }, (): RuntimeEvent[] => [])
      .exhaustive();
  }
}

const WorkerStartedSchema = z.looseObject({
  subtype: z.literal("task_started"),
  task_id: z.string(),
  tool_use_id: z.string(),
  description: z.string().default(""),
  prompt: z.string().default(""),
  is_backgrounded: z.boolean().default(false),
});

const WorkerEndedSchema = z.looseObject({
  subtype: z.literal("task_notification"),
  task_id: z.string(),
  tool_use_id: z.string().optional(),
  // eslint-disable-next-line no-restricted-syntax -- the runtime's own word, kept as reported; the engine maps it
  status: z.string(),
  summary: z.string().optional(),
});

/**
 * The worker-agent events one runtime message carries: Claude Code reports a subagent's start as a `task_started`
 * system message and its end as a `task_notification`. Other messages carry none.
 */
export const taskEventsOf = (message: RuntimeMessage, now: () => string): TaskEvent[] => {
  if (message.type !== "system") return [];
  const started = WorkerStartedSchema.safeParse(message);
  if (started.success)
    return [
      {
        type: "worker_started",
        runtimeTaskId: started.data.task_id,
        delegationCallId: started.data.tool_use_id,
        description: started.data.description,
        prompt: redactString(started.data.prompt),
        background: started.data.is_backgrounded,
        at: now(),
      },
    ];
  const ended = WorkerEndedSchema.safeParse(message);
  if (ended.success)
    return [
      {
        type: "worker_ended",
        runtimeTaskId: ended.data.task_id,
        delegationCallId: ended.data.tool_use_id ?? null,
        status: ended.data.status,
        summary: ended.data.summary === undefined ? null : redactString(ended.data.summary),
        at: now(),
      },
    ];
  return [];
};
