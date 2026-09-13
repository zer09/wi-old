import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { FixtureProcessRunner } from "./fixture-process.js";

const fixture = fileURLToPath(new URL("./provider-root-probe-fixture.mjs", import.meta.url));
const roots: string[] = [];
const processes = new FixtureProcessRunner(10_000);

function argumentsFor(root: string, mode: string): readonly string[] {
  return [
    fixture,
    join(root, "wi-home"),
    join(root, "credentials"),
    join(root, "staging"),
    mode,
  ];
}

afterEach(async () => {
  await processes.terminateAll();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("credential-root semantic probe recovery", () => {
  for (const mode of ["crash-source", "crash-rename"] as const) {
    it(`removes a crash-left semantic probe after ${mode}`, async () => {
      const root = await mkdtemp(join(tmpdir(), `wi-probe-${mode}-`));
      roots.push(root);
      await mkdir(join(root, "wi-home"), { mode: 0o700 });

      const crashed = await processes.run(process.execPath, argumentsFor(root, mode));
      expect(crashed).toMatchObject({ code: null, signal: "SIGKILL" });
      expect((await readdir(join(root, "credentials"))).some((name) =>
        /^\.wi-probe-[a-f0-9]{32}\.(?:tmp|done)$/u.test(name)
      )).toBe(true);

      const lookalike = join(root, "credentials", ".wi-probe-review-lookalike.tmp");
      await writeFile(lookalike, "keep", { mode: 0o600 });
      const inspected = await processes.run(process.execPath, argumentsFor(root, "inspect"));
      expect(inspected.code, inspected.stderr).toBe(0);
      expect(JSON.parse(inspected.stdout) as unknown).toMatchObject({
        status: "ready",
        probeFiles: [".wi-probe-review-lookalike.tmp"],
      });
      await expect(readFile(lookalike, "utf8")).resolves.toBe("keep");
    });
  }

  it("rejects and preserves an unsafe strict probe file", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-probe-unsafe-"));
    roots.push(root);
    await mkdir(join(root, "wi-home"), { mode: 0o700 });
    await mkdir(join(root, "credentials"), { mode: 0o700 });
    const unsafe = join(
      root,
      "credentials",
      ".wi-probe-0123456789abcdef0123456789abcdef.tmp",
    );
    await writeFile(unsafe, "probe", { mode: 0o600 });
    await chmod(unsafe, 0o644);

    const inspected = await processes.run(process.execPath, argumentsFor(root, "inspect"));
    expect(inspected.code, inspected.stderr).toBe(2);
    expect(JSON.parse(inspected.stdout) as unknown).toEqual({
      status: "rejected",
      code: "credential.unsupported_filesystem",
    });
    await expect(readFile(unsafe, "utf8")).resolves.toBe("probe");
  });
});
