import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../apps/server/dist/credential-cli.js", import.meta.url));
const roots: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function filesBelow(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  await visit(root);
  return found;
}

async function readProcessCommandLine(pid: number): Promise<Buffer> {
  const path = `/proc/${String(pid)}/cmdline`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Credential CLI process command line was not observable");
}

describe("credential CLI process boundary", () => {
  it("keeps descriptor credentials out of process arguments, history, output, and WI_HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-credential-cli-boundary-"));
    roots.push(root);
    const wiHome = join(root, "wi-home");
    const stateHome = join(root, "state");
    const historyPath = join(root, "controlled-shell-history");
    const secret = "sk-process-list-history-proof-7d8f4c";
    await writeFile(
      historyPath,
      `node ${cli} --provider openai_platform --auth-mode api_key --api-key-fd 3\n`,
      "utf8",
    );

    const child = spawn(process.execPath, [
      cli,
      "--provider",
      "openai_platform",
      "--auth-mode",
      "api_key",
      "--api-key-fd",
      "3",
    ], {
      env: {
        ...process.env,
        WI_HOME: wiHome,
        XDG_STATE_HOME: stateHome,
      },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    children.add(child);
    if (child.pid === undefined) throw new Error("Credential CLI process did not start");
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    const commandLine = await readProcessCommandLine(child.pid);
    expect(commandLine.toString("utf8")).toContain("--api-key-fd");
    expect(commandLine.includes(Buffer.from(secret))).toBe(false);
    expect(await readFile(historyPath, "utf8")).not.toContain(secret);
    expect(await filesBelow(wiHome)).toEqual([]);

    const descriptor = child.stdio[3] as Writable;
    descriptor.end(`${secret}\n`);
    const [exitCode, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    children.delete(child);
    const stdoutText = Buffer.concat(stdout).toString("utf8");
    const stderrText = Buffer.concat(stderr).toString("utf8");
    expect({ exitCode, signal }, stderrText).toEqual({ exitCode: 0, signal: null });
    expect(stdoutText).toContain("provref_");
    expect(stdoutText).not.toContain(secret);
    expect(stderrText).not.toContain(secret);
    for (const path of await filesBelow(wiHome)) {
      expect(await readFile(path)).not.toContain(Buffer.from(secret));
    }
    const secretFiles: string[] = [];
    for (const path of await filesBelow(root)) {
      if ((await readFile(path)).includes(Buffer.from(secret))) secretFiles.push(path);
    }
    expect(secretFiles).toHaveLength(1);
    expect(secretFiles[0]).toContain(`${join("wi", "credential-staging")}`);
  });
});
