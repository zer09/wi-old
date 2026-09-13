import { join } from "node:path";

import Database from "../../packages/storage/node_modules/better-sqlite3/lib/index.js";

import { WiRuntime } from "../../apps/server/dist/index.js";
import { CredentialProvisioner } from "../../packages/credentials/dist/index.js";

const [homeDirectory, credentialRoot, stagingRoot, provisioningRef, commandId, mode] =
  process.argv.slice(2);
if (
  [homeDirectory, credentialRoot, stagingRoot, provisioningRef, commandId, mode]
    .some((value) => value === undefined)
) {
  process.exit(64);
}
if (mode !== "remove-target" && mode !== "inspect") process.exit(65);

const databasePath = join(homeDirectory, "catalog.sqlite3");
if (mode === "remove-target") {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  const operation = database.prepare(
    "SELECT target_connection_id AS connectionId FROM provider_lifecycle_operations WHERE command_id = ?",
  ).get(commandId);
  if (operation === undefined) throw new Error("Prepared lifecycle operation is missing");
  database.prepare("DELETE FROM provider_connections WHERE connection_id = ?")
    .run(operation.connectionId);
  database.close();
  process.stdout.write("target-removed\n");
  process.exit(0);
}

const runtime = new WiRuntime({
  homeDirectory,
  credentialRoots: { credentialRoot, stagingRoot },
});
await runtime.ready();
const operation = await runtime.storage.catalog.getProviderLifecycleOperation(commandId);
let retryCode = null;
try {
  await runtime.providerConnections.route({
    v: 1,
    kind: "command",
    commandId,
    method: "providerConnection.file.create",
    params: {
      providerId: "openai_platform",
      authMode: "api_key",
      displayName: "Crash-recovered file connection",
      provisioningRef,
    },
  });
} catch (error) {
  retryCode = error?.code ?? null;
}
let stagePresent = true;
try {
  await new CredentialProvisioner(stagingRoot).read(provisioningRef, {
    allowExpiredClaimed: true,
  });
} catch (error) {
  if (error?.code === "credential.stage_missing") stagePresent = false;
  else throw error;
}
await runtime.close();

const database = new Database(databasePath, { readonly: true });
const owner = database.prepare(
  "SELECT COUNT(*) AS count FROM provider_lifecycle_owners WHERE command_id = ?",
).get(commandId);
const claim = database.prepare(
  "SELECT consumed_at_ms AS consumedAtMs FROM provider_credential_claims WHERE command_id = ?",
).get(commandId);
database.close();
process.stdout.write(`${JSON.stringify({
  phase: operation?.phase ?? null,
  failureCode: operation?.failureCode ?? null,
  retryCode,
  ownerCount: owner.count,
  claimConsumed: claim?.consumedAtMs !== null && claim?.consumedAtMs !== undefined,
  stagePresent,
})}\n`);
