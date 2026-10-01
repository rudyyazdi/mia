import { existsSync, mkdirSync, mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { overlaidEnvironment, resolveExecutableSync } from "./resolve-executable.ts";

const script = (path: string, mode = 0o755) => writeFileSync(path, "#!/bin/sh\n", { mode });

describe("resolveExecutableSync", () => {
  it("looks a bare name up in each PATH entry and takes the first executable file", () => {
    using first = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    using second = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    using third = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    script(join(first.path, "runtime"), 0o644);
    mkdirSync(join(second.path, "runtime"));
    script(join(third.path, "runtime"));
    expect(
      resolveExecutableSync("runtime", {
        path: [first.path, second.path, third.path].join(delimiter),
        cwd: "/",
      }),
    ).toBe(join(third.path, "runtime"));
  });

  it("resolves a name containing a slash, and a relative PATH entry, against the working directory", () => {
    using work = mkdtempDisposableSync(join(tmpdir(), "mia-work-"));
    mkdirSync(join(work.path, "bin"));
    script(join(work.path, "bin", "runtime"));
    const expected = join(work.path, "bin", "runtime");
    expect(resolveExecutableSync("./bin/runtime", { path: undefined, cwd: work.path })).toBe(
      expected,
    );
    expect(resolveExecutableSync("runtime", { path: "bin", cwd: work.path })).toBe(expected);
  });

  it("treats an empty PATH entry as the working directory", () => {
    using work = mkdtempDisposableSync(join(tmpdir(), "mia-work-"));
    using empty = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    script(join(work.path, "runtime"));
    expect(
      resolveExecutableSync("runtime", { path: `${empty.path}${delimiter}`, cwd: work.path }),
    ).toBe(join(work.path, "runtime"));
  });

  it("falls back to spawn's default search path when PATH is unset", () => {
    expect(["/usr/bin/sh", "/bin/sh"]).toContain(
      resolveExecutableSync("sh", { path: undefined, cwd: "/" }),
    );
  });

  it("treats shell syntax in the name as a literal file name and runs nothing", () => {
    using bin = mkdtempDisposableSync(join(tmpdir(), "mia-bin-"));
    // Names without a slash, so they go through the PATH lookup; the marker lands in cwd if a shell ran them.
    for (const name of ["$(touch ran)", "`touch ran`", "runtime; touch ran", "$HOME"])
      expect(
        resolveExecutableSync(name, { path: `${bin.path}${delimiter}/bin`, cwd: bin.path }),
      ).toBeNull();
    // With a slash, the name is a path relative to cwd, still never shell code.
    expect(resolveExecutableSync("./$(touch ran)", { path: undefined, cwd: bin.path })).toBeNull();
    expect(existsSync(join(bin.path, "ran"))).toBe(false);
    const literal = "$(runtime)";
    script(join(bin.path, literal));
    expect(resolveExecutableSync(literal, { path: bin.path, cwd: "/" })).toBe(
      join(bin.path, literal),
    );
  });
});

describe("overlaidEnvironment", () => {
  it("finds the installed runtime, not a dependency's copy that npm run put first on PATH", () => {
    using root = mkdtempDisposableSync(join(tmpdir(), "mia-path-"));
    const packageBin = join(root.path, "node_modules", ".bin");
    const installed = join(root.path, "installed");
    mkdirSync(packageBin, { recursive: true });
    mkdirSync(installed);
    script(join(packageBin, "runtime"));
    script(join(installed, "runtime"));
    const inherited = { PATH: [`${packageBin}/`, installed].join(delimiter), HOME: root.path };
    const launch = overlaidEnvironment(inherited, {});
    expect(resolveExecutableSync("runtime", { path: launch.PATH, cwd: "/" })).toBe(
      join(installed, "runtime"),
    );
    // A PATH the profile sets is its own choice, kept as it is.
    expect(overlaidEnvironment(inherited, { PATH: packageBin }).PATH).toBe(packageBin);
  });

  it("leaves PATH unset, not empty, when every inherited entry was a package's bin", () => {
    using work = mkdtempDisposableSync(join(tmpdir(), "mia-work-"));
    script(join(work.path, "sh"));
    const launch = overlaidEnvironment({ PATH: "/repo/node_modules/.bin" }, {});
    expect(launch.PATH).toBeUndefined();
    // Unset falls back to spawn's default search path; an empty PATH would have found the working directory's sh.
    expect(resolveExecutableSync("sh", { path: launch.PATH, cwd: work.path })).not.toBe(
      join(work.path, "sh"),
    );
  });
});
