import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  CredentialProvisioner,
  FileCredentialStore,
  StoredCredential,
  initializeCredentialRoots,
  internalStagingRef,
} from "@wi/credentials";
import { TEST_FAILPOINTS, type TestFailpointName } from "../../apps/server/src/testing/failpoints.js";
import { FixtureProcessRunner } from "./fixture-process.js";

const fixture = fileURLToPath(new URL("./provider-lifecycle-fixture.mjs", import.meta.url));
const recoveryFixture = fileURLToPath(new URL("./provider-recovery-fixture.mjs", import.meta.url));
const orphanLifecycleFixture = fileURLToPath(
  new URL("./provider-orphan-lifecycle-fixture.mjs", import.meta.url),
);
const mutationFixture = fileURLToPath(new URL("./provider-lifecycle-mutation-fixture.mjs", import.meta.url));
const environmentRestartFixture = fileURLToPath(new URL("./provider-environment-restart-fixture.mjs", import.meta.url));
const environmentRevalidationFixture = fileURLToPath(new URL("./provider-environment-revalidation-fixture.mjs", import.meta.url));
const provisioningFixture = fileURLToPath(new URL("./provider-provisioning-fixture.mjs", import.meta.url));
const noNetworkFixture = fileURLToPath(new URL("./provider-no-network-fixture.mjs", import.meta.url));
const specialFileFixture = fileURLToPath(
  new URL("./provider-special-file-fixture.mjs", import.meta.url),
);
const execFileAsync = promisify(execFile);
const homes: string[] = [];
const processes = new FixtureProcessRunner(20_000);

const createCrashWindows = [
  "after_provider_lifecycle_prepare",
  "after_provider_credential_temp_flush",
  "after_provider_file_effect",
  "after_provider_file_observed",
  "after_provider_lifecycle_terminal_before_ack",
  "after_provider_stage_cleanup",
  "after_provider_stage_delete_before_flush",
  "after_provider_credential_rename_before_flush",
] as const satisfies readonly TestFailpointName[];

const destructiveCrashWindows = [
  "after_provider_lifecycle_prepare",
  "after_provider_credential_unlink_before_flush",
  "after_provider_file_effect",
  "after_provider_file_observed",
  "after_provider_lifecycle_terminal_before_ack",
] as const satisfies readonly TestFailpointName[];

afterEach(async () => {
  await processes.terminateAll();
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function assertSecretAbsentFromRoot(root: string, secret: string): Promise<void> {
  const needle = Buffer.from(secret, "utf8");
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        expect((await readFile(path)).includes(needle), path).toBe(false);
      }
    }
  };
  await visit(root);
}

async function prepareRetainedRecoveryTombstone(suffix: string): Promise<{
  readonly home: string;
  readonly roots: Awaited<ReturnType<typeof initializeCredentialRoots>>;
  readonly commandId: string;
  readonly arguments: readonly string[];
}> {
  const home = await mkdtemp(join(tmpdir(), `wi-recovery-retained-${suffix}-`));
  const stateHome = `${home}-state`;
  homes.push(home, stateHome);
  const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateHome });
  const store = new FileCredentialStore(roots.credentialRoot);
  await store.put("credref_recoveryCrash", new StoredCredential({
    version: 1,
    envelopeId: "envl_recoveryCrash",
    connectionId: "pconn_recoveryCrash",
    providerId: "openai_platform",
    authMode: "api_key",
    generation: 3,
    updatedAtMs: 10,
    identity: { status: "unverified" },
    credential: { type: "api_key", apiKey: `retained-original-${suffix}` },
  }));
  const commandId = `cmd_recoveryRetained${suffix}`;
  const arguments_ = [
    recoveryFixture,
    home,
    roots.credentialRoot,
    roots.stagingRoot,
    commandId,
  ];
  const crashed = await processes.run(process.execPath, [...arguments_, "execute"], 20_000, {
    NODE_ENV: "test",
    WI_ALLOW_TEST_FAILPOINTS: "1",
    WI_TEST_FAILPOINT: "after_recovery_prepare",
    WI_TEST_FAILPOINT_COMMAND_ID: commandId,
  });
  expect(crashed.code).toBe(90 + TEST_FAILPOINTS.indexOf("after_recovery_prepare"));
  await rm(join(roots.credentialRoot, "credref_recoveryCrash.json"));
  await store.put("credref_recoveryCrash", new StoredCredential({
    version: 1,
    envelopeId: "envl_changedRecoveryEvidence",
    connectionId: "pconn_changedRecoveryEvidence",
    providerId: "openai_platform",
    authMode: "api_key",
    generation: 99,
    updatedAtMs: 11,
    identity: { status: "unverified" },
    credential: { type: "api_key", apiKey: `retained-changed-${suffix}` },
  }));
  const inspected = await processes.run(
    process.execPath,
    [...arguments_, "inspect"],
    20_000,
    { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
  );
  expect(inspected.code).toBe(0);
  expect(JSON.parse(inspected.stdout) as unknown).toEqual({
    phase: "failed_after_effect",
    failureCode: "credential.recovery_source_changed",
    connectionStatus: "unavailable",
    generation: 3,
    recoveryTombstone: true,
  });
  return { home, roots, commandId, arguments: arguments_ };
}

describe("Milestone 11 provider lifecycle process recovery", () => {
  for (const failpoint of [
    "after_provider_stage_temp_flush",
    "after_provider_stage_rename_before_flush",
    "after_provider_stage_commit",
    "before_provider_provisioning_ref_return",
  ] as const satisfies readonly TestFailpointName[]) {
    it(`cleans an unreturned durable stage after ${failpoint}`, async () => {
      const home = await mkdtemp(join(tmpdir(), "wi-provider-stage-publication-"));
      const stateHome = `${home}-state`;
      homes.push(home, stateHome);
      const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateHome });
      const commandId = `cmd_${failpoint}`;
      const arguments_ = [
        provisioningFixture,
        home,
        roots.credentialRoot,
        roots.stagingRoot,
        commandId,
      ];
      const crashed = await processes.run(
        process.execPath,
        [...arguments_, "execute"],
        20_000,
        {
          NODE_ENV: "test",
          WI_ALLOW_TEST_FAILPOINTS: "1",
          WI_TEST_FAILPOINT: failpoint,
          WI_TEST_FAILPOINT_COMMAND_ID: commandId,
        },
      );
      expect(crashed).toMatchObject({
        code: 90 + TEST_FAILPOINTS.indexOf(failpoint),
        signal: null,
      });
      expect(crashed.stdout).not.toContain("provref_");
      expect(crashed.stdout).not.toContain("process-stage-publication-secret");
      expect(crashed.stderr).not.toContain("provref_");
      expect(crashed.stderr).not.toContain("process-stage-publication-secret");
      await assertSecretAbsentFromRoot(home, "process-stage-publication-secret");

      const inspected = await processes.run(
        process.execPath,
        [...arguments_, "inspect"],
        20_000,
      );
      expect(inspected).toMatchObject({ code: 0, signal: null });
      const line = inspected.stdout.trim().split("\n").at(-1);
      expect(JSON.parse(line ?? "null") as unknown).toEqual({
        stageFilesBefore: failpoint === "after_provider_stage_temp_flush" ? 0 : 1,
        stageFilesAfter: 0,
        temporaryFilesBefore: failpoint === "after_provider_stage_temp_flush" ? 1 : 0,
        temporaryFilesAfter: 0,
        connections: 0,
      });
    });
  }

  it("rejects generated credential and stage FIFOs within a process deadline", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-provider-fifo-process-"));
    const stateHome = `${home}-state`;
    homes.push(home, stateHome);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateHome });
    const credentialFifo = join(roots.credentialRoot, "credref_fifoProcess.json");
    const stageFifo = join(roots.stagingRoot, `stage-${"a".repeat(64)}.json`);
    await execFileAsync("mkfifo", [credentialFifo]);
    await execFileAsync("mkfifo", [stageFifo]);
    await Promise.all([chmod(credentialFifo, 0o600), chmod(stageFifo, 0o600)]);

    for (const [kind, root] of [
      ["credential", roots.credentialRoot],
      ["stage", roots.stagingRoot],
    ] as const) {
      const startedAt = Date.now();
      const result = await processes.run(
        process.execPath,
        [specialFileFixture, root, kind],
        2_000,
      );
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(JSON.parse(result.stdout) as unknown).toEqual({ code: "credential.unsafe_file" });
    }
  });

  it("runs a selected provider with every Node outbound primitive denied", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-provider-no-network-"));
    homes.push(home);
    const result = await processes.run(
      process.execPath,
      [noNetworkFixture, home],
      20_000,
      { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
    );
    expect(result).toMatchObject({ code: 0, signal: null });
    const line = result.stdout.trim().split("\n").at(-1);
    expect(JSON.parse(line ?? "null") as unknown).toEqual({
      state: "completed",
      attempts: [],
    });
  });

  for (const [windowIndex, failpoint] of createCrashWindows.entries()) {
    it(`recovers an identical file-create command after ${failpoint}`, async () => {
      const home = await mkdtemp(join(tmpdir(), `wi-provider-crash-${windowIndex}-`));
      const stateHome = `${home}-state`;
      homes.push(home, stateHome);
      const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateHome });
      const staged = await new CredentialProvisioner(roots.stagingRoot).stageApiKey(
        "openai_platform",
        "api_key",
        `process-private-key-${windowIndex}`,
      );
      const commandId = `cmd_providerCrash${windowIndex}`;
      const arguments_ = [
        fixture,
        home,
        roots.credentialRoot,
        roots.stagingRoot,
        staged.provisioningRef,
        commandId,
      ];
      const crashed = await processes.run(
        process.execPath,
        [...arguments_, "execute"],
        20_000,
        {
          NODE_ENV: "test",
          WI_ALLOW_TEST_FAILPOINTS: "1",
          WI_TEST_FAILPOINT: failpoint,
          WI_TEST_FAILPOINT_COMMAND_ID: commandId,
        },
      );
      expect(crashed).toMatchObject({
        code: 90 + TEST_FAILPOINTS.indexOf(failpoint),
        signal: null,
      });
      expect(crashed.stdout).not.toContain(`process-private-key-${windowIndex}`);
      expect(crashed.stderr).not.toContain(`process-private-key-${windowIndex}`);
      await assertSecretAbsentFromRoot(home, `process-private-key-${windowIndex}`);
      const storeBeforeRestart = new FileCredentialStore(roots.credentialRoot);
      const refsBeforeRestart = await storeBeforeRestart.listRefs();
      expect(refsBeforeRestart.length).toBeLessThanOrEqual(1);
      for (const ref of refsBeforeRestart) {
        await expect(storeBeforeRestart.get(ref)).resolves.not.toBeNull();
      }

      const recovered = await processes.run(process.execPath, [...arguments_, "inspect-detailed"], 20_000, {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
      });
      expect(recovered).toMatchObject({ code: 0, signal: null });
      expect(JSON.parse(recovered.stdout) as unknown).toEqual({
        duplicate: true,
        phase: "succeeded",
        lifecycleStatus: "ready",
        credentialGeneration: 1,
        stagePresent: false,
        credentialFileCount: 1,
        lifecycleOwnerKind: null,
        claimActive: false,
      });
      const repeated = await processes.run(process.execPath, [...arguments_, "inspect-detailed"], 20_000, {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
      });
      expect(repeated.code, repeated.stderr).toBe(0);
      expect(JSON.parse(repeated.stdout) as unknown).toEqual(
        JSON.parse(recovered.stdout) as unknown,
      );
    });
  }

  for (const operationKind of ["create", "replace", "refresh", "reauthenticate"] as const) {
    it(`completes exact published ${operationKind} target when its claimed stage is missing`, async () => {
      const home = await mkdtemp(join(tmpdir(), `wi-${operationKind}-target-without-stage-`));
      const stateHome = `${home}-state`;
      homes.push(home, stateHome);
      const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateHome });
      const provisioner = new CredentialProvisioner(roots.stagingRoot);
      const publication = await provisioner.stageApiKey(
        "openai_platform",
        "api_key",
        `published-${operationKind}-without-stage`,
      );
      const commandId = `cmd_${operationKind}TargetWithoutStage`;
      let arguments_: readonly string[];
      if (operationKind === "create") {
        arguments_ = [
          fixture,
          home,
          roots.credentialRoot,
          roots.stagingRoot,
          publication.provisioningRef,
          commandId,
        ];
      } else {
        const initial = await provisioner.stageApiKey(
          "openai_platform",
          "api_key",
          `initial-${operationKind}-without-stage`,
        );
        const setup = await processes.run(process.execPath, [
          mutationFixture,
          home,
          roots.credentialRoot,
          roots.stagingRoot,
          operationKind,
          initial.provisioningRef,
          `cmd_unused${operationKind}TargetWithoutStage`,
          `pconn_unused${operationKind}TargetWithoutStage`,
          "setup",
        ], 20_000);
        expect(setup.code, setup.stderr).toBe(0);
        const connectionId = String(
          (JSON.parse(setup.stdout) as { readonly connectionId: string }).connectionId,
        );
        arguments_ = [
          mutationFixture,
          home,
          roots.credentialRoot,
          roots.stagingRoot,
          operationKind,
          publication.provisioningRef,
          commandId,
          connectionId,
        ];
      }
      const crashed = await processes.run(
        process.execPath,
        [...arguments_, "execute"],
        20_000,
        {
          NODE_ENV: "test",
          WI_ALLOW_TEST_FAILPOINTS: "1",
          WI_TEST_FAILPOINT: "after_provider_file_effect",
          WI_TEST_FAILPOINT_COMMAND_ID: commandId,
        },
      );
      expect(crashed.code, crashed.stderr).toBe(
        90 + TEST_FAILPOINTS.indexOf("after_provider_file_effect"),
      );
      await provisioner.deleteClaimedInternal(internalStagingRef(publication.provisioningRef));

      const inspected = await processes.run(
        process.execPath,
        [...arguments_, "inspect"],
        20_000,
        { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
      );
      expect(inspected.code, inspected.stderr).toBe(0);
      const result = JSON.parse(inspected.stdout) as Record<string, unknown>;
      if (operationKind === "create") {
        expect(result).toEqual({
          duplicate: true,
          phase: "succeeded",
          lifecycleStatus: "ready",
          credentialGeneration: 1,
          stagePresent: false,
          credentialFileCount: 1,
        });
      } else {
        const expectedGeneration = operationKind === "refresh" ? 1 : 2;
        expect(result).toEqual({
          phase: "succeeded",
          lifecycleStatus: "ready",
          generation: expectedGeneration,
          deleted: false,
          credentialInternalRef: expect.stringMatching(/^credref_/u),
          envelopeId: operationKind === "replace"
            ? expect.stringMatching(/^envl_/u)
            : `envl_${operationKind}Publication`,
          stagePresent: false,
          credentialFileCount: 1,
        });
      }
    });
  }

  it("rejects secret-only claimed-stage replacement after prepare and restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-stage-secret-substitution-restart-"));
    const stateHome = `${home}-state`;
    homes.push(home, stateHome);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateHome });
    const staged = await new CredentialProvisioner(roots.stagingRoot).stageApiKey(
      "openai_platform",
      "api_key",
      "stage-secret-before-prepare",
    );
    const commandId = "cmd_stageSecretSubstitutionRestart";
    const arguments_ = [
      fixture,
      home,
      roots.credentialRoot,
      roots.stagingRoot,
      staged.provisioningRef,
      commandId,
    ];
    const crashed = await processes.run(process.execPath, [...arguments_, "execute"], 20_000, {
      NODE_ENV: "test",
      WI_ALLOW_TEST_FAILPOINTS: "1",
      WI_TEST_FAILPOINT: "after_provider_lifecycle_prepare",
      WI_TEST_FAILPOINT_COMMAND_ID: commandId,
    });
    expect(crashed.code).toBe(90 + TEST_FAILPOINTS.indexOf("after_provider_lifecycle_prepare"));

    const stageRef = internalStagingRef(staged.provisioningRef);
    const stagePath = join(roots.stagingRoot, `${stageRef.replace("stage_", "stage-")}.json`);
    const envelope = JSON.parse(await readFile(stagePath, "utf8")) as Record<string, unknown>;
    envelope.apiKey = "stage-secret-after-prepare";
    const replacementPath = join(roots.stagingRoot, ".stage-secret-substitution");
    await writeFile(replacementPath, JSON.stringify(envelope), { mode: 0o600 });
    await rename(replacementPath, stagePath);

    const inspected = await processes.run(
      process.execPath,
      [...arguments_, "inspect-operation"],
      20_000,
      { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
    );
    expect(inspected.code, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout) as unknown).toEqual({
      phase: "failed",
      failureCode: "credential.binding_mismatch",
      lifecycleStatus: "unavailable",
      credentialGeneration: 1,
      lifecycleOwnerKind: null,
      stagePresent: false,
      credentialFileCount: 0,
    });
  });

  it("terminalizes a prepared lifecycle operation whose target disappeared", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-provider-orphan-lifecycle-"));
    const stateHome = `${home}-state`;
    homes.push(home, stateHome);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateHome });
    const secret = "orphan-lifecycle-private-stage";
    const staged = await new CredentialProvisioner(roots.stagingRoot).stageApiKey(
      "openai_platform",
      "api_key",
      secret,
    );
    const commandId = "cmd_providerOrphanLifecycle";
    const commonArguments = [
      home,
      roots.credentialRoot,
      roots.stagingRoot,
      staged.provisioningRef,
      commandId,
    ];
    const crashed = await processes.run(
      process.execPath,
      [fixture, ...commonArguments, "execute"],
      20_000,
      {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: "after_provider_lifecycle_prepare",
        WI_TEST_FAILPOINT_COMMAND_ID: commandId,
      },
    );
    expect(crashed.code).toBe(90 + TEST_FAILPOINTS.indexOf("after_provider_lifecycle_prepare"));
    const removed = await processes.run(
      process.execPath,
      [orphanLifecycleFixture, ...commonArguments, "remove-target"],
      20_000,
    );
    expect(removed, removed.stderr).toMatchObject({ code: 0, signal: null });
    const inspected = await processes.run(
      process.execPath,
      [orphanLifecycleFixture, ...commonArguments, "inspect"],
      20_000,
    );
    expect(inspected.code, inspected.stderr).toBe(0);
    expect(inspected.stdout).not.toContain(secret);
    expect(inspected.stderr).not.toContain(secret);
    expect(JSON.parse(inspected.stdout) as unknown).toEqual({
      phase: "failed_after_effect",
      failureCode: "provider.connection_not_found",
      retryCode: "provider.connection_not_found",
      ownerCount: 0,
      claimConsumed: true,
      stagePresent: false,
    });
  });

  for (const operationKind of ["replace", "logout", "delete"] as const) {
    const windows = operationKind === "replace"
      ? createCrashWindows
      : destructiveCrashWindows;
    for (const [windowIndex, failpoint] of windows.entries()) {
      it(`recovers file ${operationKind} after ${failpoint}`, async () => {
        const home = await mkdtemp(join(tmpdir(), `wi-${operationKind}-crash-${windowIndex}-`));
        const stateHome = `${home}-state`;
        homes.push(home, stateHome);
        const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateHome });
        const provisioner = new CredentialProvisioner(roots.stagingRoot);
        const initial = await provisioner.stageApiKey(
          "openai_platform",
          "api_key",
          `initial-private-key-${operationKind}-${windowIndex}`,
        );
        const setup = await processes.run(process.execPath, [
          mutationFixture, home, roots.credentialRoot, roots.stagingRoot,
          operationKind, initial.provisioningRef, "cmd_unusedMutation", "pconn_unusedMutation", "setup",
        ], 20_000);
        expect(setup.code).toBe(0);
        const connectionId = String((JSON.parse(setup.stdout) as { connectionId: string }).connectionId);
        const replacement = operationKind === "replace"
          ? await provisioner.stageApiKey(
              "openai_platform",
              "api_key",
              `replacement-private-key-${windowIndex}`,
            )
          : { provisioningRef: "provref_notUsedForDelete" };
        const commandId = `cmd_${operationKind}Crash${windowIndex}`;
        const arguments_ = [
          mutationFixture, home, roots.credentialRoot, roots.stagingRoot,
          operationKind, replacement.provisioningRef, commandId, connectionId,
        ];
        const crashed = await processes.run(
          process.execPath,
          [...arguments_, "execute"],
          20_000,
          {
            NODE_ENV: "test",
            WI_ALLOW_TEST_FAILPOINTS: "1",
            WI_TEST_FAILPOINT: failpoint,
            WI_TEST_FAILPOINT_COMMAND_ID: commandId,
          },
        );
        expect(crashed.code).toBe(90 + TEST_FAILPOINTS.indexOf(failpoint));
        expect(crashed.stdout).not.toContain(`initial-private-key-${operationKind}-${windowIndex}`);
        expect(crashed.stdout).not.toContain(`replacement-private-key-${windowIndex}`);
        expect(crashed.stderr).not.toContain(`initial-private-key-${operationKind}-${windowIndex}`);
        expect(crashed.stderr).not.toContain(`replacement-private-key-${windowIndex}`);
        await assertSecretAbsentFromRoot(
          home,
          `initial-private-key-${operationKind}-${windowIndex}`,
        );
        await assertSecretAbsentFromRoot(home, `replacement-private-key-${windowIndex}`);

        // Observe the namespace before restart: only complete old/new evidence is allowed.
        const storeBeforeRestart = new FileCredentialStore(roots.credentialRoot);
        const refsBeforeRestart = await storeBeforeRestart.listRefs();
        expect(refsBeforeRestart.length).toBeLessThanOrEqual(1);
        for (const ref of refsBeforeRestart) {
          await expect(storeBeforeRestart.get(ref)).resolves.not.toBeNull();
        }

        const inspected = await processes.run(
          process.execPath,
          [...arguments_, "inspect-detailed"],
          20_000,
          { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
        );
        expect(inspected.code).toBe(0);
        const result = JSON.parse(inspected.stdout) as Record<string, unknown>;
        if (operationKind === "replace") {
          expect(result).toEqual({
            phase: "succeeded",
            lifecycleStatus: "ready",
            generation: 2,
            deleted: false,
            credentialInternalRef: expect.stringMatching(/^credref_/u),
            envelopeId: expect.stringMatching(/^envl_/u),
            stagePresent: false,
            credentialFileCount: 1,
            lifecycleOwnerKind: null,
            claimActive: false,
          });
        } else if (operationKind === "logout") {
          expect(result).toEqual({
            phase: "succeeded",
            lifecycleStatus: "reauth_required",
            generation: 1,
            deleted: false,
            credentialInternalRef: null,
            envelopeId: null,
            stagePresent: false,
            credentialFileCount: 0,
            lifecycleOwnerKind: null,
            claimActive: false,
          });
        } else {
          expect(result).toEqual({
            phase: "succeeded",
            lifecycleStatus: "unavailable",
            generation: 1,
            deleted: true,
            credentialInternalRef: null,
            envelopeId: null,
            stagePresent: false,
            credentialFileCount: 0,
            lifecycleOwnerKind: null,
            claimActive: false,
          });
        }

        const retried = await processes.run(
          process.execPath,
          [...arguments_, "execute"],
          20_000,
          { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
        );
        expect(retried.code, retried.stderr).toBe(0);
        const finalInspected = await processes.run(
          process.execPath,
          [...arguments_, "inspect-detailed"],
          20_000,
          { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
        );
        expect(finalInspected.code, finalInspected.stderr).toBe(0);
        expect(JSON.parse(finalInspected.stdout) as unknown).toEqual(result);
      });
    }
  }

  for (const operationKind of ["refresh", "reauthenticate"] as const) {
    for (const [windowIndex, failpoint] of ([
      "after_provider_lifecycle_prepare",
      "after_provider_file_effect",
      "after_provider_file_observed",
      "after_provider_lifecycle_terminal_before_ack",
      "after_provider_stage_cleanup",
    ] as const satisfies readonly TestFailpointName[]).entries()) {
      it(`recovers test-only ${operationKind} publication after ${failpoint}`, async () => {
        const home = await mkdtemp(join(tmpdir(), `wi-${operationKind}-crash-${windowIndex}-`));
        const stateHome = `${home}-state`;
        homes.push(home, stateHome);
        const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateHome });
        const provisioner = new CredentialProvisioner(roots.stagingRoot);
        const initial = await provisioner.stageApiKey(
          "openai_platform",
          "api_key",
          `initial-${operationKind}-${windowIndex}`,
        );
        const setup = await processes.run(process.execPath, [
          mutationFixture, home, roots.credentialRoot, roots.stagingRoot,
          operationKind, initial.provisioningRef, "cmd_unusedFuture", "pconn_unusedFuture", "setup",
        ], 20_000);
        expect(setup.code).toBe(0);
        const connectionId = String(
          (JSON.parse(setup.stdout) as { readonly connectionId: string }).connectionId,
        );
        const publication = await provisioner.stageApiKey(
          "openai_platform",
          "api_key",
          `publication-${operationKind}-${windowIndex}`,
        );
        const commandId = `cmd_${operationKind}Crash${windowIndex}`;
        const arguments_ = [
          mutationFixture, home, roots.credentialRoot, roots.stagingRoot,
          operationKind, publication.provisioningRef, commandId, connectionId,
        ];
        const crashed = await processes.run(
          process.execPath,
          [...arguments_, "execute"],
          20_000,
          {
            NODE_ENV: "test",
            WI_ALLOW_TEST_FAILPOINTS: "1",
            WI_TEST_FAILPOINT: failpoint,
            WI_TEST_FAILPOINT_COMMAND_ID: commandId,
          },
        );
        expect(crashed.code, crashed.stderr).toBe(90 + TEST_FAILPOINTS.indexOf(failpoint));
        const inspected = await processes.run(
          process.execPath,
          [...arguments_, "inspect"],
          20_000,
          { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
        );
        expect(inspected.code).toBe(0);
        expect(JSON.parse(inspected.stdout) as unknown).toEqual({
          phase: "succeeded",
          lifecycleStatus: "ready",
          generation: operationKind === "refresh" ? 1 : 2,
          deleted: false,
          credentialInternalRef: expect.stringMatching(/^credref_/u),
          envelopeId: `envl_${operationKind}Publication`,
          stagePresent: false,
          credentialFileCount: 1,
        });
      });
    }
  }

  it("rejects substituted claimed-stage evidence after replacement prepare", async () => {
    for (const field of ["provisioningId", "providerId", "authMode"] as const) {
      const home = await mkdtemp(join(tmpdir(), `wi-stage-substitution-${field}-`));
      const stateHome = `${home}-state`;
      homes.push(home, stateHome);
      const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateHome });
      const provisioner = new CredentialProvisioner(roots.stagingRoot);
      const initial = await provisioner.stageApiKey(
        "openai_platform",
        "api_key",
        `stage-substitution-initial-${field}`,
      );
      const setup = await processes.run(process.execPath, [
        mutationFixture, home, roots.credentialRoot, roots.stagingRoot,
        "replace", initial.provisioningRef, `cmd_unusedStage${field}`,
        `pconn_unusedStage${field}`, "setup",
      ], 20_000);
      const connectionId = String((JSON.parse(setup.stdout) as { connectionId: string }).connectionId);
      const replacement = await provisioner.stageApiKey(
        "openai_platform",
        "api_key",
        `stage-substitution-intended-${field}`,
      );
      const commandId = `cmd_stageSubstitution${field}`;
      const arguments_ = [
        mutationFixture, home, roots.credentialRoot, roots.stagingRoot,
        "replace", replacement.provisioningRef, commandId, connectionId,
      ];
      const crashed = await processes.run(
        process.execPath,
        [...arguments_, "execute"],
        20_000,
        {
          NODE_ENV: "test",
          WI_ALLOW_TEST_FAILPOINTS: "1",
          WI_TEST_FAILPOINT: "after_provider_lifecycle_prepare",
          WI_TEST_FAILPOINT_COMMAND_ID: commandId,
        },
      );
      expect(crashed.code).toBe(90 + TEST_FAILPOINTS.indexOf("after_provider_lifecycle_prepare"));
      const stageRef = internalStagingRef(replacement.provisioningRef);
      const stagePath = join(roots.stagingRoot, `${stageRef.replace("stage_", "stage-")}.json`);
      const envelope = JSON.parse(await readFile(stagePath, "utf8")) as Record<string, unknown>;
      if (field === "provisioningId") envelope.provisioningId = "prov_substitutedStageEvidence";
      else if (field === "providerId") envelope.providerId = "openai_codex";
      else envelope.authMode = "chatgpt_oauth";
      await writeFile(stagePath, JSON.stringify(envelope), { mode: 0o600 });

      const inspected = await processes.run(
        process.execPath,
        [...arguments_, "inspect"],
        20_000,
        { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
      );
      expect(inspected.code, inspected.stderr).toBe(0);
      expect(JSON.parse(inspected.stdout) as unknown).toMatchObject({
        phase: "failed",
        lifecycleStatus: "ready",
        generation: 1,
        stagePresent: false,
        credentialFileCount: 1,
      });
    }
  });

  it("restores the old generation when a replacement stage is missing after restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-replace-missing-stage-restart-"));
    const stateHome = `${home}-state`;
    homes.push(home, stateHome);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateHome });
    const provisioner = new CredentialProvisioner(roots.stagingRoot);
    const initial = await provisioner.stageApiKey(
      "openai_platform",
      "api_key",
      "missing-restart-initial",
    );
    const setup = await processes.run(process.execPath, [
      mutationFixture, home, roots.credentialRoot, roots.stagingRoot,
      "replace", initial.provisioningRef, "cmd_unusedMissingRestart",
      "pconn_unusedMissingRestart", "setup",
    ], 20_000);
    const connectionId = String((JSON.parse(setup.stdout) as { connectionId: string }).connectionId);
    const missing = await provisioner.stageApiKey(
      "openai_platform",
      "api_key",
      "missing-restart-replacement",
    );
    const commandId = "cmd_replaceMissingRestart";
    const arguments_ = [
      mutationFixture, home, roots.credentialRoot, roots.stagingRoot,
      "replace", missing.provisioningRef, commandId, connectionId,
    ];
    const crashed = await processes.run(
      process.execPath,
      [...arguments_, "execute"],
      20_000,
      {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: "after_provider_lifecycle_prepare",
        WI_TEST_FAILPOINT_COMMAND_ID: commandId,
      },
    );
    expect(crashed.code).toBe(90 + TEST_FAILPOINTS.indexOf("after_provider_lifecycle_prepare"));
    await provisioner.delete(missing.provisioningRef);
    const inspected = await processes.run(
      process.execPath,
      [...arguments_, "inspect"],
      20_000,
      { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
    );
    expect(inspected.code, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout) as unknown).toMatchObject({
      phase: "failed",
      lifecycleStatus: "ready",
      generation: 1,
      stagePresent: false,
      credentialFileCount: 1,
    });

    const retryStage = await provisioner.stageApiKey(
      "openai_platform",
      "api_key",
      "missing-restart-later-replacement",
    );
    const retryArguments = [
      mutationFixture, home, roots.credentialRoot, roots.stagingRoot,
      "replace", retryStage.provisioningRef, "cmd_replaceAfterMissingRestart", connectionId,
    ];
    const replaced = await processes.run(
      process.execPath,
      [...retryArguments, "execute"],
      20_000,
      { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
    );
    expect(replaced.code, replaced.stderr).toBe(0);
    const verified = await processes.run(
      process.execPath,
      [...retryArguments, "inspect"],
      20_000,
      { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
    );
    expect(verified.code, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout) as unknown).toMatchObject({
      phase: "succeeded",
      lifecycleStatus: "ready",
      generation: 2,
      stagePresent: false,
      credentialFileCount: 1,
    });
  });

  it("fails closed when a crash-published replacement keeps only the target envelope ID", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-replace-binding-mismatch-"));
    const stateHome = `${home}-state`;
    homes.push(home, stateHome);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateHome });
    const provisioner = new CredentialProvisioner(roots.stagingRoot);
    const initial = await provisioner.stageApiKey(
      "openai_platform",
      "api_key",
      "binding-mismatch-initial",
    );
    const setup = await processes.run(process.execPath, [
      mutationFixture, home, roots.credentialRoot, roots.stagingRoot,
      "replace", initial.provisioningRef, "cmd_unusedBinding", "pconn_unusedBinding", "setup",
    ], 20_000);
    const connectionId = String((JSON.parse(setup.stdout) as { connectionId: string }).connectionId);
    const replacement = await provisioner.stageApiKey(
      "openai_platform",
      "api_key",
      "binding-mismatch-replacement",
    );
    const commandId = "cmd_replaceBindingMismatch";
    const arguments_ = [
      mutationFixture, home, roots.credentialRoot, roots.stagingRoot,
      "replace", replacement.provisioningRef, commandId, connectionId,
    ];
    const crashed = await processes.run(
      process.execPath,
      [...arguments_, "execute"],
      20_000,
      {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: "after_provider_file_effect",
        WI_TEST_FAILPOINT_COMMAND_ID: commandId,
      },
    );
    expect(crashed.code).toBe(90 + TEST_FAILPOINTS.indexOf("after_provider_file_effect"));

    const [credentialRef] = await new FileCredentialStore(roots.credentialRoot).listRefs();
    if (credentialRef === undefined) throw new Error("Replacement credential file is missing");
    const credentialPath = join(roots.credentialRoot, `${credentialRef}.json`);
    const envelope = JSON.parse(await readFile(credentialPath, "utf8")) as Record<string, unknown>;
    envelope.connectionId = "pconn_wrongBinding";
    await writeFile(credentialPath, JSON.stringify(envelope), { mode: 0o600 });

    const inspected = await processes.run(
      process.execPath,
      [...arguments_, "inspect"],
      20_000,
      { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
    );
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.stdout) as unknown).toEqual({
      phase: "failed_after_effect",
      lifecycleStatus: "unavailable",
      generation: 2,
      deleted: false,
      credentialInternalRef: expect.stringMatching(/^credref_/u),
      envelopeId: expect.stringMatching(/^envl_/u),
      stagePresent: false,
      credentialFileCount: 1,
    });
  });

  it("fails closed when crash-published target metadata contains the wrong secret", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-replace-secret-mismatch-"));
    const stateHome = `${home}-state`;
    homes.push(home, stateHome);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateHome });
    const provisioner = new CredentialProvisioner(roots.stagingRoot);
    const initial = await provisioner.stageApiKey(
      "openai_platform",
      "api_key",
      "secret-mismatch-initial",
    );
    const setup = await processes.run(process.execPath, [
      mutationFixture, home, roots.credentialRoot, roots.stagingRoot,
      "replace", initial.provisioningRef, "cmd_unusedSecret", "pconn_unusedSecret", "setup",
    ], 20_000);
    const connectionId = String((JSON.parse(setup.stdout) as { connectionId: string }).connectionId);
    const replacement = await provisioner.stageApiKey(
      "openai_platform",
      "api_key",
      "secret-mismatch-intended",
    );
    const commandId = "cmd_replaceSecretMismatch";
    const arguments_ = [
      mutationFixture, home, roots.credentialRoot, roots.stagingRoot,
      "replace", replacement.provisioningRef, commandId, connectionId,
    ];
    const crashed = await processes.run(
      process.execPath,
      [...arguments_, "execute"],
      20_000,
      {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: "after_provider_file_effect",
        WI_TEST_FAILPOINT_COMMAND_ID: commandId,
      },
    );
    expect(crashed.code).toBe(90 + TEST_FAILPOINTS.indexOf("after_provider_file_effect"));

    const [credentialRef] = await new FileCredentialStore(roots.credentialRoot).listRefs();
    if (credentialRef === undefined) throw new Error("Replacement credential file is missing");
    const credentialPath = join(roots.credentialRoot, `${credentialRef}.json`);
    const envelope = JSON.parse(await readFile(credentialPath, "utf8")) as {
      credential: { apiKey: string };
    };
    envelope.credential.apiKey = "secret-mismatch-wrong";
    await writeFile(credentialPath, JSON.stringify(envelope), { mode: 0o600 });

    const inspected = await processes.run(
      process.execPath,
      [...arguments_, "inspect"],
      20_000,
      { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
    );
    expect(inspected.code, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout) as unknown).toMatchObject({
      phase: "failed_after_effect",
      lifecycleStatus: "unavailable",
      generation: 2,
      stagePresent: false,
      credentialFileCount: 1,
    });
    expect(await readFile(credentialPath, "utf8")).toContain("secret-mismatch-wrong");
  });

  it("interrupts an accepted environment-backed run across backend restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-environment-restart-"));
    homes.push(home);
    const commandId = "cmd_environmentRestartSubmit";
    const crashed = await processes.run(
      process.execPath,
      [environmentRestartFixture, home, "execute"],
      20_000,
      {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_PROCESS_PROVIDER_KEY: "process-private-environment-key",
        WI_TEST_FAILPOINT: "after_environment_run_acceptance_before_request",
        WI_TEST_FAILPOINT_COMMAND_ID: commandId,
      },
    );
    expect(crashed.code).toBe(
      90 + TEST_FAILPOINTS.indexOf("after_environment_run_acceptance_before_request"),
    );
    const inspected = await processes.run(
      process.execPath,
      [environmentRestartFixture, home, "inspect"],
      20_000,
      {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_PROCESS_PROVIDER_KEY: "process-private-environment-key",
      },
    );
    expect(inspected.code).toBe(0);
    const summaryLine = inspected.stdout.trim().split("\n").at(-1)!;
    expect(JSON.parse(summaryLine) as unknown).toMatchObject({
      runState: "interrupted",
      providerRequests: 0,
      backendProcessEpoch: expect.stringMatching(/^process_/u),
    });
  });

  it("revalidates an unavailable environment connection during restart recovery", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-environment-revalidation-prepared-"));
    homes.push(home);
    const crashed = await processes.run(
      process.execPath,
      [environmentRevalidationFixture, home, "execute-prepared"],
      20_000,
      {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: "after_provider_lifecycle_prepare",
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_environmentRevalidateProcess",
      },
    );
    expect(crashed.code).toBe(
      90 + TEST_FAILPOINTS.indexOf("after_provider_lifecycle_prepare"),
    );
    const inspected = await processes.run(
      process.execPath,
      [environmentRevalidationFixture, home, "inspect"],
      20_000,
      {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_REVALIDATE_PROCESS_KEY: "process-environment-revalidated",
      },
    );
    expect(inspected.code, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout.trim().split("\n").at(-1)!) as unknown).toMatchObject({
      lifecycleStatus: "ready",
      lifecycleRevision: 2,
      credentialGeneration: 1,
      lifecycleOwnerKind: null,
      operationPhase: "succeeded",
      providerRequests: 0,
    });
  });

  it("persists a successful environment revalidation across restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-environment-revalidation-success-"));
    homes.push(home);
    const executed = await processes.run(
      process.execPath,
      [environmentRevalidationFixture, home, "execute-success"],
      20_000,
      { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
    );
    expect(executed.code, executed.stderr).toBe(0);
    expect(JSON.parse(executed.stdout.trim().split("\n").at(-1)!) as unknown).toMatchObject({
      accepted: true,
      lifecycleStatus: "ready",
      lifecycleRevision: 2,
      credentialGeneration: 1,
      providerRequests: 0,
    });
    const inspected = await processes.run(
      process.execPath,
      [environmentRevalidationFixture, home, "inspect"],
      20_000,
      {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_REVALIDATE_PROCESS_KEY: "process-environment-revalidated",
      },
    );
    expect(inspected.code, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout.trim().split("\n").at(-1)!) as unknown).toMatchObject({
      lifecycleStatus: "ready",
      lifecycleRevision: 2,
      credentialGeneration: 1,
      lifecycleOwnerKind: null,
      operationPhase: "succeeded",
      providerRequests: 0,
    });
  });

  it("continues multi-envelope catalog-loss recovery across child-process restart", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-recovery-multi-process-"));
    const stateHome = `${home}-state`;
    homes.push(home, stateHome);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateHome });
    const store = new FileCredentialStore(roots.credentialRoot);
    for (const [suffix, connectionId] of [
      ["Crash", "pconn_recoveryCrash"],
      ["Second", "pconn_recoverySecond"],
    ] as const) {
      await store.put(`credref_recovery${suffix}`, new StoredCredential({
        version: 1,
        envelopeId: `envl_recovery${suffix}`,
        connectionId,
        providerId: "openai_platform",
        authMode: "api_key",
        generation: suffix === "Crash" ? 3 : 4,
        updatedAtMs: suffix === "Crash" ? 10 : 20,
        identity: { status: "unverified" },
        credential: { type: "api_key", apiKey: `multi-process-${suffix}-secret` },
      }));
    }
    const first = await processes.run(process.execPath, [
      recoveryFixture, home, roots.credentialRoot, roots.stagingRoot,
      "cmd_recoveryMultiFirst", "execute",
    ], 20_000, { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" });
    expect(first.code).toBe(0);
    const second = await processes.run(process.execPath, [
      recoveryFixture, home, roots.credentialRoot, roots.stagingRoot,
      "cmd_recoveryMultiSecond", "execute-second",
    ], 20_000, { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" });
    expect(second.code).toBe(0);
    const inspected = await processes.run(process.execPath, [
      recoveryFixture, home, roots.credentialRoot, roots.stagingRoot,
      "cmd_recoveryMultiSecond", "inspect",
    ], 20_000, { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" });
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.stdout) as unknown).toMatchObject({
      phase: "succeeded",
      failureCode: null,
    });
  });

  it("replaces a recovery tombstone while preserving retained changed evidence", async () => {
    const setup = await prepareRetainedRecoveryTombstone("Direct");
    const replaced = await processes.run(
      process.execPath,
      [...setup.arguments, "replace"],
      20_000,
      { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
    );
    expect(replaced.code).toBe(0);
    expect(JSON.parse(replaced.stdout) as unknown).toMatchObject({
      connectionStatus: "ready",
      generation: 4,
      recoveryTombstone: false,
      credentialInternalRef: expect.stringMatching(/^credref_/u),
      refs: expect.arrayContaining(["credref_recoveryCrash"]),
      retainedConnectionId: "pconn_changedRecoveryEvidence",
      retainedEnvelopeId: "envl_changedRecoveryEvidence",
    });
    const result = JSON.parse(replaced.stdout) as {
      credentialInternalRef: string;
      refs: string[];
    };
    expect(result.credentialInternalRef).not.toBe("credref_recoveryCrash");
    expect(result.refs).toHaveLength(2);
  });

  for (const [windowIndex, failpoint] of createCrashWindows.entries()) {
    it(`recovers retained-evidence tombstone replacement after ${failpoint}`, async () => {
      const setup = await prepareRetainedRecoveryTombstone(`Crash${windowIndex}`);
      const staged = await new CredentialProvisioner(setup.roots.stagingRoot).stageApiKey(
        "openai_platform",
        "api_key",
        `retained-replacement-${windowIndex}`,
      );
      const replacementCommandId = `${setup.commandId}Replacement`;
      const replaceArguments = [
        ...setup.arguments,
        "replace",
        staged.provisioningRef,
      ];
      const crashed = await processes.run(process.execPath, replaceArguments, 20_000, {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: failpoint,
        WI_TEST_FAILPOINT_COMMAND_ID: replacementCommandId,
      });
      expect(crashed.code).toBe(90 + TEST_FAILPOINTS.indexOf(failpoint));
      const retried = await processes.run(
        process.execPath,
        replaceArguments,
        20_000,
        { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
      );
      expect(retried.code, retried.stderr).toBe(0);
      const result = JSON.parse(retried.stdout) as {
        connectionStatus: string;
        generation: number;
        recoveryTombstone: boolean;
        credentialInternalRef: string;
        refs: string[];
        retainedConnectionId: string;
        retainedEnvelopeId: string;
      };
      expect(result).toMatchObject({
        connectionStatus: "ready",
        generation: 4,
        recoveryTombstone: false,
        credentialInternalRef: expect.stringMatching(/^credref_/u),
        refs: expect.arrayContaining(["credref_recoveryCrash"]),
        retainedConnectionId: "pconn_changedRecoveryEvidence",
        retainedEnvelopeId: "envl_changedRecoveryEvidence",
      });
      expect(result.credentialInternalRef).not.toBe("credref_recoveryCrash");
      expect(result.refs).toHaveLength(2);
    });
  }

  it("tombstones recovery when only API-key bytes change after claim and prepare", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-recovery-secret-change-"));
    const stateHome = `${home}-state`;
    homes.push(home, stateHome);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateHome });
    const store = new FileCredentialStore(roots.credentialRoot);
    const internalRef = "credref_recoveryCrash";
    const original = new StoredCredential({
      version: 1,
      envelopeId: "envl_recoveryCrash",
      connectionId: "pconn_recoveryCrash",
      providerId: "openai_platform",
      authMode: "api_key",
      generation: 3,
      updatedAtMs: 10,
      identity: { status: "unverified" },
      credential: { type: "api_key", apiKey: "recovery-secret-before-claim" },
    });
    await store.put(internalRef, original);
    const commandId = "cmd_recoverySecretChangedAfterPrepare";
    const arguments_ = [
      recoveryFixture,
      home,
      roots.credentialRoot,
      roots.stagingRoot,
      commandId,
    ];
    const crashed = await processes.run(process.execPath, [...arguments_, "execute"], 20_000, {
      NODE_ENV: "test",
      WI_ALLOW_TEST_FAILPOINTS: "1",
      WI_TEST_FAILPOINT: "after_recovery_prepare",
      WI_TEST_FAILPOINT_COMMAND_ID: commandId,
    });
    expect(crashed.code).toBe(90 + TEST_FAILPOINTS.indexOf("after_recovery_prepare"));

    await store.replaceBound(internalRef, {
      connectionId: original.metadata.connectionId,
      providerId: original.metadata.providerId,
      authMode: original.metadata.authMode,
      generation: original.metadata.generation,
      envelopeId: original.metadata.envelopeId,
    }, new StoredCredential({
      ...original.toEnvelopeForStore(),
      credential: { type: "api_key", apiKey: "recovery-secret-after-claim" },
    }));

    const inspected = await processes.run(
      process.execPath,
      [...arguments_, "inspect-binding"],
      20_000,
      { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
    );
    expect(inspected.code, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout) as unknown).toEqual({
      phase: "failed_after_effect",
      failureCode: "credential.recovery_source_changed",
      connectionStatus: "unavailable",
      generation: 3,
      recoveryTombstone: true,
      credentialInternalRef: internalRef,
    });
    const retained = await store.get(internalRef);
    expect(retained?.metadata).toEqual(original.metadata);
    expect(retained?.withApiKey((apiKey) => apiKey)).toBe("recovery-secret-after-claim");
    await expect(store.listRefs()).resolves.toEqual([internalRef]);
  });

  for (const [windowIndex, failpoint] of ([
    "after_recovery_admission",
    "after_recovery_prepare",
  ] as const satisfies readonly TestFailpointName[]).entries()) {
    it(`reconciles credential recovery after ${failpoint}`, async () => {
      const home = await mkdtemp(join(tmpdir(), `wi-recovery-crash-${windowIndex}-`));
      const stateHome = `${home}-state`;
      homes.push(home, stateHome);
      const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateHome });
      await new FileCredentialStore(roots.credentialRoot).put(
        "credref_recoveryCrash",
        new StoredCredential({
          version: 1,
          envelopeId: "envl_recoveryCrash",
          connectionId: "pconn_recoveryCrash",
          providerId: "openai_platform",
          authMode: "api_key",
          generation: 3,
          updatedAtMs: 10,
          identity: { status: "unverified" },
          credential: { type: "api_key", apiKey: `recovery-private-key-${windowIndex}` },
        }),
      );
      const commandId = `cmd_recoveryCrash${windowIndex}`;
      const arguments_ = [
        recoveryFixture,
        home,
        roots.credentialRoot,
        roots.stagingRoot,
        commandId,
      ];
      const crashed = await processes.run(
        process.execPath,
        [...arguments_, "execute"],
        20_000,
        {
          NODE_ENV: "test",
          WI_ALLOW_TEST_FAILPOINTS: "1",
          WI_TEST_FAILPOINT: failpoint,
          WI_TEST_FAILPOINT_COMMAND_ID: commandId,
        },
      );
      expect(crashed.code).toBe(90 + TEST_FAILPOINTS.indexOf(failpoint));

      const inspected = await processes.run(
        process.execPath,
        [...arguments_, "inspect"],
        20_000,
        { NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" },
      );
      expect(inspected.code).toBe(0);
      const result = JSON.parse(inspected.stdout) as Record<string, unknown>;
      if (failpoint === "after_recovery_admission") {
        expect(result).toEqual({
          phase: "failed",
          failureCode: "credential.recovery_ref_expired",
          connectionStatus: null,
          generation: null,
          recoveryTombstone: null,
        });
      } else {
        expect(result).toEqual({
          phase: "succeeded",
          failureCode: null,
          connectionStatus: "ready",
          generation: 3,
          recoveryTombstone: false,
        });
      }
    });
  }
});
