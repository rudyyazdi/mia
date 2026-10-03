import { describe, expect, it } from "vitest";
import { SteeredEnds } from "./steered-ends.ts";
import type { EndReport } from "./turn-queue.ts";

const ended = (threadId: string): EndReport => ({
  path: `/root/${threadId}`,
  threadId,
  end: "completed",
  summary: null,
  note: null,
});

describe("SteeredEnds", () => {
  it("counts an end reported only by reply text that follows Codex recording its steer", () => {
    const steered = new SteeredEnds();
    steered.steer("s1", ended("a"));
    steered.steer("s2", ended("b"));
    expect(steered.answered()).toEqual([]);
    expect(steered.recorded("s1")).toBe(true);
    expect(steered.answered()).toEqual([ended("a")]);
    expect(steered.answered()).toEqual([]);
    expect(steered.turnEnded()).toEqual([ended("b")]);
  });

  it("gives back an end recorded after the turn's last reply, which Codex never answered", () => {
    const steered = new SteeredEnds();
    steered.steer("s1", ended("a"));
    expect(steered.recorded("s1")).toBe(true);
    expect(steered.turnEnded()).toEqual([ended("a")]);
  });

  it("gives back a refused steer's end once, whether the refusal or the turn's end comes first", () => {
    const steered = new SteeredEnds();
    steered.steer("s1", ended("a"));
    steered.steer("s2", ended("b"));
    expect(steered.refused("s1")).toEqual([ended("a")]);
    expect(steered.turnEnded()).toEqual([ended("b")]);
    expect(steered.refused("s2")).toEqual([]);
  });
});
