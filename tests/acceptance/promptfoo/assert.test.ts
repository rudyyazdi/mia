import { describe, expect, it } from "vitest";
import assertScenario from "./assert.ts";
import type { ScenarioName } from "./scenarios.ts";

/** Provider output as JSON would carry it: deliberately untyped, so a test can send a shape the schema refuses. */
const evidenceFor = (
  scenario: ScenarioName,
  overrides: Record<string, unknown>,
): Record<string, unknown> => ({
  scenario,
  profile: "fixture-test",
  conversation_id: "conversation",
  tasks: [],
  replies: [],
  decisions: [],
  ledger_after: { counter: 0, commits: [], returned: [], entered: [], kinds: {} },
  events: [],
  notes: [],
  live: true,
  ...overrides,
});

const judge = (scenario: ScenarioName, evidence: Record<string, unknown>) =>
  assertScenario(JSON.stringify(evidence), { vars: { scenario } });

describe("scenario assertion", () => {
  it("reads ledger kinds by their declared names and refuses an undeclared one", () => {
    const interrupted = (kinds: Record<string, number>) =>
      evidenceFor("interrupt-all", {
        tasks: [{ task_id: "task", status: "interrupted" }],
        ledger_after: {
          counter: 0,
          commits: [],
          returned: [],
          entered: [{ tool: "slow", call_id: "call" }],
          kinds,
        },
        events: [{ type: "interruption_outcome", sequence: 1, payload: { actions: [] } }],
      });
    expect(judge("interrupt-all", interrupted({ entered: 1, cancelled: 1 })).pass).toBe(true);
    expect(judge("interrupt-all", interrupted({ entered: 1 })).reason).toBe(
      "slow action was not cancelled in the ledger",
    );
    expect(judge("interrupt-all", interrupted({ entered: 1, canceled: 1 })).reason).toMatch(
      /^provider output does not match the evidence shape/,
    );
  });

  it("fails a scenario whose decision the server refused or never answered, or whose task never ended", () => {
    const approveReject = (second: Record<string, unknown>) =>
      evidenceFor("approve-reject", {
        decisions: [
          {
            approval_id: "first",
            task_id: "task",
            tool: "mcp__fixture__change",
            decision: "approve",
            ack: { disposition: "accepted" },
            ledger_commits_at_request: 0,
          },
          {
            approval_id: "second",
            task_id: "task",
            tool: "mcp__fixture__change",
            decision: "reject",
            ledger_commits_at_request: 1,
            ...second,
          },
        ],
        ledger_after: {
          counter: 1,
          commits: [{ tool: "change", call_id: "call" }],
          returned: [],
          entered: [],
          kinds: { committed: 1 },
        },
      });
    const accepted = { ack: { disposition: "accepted" } };
    expect(judge("approve-reject", approveReject(accepted)).pass).toBe(true);
    expect(
      judge(
        "approve-reject",
        approveReject({ ack: { disposition: "rejected", code: "invalid_state" } }),
      ).reason,
    ).toBe("decisions not accepted: reject second rejected:invalid_state");
    expect(judge("approve-reject", approveReject({})).reason).toBe(
      "decisions not accepted: reject second unanswered",
    );
    expect(
      judge("approve-reject", {
        ...approveReject(accepted),
        tasks: [{ task_id: "task", status: "running" }],
      }).reason,
    ).toBe("tasks never ended: task");
  });
});
