import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, opendir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  ProviderAuthModeSchema,
  ProviderIdSchema,
  ProvisioningIdSchema,
  ProvisioningRefSchema,
  type ProviderId,
} from "@wi/protocol";

import { CredentialError, credentialError } from "./errors.js";
import type { CredentialFileIdentity } from "./file-store.js";
import {
  MAXIMUM_CREDENTIAL_FILE_BYTES,
  StagedCredentialEnvelopeSchema,
  type StagedCredentialEnvelope,
} from "./models.js";
import { assertContainedGeneratedPath } from "./roots.js";

const MAXIMUM_STAGES = 1_000;
const STAGE_LIFETIME_MS = 15 * 60 * 1_000;
const MAXIMUM_STAGE_SCAN_MS = 10_000;
const TEMPORARY_STAGE_PATTERN = /^\.tmp-stage-[a-f0-9]{32}$/u;

async function flushDirectory(root: string): Promise<void> {
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}

export function internalStagingRef(ref: string): string {
  const provisioningRef = ProvisioningRefSchema.parse(ref);
  return `stage_${createHash("sha256").update(provisioningRef).digest("hex")}`;
}

function stageFilename(ref: string): string {
  return `${internalStagingRef(ref).replace("stage_", "stage-")}.json`;
}

export interface ProvisioningResult {
  readonly provisioningRef: string;
  readonly providerId: ProviderId;
  readonly authMode: "api_key";
  readonly expiresAtMs: number;
}

export interface CredentialProvisionerHooks {
  readonly afterTemporaryFileSync?: () => void;
  readonly afterStageRenameBeforeFlush?: () => void;
  readonly afterStageCommit?: () => void;
  readonly beforeProvisioningRefReturn?: () => void;
  readonly afterStageDeleteBeforeFlush?: () => void;
}

export interface StagedCredentialWithFileIdentity {
  readonly credential: StagedCredentialEnvelope;
  readonly fileIdentity: CredentialFileIdentity;
}

export class CredentialProvisioner {
  constructor(
    readonly root: string,
    private readonly now: () => number = Date.now,
    private readonly random: () => string = () => randomUUID().replaceAll("-", ""),
    private readonly hooks: CredentialProvisionerHooks = {},
  ) {}

  private path(ref: string): string {
    const path = join(this.root, stageFilename(ref));
    assertContainedGeneratedPath(this.root, path);
    return path;
  }

  async stageApiKey(providerValue: unknown, authValue: unknown, apiKey: string): Promise<ProvisioningResult> {
    const providerId = ProviderIdSchema.parse(providerValue);
    const authMode = ProviderAuthModeSchema.parse(authValue);
    if (authMode !== "api_key") throw new CredentialError("credential.reference_invalid");
    const createdAtMs = this.now();
    const expiresAtMs = createdAtMs + STAGE_LIFETIME_MS;
    const provisioningId = ProvisioningIdSchema.parse(`prov_${this.random()}`);
    const provisioningRef = ProvisioningRefSchema.parse(`provref_${this.random()}`);
    const envelope = StagedCredentialEnvelopeSchema.parse({
      version: 1,
      provisioningId,
      providerId,
      authMode,
      createdAtMs,
      expiresAtMs,
      apiKey,
    });
    const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
    if (bytes.byteLength > MAXIMUM_CREDENTIAL_FILE_BYTES) {
      throw new CredentialError("credential.malformed");
    }
    const target = this.path(provisioningRef);
    const temporary = join(this.root, `.tmp-stage-${this.random()}`);
    assertContainedGeneratedPath(this.root, temporary);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      const identity = await handle.stat();
      if (!identity.isFile() || identity.nlink !== 1 || identity.uid !== process.getuid?.()) {
        throw new CredentialError("credential.unsafe_file");
      }
      await handle.writeFile(bytes);
      await handle.sync();
      this.hooks.afterTemporaryFileSync?.();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      this.hooks.afterStageRenameBeforeFlush?.();
      await flushDirectory(this.root);
      this.hooks.afterStageCommit?.();
      this.hooks.beforeProvisioningRefReturn?.();
      return { provisioningRef, providerId, authMode, expiresAtMs };
    } catch (error) {
      throw credentialError(error, "credential.io_failed");
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async read(ref: string, options: { readonly allowExpiredClaimed: boolean }): Promise<StagedCredentialEnvelope> {
    return (await this.readWithFileIdentity(ref, options)).credential;
  }

  async readWithFileIdentity(
    ref: string,
    options: { readonly allowExpiredClaimed: boolean },
  ): Promise<StagedCredentialWithFileIdentity> {
    return this.readPath(this.path(ref), options);
  }

  async readClaimedInternal(internalRef: string): Promise<StagedCredentialEnvelope> {
    return (await this.readClaimedInternalWithFileIdentity(internalRef)).credential;
  }

  async readClaimedInternalWithFileIdentity(
    internalRef: string,
  ): Promise<StagedCredentialWithFileIdentity> {
    if (!/^stage_[a-f0-9]{64}$/u.test(internalRef)) {
      throw new CredentialError("credential.reference_invalid");
    }
    const path = join(this.root, `${internalRef.replace("stage_", "stage-")}.json`);
    assertContainedGeneratedPath(this.root, path);
    return this.readPath(path, { allowExpiredClaimed: true });
  }

  private async readPath(
    path: string,
    options: { readonly allowExpiredClaimed: boolean },
  ): Promise<StagedCredentialWithFileIdentity> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CredentialError("credential.stage_missing");
      }
      throw credentialError(error, "credential.unsafe_file");
    }
    try {
      const identity = await handle.stat();
      if (
        !identity.isFile() ||
        identity.nlink !== 1 ||
        identity.uid !== process.getuid?.() ||
        (identity.mode & 0o777) !== 0o600 ||
        identity.size > MAXIMUM_CREDENTIAL_FILE_BYTES
      ) {
        throw new CredentialError("credential.unsafe_file");
      }
      const before = await handle.stat({ bigint: true });
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
      let raw: unknown;
      try { raw = JSON.parse(bytes.toString("utf8")); } catch {
        throw new CredentialError("credential.malformed");
      }
      const envelope = StagedCredentialEnvelopeSchema.parse(raw);
      if (!options.allowExpiredClaimed && envelope.expiresAtMs <= this.now()) {
        throw new CredentialError("credential.stage_missing");
      }
      return {
        credential: envelope,
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

  async delete(ref: string): Promise<void> {
    try {
      await unlink(this.path(ref));
      this.hooks.afterStageDeleteBeforeFlush?.();
      await flushDirectory(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw credentialError(error, "credential.io_failed");
    }
  }

  async deleteClaimedInternal(internalRef: string): Promise<void> {
    if (!/^stage_[a-f0-9]{64}$/u.test(internalRef)) {
      throw new CredentialError("credential.reference_invalid");
    }
    const path = join(this.root, `${internalRef.replace("stage_", "stage-")}.json`);
    assertContainedGeneratedPath(this.root, path);
    try {
      await unlink(path);
      this.hooks.afterStageDeleteBeforeFlush?.();
      await flushDirectory(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw credentialError(error, "credential.io_failed");
    }
  }

  async cleanupExpiredUnclaimed(
    isClaimed: (provisioningId: string) => Promise<boolean>,
  ): Promise<number> {
    const startedAt = performance.now();
    let entries = 0;
    let stages = 0;
    let deleted = 0;
    const directory = await opendir(this.root);
    try {
      for await (const entry of directory) {
        entries += 1;
        if (
          entries > MAXIMUM_STAGES * 4 ||
          performance.now() - startedAt > MAXIMUM_STAGE_SCAN_MS
        ) {
          throw new CredentialError("credential.scan_incomplete");
        }
        if (TEMPORARY_STAGE_PATTERN.test(entry.name)) {
          if (!entry.isFile() || entry.isSymbolicLink()) {
            throw new CredentialError("credential.unsafe_file");
          }
          const temporaryPath = join(this.root, entry.name);
          assertContainedGeneratedPath(this.root, temporaryPath);
          const temporaryHandle = await open(
            temporaryPath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const identity = await temporaryHandle.stat();
            if (
              !identity.isFile() ||
              identity.nlink !== 1 ||
              identity.uid !== process.getuid?.() ||
              (identity.mode & 0o777) !== 0o600
            ) {
              throw new CredentialError("credential.unsafe_file");
            }
          } finally {
            await temporaryHandle.close();
          }
          await unlink(temporaryPath);
          await flushDirectory(this.root);
          deleted += 1;
          continue;
        }
        if (!/^stage-[a-f0-9]{64}\.json$/u.test(entry.name) || !entry.isFile()) continue;
        stages += 1;
        if (stages > MAXIMUM_STAGES) {
          throw new CredentialError("credential.scan_incomplete");
        }
        const path = join(this.root, entry.name);
        assertContainedGeneratedPath(this.root, path);
        let handle: Awaited<ReturnType<typeof open>>;
        try {
          handle = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        let envelope: StagedCredentialEnvelope;
        try {
          const identity = await handle.stat();
          if (
            !identity.isFile() ||
            identity.nlink !== 1 ||
            identity.uid !== process.getuid?.() ||
            (identity.mode & 0o777) !== 0o600 ||
            identity.size > MAXIMUM_CREDENTIAL_FILE_BYTES
          ) continue;
          const raw = JSON.parse((await handle.readFile()).toString("utf8")) as unknown;
          envelope = StagedCredentialEnvelopeSchema.parse(raw);
        } catch {
          continue;
        } finally {
          await handle.close();
        }
        if (envelope.expiresAtMs > this.now() || await isClaimed(envelope.provisioningId)) continue;
        await unlink(path);
        await flushDirectory(this.root);
        deleted += 1;
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    return deleted;
  }
}
