import {
  CredentialProvisioner,
  FileCredentialStore,
} from "../../packages/credentials/dist/index.js";

const [root, kind] = process.argv.slice(2);
if (root === undefined || (kind !== "credential" && kind !== "stage")) process.exit(64);
try {
  if (kind === "credential") {
    await new FileCredentialStore(root).get("credref_fifoProcess");
  } else {
    await new CredentialProvisioner(root).readClaimedInternal(`stage_${"a".repeat(64)}`);
  }
  process.stdout.write("unexpected-success\n");
  process.exit(2);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ code: error?.code ?? null })}\n`);
}
