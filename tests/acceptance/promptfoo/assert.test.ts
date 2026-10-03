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

  describe("set-and-deduct", () => {
    const deduct = { delta: -1 };
    const expected = [{ value: 0 }, { value: 0 }, deduct, deduct];
    const decision = (taskId: string, verdict: "approve" | "reject") => ({
      approval_id: `approval-${taskId}`,
      task_id: taskId,
      tool: "mcp__fixture__change",
      decision: verdict,
      ack: { disposition: "accepted" },
      ledger_commits_at_request: 0,
    });
    const reply = (taskIds: string[], text: string) => ({
      turn_id: `turn-${taskIds.join("-")}`,
      cause: "task_end",
      task_ids: taskIds,
      text,
    });
    const deducted = reply(["approved"], "Deducted 1; the tool returned -1.");
    const refused = reply(["rejected"], "My call did not change the counter: it was rejected.");
    /** The deduction phase: task `approved` committed its call, task `rejected` had its call denied. */
    const setAndDeduct = (
      replies: Record<string, unknown>[],
      changes: Record<string, number>[] = expected,
    ) =>
      evidenceFor("set-and-deduct", {
        decisions: [decision("approved", "approve"), decision("rejected", "reject")],
        events: [
          ...changes.map((args) => ({
            type: "approval_requested",
            sequence: 1,
            payload: { redacted_arguments: args },
          })),
          { type: "tool_call", sequence: 2, payload: { task_id: "approved", status: "completed" } },
          { type: "tool_call", sequence: 3, payload: { task_id: "rejected", status: "denied" } },
        ],
        replies,
        ledger_after: {
          counter: -1,
          commits: changes
            .slice(0, 3)
            .map((args, index) => ({ tool: "change", call_id: `call-${index}`, args })),
          returned: [],
          entered: [],
          kinds: {},
        },
      });
    const judged = (replies: Record<string, unknown>[], changes?: Record<string, number>[]) =>
      judge("set-and-deduct", setAndDeduct(replies, changes));

    it("passes a task-scoped report of the rejected deduction, alone or batched with its sibling", () => {
      expect(judged([deducted, refused]).pass).toBe(true);
      expect(
        judged([reply(["approved", "rejected"], `${deducted.text} ${refused.text}`)]).pass,
      ).toBe(true);
    });

    it("fails when no reply reports the rejected deduction's task", () => {
      expect(judged([deducted]).reason).toBe("no reply reported the rejected deduction's task");
    });

    it("fails a report of a denied call that claims the counter's state", () => {
      expect(
        judged([deducted, reply(["rejected"], "The fixture counter was not changed.")]).reason,
      ).toMatch(/^a report of a call that did not run claimed/);
    });

    it("fails a set made as a read plus a delta", () => {
      expect(judged([deducted, refused], [{ delta: -12 }, { value: 0 }, deduct, deduct]).pass).toBe(
        false,
      );
    });
  });
});
