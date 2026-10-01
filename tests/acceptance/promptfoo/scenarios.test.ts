import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import assertScenario from "./assert.ts";
import type { ServerEvent } from "@mia/protocol";
import { quietAfter, readScenarioList, SCENARIOS, ScenarioNameSchema } from "./scenarios.ts";

const declared = [...ScenarioNameSchema.options].toSorted();

describe("live scenario names", () => {
  it("defines every declared scenario exactly once", () => {
    expect(SCENARIOS.map((scenario) => scenario.name).toSorted()).toEqual(declared);
  });

  // promptfoo reads its test list from YAML, so the declared names are checked against it here.
  // `--filter-pattern` selects by description, so each description must be its scenario's name.
  it("runs every declared scenario exactly once from the promptfoo config, described by its name", () => {
    const config = readFileSync(join(import.meta.dirname, "promptfooconfig.yaml"), "utf8");
    const tests = [
      ...config.matchAll(/description: ([\w-]+)\n\s+vars: \{ scenario: ([\w-]+) \}/g),
    ].map((found) => ({ description: found[1], scenario: found[2] }));
    expect(tests.map((test) => test.scenario).toSorted()).toEqual(declared);
    for (const test of tests) expect(test.description).toBe(test.scenario);
  });

  it("fails an assertion for an unknown scenario before reading the output", () => {
    expect(assertScenario("", { vars: { scenario: "alowed" } })).toEqual({
      pass: false,
      score: 0,
      reason: 'unknown scenario "alowed"',
    });
  });

  it("reads a --scenarios list only when every entry is declared", () => {
    expect(readScenarioList("allowed,denied")).toEqual({ ok: true, names: ["allowed", "denied"] });
    const rejected: [value: string, entry: string][] = [
      ["alowed", "alowed"],
      ["allowed,", ""],
      ["", ""],
    ];
    for (const [value, entry] of rejected)
      expect(readScenarioList(value)).toEqual({
        ok: false,
        error: `unknown scenario ${JSON.stringify(entry)}; declared: ${ScenarioNameSchema.options.join(", ")}`,
      });
  });

  it("is quiet only once every task ended and a later turn reported it", () => {
    const at = (type: string, payload: Record<string, unknown> = {}) =>
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a minimal event stream for the decision
      ({
        type,
        sequence: null,
        payload: { conversation_id: "conversation", ...payload },
      }) as unknown as ServerEvent;
    const delegated = [
      at("turn_started", { turn_id: "turn_1" }),
      at("task_started", { task_id: "task_1" }),
      at("turn_finished", { turn_id: "turn_1" }),
    ];
    expect(quietAfter(delegated, 0)).toBe(false);
    const ended = [...delegated, at("task_finished", { task_id: "task_1" })];
    expect(quietAfter(ended, 0)).toBe(false);
    const reporting = [...ended, at("turn_started", { turn_id: "turn_2" })];
    expect(quietAfter(reporting, 0)).toBe(false);
    expect(quietAfter([...reporting, at("turn_finished", { turn_id: "turn_2" })], 0)).toBe(true);
    // An interrupted task ends with its interruption's outcome.
    const interrupted = [
      ...delegated,
      at("interruption_outcome", { task_id: "task_1" }),
      at("turn_started", { turn_id: "turn_2" }),
      at("turn_finished", { turn_id: "turn_2" }),
    ];
    expect(quietAfter(interrupted, 0)).toBe(true);
    // A message sent after the conversation went quiet is not settled by the earlier turns.
    expect(quietAfter([...reporting, at("turn_finished", { turn_id: "turn_2" })], 5)).toBe(false);
  });
});
