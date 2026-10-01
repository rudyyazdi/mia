import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ObjectStore,
  exportConversationSync,
  reconcileObjectsSync,
  snapshotConversation,
  verifyExportSync,
} from "@mia/records";
import type { MiaClient } from "@mia/text-client";
import { must, turnWithWorker, useScripted, type Scripted, type TestServer } from "./harness.ts";

let scripted: Scripted;
let ts: TestServer;
let client: MiaClient;
useScripted((started) => {
  scripted = started;
  ({ server: ts, client } = started);
});

const ExportedArtifactRow = z.object({ logical_name: z.string(), object_digest: z.string() });
const ExportedEventRow = z.object({ sequence: z.number() });
const jsonLines = <T>(path: string, schema: z.ZodType<T>): T[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => schema.parse(JSON.parse(line)));

/** Build a conversation containing every evidence type the record must hold. */
const richConversation = async (): Promise<{ conversationId: string; artifactFile: string }> => {
  const outDir = must(ts.profile.runtime.outputDirectories[0], "output directory");
  mkdirSync(outDir, { recursive: true });
  const artifactFile = join(outDir, "result.txt");
  writeFileSync(artifactFile, "D1");
  // task 1: a reply, an approved, a rejected and an output-declaring call, and a call no policy lists
  const session = await turnWithWorker(scripted, { text: "do things", runtimeTaskId: "a1" });
  await session.reply(
    "Working on it. secret sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 leaked?",
  );
  const decide = async (
    call: { toolName: string; input: unknown; toolUseId: string; agentId?: string },
    decision: "approve" | "reject",
  ) => {
    const { toolUseId } = call;
    const answer = session.ask({ ...call, agentId: call.agentId ?? "a1" });
    const requested = await client.waitFor(
      "approval_requested",
      (event) => event.payload.runtime_call_id === toolUseId,
    );
    await client.decide({
      taskId: requested.payload.task_id,
      approvalId: requested.payload.approval_id,
      decision,
    });
    return answer;
  };
  await decide(
    {
      toolName: "mcp__fixture__change",
      input: { delta: 1, token: "super-secret-value-123456" },
      toolUseId: "toolu_1",
    },
    "approve",
  );
  await session.toolResult({
    runtimeCallId: "toolu_1",
    workerTaskId: "a1",
    content: JSON.stringify({ counter: 1 }),
  });
  await decide(
    { toolName: "mcp__fixture__change", input: { delta: 1 }, toolUseId: "toolu_2" },
    "reject",
  );
  await decide(
    {
      toolName: "mcp__fixture__artifact",
      input: { name: "result.txt", text: "D1" },
      toolUseId: "toolu_3",
    },
    "approve",
  );
  await session.toolResult({
    runtimeCallId: "toolu_3",
    workerTaskId: "a1",
    content: JSON.stringify({
      artifact: { path: artifactFile, name: "result.txt", mime_type: "text/plain" },
    }),
  });
  await session.ask({ toolName: "mcp__fixture__mystery", toolUseId: "toolu_4", agentId: "a1" });
  await session.endWorker("a1");
  await session.endTurn();
  await client.waitFor("task_finished");
  await client.sendDiagnostics();
  // task 2: interruption with an in-flight action
  await session.beginTurn();
  await session.delegate("a2");
  await decide(
    {
      toolName: "mcp__fixture__slow",
      input: { mode: "uncancellable" },
      toolUseId: "toolu_5",
      agentId: "a2",
    },
    "approve",
  );
  await client.interruptAll();
  await client.waitFor("interruption_outcome");
  return { conversationId: must(client.conversationId, "conversation id"), artifactFile };
};

describe("records, report and export", () => {
  it("produces one report covering streamed output, approvals, interruption, errors, diagnostics, a generated file and provenance; exports and verifies offline; survives source edits", async () => {
    const { conversationId, artifactFile } = await richConversation();
    const exportDir = join(ts.dir, "export-1");
    const catalog = ts.catalog();
    const snapshot = snapshotConversation(catalog, conversationId);
    expect(snapshot.tables.tasks).toHaveLength(2);
    expect(snapshot.tables.events.some((event) => event.type === "reply_delta")).toBe(true);
    expect(snapshot.tables.approvals.map((approval) => approval.status).sort()).toEqual([
      "approved",
      "approved",
      "approved",
      "rejected",
    ]);
    expect(snapshot.tables.events.some((event) => event.type === "interruption_outcome")).toBe(
      true,
    );
    expect(snapshot.tables.tool_calls).toContainEqual(
      expect.objectContaining({ tool_identity: "mcp__fixture__mystery", status: "denied" }),
    );
    expect(snapshot.tables.diagnostics.length).toBeGreaterThan(0);
    expect(snapshot.tables.events.some((event) => event.type === "runtime_result")).toBe(true);
    expect(
      snapshot.tables.artifacts.some(
        (artifact) => artifact.kind === "tool_output" && artifact.capture_status === "retained",
      ),
    ).toBe(true);
    expect(
      snapshot.tables.provenance_entries.some(
        (entry) =>
          (entry.role === "agent_prompt" || entry.role === "worker_prompt") &&
          entry.availability === "retained",
      ),
    ).toBe(true);
    expect(
      snapshot.tables.provenance_entries.some(
        (entry) => entry.role === "runtime_instructions" && entry.availability === "unavailable",
      ),
    ).toBe(true);
    // Seeded credentials never reach the records.
    const dump = JSON.stringify(snapshot.tables);
    expect(dump).not.toContain("sk-ant-api03");
    expect(dump).not.toContain("super-secret-value-123456");
    const result = exportConversationSync(catalog, conversationId, exportDir);
    catalog.close();
    expect(result.manifest.complete).toBe(true);
    const verification = verifyExportSync(exportDir);
    expect(verification.problems).toEqual([]);
    const report = readFileSync(join(exportDir, "report.html"), "utf8");
    expect(report).toContain("partial output");
    expect(report).not.toContain("sk-ant-api03");
    // Edit the original generated file and the prompt after export: retained bytes still verify.
    writeFileSync(artifactFile, "changed later");
    writeFileSync(ts.profile.runtime.agentPromptFile, "edited prompt");
    expect(verifyExportSync(exportDir).ok).toBe(true);
    const artifacts = jsonLines(join(exportDir, "records/artifacts.jsonl"), ExportedArtifactRow);
    const retained = must(
      artifacts.find((artifact) => artifact.logical_name === "result.txt"),
      "retained artifact",
    );
    expect(
      readFileSync(
        join(
          exportDir,
          "objects/sha256",
          retained.object_digest.slice(0, 2),
          retained.object_digest,
        ),
        "utf8",
      ),
    ).toBe("D1");
  });

  it("exports from one consistent snapshot: events written during export do not leak", async () => {
    const session = await turnWithWorker(scripted, { text: "stream", runtimeTaskId: "a1" });
    const delivered = (text: string) =>
      client.waitFor("reply_delta", (event) => event.payload.text === text);
    await session.reply("a");
    await delivered("a");
    const catalog = ts.catalog();
    const conversationId = must(client.conversationId, "conversation id");
    const before = snapshotConversation(catalog, conversationId).cutoff_sequence;
    // Write more events while exporting: the export must stop at its own cutoff.
    await session.reply("b");
    await session.reply("c");
    await delivered("c");
    const exportDir = join(ts.dir, "export-2");
    const result = exportConversationSync(catalog, conversationId, exportDir);
    catalog.close();
    expect(result.manifest.cutoff_sequence).toBeGreaterThanOrEqual(before);
    const events = jsonLines(join(exportDir, "events.jsonl"), ExportedEventRow);
    expect(Math.max(...events.map((event) => event.sequence))).toBe(
      result.manifest.cutoff_sequence,
    );
    const started = await client.waitFor("task_started");
    expect(result.manifest.ongoing_tasks).toEqual([started.payload.task_id]);
    const report = readFileSync(join(exportDir, "report.html"), "utf8");
    expect(report).toContain("ongoing tasks at cutoff");
    await session.endWorker("a1");
    await client.waitFor("task_finished");
    expect(verifyExportSync(exportDir).ok).toBe(true);
  });

  it("exports the prompt object two conversations share without the other conversation's records", async () => {
    const first = must(client.conversationId, "conversation id");
    const session = await turnWithWorker(scripted, { text: "first conversation text" });
    await session.reply("first answer");
    await session.endTurn();
    // Second conversation from the same client shares the prompt snapshot (same bytes -> same object).
    const second = await client.startConversation();
    expect(second).not.toBe(first);
    const session2 = await turnWithWorker(scripted, { text: "UNRELATED-SECOND-TEXT" });
    await session2.reply("UNRELATED-SECOND-ANSWER");
    await session2.endTurn();
    await client.waitFor("turn_finished", (event) => event.payload.conversation_id === second);
    const catalog = ts.catalog();
    const promptDigest = must(
      catalog.get<{ object_digest: string }>(
        "SELECT a.object_digest FROM artifacts a JOIN provenance_entries p ON p.artifact_id = a.id WHERE p.role = 'agent_prompt' LIMIT 1",
      ),
      "agent prompt artifact",
    ).object_digest;
    const exportDir = join(ts.dir, "export-3");
    const result = exportConversationSync(catalog, first, exportDir);
    catalog.close();
    expect(result.manifest.complete).toBe(true);
    const all =
      readFileSync(join(exportDir, "events.jsonl"), "utf8") +
      readFileSync(join(exportDir, "records/tasks.jsonl"), "utf8") +
      readFileSync(join(exportDir, "report.html"), "utf8");
    expect(all).not.toContain("UNRELATED-SECOND");
    expect(
      existsSync(join(exportDir, "objects/sha256", promptDigest.slice(0, 2), promptDigest)),
    ).toBe(true);
    expect(result.manifest.record_counts.conversations).toBe(1);
  });

  it("detects missing and corrupt objects, labels the export partial, and reconciles orphans", async () => {
    await richConversation();
    const catalog = ts.catalog();
    const store = new ObjectStore(catalog.paths);
    const artifact = must(
      catalog.get<{ object_digest: string }>(
        "SELECT object_digest FROM artifacts WHERE logical_name = 'result.txt'",
      ),
      "result.txt artifact",
    );
    const path = store.pathFor(artifact.object_digest);
    rmSync(path, { force: true });
    // Orphan object: bytes published without a catalog row (simulated crash between publish and commit).
    const orphan = await store.put(Buffer.from("orphan bytes"), {
      signal: new AbortController().signal,
    });
    // Corrupt a provenance object.
    const prov = must(
      catalog.get<{ object_digest: string }>(
        "SELECT a.object_digest FROM artifacts a JOIN provenance_entries p ON p.artifact_id = a.id WHERE p.role = 'configuration'",
      ),
      "configuration provenance artifact",
    );
    const provPath = store.pathFor(prov.object_digest);
    const { chmodSync } = await import("node:fs");
    chmodSync(provPath, 0o600);
    writeFileSync(provPath, "corrupted");
    const reconciled = reconcileObjectsSync(catalog);
    expect(reconciled.orphans).toContain(orphan.digest);
    expect(reconciled.missing).toContain(artifact.object_digest);
    expect(reconciled.corrupt).toContain(prov.object_digest);
    const exportDir = join(ts.dir, "export-4");
    const result = exportConversationSync(
      catalog,
      must(client.conversationId, "conversation id"),
      exportDir,
    );
    catalog.close();
    expect(result.manifest.complete).toBe(false);
    expect(result.manifest.objects.missing).toEqual([artifact.object_digest]);
    expect(result.manifest.objects.corrupt).toEqual([prov.object_digest]);
    expect(result.manifest.partial_reasons.length).toBe(2);
    const verification = verifyExportSync(exportDir);
    expect(verification.ok).toBe(true); // internally consistent
    expect(verification.complete).toBe(false); // but explicitly incomplete
    const report = readFileSync(join(exportDir, "report.html"), "utf8");
    expect(report).toContain("missing");
    expect(report).toContain("corrupt");
  });
});
