import { randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open, opendir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

import { ProviderConnectionIdSchema, canonicalJson } from "@wi/protocol";

import { CredentialError, credentialError } from "./errors.js";
import {
  MAXIMUM_CREDENTIAL_FILE_BYTES,
  StoredCredential,
  StoredCredentialEnvelopeSchema,
  type CredentialStore,
} from "./models.js";
import { assertContainedGeneratedPath } from "./roots.js";

const INTERNAL_REF_PATTERN = /^credref_[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u;
const FINAL_FILE_PATTERN = /^(credref_[A-Za-z0-9][A-Za-z0-9_-]{0,119})\.json$/u;
const TEMPORARY_FILE_PATTERN = /^\.tmp-[a-f0-9]{32}$/u;
const MAXIMUM_CREDENTIAL_FILES = 1_000;
const MAXIMUM_CREDENTIAL_SCAN_MS = 10_000;

export function validateInternalCredentialRef(ref: string): string {
  if (!INTERNAL_REF_PATTERN.test(ref)) {
    throw new CredentialError("credential.reference_invalid");
  }
  return ref;
}

async function flushDirectory(root: string): Promise<void> {
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}

function sameCredentialTarget(left: StoredCredential, right: StoredCredential): boolean {
  const leftEnvelope = left.toEnvelopeForStore();
  const rightEnvelope = right.toEnvelopeForStore();
  const leftKey = Buffer.from(leftEnvelope.credential.apiKey, "utf8");
  const rightKey = Buffer.from(rightEnvelope.credential.apiKey, "utf8");
  return leftEnvelope.envelopeId === rightEnvelope.envelopeId &&
    leftEnvelope.connectionId === rightEnvelope.connectionId &&
    leftEnvelope.providerId === rightEnvelope.providerId &&
    leftEnvelope.authMode === rightEnvelope.authMode &&
    leftEnvelope.generation === rightEnvelope.generation &&
    canonicalJson(leftEnvelope.identity) === canonicalJson(rightEnvelope.identity) &&
    leftKey.byteLength === rightKey.byteLength && timingSafeEqual(leftKey, rightKey);
}

export interface CredentialBinding {
  readonly connectionId: string;
  readonly providerId: "openai_platform" | "openai_codex";
  readonly authMode: "api_key" | "chatgpt_oauth";
  readonly generation: number;
}

export interface CredentialBindingEvidence extends CredentialBinding {
  readonly envelopeId: string;
}

export interface CredentialFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly ctimeNs: string;
}

export interface CredentialWithFileIdentity {
  readonly credential: StoredCredential;
  readonly fileIdentity: CredentialFileIdentity;
}

export interface FileCredentialStoreHooks {
  readonly afterTemporaryFileSync?: () => void;
  readonly afterCredentialRenameBeforeFlush?: () => void;
  readonly afterCredentialUnlinkBeforeFlush?: () => void;
}

export class FileCredentialStore implements CredentialStore {
  constructor(
    readonly root: string,
    private readonly hooks: FileCredentialStoreHooks = {},
  ) {}

  private path(ref: string): string {
    const path = join(this.root, `${validateInternalCredentialRef(ref)}.json`);
    assertContainedGeneratedPath(this.root, path);
    return path;
  }

  private async openValidated(path: string, repairMode: boolean) {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const first = await handle.stat();
      if (!first.isFile() || first.nlink !== 1 || first.uid !== process.getuid?.()) {
        throw new CredentialError("credential.unsafe_file");
      }
      if ((first.mode & 0o777) !== 0o600) {
        if (!repairMode) throw new CredentialError("credential.unsafe_file");
        await handle.chmod(0o600);
        await handle.sync();
        await flushDirectory(this.root);
      }
      const second = await handle.stat();
      if (
        !second.isFile() ||
        second.nlink !== 1 ||
        second.uid !== process.getuid?.() ||
        second.dev !== first.dev ||
        second.ino !== first.ino ||
        (second.mode & 0o777) !== 0o600
      ) {
        throw new CredentialError("credential.unsafe_file");
      }
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private async write(ref: string, credential: StoredCredential): Promise<void> {
    const target = this.path(ref);
    const envelope = StoredCredentialEnvelopeSchema.parse(credential.toEnvelopeForStore());
    const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
    if (bytes.byteLength > MAXIMUM_CREDENTIAL_FILE_BYTES) {
      throw new CredentialError("credential.malformed");
    }
    const temporary = join(
      this.root,
      `.tmp-${randomUUID().replaceAll("-", "")}`,
    );
    assertContainedGeneratedPath(this.root, temporary);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      const created = await handle.stat();
      if (!created.isFile() || created.nlink !== 1 || created.uid !== process.getuid?.()) {
        throw new CredentialError("credential.unsafe_file");
      }
      await handle.writeFile(bytes);
      await handle.sync();
      this.hooks.afterTemporaryFileSync?.();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      this.hooks.afterCredentialRenameBeforeFlush?.();
      await chmod(target, 0o600);
      const finalHandle = await this.openValidated(target, false);
      await finalHandle.close();
      await flushDirectory(this.root);
    } catch (error) {
      throw credentialError(error, "credential.io_failed");
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async put(ref: string, credential: StoredCredential): Promise<void> {
    const current = await this.get(ref);
    if (current !== null) {
      if (sameCredentialTarget(current, credential)) return;
      throw new CredentialError("credential.binding_mismatch");
    }
    await this.write(ref, credential);
  }

  async getWithFileIdentity(ref: string): Promise<CredentialWithFileIdentity | null> {
    const path = this.path(ref);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await this.openValidated(path, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw credentialError(error, "credential.unsafe_file");
    }
    try {
      const before = await handle.stat({ bigint: true });
      if (before.size > BigInt(MAXIMUM_CREDENTIAL_FILE_BYTES)) {
        throw new CredentialError("credential.malformed");
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength > MAXIMUM_CREDENTIAL_FILE_BYTES) {
        throw new CredentialError("credential.malformed");
      }
      const after = await handle.stat({ bigint: true });
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.ctimeNs !== before.ctimeNs
      ) {
        throw new CredentialError("credential.unsafe_file");
      }
      let value: unknown;
      try { value = JSON.parse(bytes.toString("utf8")); } catch {
        throw new CredentialError("credential.malformed");
      }
      return {
        credential: new StoredCredential(StoredCredentialEnvelopeSchema.parse(value)),
        fileIdentity: {
          device: after.dev.toString(),
          inode: after.ino.toString(),
          size: after.size.toString(),
          ctimeNs: after.ctimeNs.toString(),
        },
      };
    } catch (error) {
      throw credentialError(error, "credential.malformed");
    } finally {
      await handle.close();
    }
  }

  async get(ref: string): Promise<StoredCredential | null> {
    return (await this.getWithFileIdentity(ref))?.credential ?? null;
  }

  async getBound(ref: string, binding: CredentialBinding): Promise<StoredCredential | null> {
    ProviderConnectionIdSchema.parse(binding.connectionId);
    const credential = await this.get(ref);
    if (credential === null) return null;
    const metadata = credential.metadata;
    if (
      metadata.connectionId !== binding.connectionId ||
      metadata.providerId !== binding.providerId ||
      metadata.authMode !== binding.authMode ||
      metadata.generation !== binding.generation
    ) {
      throw new CredentialError("credential.binding_mismatch");
    }
    return credential;
  }

  private async requireEvidence(
    ref: string,
    evidence: CredentialBindingEvidence,
  ): Promise<void> {
    const credential = await this.getBound(ref, evidence);
    if (credential === null || credential.metadata.envelopeId !== evidence.envelopeId) {
      throw new CredentialError("credential.binding_mismatch");
    }
  }

  async replaceBound(
    ref: string,
    evidence: CredentialBindingEvidence,
    credential: StoredCredential,
  ): Promise<void> {
    const current = await this.get(ref);
    if (current !== null && sameCredentialTarget(current, credential)) return;
    await this.requireEvidence(ref, evidence);
    await this.write(ref, credential);
  }

  async deleteBound(ref: string, evidence: CredentialBindingEvidence): Promise<void> {
    const current = await this.getBound(ref, evidence);
    if (current === null) return;
    if (current.metadata.envelopeId !== evidence.envelopeId) {
      throw new CredentialError("credential.binding_mismatch");
    }
    await this.delete(ref);
  }

  async delete(ref: string): Promise<void> {
    const path = this.path(ref);
    try {
      const handle = await this.openValidated(path, false);
      await handle.close();
      await unlink(path);
      this.hooks.afterCredentialUnlinkBeforeFlush?.();
      await flushDirectory(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw credentialError(error, "credential.io_failed");
    }
  }

  async cleanupOrphanedTemporaryFiles(): Promise<number> {
    const startedAt = performance.now();
    let entries = 0;
    let deleted = 0;
    const directory = await opendir(this.root);
    try {
      for await (const entry of directory) {
        entries += 1;
        if (
          entries > MAXIMUM_CREDENTIAL_FILES * 4 ||
          performance.now() - startedAt > MAXIMUM_CREDENTIAL_SCAN_MS
        ) {
          throw new CredentialError("credential.scan_incomplete");
        }
        if (!TEMPORARY_FILE_PATTERN.test(entry.name)) continue;
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw new CredentialError("credential.unsafe_file");
        }
        const path = join(this.root, entry.name);
        assertContainedGeneratedPath(this.root, path);
        const handle = await this.openValidated(path, false);
        await handle.close();
        await unlink(path);
        await flushDirectory(this.root);
        deleted += 1;
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    return deleted;
  }

  async listRefs(): Promise<readonly string[]> {
    const refs: string[] = [];
    const startedAt = performance.now();
    let entries = 0;
    const directory = await opendir(this.root);
    try {
      for await (const entry of directory) {
        entries += 1;
        if (
          entries > MAXIMUM_CREDENTIAL_FILES * 4 ||
          performance.now() - startedAt > MAXIMUM_CREDENTIAL_SCAN_MS
        ) {
          throw new CredentialError("credential.scan_incomplete");
        }
        const match = FINAL_FILE_PATTERN.exec(entry.name);
        if (match === null) continue;
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw new CredentialError("credential.unsafe_file");
        }
        const ref = match[1];
        if (ref === undefined) continue;
        refs.push(validateInternalCredentialRef(ref));
        if (refs.length > MAXIMUM_CREDENTIAL_FILES) {
          throw new CredentialError("credential.scan_incomplete");
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    refs.sort();
    return refs;
  }
}
