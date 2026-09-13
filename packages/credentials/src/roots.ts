import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { CredentialError, credentialError } from "./errors.js";

export interface MountInspection {
  readonly mountPoint: string;
  readonly filesystemType: string;
  readonly supportsOwnership: boolean;
  readonly supportsExactModes: boolean;
  readonly supportsAtomicRename: boolean;
  readonly supportsFileFlush: boolean;
  readonly supportsDirectoryFlush: boolean;
}

export interface MountInspector {
  inspect(path: string): Promise<MountInspection | null>;
}

const SUPPORTED_FILESYSTEMS = new Set(["ext2", "ext3", "ext4", "btrfs", "xfs", "tmpfs", "overlay"]);
const UNSUPPORTED_FILESYSTEMS = new Set(["9p", "drvfs", "fuseblk", "cifs", "smb3", "ntfs", "vfat", "exfat"]);
const MAXIMUM_MOUNTINFO_BYTES = 1024 * 1024;
const MAXIMUM_MOUNTINFO_LINES = 16_384;
const MAXIMUM_MOUNTINFO_LINE_BYTES = 16_384;
const MAXIMUM_MOUNTINFO_FIELDS = 256;
const MAXIMUM_ROOT_ENTRIES = 4_000;
const MAXIMUM_ROOT_SCAN_MS = 10_000;
const PROBE_FILE_PATTERN = /^\.wi-probe-[a-f0-9]{32}\.(?:tmp|done)$/u;
const PROBE_BYTES = Buffer.from("probe", "utf8");

function mountField(value: string): string {
  return value
    .replaceAll("\\040", " ")
    .replaceAll("\\011", "\t")
    .replaceAll("\\012", "\n")
    .replaceAll("\\134", "\\");
}

async function readBoundedMountInfo(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const stream = createReadStream("/proc/self/mountinfo", { highWaterMark: 64 * 1024 });
  for await (const chunkValue of stream) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    bytes += chunk.byteLength;
    if (bytes > MAXIMUM_MOUNTINFO_BYTES) {
      stream.destroy();
      throw new CredentialError("credential.unsupported_filesystem");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

export function inspectMountInfo(
  path: string,
  mountInfo: string,
): MountInspection | null {
    const lines = mountInfo.split("\n");
    if (lines.length > MAXIMUM_MOUNTINFO_LINES) {
      throw new CredentialError("credential.unsupported_filesystem");
    }
    let selected: { mountPoint: string; filesystemType: string } | null = null;
    for (const line of lines) {
      if (line.length === 0) continue;
      if (Buffer.byteLength(line, "utf8") > MAXIMUM_MOUNTINFO_LINE_BYTES) {
        throw new CredentialError("credential.unsupported_filesystem");
      }
      const fields = line.split(" ");
      if (fields.length > MAXIMUM_MOUNTINFO_FIELDS) {
        throw new CredentialError("credential.unsupported_filesystem");
      }
      const separator = fields.indexOf("-");
      const rawMountPoint = fields[4];
      const filesystemType = fields[separator + 1];
      if (separator < 0 || rawMountPoint === undefined || filesystemType === undefined) continue;
      const mountPoint = mountField(rawMountPoint);
      if (!containsPath(mountPoint, path)) continue;
      if (selected === null || mountPoint.length > selected.mountPoint.length) {
        selected = { mountPoint, filesystemType: filesystemType.toLowerCase() };
      }
    }
    if (selected === null) return null;
    const supported = SUPPORTED_FILESYSTEMS.has(selected.filesystemType) &&
      !UNSUPPORTED_FILESYSTEMS.has(selected.filesystemType);
    return {
      ...selected,
      supportsOwnership: supported,
      supportsExactModes: supported,
      supportsAtomicRename: supported,
      supportsFileFlush: supported,
      supportsDirectoryFlush: supported,
    };
}

export class ProcMountInspector implements MountInspector {
  async inspect(path: string): Promise<MountInspection | null> {
    return inspectMountInfo(path, await readBoundedMountInfo());
  }
}

export interface CredentialRoots {
  readonly credentialRoot: string;
  readonly stagingRoot: string;
}

export interface CredentialRootProbeHooks {
  readonly afterSourceSync?: (root: string) => void;
  readonly afterRename?: (root: string) => void;
}

export interface CredentialRootOptions {
  readonly wiHome: string;
  readonly credentialRoot?: string;
  readonly stagingRoot?: string;
  readonly xdgStateHome?: string;
  readonly homeDirectory?: string;
  readonly mountInspector?: MountInspector;
  readonly probeHooks?: CredentialRootProbeHooks;
}

function containsPath(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === "" || (candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate));
}

function overlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

async function ensurePrivateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new CredentialError("credential.invalid_configuration");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid?.()) {
    throw new CredentialError("credential.unsafe_path");
  }
  if ((before.mode & 0o777) !== 0o700) await chmod(path, 0o700);
  const canonical = await realpath(path);
  const after = await stat(canonical);
  if (!after.isDirectory() || after.uid !== process.getuid?.() || (after.mode & 0o777) !== 0o700) {
    throw new CredentialError("credential.unsafe_path");
  }
  return canonical;
}

function isWindowsDriveMount(path: string): boolean {
  return /^\/mnt\/[A-Za-z](?:\/|$)/u.test(path);
}

async function flushDirectory(root: string): Promise<void> {
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function cleanupOrphanedProbeFiles(root: string): Promise<number> {
  const startedAt = performance.now();
  let entries = 0;
  let deleted = 0;
  const directory = await opendir(root);
  try {
    for await (const entry of directory) {
      entries += 1;
      if (entries > MAXIMUM_ROOT_ENTRIES || performance.now() - startedAt > MAXIMUM_ROOT_SCAN_MS) {
        throw new CredentialError("credential.scan_incomplete");
      }
      if (!PROBE_FILE_PATTERN.test(entry.name)) continue;
      const path = join(root, entry.name);
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (error) {
        throw credentialError(error, "credential.unsupported_filesystem");
      }
      try {
        const identity = await handle.stat();
        if (
          !identity.isFile() ||
          identity.nlink !== 1 ||
          identity.uid !== process.getuid?.() ||
          (identity.mode & 0o777) !== 0o600 ||
          identity.size !== PROBE_BYTES.byteLength ||
          !Buffer.from(await handle.readFile()).equals(PROBE_BYTES)
        ) {
          throw new CredentialError("credential.unsupported_filesystem");
        }
      } finally {
        await handle.close();
      }
      await unlink(path);
      deleted += 1;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  if (deleted > 0) await flushDirectory(root);
  return deleted;
}

async function probeSemantics(root: string, hooks: CredentialRootProbeHooks = {}): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "");
  const source = join(root, `.wi-probe-${suffix}.tmp`);
  const target = join(root, `.wi-probe-${suffix}.done`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(source, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile("probe", "utf8");
    await handle.sync();
    hooks.afterSourceSync?.(root);
    await handle.close();
    handle = undefined;
    await rename(source, target);
    hooks.afterRename?.(root);
    const targetHandle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const identity = await targetHandle.stat();
      if (!identity.isFile() || identity.nlink !== 1 || identity.uid !== process.getuid?.() || (identity.mode & 0o777) !== 0o600) {
        throw new CredentialError("credential.unsupported_filesystem");
      }
    } finally {
      await targetHandle.close();
    }
    await flushDirectory(root);
    await unlink(target);
    await flushDirectory(root);
  } catch (error) {
    throw credentialError(error, "credential.unsupported_filesystem");
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(source, { force: true }).catch(() => undefined);
    await rm(target, { force: true }).catch(() => undefined);
  }
}

async function prospectiveCanonicalPath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new CredentialError("credential.invalid_configuration");
  let ancestor = path;
  while (true) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      return resolve(canonicalAncestor, relative(ancestor, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw credentialError(error, "credential.unsafe_path");
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new CredentialError("credential.unsafe_path");
      ancestor = parent;
    }
  }
}

async function assertSupportedRoot(path: string, inspector: MountInspector): Promise<void> {
  if (isWindowsDriveMount(path)) throw new CredentialError("credential.unsupported_filesystem");
  const mount = await inspector.inspect(path);
  if (
    mount === null ||
    UNSUPPORTED_FILESYSTEMS.has(mount.filesystemType.toLowerCase()) ||
    !mount.supportsOwnership ||
    !mount.supportsExactModes ||
    !mount.supportsAtomicRename ||
    !mount.supportsFileFlush ||
    !mount.supportsDirectoryFlush
  ) {
    throw new CredentialError("credential.unsupported_filesystem");
  }
}

async function validateRoot(
  path: string,
  inspector: MountInspector,
  hooks: CredentialRootProbeHooks | undefined,
): Promise<string> {
  const canonical = await ensurePrivateDirectory(path);
  await assertSupportedRoot(canonical, inspector);
  await cleanupOrphanedProbeFiles(canonical);
  await probeSemantics(canonical, hooks);
  return canonical;
}

export async function initializeCredentialRoots(options: CredentialRootOptions): Promise<CredentialRoots> {
  const xdgStateHome = options.xdgStateHome ?? process.env.XDG_STATE_HOME;
  if (
    (xdgStateHome !== undefined && !isAbsolute(xdgStateHome)) ||
    (options.credentialRoot !== undefined && !isAbsolute(options.credentialRoot)) ||
    (options.stagingRoot !== undefined && !isAbsolute(options.stagingRoot))
  ) {
    throw new CredentialError("credential.invalid_configuration");
  }
  const base = resolve(
    xdgStateHome ?? join(options.homeDirectory ?? homedir(), ".local", "state"),
  );
  const inspector = options.mountInspector ?? new ProcMountInspector();
  const wiHome = await prospectiveCanonicalPath(resolve(options.wiHome));
  const credentialPath = resolve(options.credentialRoot ?? join(base, "wi", "credentials"));
  const stagingPath = resolve(options.stagingRoot ?? join(base, "wi", "credential-staging"));
  const credentialCandidate = await prospectiveCanonicalPath(credentialPath);
  const stagingCandidate = await prospectiveCanonicalPath(stagingPath);
  if (
    overlap(wiHome, credentialCandidate) ||
    overlap(wiHome, stagingCandidate) ||
    overlap(credentialCandidate, stagingCandidate)
  ) {
    throw new CredentialError("credential.invalid_configuration");
  }
  // Reject unsupported locations before mkdir/chmod/probe can mutate them.
  await assertSupportedRoot(credentialCandidate, inspector);
  await assertSupportedRoot(stagingCandidate, inspector);
  const credentialRoot = await validateRoot(credentialPath, inspector, options.probeHooks);
  const stagingRoot = await validateRoot(stagingPath, inspector, options.probeHooks);
  return { credentialRoot, stagingRoot };
}

export function assertContainedGeneratedPath(root: string, path: string): void {
  if (dirname(path) !== root || !containsPath(root, path)) {
    throw new CredentialError("credential.unsafe_path");
  }
}
