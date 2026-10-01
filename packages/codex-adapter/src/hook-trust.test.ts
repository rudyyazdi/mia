import { describe, expect, it } from "vitest";
import { gateHookTrust } from "./hook-trust.ts";

const hook = { source: "/home/codex/hooks.json", command: "'node' 'gate-hook.mjs'" };

const listed = (fields: Record<string, unknown>) => ({
  data: [
    {
      hooks: [
        {
          key: "/home/codex/hooks.json:pre_tool_use:0:0",
          command: hook.command,
          sourcePath: hook.source,
          currentHash: "sha256:abc",
          trustStatus: "untrusted",
          enabled: true,
          ...fields,
        },
      ],
    },
  ],
});

describe("gateHookTrust", () => {
  it("trusts Mia's hook by the hash Codex reports when it is not yet trusted", () => {
    expect(gateHookTrust(listed({}), hook)).toEqual({
      kind: "untrusted",
      key: "/home/codex/hooks.json:pre_tool_use:0:0",
      hash: "sha256:abc",
    });
    expect(gateHookTrust(listed({ trustStatus: "modified" }), hook)).toMatchObject({
      kind: "untrusted",
    });
    expect(gateHookTrust(listed({ trustStatus: "trusted" }), hook)).toEqual({ kind: "trusted" });
  });

  it("finds no hook of Mia's when only another command or file is listed, or Codex disabled it", () => {
    expect(gateHookTrust(listed({ command: "'node' 'other.mjs'" }), hook)).toEqual({
      kind: "missing",
    });
    expect(gateHookTrust(listed({ sourcePath: "/elsewhere/hooks.json" }), hook)).toEqual({
      kind: "missing",
    });
    expect(gateHookTrust(listed({ enabled: false, trustStatus: "trusted" }), hook)).toEqual({
      kind: "disabled",
    });
  });
});
