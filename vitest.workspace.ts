import { fileURLToPath } from "node:url";

import { defineWorkspace } from "vitest/config";

const protocolSource = fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url));

export default defineWorkspace([
  {
    resolve: {
      alias: {
        "@wi/protocol": protocolSource,
      },
    },
    test: {
      name: "unit",
      environment: "node",
      include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
      pool: "threads",
      poolOptions: { threads: { singleThread: true } },
    },
  },
  {
    test: {
      name: "architecture",
      environment: "node",
      include: ["tests/architecture/**/*.test.ts", "tests/preflight/**/*.test.ts"],
      pool: "threads",
      poolOptions: { threads: { singleThread: true } },
      testTimeout: 10_000,
    },
  },
  {
    test: {
      name: "integration",
      environment: "node",
      include: ["tests/integration/**/*.test.ts"],
      pool: "threads",
      poolOptions: { threads: { singleThread: true } },
    },
  },
  {
    test: {
      name: "property",
      environment: "node",
      include: ["tests/property/**/*.test.ts"],
      setupFiles: ["tests/property/support/fuzz-artifacts-setup.ts"],
      ...(process.env.WI_FUZZ_PROFILE === undefined || process.env.WI_FUZZ_PROFILE === "property"
        ? { pool: "threads" as const, poolOptions: { threads: { singleThread: true } } }
        : {}),
      // Property gates share CI capacity with worker/process suites and must finish
      // their deterministic counterexample before reporting a timeout.
      testTimeout: 15_000,
    },
  },
  {
    test: {
      name: "process",
      environment: "node",
      include: ["tests/process/**/*.test.ts"],
      // Process fixtures already exercise concurrency internally. Explicitly select
      // one project thread so process files cannot overlap under the workspace gate.
      pool: "threads",
      poolOptions: { threads: { singleThread: true } },
      testTimeout: 15_000,
    },
  },
]);
