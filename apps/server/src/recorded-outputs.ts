import type { HookEvidence } from "@mia/agent-adapter";
import { mcpPayload, type ArtifactKind } from "@mia/records";
import { captureFields, type DeclaredArtifact, type Retention } from "./artifact-capture.ts";
import type { ConversationDraft, EventLinks } from "./conversation-draft.ts";
import { MCP_BODY_EVENT, type McpBody } from "./mcp-bodies.ts";

// What a transition records of the outputs the boundary read before deciding it: a tool output a result declared,
// the MCP bodies debug mode reads for a call, and the runtime's transcript and hook evidence when its session ends.

/** A tool output a tool result declared, and what reading and storing it produced at the boundary. */
export interface CapturedOutput {
  declared: DeclaredArtifact;
  retention: Retention;
}

/**
 * Record a declared tool output whatever its capture status, with the tool result `resultEventId` that declared it.
 * Only a retained output becomes a task output and gets an artifact_registered event.
 */
export const registerToolOutput = (
  draft: ConversationDraft,
  input: {
    output: CapturedOutput;
    links: { taskId: string; executionId: string };
    callId: string;
    resultEventId: string;
  },
): void => {
  const { output, links, callId, resultEventId } = input;
  const { declared, retention } = output;
  const conversationId = draft.draft.id;
  const artifactId = draft.id("art");
  draft.write(
    {
      kind: "register_artifact",
      input: {
        id: artifactId,
        createdAt: draft.at,
        kind: "tool_output",
        logicalName: declared.name ?? declared.path,
        mimeType: declared.mimeType ?? "application/octet-stream",
        producerExecutionId: links.executionId,
        producerEventId: resultEventId,
        originalPath: declared.path,
        externalLocator: retention.status === "retained" ? null : declared.path,
        ...captureFields(retention),
      },
    },
    {
      kind: "link_artifact",
      input: {
        id: draft.id("link"),
        conversationId,
        artifactId,
        relation: "tool_result",
        toolCallId: callId,
        taskId: links.taskId,
      },
    },
  );
  if (retention.status !== "retained") return;
  draft.write({
    kind: "link_artifact",
    input: {
      id: draft.id("link"),
      conversationId,
      artifactId,
      relation: "task_output",
      taskId: links.taskId,
    },
  });
  draft.record(
    "artifact_registered",
    {
      artifact_id: artifactId,
      tool_call_id: callId,
      digest: retention.stored.digest,
      size: retention.stored.byteCount,
      original_path: declared.path,
    },
    { ...links, id: draft.id("evt"), causedBy: resultEventId },
  );
};

/** Record the MCP bodies debug mode read for call `call`, under it. */
export const recordBodies = (
  draft: ConversationDraft,
  input: {
    bodies: readonly McpBody[];
    call: { id: string; runtimeCallId: string };
    links: EventLinks;
  },
): void => {
  for (const body of input.bodies)
    draft.record(
      MCP_BODY_EVENT[body.direction],
      mcpPayload({ toolCallId: input.call.id, runtimeCallId: input.call.runtimeCallId }, body),
      { ...input.links, id: draft.id("evt") },
    );
};

/** A file a session's runtime wrote that its end retains, with what storing it produced; null when absent. */
export interface SessionFile {
  name: string;
  originalPath: string;
  retention: Retention;
}

/** Record a session's retained file as runtime evidence of the conversation, linked under the session's execution. */
export const registerSessionFile = (
  draft: ConversationDraft,
  input: { file: SessionFile; kind: ArtifactKind; executionId: string },
): void => {
  const { file } = input;
  const artifactId = draft.id("art");
  draft.write(
    {
      kind: "register_artifact",
      input: {
        id: artifactId,
        createdAt: draft.at,
        kind: input.kind,
        logicalName: file.name,
        mimeType: "application/x-ndjson",
        producerExecutionId: input.executionId,
        originalPath: file.originalPath,
        ...captureFields(file.retention),
      },
    },
    {
      kind: "link_artifact",
      input: {
        id: draft.id("link"),
        conversationId: draft.draft.id,
        artifactId,
        relation: "runtime_transcript",
      },
    },
  );
};

/** The effective effort levels the manager agent's own hook records report, distinct, in order. */
export const managerEffortLevels = (evidence: HookEvidence): string[] => {
  const levels = evidence.records
    .filter((record) => record.agent_id === null || record.agent_id === undefined)
    .map((record) => {
      const { effort } = record;
      if (typeof effort === "string") return effort;
      if (typeof effort === "object" && effort !== null && "level" in effort)
        return typeof effort.level === "string" ? effort.level : null;
      return null;
    });
  return [...new Set(levels.filter((level): level is string => level !== null))];
};
