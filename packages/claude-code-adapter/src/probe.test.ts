import { mkdirSync, mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeClaudeCodeSync } from "./probe.ts";

describe("probeClaudeCodeSync", () => {
  const probe = (
    env: NodeJS.ProcessEnv,
    executable = "mia-test-runtime-that-is-not-installed",
    configEnv: Record<string, string> = {},
  ) =>
    probeClaudeCodeSync(
      {
        kind: "claude-code",
        executable,
        model: "m",
        effort: "medium",
        workingDirectory: "/work",
        mcpServers: {},
        toolPolicy: {},
        agentPromptFile: "/prompt.md",
        outputDirectories: [],
        env: configEnv,
        extraSettings: {},
        workerAgent: { description: "does tool work", promptFile: "/worker.md" },
        exclusiveTools: [],
      },
      env,
    );

  it("detects the runtime credential from the environment it is given", () => {
    using home = mkdtempDisposableSync(join(tmpdir(), "mia-home-"));
    expect(probe({ ANTHROPIC_API_KEY: "key", HOME: home.path }).credential_source).toBe(
      "ANTHROPIC_API_KEY",
    );
    expect(probe({ HOME: home.path }).credential_source).toBe("none_detected");
    mkdirSync(join(home.path, ".claude"));
    writeFileSync(join(home.path, ".claude", ".credentials.json"), "{}");
    expect(probe({ HOME: home.path }).credential_source).toBe("claude_credentials_file");
  });

  it("looks the runtime up on the given environment's PATH and runs it with that environment", () => {
    using bin = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    // Prints the version only when the environment it runs with carries the marker. /bin stays on
    // PATH for the script's shebang.
    writeFileSync(join(bin.path, "mia-fake-runtime"), '#!/bin/sh\necho "v-$MIA_MARKER"\n', {
      mode: 0o755,
    });
    const found = probe(
      { PATH: `${bin.path}${delimiter}/bin`, MIA_MARKER: "given" },
      "mia-fake-runtime",
    );
    expect(found.executable_resolved).toBe(join(bin.path, "mia-fake-runtime"));
    expect(found.runtime_version).toBe("v-given");
  });

  it("reports a runtime missing from PATH", () => {
    using empty = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    const missing = probe({ PATH: empty.path }, "mia-fake-runtime");
    expect(missing.executable_resolved).toBeNull();
    expect(missing.errors).toContain('runtime executable "mia-fake-runtime" not found on PATH');
  });

  it("looks the runtime up on the PATH the profile's env gives the launch", () => {
    using bin = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    using empty = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    writeFileSync(join(bin.path, "mia-fake-runtime"), "#!/bin/sh\necho v\n", { mode: 0o755 });
    const found = probe({ PATH: empty.path }, "mia-fake-runtime", {
      PATH: `${bin.path}${delimiter}/bin`,
    });
    expect(found.executable_resolved).toBe(join(bin.path, "mia-fake-runtime"));
    expect(found.runtime_version).toBe("v");
  });
});
