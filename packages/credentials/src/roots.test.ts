import { access, mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CredentialError } from "./errors.js";
import { initializeCredentialRoots, inspectMountInfo, type MountInspector } from "./roots.js";

const homes: string[] = [];
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const supported: MountInspector = {
  inspect: async (path) => ({
    mountPoint: path,
    filesystemType: "ext4",
    supportsOwnership: true,
    supportsExactModes: true,
    supportsAtomicRename: true,
    supportsFileFlush: true,
    supportsDirectoryFlush: true,
  }),
};

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  if (originalXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdgStateHome;
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "wi-credential-roots-"));
  homes.push(home);
  const wiHome = join(home, "wi-home");
  await mkdir(wiHome, { mode: 0o700 });
  return { home, wiHome };
}

describe("credential root validation", () => {
  it("accepts proven supported Linux roots and enforces private modes", async () => {
    const { home, wiHome } = await fixture();
    const roots = await initializeCredentialRoots({
      wiHome,
      credentialRoot: join(home, "credentials"),
      stagingRoot: join(home, "staging"),
      mountInspector: supported,
    });
    expect(roots).toEqual({
      credentialRoot: await realpath(join(home, "credentials")),
      stagingRoot: await realpath(join(home, "staging")),
    });
  });

  it("initializes credential roots when WI_HOME does not yet exist", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-credential-fresh-home-"));
    homes.push(home);
    const wiHome = join(home, "wi-home");
    const stateHome = join(home, "state");

    const roots = await initializeCredentialRoots({
      wiHome,
      xdgStateHome: stateHome,
      mountInspector: supported,
    });

    expect(roots).toEqual({
      credentialRoot: await realpath(join(stateHome, "wi", "credentials")),
      stagingRoot: await realpath(join(stateHome, "wi", "credential-staging")),
    });
    await expect(access(wiHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses process XDG_STATE_HOME for default credential roots", async () => {
    const { home, wiHome } = await fixture();
    const xdgStateHome = join(home, "xdg-state");
    process.env.XDG_STATE_HOME = xdgStateHome;
    const roots = await initializeCredentialRoots({ wiHome, mountInspector: supported });
    expect(roots).toEqual({
      credentialRoot: await realpath(join(xdgStateHome, "wi", "credentials")),
      stagingRoot: await realpath(join(xdgStateHome, "wi", "credential-staging")),
    });
  });

  it.each(["xdg", "credential", "staging"] as const)(
    "rejects a relative %s root before filesystem mutation",
    async (kind) => {
      const { home, wiHome } = await fixture();
      const relativeRoot = `wi-relative-${kind}-${basename(home)}`;
      await expect(initializeCredentialRoots({
        wiHome,
        mountInspector: supported,
        ...(kind === "xdg" ? { xdgStateHome: relativeRoot } : {}),
        ...(kind === "credential" ? { credentialRoot: relativeRoot } : {}),
        ...(kind === "staging" ? { stagingRoot: relativeRoot } : {}),
      })).rejects.toMatchObject({ code: "credential.invalid_configuration" });
      await expect(access(join(process.cwd(), relativeRoot))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("rejects root overlap without mutating either rejected root", async () => {
    const { home, wiHome } = await fixture();
    const credentialRoot = join(wiHome, "credentials");
    const stagingRoot = join(home, "staging");
    await expect(
      initializeCredentialRoots({
        wiHome,
        credentialRoot,
        stagingRoot,
        mountInspector: supported,
      }),
    ).rejects.toThrowError(CredentialError);
    await expect(access(credentialRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlink ancestor resolving into WI_HOME without creating its child", async () => {
    const { home, wiHome } = await fixture();
    const alias = join(home, "alias");
    const credentialRoot = join(alias, "credentials");
    const stagingRoot = join(home, "staging");
    await symlink(wiHome, alias);
    await expect(initializeCredentialRoots({
      wiHome,
      credentialRoot,
      stagingRoot,
      mountInspector: supported,
    })).rejects.toThrowError(CredentialError);
    await expect(access(credentialRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("decodes escaped newlines before selecting the longest unsafe mount", () => {
    const nestedMount = "/safe/unsafe\nnested";
    const inspection = inspectMountInfo(
      `${nestedMount}/credentials`,
      [
        "20 1 0:20 / /safe rw - ext4 /dev/root rw",
        "21 20 0:21 / /safe/unsafe\\012nested rw - 9p drvfs rw",
      ].join("\n"),
    );
    expect(inspection).toMatchObject({
      mountPoint: nestedMount,
      filesystemType: "9p",
      supportsOwnership: false,
      supportsExactModes: false,
      supportsAtomicRename: false,
    });
  });

  it.each(["9p", "drvfs"])("rejects synthetic Windows-backed %s mounts", async (filesystemType) => {
    const { home, wiHome } = await fixture();
    await expect(
      initializeCredentialRoots({
        wiHome,
        credentialRoot: join(home, "credentials"),
        stagingRoot: join(home, "staging"),
        mountInspector: {
          inspect: async (path) => ({
            ...(await supported.inspect(path))!,
            filesystemType,
          }),
        },
      }),
    ).rejects.toThrowError(CredentialError);
  });
});
