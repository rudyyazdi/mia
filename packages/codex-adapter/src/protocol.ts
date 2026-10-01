import { z } from "zod";
import { readJsonLine, type JsonLine } from "@mia/agent-adapter";

/**
 * The subset of `codex app-server`'s JSON-RPC protocol (Codex 0.159.3) that Mia relies on, written by hand from its
 * generated bindings: only the fields Mia reads are typed, and every message is kept whole, redacted, in the
 * transcript. The server speaks JSON-RPC 2.0 without the `jsonrpc` field, one message per line.
 */

const IdSchema = z.union([z.string(), z.number()]);

const ResponseSchema = z.looseObject({
  id: IdSchema,
  result: z.unknown().optional(),
  error: z.looseObject({ message: z.string() }).optional(),
});
const RequestSchema = z.looseObject({ id: IdSchema, method: z.string(), params: z.unknown() });
const NotificationSchema = z.looseObject({ method: z.string(), params: z.unknown() });

/** One line of the server's output, by what it is: our request's answer, its own request, or a notification. */
export type CodexMessage =
  | { kind: "response"; id: string | number; result: unknown; error: string | null }
  | { kind: "request"; id: string | number; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown };

/** Every line carries what was read of it, so it is retained redacted even when it is no JSON-RPC message. */
export type CodexLine =
  | { ok: true; message: CodexMessage; line: JsonLine }
  | { ok: false; error: string; line: JsonLine };

/** Reads one output line; null for a blank one. A line with a method and an id is a request the server makes. */
export const parseCodexLine = (text: string): CodexLine | null => {
  const line = readJsonLine(text);
  if (!line) return null;
  if (!line.ok) return { ok: false, error: "invalid JSON", line };
  const request = RequestSchema.safeParse(line.json);
  if (request.success) return { ok: true, line, message: { kind: "request", ...request.data } };
  const notification = NotificationSchema.safeParse(line.json);
  if (notification.success)
    return { ok: true, line, message: { kind: "notification", ...notification.data } };
  const response = ResponseSchema.safeParse(line.json);
  if (!response.success) return { ok: false, error: "not a JSON-RPC message", line };
  const { id, result, error } = response.data;
  return {
    ok: true,
    line,
    message: { kind: "response", id, result, error: error?.message ?? null },
  };
};

// ---------------------------------------------------------------- results of Mia's requests

export const ThreadResultSchema = z.looseObject({
  thread: z.looseObject({ id: z.string() }),
  model: z.string(),
});

export const HooksListResultSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      hooks: z.array(
        z.looseObject({
          key: z.string(),
          command: z.string().optional(),
          sourcePath: z.string(),
          currentHash: z.string(),
          // eslint-disable-next-line no-restricted-syntax -- Codex's own trust word, compared with "trusted" only
          trustStatus: z.string(),
          enabled: z.boolean(),
        }),
      ),
    }),
  ),
});
export type HooksList = z.infer<typeof HooksListResultSchema>;

// ---------------------------------------------------------------- notifications

export const TurnStartedSchema = z.looseObject({
  threadId: z.string(),
  turn: z.looseObject({ id: z.string() }),
});

export const TurnCompletedSchema = z.looseObject({
  threadId: z.string(),
  turn: z.looseObject({
    id: z.string(),
    // eslint-disable-next-line no-restricted-syntax -- Codex's own word for how a turn ended, kept as reported
    status: z.string(),
    items: z.array(z.unknown()),
    durationMs: z.number().nullable().optional(),
  }),
});

export const ItemNotificationSchema = z.looseObject({
  threadId: z.string(),
  item: z.looseObject({ type: z.string(), id: z.string() }),
});

export const UserMessageItemSchema = z.looseObject({
  type: z.literal("userMessage"),
  /** The `clientUserMessageId` the turn was started with, which Mia sets to the message's runtime id. */
  clientId: z.string().nullable().optional(),
});

export const AgentMessageItemSchema = z.looseObject({
  type: z.literal("agentMessage"),
  text: z.string(),
});

export const McpToolCallItemSchema = z.looseObject({
  type: z.literal("mcpToolCall"),
  id: z.string(),
  server: z.string(),
  tool: z.string(),
  // eslint-disable-next-line no-restricted-syntax -- Codex's own call status, compared with "failed" only
  status: z.string(),
  arguments: z.unknown(),
  result: z.looseObject({ content: z.unknown() }).nullable().optional(),
  error: z.looseObject({ message: z.string() }).nullable().optional(),
});

/** The manager agent's thread reports each worker agent it starts and each end as one of these. */
export const SubAgentActivityItemSchema = z.looseObject({
  type: z.literal("subAgentActivity"),
  id: z.string(),
  // eslint-disable-next-line no-restricted-syntax -- Codex's own activity word, mapped by the translator
  kind: z.string(),
  agentThreadId: z.string(),
  agentPath: z.string(),
});

export type SubAgentActivityItem = z.infer<typeof SubAgentActivityItemSchema>;

export const AgentMessageDeltaSchema = z.looseObject({
  threadId: z.string(),
  delta: z.string(),
});

export const TokenUsageSchema = z.looseObject({ threadId: z.string(), tokenUsage: z.unknown() });

/** A hook run: its id is `<event>:<index>:<source>:<tool call id>` for a PreToolUse run. */
export const HookRunSchema = z.looseObject({
  threadId: z.string(),
  run: z.looseObject({
    id: z.string(),
    eventName: z.string(),
    // eslint-disable-next-line no-restricted-syntax -- Codex's own run status, compared with "failed" only
    status: z.string(),
    entries: z.array(z.looseObject({ text: z.string() })).default([]),
  }),
});

export const ErrorNotificationSchema = z.looseObject({
  threadId: z.string(),
  error: z.looseObject({ message: z.string() }),
  willRetry: z.boolean(),
});

export const WarningSchema = z.looseObject({ message: z.string() });
