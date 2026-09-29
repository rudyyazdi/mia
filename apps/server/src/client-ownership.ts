import type { ClientCommand } from "@mia/protocol";
import type { NewId, RecordWriter } from "@mia/records";
import type { Origin } from "./engine-effects.ts";

/**
 * Which client owns the active conversation, and which of its connections the conversation's events reach. A start
 * sets both (`activate`); a disconnect clears the connection; while none is active, a client's command adopts its own,
 * if no other client owns the conversation (`adopt`). One conversation, one active client, in D1 and D2 alike.
 */
export class ClientOwnership {
  connectionId: string | null = null;
  clientId: string | null = null;

  /** The client and connection a transition decided now records its events under. */
  get origin(): Origin {
    return { clientId: this.clientId, connectionId: this.connectionId };
  }

  activate(origin: Origin): void {
    this.connectionId = origin.connectionId;
    this.clientId = origin.clientId;
  }

  /** A reconnecting client (same client id) may resume ownership when no other connection is active. */
  adopt(connectionId: string, clientId: string): boolean {
    if (this.connectionId === null && (this.clientId === null || this.clientId === clientId)) {
      this.activate({ connectionId, clientId });
      return true;
    }
    return false;
  }

  /** Why the client on `connectionId` may not act on the conversation now, or null, adopting its connection if free. */
  refusal(connectionId: string, clientId: string): string | null {
    if (this.connectionId && this.connectionId !== connectionId)
      return "another client owns the active conversation";
    if (!this.connectionId && !this.adopt(connectionId, clientId))
      return "the conversation belongs to another client";
    return null;
  }

  /** Clears the active connection if it is `connectionId`; returns whether it was. */
  disconnect(connectionId: string): boolean {
    if (this.connectionId !== connectionId) return false;
    this.connectionId = null;
    return true;
  }
}

/** Records a client's heartbeat: the connection is touched, and a diagnostics row notes the state it reported. */
export const recordHeartbeat = (input: {
  writer: RecordWriter;
  newId: NewId;
  now: () => Date;
  from: { clientId: string; connectionId: string };
  conversationId: string | null;
  payload: Extract<ClientCommand, { type: "heartbeat" }>["payload"];
}): void => {
  const { writer, from, payload } = input;
  writer.touchConnection(from.connectionId);
  writer.recordDiagnostics({
    id: input.newId("diag"),
    receivedAt: input.now().toISOString(),
    conversationId: input.conversationId,
    clientId: from.clientId,
    clientConnectionId: from.connectionId,
    eventId: null,
    capturedAt: payload.captured_at,
    state: { heartbeat: true, connection_state: payload.connection_state },
  });
};
