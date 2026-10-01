import { describe, expect, it } from "vitest";
import { diagnosticsViews, turnViews } from "./queries.ts";
import { fixtureEvent, snapshotFixture } from "./snapshot-fixture.ts";

describe("turnViews", () => {
  it("assembles each turn's reply and the messages it took, in journal order", () => {
    const snapshot = snapshotFixture();
    const turn = {
      conversation_id: "conversation",
      execution_id: "exec",
      caused_by_task_id: null,
      status: "completed" as const,
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: null,
      usage: null,
    };
    snapshot.tables.turns = [
      { ...turn, id: "turn", cause: "user_input" },
      { ...turn, id: "other", cause: "user_input" },
    ];
    snapshot.tables.events = [
      fixtureEvent({ id: "m1", type: "message_received", payload: '{"text":"hi"}' }),
      fixtureEvent({
        id: "t1",
        sequence: 2,
        type: "message_taken",
        payload: '{"message_event_id":"m1","turn_id":"turn"}',
      }),
      fixtureEvent({ id: "r1", sequence: 3, payload: '{"turn_id":"turn","text":"Hello "}' }),
      fixtureEvent({ id: "r2", sequence: 4, payload: '{"turn_id":"other","text":"Other"}' }),
      fixtureEvent({ id: "r3", sequence: 5, payload: '{"turn_id":"turn","text":"world"}' }),
    ];
    expect(
      turnViews(snapshot).map((view) => ({
        id: view.id,
        messages: view.messages,
        reply: view.reply,
      })),
    ).toEqual([
      { id: "turn", messages: ["hi"], reply: "Hello world" },
      { id: "other", messages: [], reply: "Other" },
    ]);
  });
});

describe("diagnosticsViews freshness", () => {
  it.each([
    { age: 60_000, disconnected: false, expected: "current" },
    { age: 60_001, disconnected: false, expected: "stale" },
    { age: 60_001, disconnected: true, expected: "disconnected" },
  ])(
    "reports $expected at age $age with disconnected=$disconnected",
    ({ age, disconnected, expected }) => {
      const snapshot = snapshotFixture();
      const now = Date.parse("2026-01-01T00:02:00Z");
      for (const diagnostic of snapshot.tables.diagnostics) {
        diagnostic.received_at = new Date(now - age).toISOString();
        diagnostic.captured_at = "2000-01-01T00:00:00Z";
      }
      snapshot.tables.client_connections = [
        {
          id: "connection",
          client_id: "client",
          build: null,
          provenance_set_id: null,
          connected_at: "2026-01-01T00:00:00Z",
          disconnected_at: disconnected ? "2026-01-01T00:01:00Z" : null,
          last_received_at: null,
        },
      ];
      expect(diagnosticsViews(snapshot, now)[0]).toMatchObject({
        freshness: expected,
        state: { detail: "diagnostic-state" },
      });
    },
  );

  it("uses custom age thresholds even when a connection is absent", () => {
    const snapshot = snapshotFixture();
    for (const diagnostic of snapshot.tables.diagnostics) {
      diagnostic.client_connection_id = null;
      diagnostic.received_at = "2026-01-01T00:00:00Z";
    }
    const now = Date.parse("2026-01-01T00:00:01Z");
    expect(diagnosticsViews(snapshot, now, 1000)[0]?.freshness).toBe("current");
    expect(diagnosticsViews(snapshot, now, 999)[0]?.freshness).toBe("stale");
    snapshot.tables.diagnostics = [];
    expect(diagnosticsViews(snapshot, now)).toEqual([]);
  });
});
