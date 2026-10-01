// Claude Code PreToolUse hook for Mia's tool gate (see gate.ts): posts the hook input to the gate, waits for Mia's
// decision, and prints it as the hook's permission decision. It appends each hook input to the evidence file. It never
// lets a call through without Mia: any failure blocks the call (exit code 2), because a hook that merely fails lets
// the runtime run a tool that needs no permission, such as the manager agent's Task (capability record, D2 addendum).
// Plain JS so the runtime can execute it without a TS loader.
import { appendFileSync } from "node:fs";
import { request } from "node:http";
import { Command } from "commander";

/** The most hook input it reads: past this the call is blocked rather than buffered. */
const MAX_INPUT_BYTES = 1024 * 1024;

const block = (reason) => {
  process.stderr.write(`Mia blocked this call: ${reason}\n`);
  process.exit(2);
};
process.on("uncaughtException", (error) =>
  block(error instanceof Error ? error.message : String(error)),
);

const { gate, evidence } = new Command()
  .requiredOption("--gate <url>", "the tool gate to ask")
  .requiredOption("--evidence <file>", "where each hook input is appended")
  .exitOverride(() => block("the hook was started without its gate"))
  .parse()
  .opts();

// Claude Code starts each hook in a process group of its own, so killing the runtime's group leaves this hook running.
// Once the runtime is gone (this process is re-parented), the call it asked about can no longer run: stop waiting,
// which closes the request, so Mia sees the held call abandoned.
const runtimePid = process.ppid;
setInterval(() => {
  if (process.ppid !== runtimePid) process.exit(0);
}, 250).unref();

const decide = (decision, reason) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
};

const recordEvidence = (parsed) => {
  try {
    appendFileSync(
      evidence,
      JSON.stringify({
        received_at: new Date().toISOString(),
        hook_event_name: parsed.hook_event_name,
        session_id: parsed.session_id,
        tool_name: parsed.tool_name,
        tool_use_id: parsed.tool_use_id,
        agent_id: parsed.agent_id ?? null,
        agent_type: parsed.agent_type ?? null,
        effort: parsed.effort,
        model: parsed.model,
        env_claude_effort: process.env.CLAUDE_EFFORT ?? null,
      }) + "\n",
    );
  } catch {
    // Evidence is best effort; the decision does not depend on it.
  }
};

const chunks = [];
let size = 0;
process.stdin.on("data", (chunk) => {
  size += chunk.length;
  if (size > MAX_INPUT_BYTES) block("its hook input is larger than Mia reads");
  chunks.push(chunk);
});
process.stdin.on("end", () => {
  const data = Buffer.concat(chunks).toString("utf8");
  recordEvidence(JSON.parse(data));
  // node:http, not fetch: fetch gives up on a response after 300s, and a held approval can wait far longer.
  const post = request(
    gate,
    { method: "POST", headers: { "content-type": "application/json" } },
    (response) => {
      const body = [];
      response.on("data", (chunk) => body.push(chunk));
      response.on("end", () => {
        const answer = JSON.parse(Buffer.concat(body).toString("utf8"));
        if (answer.behavior === "allow") decide("allow", "Mia allowed this call.");
        else
          decide(
            "deny",
            typeof answer.message === "string" ? answer.message : "Mia denied this call.",
          );
      });
    },
  );
  post.on("error", (error) => block(`Mia could not be asked: ${error.message}`));
  post.end(data);
});
