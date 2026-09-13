import { readdir } from "node:fs/promises";

import { initializeCredentialRoots } from "../../packages/credentials/dist/index.js";

const [homeDirectory, credentialRoot, stagingRoot, mode] = process.argv.slice(2);
if ([homeDirectory, credentialRoot, stagingRoot, mode].some((value) => value === undefined)) {
  process.exit(64);
}
if (!new Set(["crash-source", "crash-rename", "inspect"]).has(mode)) process.exit(65);

const crash = () => process.kill(process.pid, "SIGKILL");
try {
  const roots = await initializeCredentialRoots({
    wiHome: homeDirectory,
    credentialRoot,
    stagingRoot,
    ...(mode === "inspect"
      ? {}
      : {
          probeHooks: mode === "crash-source"
            ? { afterSourceSync: crash }
            : { afterRename: crash },
        }),
  });
  const entries = await readdir(roots.credentialRoot);
  process.stdout.write(`${JSON.stringify({
    status: "ready",
    probeFiles: entries.filter((name) => name.startsWith(".wi-probe-")),
    entries,
  })}\n`);
  process.exit(0);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: "rejected",
    code: typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "unknown",
  })}\n`);
  process.exit(2);
}
