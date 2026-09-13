import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const profile = process.argv[2];
if (profile !== "local" && profile !== "extended") {
  process.stderr.write("Usage: node scripts/run-fuzz.mjs <local|extended> [vitest arguments...]\n");
  process.exit(64);
}

const forwardedArguments = process.argv.slice(3);
if (forwardedArguments[0] === "--") forwardedArguments.shift();
let commandLineDuration;
const extraArguments = [];
for (let index = 0; index < forwardedArguments.length; index += 1) {
  const argument = forwardedArguments[index];
  if (argument === "--duration") {
    commandLineDuration = forwardedArguments[index + 1] ?? "";
    index += 1;
  } else if (argument?.startsWith("--duration=")) {
    commandLineDuration = argument.slice("--duration=".length);
  } else if (argument !== undefined) {
    extraArguments.push(argument);
  }
}

function durationMilliseconds(raw) {
  if (raw === undefined) return undefined;
  const match = /^(\d+)(ms|s|m)?$/u.exec(raw);
  if (match === null) return Number.NaN;
  const value = Number(match[1]);
  const unit = match[2] ?? "ms";
  if (unit === "m") return value * 60_000;
  if (unit === "s") return value * 1_000;
  return value;
}

const defaultDurationMs = profile === "local" ? 60_000 : 600_000;
const configuredDuration = commandLineDuration ?? process.env.WI_FUZZ_DURATION_MS;
const durationMs = durationMilliseconds(configuredDuration) ?? defaultDurationMs;
if (!Number.isSafeInteger(durationMs) || durationMs < 1_000 || durationMs > 86_400_000) {
  process.stderr.write("Fuzz duration must be between 1000ms and 86400000ms\n");
  process.exit(64);
}

const maximumFastCheckSeed = 2_147_483_647;
const rawSeed = process.env.WI_FC_SEED ?? "737373";
const seed = Number(rawSeed);
if (!Number.isSafeInteger(seed) || seed < 1 || seed > maximumFastCheckSeed) {
  process.stderr.write(`WI_FC_SEED must be between 1 and ${maximumFastCheckSeed}\n`);
  process.exit(64);
}

const environment = {
  ...process.env,
  WI_FC_SEED: String(seed),
  WI_FUZZ_PROFILE: profile,
};

process.stdout.write(
  `Wi ${profile} fuzz profile: duration=${durationMs}ms seed=${seed} ` +
    `artifacts=.artifacts/fuzz/\n`,
);

function run(command, arguments_, childEnvironment = environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: process.cwd(),
      env: childEnvironment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${command} terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

const buildCode = await run("pnpm", ["build:test-deps"]);
if (buildCode !== 0) process.exit(buildCode);
// Vitest's worker RPC expects a file-level result within roughly one minute.
// Cap each round's shared fast-check interruption budget at 5 seconds per core property.
// Durable histories and fixed-run companions finish their current work, so end-to-end
// round wall time may exceed this budget.
const maximumRoundDurationMs = 45_000;
const fuzzTestFiles = [
  "tests/property/milestone8-hardening.test.ts",
  "tests/property/milestone8-durable-models.test.ts",
  "tests/property/storage-idempotency.test.ts",
  "tests/property/storage-event-store.test.ts",
  "tests/property/harness-core.test.ts",
  "tests/property/client-reducer.test.ts",
  "tests/property/provider-lifecycle.test.ts",
  "tests/property/provider-credential-evidence.test.ts",
  "tests/property/provider-control-plane-model.test.ts",
  "tests/property/milestone5-gateway.test.ts",
  "tests/property/milestone4-agent-loop-model.test.ts",
];
const fuzzStartedAt = performance.now();
let round = 0;
while (performance.now() - fuzzStartedAt < durationMs) {
  round += 1;
  const elapsedMs = performance.now() - fuzzStartedAt;
  const remainingDurationMs = Math.max(1_000, Math.ceil(durationMs - elapsedMs));
  const roundDurationMs = Math.min(remainingDurationMs, maximumRoundDurationMs);
  const roundSeed = ((seed - 1 + round - 1) % maximumFastCheckSeed) + 1;
  process.stdout.write(
    `Fuzz round ${round}: duration=${roundDurationMs}ms seed=${roundSeed}\n`,
  );
  const testCode = await run(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--workspace",
      "vitest.workspace.ts",
      "--project",
      "property",
      "--testTimeout",
      String(roundDurationMs + 60_000),
      ...fuzzTestFiles,
      ...extraArguments,
    ],
    {
      ...environment,
      WI_FC_SEED: String(roundSeed),
      WI_M4_AGENT_FC_SEED: String(roundSeed),
      WI_FUZZ_DURATION_MS: String(roundDurationMs),
    },
  );
  if (testCode !== 0) process.exit(testCode);
  process.stdout.write(
    `Fuzz elapsed: ${Math.floor(performance.now() - fuzzStartedAt)}ms / ${durationMs}ms\n`,
  );
}
process.exit(0);
