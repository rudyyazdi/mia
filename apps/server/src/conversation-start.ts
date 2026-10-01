import { conversationDirectory } from "@mia/records";
import type { ConversationDraft } from "./conversation-draft.ts";
import type { ConversationState } from "./conversation-state.ts";
import type { Origin } from "./engine-effects.ts";
import { provenanceLinks, provenanceRecords, type NamedProvenancePlan } from "./provenance.ts";

/** The ids a conversation start records, drawn before it is decided. */
export interface StartIds {
  conversation: string;
  runtimeConversation: string;
  provenanceRecorded: string;
  started: string;
  captured: string;
}

/** What a conversation's state begins with: what its start's records name. */
export interface StartedConversation {
  id: string;
  runtimeConversationId: string;
  provenanceSetId: string;
  directory: string;
}

/**
 * Build a conversation's start into `draft`: its provenance rows, the conversation that names them and its links to
 * them, the close of the conversation it replaces, the state `stateOf` builds from the new conversation, its
 * activation for `start.origin`'s client, then its provenance_recorded and conversation_started events, and in debug
 * mode captured_in_debug_mode, all in one commit.
 */
export const buildConversationStart = (input: {
  draft: ConversationDraft;
  start: {
    origin: Origin;
    ids: StartIds;
    provenance: NamedProvenancePlan;
    closes: string | null;
    conversationsRoot: string;
    debugMode: boolean;
  };
  stateOf: (conversation: StartedConversation) => ConversationState;
}): void => {
  const { draft, start } = input;
  const { ids, provenance: plan } = start;
  const startedAt = draft.at;
  const { records: provenanceRows, summary: provenance } = provenanceRecords(plan, startedAt);
  const conversationId = ids.conversation;
  draft.write(...provenanceRows, {
    kind: "create_conversation",
    input: {
      id: conversationId,
      startedAt,
      provenanceSetId: provenance.provenance_set_id,
      runtimeConversationId: ids.runtimeConversation,
    },
  });
  draft.write(...provenanceLinks({ conversationId, plan }));
  if (start.closes !== null)
    draft.write({ kind: "update_conversation", id: start.closes, fields: { status: "closed" } });
  draft.advance(
    input.stateOf({
      id: conversationId,
      runtimeConversationId: ids.runtimeConversation,
      provenanceSetId: provenance.provenance_set_id,
      directory: conversationDirectory({
        root: start.conversationsRoot,
        id: conversationId,
        startedAt,
      }),
    }),
  );
  draft.effect({ kind: "activate_conversation", origin: start.origin });
  draft.record("provenance_recorded", provenance, { id: ids.provenanceRecorded });
  draft.emit(
    {
      type: "conversation_started",
      payload: {
        conversation_id: conversationId,
        started_at: startedAt,
        provenance_set_id: provenance.provenance_set_id,
      },
    },
    { id: ids.started },
  );
  // After conversation_started, so that event keeps the sequence it has with debug mode off.
  if (start.debugMode) draft.record("captured_in_debug_mode", {}, { id: ids.captured });
};
