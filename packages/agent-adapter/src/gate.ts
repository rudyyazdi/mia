import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage } from "@mia/protocol";

/**
 * The tool gate: Claude Code runs Mia's PreToolUse hook (`gate-hook.mjs`) before every tool call, from the
 * manager agent and from every worker agent, background ones included, and the hook asks this server what to do.
 * It exists because a background worker agent never reaches `--permission-prompt-tool`: the runtime denies any of
 * its calls that would prompt (see the capability record). The hook blocks until Mia decides, so a held approval
 * holds only the worker agent that asked.
 *
 * capability record: https://github.com/rudyyazdi/mia/pull/202#issuecomment-5922737456
 */

export const GATE_HOOK_PATH = join(import.meta.dirname, "gate-hook.mjs");

/** Largest hook payload the gate reads; a bigger one is refused, and the hook then denies the call. */
export const MAX_GATE_PAYLOAD_BYTES = 1024 * 1024;

/** The PreToolUse hook input observed from Claude Code 2.1.283; extra fields are retained raw. */
const GatePayloadSchema = z
  .object({
    tool_name: z.string(),
    tool_input: z.unknown().optional(),
    tool_use_id: z.string().optional(),
    /** Set for a call from a subagent: the id the runtime also reports as that subagent's `task_id`. */
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
  })
  .passthrough();

/** One tool call the runtime is about to make, as the gate hands it to Mia. */
export interface GateRequest {
  toolName: string;
  input: unknown;
  /** Runtime call identity; undefined if the runtime did not supply one (then the call must be denied). */
  toolUseId: string | undefined;
  /** The worker agent making the call, by the runtime's task id, or null for the manager agent's own call. */
  agentId: string | null;
  agentType: string | null;
  raw: unknown;
  receivedAt: string;
  /** Aborts when the hook goes away before a decision: the runtime was killed or dropped the call. */
  abandoned: AbortSignal;
}

export type GateDecision = { behavior: "allow" } | { behavior: "deny"; message: string };

export type GateHandler = (request: GateRequest) => Promise<GateDecision>;

const respond = (response: ServerResponse, decision: GateDecision): void => {
  if (response.writableEnded) return;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(decision));
};

/** Reads a request body up to `limit` bytes; resolves null when it is bigger. */
const readBody = async (request: IncomingMessage, limit: number): Promise<string | null> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size > limit) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
};

/**
 * Loopback HTTP server the gate hook calls, at a path holding a random token so no other local process can decide
 * calls. Without a handler it denies: no decision is ever inferred.
 */
export class ToolGate {
  private handler: GateHandler | null = null;
  private server: Server | null = null;
  private readonly token = randomBytes(24).toString("hex");

  get url(): string {
    const address = this.server?.address();
    if (!address || typeof address === "string") throw new Error("gate not started");
    const { port }: AddressInfo = address;
    return `http://127.0.0.1:${port}/gate/${this.token}`;
  }

  setHandler(handler: GateHandler | null): void {
    this.handler = handler;
  }

  /** Clears `handler` if it is still the one set, so a session that ended cannot clear its successor's. */
  clearHandler(handler: GateHandler): void {
    if (this.handler === handler) this.handler = null;
  }

  async start(): Promise<string> {
    const server = createServer((request, response) => {
      this.serve(request, response).catch((error: unknown) =>
        respond(response, {
          behavior: "deny",
          message: `Mia could not evaluate this call: ${errorMessage(error)}`,
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    this.server = server;
    return this.url;
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== `/gate/${this.token}`) {
      response.writeHead(404).end();
      return;
    }
    const receivedAt = new Date().toISOString();
    const abandoned = new AbortController();
    response.once("close", () => {
      if (!response.writableEnded) abandoned.abort();
    });
    const body = await readBody(request, MAX_GATE_PAYLOAD_BYTES);
    if (body === null) {
      respond(response, { behavior: "deny", message: "Mia refused an oversized tool call." });
      return;
    }
    const parsed = GatePayloadSchema.safeParse(parseJson(body));
    if (!parsed.success) {
      respond(response, {
        behavior: "deny",
        message: `Mia rejected a malformed tool call: ${parsed.error.message.slice(0, 200)}`,
      });
      return;
    }
    const handler = this.handler;
    if (!handler) {
      respond(response, {
        behavior: "deny",
        message: "Mia has no conversation accepting tool calls.",
      });
      return;
    }
    const decision = await handler({
      toolName: parsed.data.tool_name,
      input: parsed.data.tool_input ?? {},
      toolUseId: parsed.data.tool_use_id,
      agentId: parsed.data.agent_id ?? null,
      agentType: parsed.data.agent_type ?? null,
      raw: parsed.data,
      receivedAt,
      abandoned: abandoned.signal,
    });
    respond(response, decision);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    server.close();
    await once(server, "close").catch(() => undefined);
  }
}

/** The body as JSON, or undefined when it is not JSON (the schema then refuses it). */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
