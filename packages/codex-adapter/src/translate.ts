import { redactString, redactValue } from "@mia/protocol";
import type { SessionEvent, TurnSummary, WorkerEnd } from "@mia/agent-adapter";
import {
  AgentMessageDeltaSchema,
  AgentMessageItemSchema,
  ErrorNotificationSchema,
  HookRunSchema,
  ItemNotificationSchema,
  McpToolCallItemSchema,
  SubAgentActivityItemSchema,
  TokenUsageSchema,
  TurnCompletedSchema,
  TurnStartedSchema,
  UserMessageItemSchema,
  WarningSchema,
  type SubAgentActivityItem,
} from "./protocol.ts";

/** A notification as the server sent it: its method and its still-unread params. */
export interface Notification {
  method: string;
  params: unknown;
}

/** How many worker agents a translator remembers; past it, the oldest ended one is forgotten. */
export const MAX_REMEMBERED_WORKERS = 1024;

/** The most of a worker agent's final message a translator keeps for its end's summary. */
const MAX_SUMMARY_CHARS = 16_384;

/** A worker agent Codex started for the manager agent: a thread of its own, at a path such as `/root/<task>`. */
interface Worker {
  delegationCallId: string;
  path: string;
  /** How its current turn ended, in Codex's word; null while it runs. */
  // eslint-disable-next-line no-restricted-syntax -- Codex's own word, mapped by `workerEndOf`
  turnStatus: string | null;
  /** Its latest agent message, which its end reports as the summary. */
  finalText: string | null;
  /**
   * running; ending: the manager thread reported it completed before its own turn reported how it ended, so its end
   * waits for that; ended: its end was reported.
   */
  phase: "running" | "ending" | "ended";
}

/**
 * How a worker agent ended, from Codex's words: the manager thread's activity (`completed` when the worker agent's
 * turn ended, `interrupted` when interrupt_agent stopped it) and the worker agent's own turn status. Any other word is
 * a failure.
 */
// eslint-disable-next-line no-restricted-syntax -- Codex's own words for a worker agent's end, mapped here once
export const workerEndOf = (activity: string, turnStatus: string | null): WorkerEnd => {
  if (activity === "interrupted" || turnStatus === "interrupted") return "stopped";
  if (activity !== "completed") return "failed";
  return turnStatus === null || turnStatus === "completed" ? "completed" : "failed";
};

/** The text of the last agent message among a turn's items, if any. */
const lastAgentText = (items: readonly unknown[]): string | undefined =>
  items.map((item) => AgentMessageItemSchema.safeParse(item)).findLast((parsed) => parsed.success)
    ?.data?.text;

/**
 * Translates `codex app-server` notifications into session events. The manager agent is the thread Mia started or
 * resumed (`adopt`); every other thread is a worker agent, known from the manager thread's report of its start, and
 * a worker agent's events carry the delegation call that started it. A thread it does not know reports nothing, so a
 * worker agent's text is never taken for the manager agent's reply.
 */
export class CodexTranslator {
  #manager: { threadId: string; model: string } | null = null;
  /** By thread id, oldest first; bounded by MAX_REMEMBERED_WORKERS. */
  readonly #workers = new Map<string, Worker>();
  /** The manager agent's latest token accounting, which its turn's summary reports. */
  #usage: unknown = undefined;

  /** Makes `threadId` the manager agent's thread. */
  adopt(manager: { threadId: string; model: string }): void {
    this.#manager = manager;
  }

  get managerThreadId(): string | null {
    return this.#manager?.threadId ?? null;
  }

  /** Worker agents started and not yet ended. */
  get runningWorkers(): number {
    return [...this.#workers.values()].filter((worker) => worker.phase !== "ended").length;
  }

  /**
   * The worker agent a stop names, as the task id Mia knows it by (its thread id): Codex's interrupt_agent takes a
   * thread id or an agent path. Null when it names no worker agent this translator knows.
   */
  taskIdOf(target: string): string | null {
    if (this.#workers.has(target)) return target;
    for (const [threadId, worker] of this.#workers) if (worker.path === target) return threadId;
    return null;
  }

  /** A worker agent's final message as it wrote it, unredacted, or null when it wrote none or is not known. */
  finalTextOf(threadId: string): string | null {
    return this.#workers.get(threadId)?.finalText ?? null;
  }

  /** The worker agent's path, as the manager agent names it, or null when it is not known. */
  pathOf(threadId: string): string | null {
    return this.#workers.get(threadId)?.path ?? null;
  }

  /**
   * The tool call a PreToolUse hook is starting for on the manager agent's thread, or null. Codex reports the hook
   * run before it runs the hook, so the manager agent's call is announced before the gate is asked about it.
   */
  managerHookStart(notification: Notification): string | null {
    if (notification.method !== "hook/started") return null;
    const parsed = HookRunSchema.safeParse(notification.params);
    if (!parsed.success || parsed.data.threadId !== this.managerThreadId) return null;
    if (parsed.data.run.eventName !== "preToolUse") return null;
    const { id } = parsed.data.run;
    return id.slice(id.lastIndexOf(":") + 1) || null;
  }

  /** `now` stamps each event as it is produced. */
  translate(notification: Notification, now: () => string): SessionEvent[] {
    const { method, params } = notification;
    if (method === "turn/started") return this.#turnStarted(params, now);
    if (method === "turn/completed") return this.#turnCompleted(params, now);
    if (method === "item/started") return this.#itemStarted(params, now);
    if (method === "item/completed") return this.#itemCompleted(params, now);
    if (method === "item/agentMessage/delta") return this.#delta(params, now);
    if (method === "thread/tokenUsage/updated") {
      const parsed = TokenUsageSchema.safeParse(params);
      if (parsed.success && parsed.data.threadId === this.managerThreadId)
        this.#usage = parsed.data.tokenUsage;
      return [];
    }
    if (method === "error") {
      const parsed = ErrorNotificationSchema.safeParse(params);
      if (!parsed.success) return [];
      const retry = parsed.data.willRetry ? " (retrying)" : "";
      return [
        { type: "runtime_stderr", text: `[codex] ${parsed.data.error.message}${retry}`, at: now() },
      ];
    }
    if (method === "warning") {
      const parsed = WarningSchema.safeParse(params);
      return parsed.success
        ? [{ type: "runtime_stderr", text: `[codex] ${parsed.data.message}`, at: now() }]
        : [];
    }
    if (method === "hook/completed") {
      // A hook that failed lets Codex run the call anyway; only a deny or exit code 2 blocks it.
      const parsed = HookRunSchema.safeParse(params);
      if (!parsed.success || parsed.data.run.status !== "failed") return [];
      const detail = parsed.data.run.entries.map((entry) => entry.text).join("; ");
      return [{ type: "runtime_stderr", text: `[codex] hook failed: ${detail}`, at: now() }];
    }
    return [];
  }

  /** The delegation call a thread's events belong to: null for the manager agent, undefined for a thread unknown. */
  #parentOf(threadId: string): string | null | undefined {
    if (threadId === this.managerThreadId) return null;
    return this.#workers.get(threadId)?.delegationCallId;
  }

  /** An item notification's item and the delegation call its thread belongs to, or null for a thread unknown. */
  #itemOf(params: unknown): { threadId: string; item: unknown; parent: string | null } | null {
    const parsed = ItemNotificationSchema.safeParse(params);
    if (!parsed.success) return null;
    const { threadId, item } = parsed.data;
    const parent = this.#parentOf(threadId);
    return parent === undefined ? null : { threadId, item, parent };
  }

  #turnStarted(params: unknown, now: () => string): SessionEvent[] {
    const parsed = TurnStartedSchema.safeParse(params);
    if (!parsed.success) return [];
    const worker = this.#workers.get(parsed.data.threadId);
    if (worker) worker.turnStatus = null;
    const manager = this.#manager;
    if (!manager || parsed.data.threadId !== manager.threadId) return [];
    this.#usage = undefined;
    return [{ type: "runtime_init", init: { model: manager.model, evidence: params }, at: now() }];
  }

  #turnCompleted(params: unknown, now: () => string): SessionEvent[] {
    const parsed = TurnCompletedSchema.safeParse(params);
    if (!parsed.success) return [];
    const { threadId, turn } = parsed.data;
    const worker = this.#workers.get(threadId);
    if (worker) {
      worker.turnStatus = turn.status;
      worker.finalText = lastAgentText(turn.items)?.slice(0, MAX_SUMMARY_CHARS) ?? worker.finalText;
      return worker.phase === "ending"
        ? [this.#ended({ threadId, worker, activity: "completed" }, now)]
        : [];
    }
    if (threadId !== this.managerThreadId) return [];
    const summary: TurnSummary = {
      isError: turn.status === "failed",
      outcome: turn.status,
      finalText: lastAgentText(turn.items),
      usage: this.#usage,
      durationMs: turn.durationMs ?? undefined,
      evidence: redactValue(params),
    };
    return [{ type: "turn_result", summary, at: now() }];
  }

  #itemStarted(params: unknown, now: () => string): SessionEvent[] {
    const known = this.#itemOf(params);
    if (!known) return [];
    const { item, parent } = known;
    const user = UserMessageItemSchema.safeParse(item);
    if (user.success)
      return parent === null && user.data.clientId
        ? [{ type: "input_taken", runtimeMessageId: user.data.clientId, at: now() }]
        : [];
    const call = McpToolCallItemSchema.safeParse(item);
    if (call.success)
      return [
        {
          type: "tool_proposed",
          runtimeCallId: call.data.id,
          parentCallId: parent,
          toolIdentity: `mcp__${call.data.server}__${call.data.tool}`,
          arguments: call.data.arguments ?? {},
          complete: true,
          at: now(),
        },
      ];
    const activity = SubAgentActivityItemSchema.safeParse(item);
    if (activity.success && parent === null) return this.#activity(activity.data, now);
    return [];
  }

  #activity(activity: SubAgentActivityItem, now: () => string): SessionEvent[] {
    const { agentThreadId: threadId, agentPath: path } = activity;
    const known = this.#workers.get(threadId);
    if (activity.kind === "started") {
      if (known) return [];
      this.#remember(threadId, {
        delegationCallId: activity.id,
        path,
        turnStatus: null,
        finalText: null,
        phase: "running",
      });
      return [
        {
          type: "worker_started",
          runtimeTaskId: threadId,
          delegationCallId: activity.id,
          // Codex encrypts the task it hands a worker agent, so its path's last part, the task name, describes it.
          description: path.slice(path.lastIndexOf("/") + 1),
          prompt: "",
          background: true,
          at: now(),
        },
      ];
    }
    if (!known || known.phase === "ended") return [];
    if (activity.kind === "interrupted")
      return [this.#ended({ threadId, worker: known, activity: activity.kind }, now)];
    if (activity.kind !== "completed") return [];
    // Codex may report the end before the worker agent's own turn says how it went; the end then waits for it.
    if (known.turnStatus === null) {
      known.phase = "ending";
      return [];
    }
    return [this.#ended({ threadId, worker: known, activity: activity.kind }, now)];
  }

  #ended(
    { threadId, worker, activity }: { threadId: string; worker: Worker; activity: string },
    now: () => string,
  ): SessionEvent {
    worker.phase = "ended";
    return {
      type: "worker_ended",
      runtimeTaskId: threadId,
      delegationCallId: worker.delegationCallId,
      end: workerEndOf(activity, worker.turnStatus),
      runtimeStatus: worker.turnStatus ?? activity,
      summary: worker.finalText === null ? null : redactString(worker.finalText),
      at: now(),
    };
  }

  #itemCompleted(params: unknown, now: () => string): SessionEvent[] {
    const known = this.#itemOf(params);
    if (!known) return [];
    const { threadId, item, parent } = known;
    const message = AgentMessageItemSchema.safeParse(item);
    if (message.success) {
      const worker = parent === null ? undefined : this.#workers.get(threadId);
      if (worker) worker.finalText = message.data.text.slice(0, MAX_SUMMARY_CHARS);
      return [{ type: "assistant_message", message: redactValue(item), at: now() }];
    }
    const call = McpToolCallItemSchema.safeParse(item);
    if (!call.success) return [];
    const failed = call.data.status === "failed";
    return [
      {
        type: "tool_result",
        runtimeCallId: call.data.id,
        parentCallId: parent,
        isError: failed,
        content: redactValue(
          call.data.result?.content ?? (failed ? (call.data.error?.message ?? null) : null),
        ),
        raw: redactValue(item),
        at: now(),
      },
    ];
  }

  #delta(params: unknown, now: () => string): SessionEvent[] {
    const parsed = AgentMessageDeltaSchema.safeParse(params);
    if (!parsed.success || parsed.data.delta === "") return [];
    const parent = this.#parentOf(parsed.data.threadId);
    if (parent === undefined) return [];
    return [{ type: "text_delta", text: parsed.data.delta, parentCallId: parent, at: now() }];
  }

  /** Remembers a worker agent, forgetting the oldest ended one once MAX_REMEMBERED_WORKERS are known. */
  #remember(threadId: string, worker: Worker): void {
    this.#workers.set(threadId, worker);
    if (this.#workers.size <= MAX_REMEMBERED_WORKERS) return;
    const oldestEnded = [...this.#workers].find(([, known]) => known.phase === "ended")?.[0];
    if (oldestEnded !== undefined) this.#workers.delete(oldestEnded);
  }
}
