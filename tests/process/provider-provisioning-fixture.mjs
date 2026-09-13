import { readdir } from "node:fs/promises";

import {
  createTestFailpointController,
  WiRuntime,
} from "../../apps/server/dist/index.js";
import { CredentialProvisioner } from "../../packages/credentials/dist/index.js";

const [homeDirectory, credentialRoot, stagingRoot, commandId, mode] = process.argv.slice(2);
if ([homeDirectory, credentialRoot, stagingRoot, commandId, mode].some((value) => value === undefined)) {
  process.exit(64);
}
if (mode !== "execute" && mode !== "inspect") process.exit(65);

if (mode === "execute") {
  const failpoint = createTestFailpointController(process.env);
  const provisioner = new CredentialProvisioner(
    stagingRoot,
    Date.now,
    undefined,
    {
      afterTemporaryFileSync: () => failpoint?.hit(
        "after_provider_stage_temp_flush",
        { commandId },
      ),
      afterStageRenameBeforeFlush: () => failpoint?.hit(
        "after_provider_stage_rename_before_flush",
        { commandId },
      ),
      afterStageCommit: () => failpoint?.hit("after_provider_stage_commit", { commandId }),
      beforeProvisioningRefReturn: () => failpoint?.hit(
        "before_provider_provisioning_ref_return",
        { commandId },
      ),
    },
  );
  const result = await provisioner.stageApiKey(
    "openai_platform",
    "api_key",
    "process-stage-publication-secret",
  );
  process.stdout.write(`${JSON.stringify({ returned: true, provisioningRef: result.provisioningRef })}\n`);
  process.exit(0);
}

const entriesBefore = await readdir(stagingRoot);
const stageFilesBefore = entriesBefore.filter((name) => name.startsWith("stage-"));
const temporaryFilesBefore = entriesBefore.filter((name) => name.startsWith(".tmp-stage-"));
const runtime = new WiRuntime({
  homeDirectory,
  credentialRoots: { credentialRoot, stagingRoot },
  now: () => Date.now() + 16 * 60 * 1_000,
});
await runtime.ready();
const entriesAfter = await readdir(stagingRoot);
const stageFilesAfter = entriesAfter.filter((name) => name.startsWith("stage-"));
const temporaryFilesAfter = entriesAfter.filter((name) => name.startsWith(".tmp-stage-"));
const connections = await runtime.storage.catalog.listProviderConnections();
process.stdout.write(`${JSON.stringify({
  stageFilesBefore: stageFilesBefore.length,
  stageFilesAfter: stageFilesAfter.length,
  temporaryFilesBefore: temporaryFilesBefore.length,
  temporaryFilesAfter: temporaryFilesAfter.length,
  connections: connections.connections.length,
})}\n`);
await runtime.close();
