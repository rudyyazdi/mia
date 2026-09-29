// Claude Code PreToolUse hook for Mia's tool gate (see gate.ts): posts the hook input to the gate URL given as
// argv[2], waits for Mia's decision, and prints it as the hook's permission decision. It appends each hook input to
// the evidence file given as argv[3], as hook-capture.mjs does, and denies whenever it cannot get a decision. Plain
// JS so the runtime can execute it without a TS loader.
import { appendFileSync } from "node:fs";
import { request } from "node:http";

const [gateUrl, evidence] = process.argv.slice(2);

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

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", () => {
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    decide("deny", "Mia could not read this tool call.");
    return;
  }
  if (evidence) {
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
      // Evidence is best effort; the decision below does not depend on it.
    }
  }
  // node:http, not fetch: fetch gives up on a response after 300s, and a held approval can wait far longer.
  const post = request(
    gateUrl,
    { method: "POST", headers: { "content-type": "application/json" } },
    (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => {
        try {
          const answer = JSON.parse(body);
          if (answer.behavior === "allow") decide("allow", "Mia allowed this call.");
          else
            decide(
              "deny",
              typeof answer.message === "string" ? answer.message : "Mia denied this call.",
            );
        } catch {
          decide("deny", "Mia sent no readable decision for this call.");
        }
      });
    },
  );
  post.on("error", (error) => decide("deny", `Mia could not decide this call: ${error.message}`));
  post.end(data);
});
