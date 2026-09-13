import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

const workspaceDirectories = [
  "apps/server",
  "apps/web",
  "packages/protocol",
  "packages/storage",
  "packages/provider-contract",
  "packages/provider-connections",
  "packages/credentials",
  "packages/provider-fake",
  "packages/tools",
  "packages/harness-core",
  "packages/client-state",
  "packages/test-support",
] as const;

const allowedInternalDependencies: Readonly<Record<string, readonly string[]>> = {
  "@wi/protocol": [],
  "@wi/storage": ["@wi/protocol"],
  "@wi/provider-contract": ["@wi/protocol"],
  "@wi/provider-connections": ["@wi/protocol"],
  "@wi/credentials": ["@wi/protocol"],
  "@wi/provider-fake": ["@wi/protocol", "@wi/provider-contract"],
  "@wi/tools": ["@wi/protocol"],
  "@wi/harness-core": [
    "@wi/protocol",
    "@wi/provider-contract",
    "@wi/storage",
    "@wi/tools",
  ],
  "@wi/client-state": ["@wi/protocol"],
  "@wi/test-support": ["@wi/protocol"],
  "@wi/server": [
    "@wi/protocol",
    "@wi/storage",
    "@wi/provider-contract",
    "@wi/provider-connections",
    "@wi/credentials",
    "@wi/provider-fake",
    "@wi/tools",
    "@wi/harness-core",
  ],
  "@wi/web": ["@wi/protocol", "@wi/client-state"],
};

interface PackageManifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const universallyForbiddenModules = [
  "openai",
  "@openai/",
  "codex-app-server",
  "codex_app_server",
  "eventsource",
] as const;

const packageSpecificForbiddenModules: Readonly<Record<string, readonly string[]>> = {
  "@wi/protocol": ["@wi/server", "@wi/storage", "@wi/provider-contract", "@wi/provider-connections", "@wi/credentials", "@wi/provider-fake"],
  "@wi/provider-connections": ["node:dns", "node:net", "node:tls", "node:http", "node:https", "undici"],
  "@wi/credentials": ["node:dns", "node:net", "node:tls", "node:http", "node:https", "undici"],
  "@wi/client-state": ["@wi/server", "@wi/storage"],
};

const nodeBuiltinRoots = new Set(
  builtinModules.map((module) => module.replace(/^node:/, "").split("/")[0]),
);

const harnessImplementationPatterns = [
  /^(?:fastify(?:-|\/|$)|@fastify\/)/,
  /^(?:react(?:-|\/|$)|@react\/)/,
  /(?:^|[-_/:])sqlite(?:3)?(?:[-_/:]|$)/,
  /^sql\.js(?:\/|$)/,
  /^@libsql\//,
] as const;

function manifestAt(directory: string): PackageManifest {
  return JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")) as PackageManifest;
}

function actualWorkspaceDirectories(): string[] {
  return ["apps", "packages"].flatMap((workspaceRoot) =>
    readdirSync(join(root, workspaceRoot))
      .filter((entry) => existsSync(join(root, workspaceRoot, entry, "package.json")))
      .map((entry) => join(workspaceRoot, entry)),
  );
}

function productionDependencies(manifest: PackageManifest): string[] {
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  });
}

function sourceFiles(directory: string): string[] {
  const absolute = join(root, directory);
  const files: string[] = [];

  for (const entry of readdirSync(absolute)) {
    const path = join(absolute, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(relative(root, path)));
    } else if (/\.[cm]?[jt]sx?$/.test(entry)) {
      files.push(path);
    }
  }

  return files;
}

function importedSpecifiers(source: string, fileName: string): string[] {
  const imports: string[] = [];
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    }

    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const firstArgument = node.arguments[0];
      if ((isDynamicImport || isRequire) && firstArgument !== undefined && ts.isStringLiteralLike(firstArgument)) {
        imports.push(firstArgument.text);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

function internalPackageName(specifier: string): string | undefined {
  const match = /^(@wi\/[^/]+)/.exec(specifier);
  return match?.[1];
}

function moduleIsForbidden(specifier: string, packageName: string): boolean {
  const normalized = specifier.toLowerCase();
  const forbiddenModules = [
    ...universallyForbiddenModules,
    ...(packageSpecificForbiddenModules[packageName] ?? []),
  ];

  const builtinRoot = normalized.replace(/^node:/, "").split("/")[0];
  if (packageName === "@wi/protocol" && builtinRoot !== undefined && nodeBuiltinRoots.has(builtinRoot)) {
    return true;
  }

  if (
    packageName === "@wi/harness-core" &&
    harnessImplementationPatterns.some((pattern) => pattern.test(normalized))
  ) {
    return true;
  }

  return forbiddenModules.some(
    (forbidden) =>
      normalized === forbidden ||
      normalized.startsWith(forbidden.endsWith("/") ? forbidden : `${forbidden}/`),
  );
}

function isTestSource(file: string): boolean {
  return /\.test\.ts$/.test(file);
}

function allowedInternalDependenciesForSource(packageName: string, file: string): readonly string[] {
  const packageAllowed = allowedInternalDependencies[packageName] ?? [];
  return isTestSource(file) ? [...packageAllowed, "@wi/test-support"] : packageAllowed;
}

describe("workspace architecture", () => {
  it("contains exactly the planned package skeletons", () => {
    expect(actualWorkspaceDirectories().sort()).toEqual([...workspaceDirectories].sort());

    const names = workspaceDirectories.map((directory) => manifestAt(directory).name);
    expect(new Set(names).size).toBe(workspaceDirectories.length);
    expect(names.sort()).toEqual(Object.keys(allowedInternalDependencies).sort());
  });

  it("detects static, side-effect, exported, dynamic, and require imports", () => {
    const source = [
      'import value from "static-import";',
      'import "side-effect-import";',
      'export { value } from "exported-import";',
      'void import("dynamic-import");',
      'require("required-import");',
    ].join("\n");

    expect(importedSpecifiers(source, "fixture.ts")).toEqual([
      "static-import",
      "side-effect-import",
      "exported-import",
      "dynamic-import",
      "required-import",
    ]);
  });

  it.each(["node:crypto", "fs/promises"])(
    "rejects Node builtin %s from the browser-safe protocol package",
    (specifier) => {
      expect(moduleIsForbidden(specifier, "@wi/protocol")).toBe(true);
    },
  );

  it.each([
    "fastify",
    "@fastify/websocket",
    "react",
    "react-dom",
    "better-sqlite3",
    "node:sqlite",
    "sql.js",
    "@libsql/client",
  ])("rejects harness implementation dependency %s", (specifier) => {
    expect(moduleIsForbidden(specifier, "@wi/harness-core")).toBe(true);
  });

  it("allows test-support only from test source", () => {
    expect(allowedInternalDependenciesForSource("@wi/protocol", "fixture.test.ts")).toContain(
      "@wi/test-support",
    );
    expect(allowedInternalDependenciesForSource("@wi/web", "fixture.test.tsx")).not.toContain(
      "@wi/test-support",
    );
    expect(allowedInternalDependenciesForSource("@wi/protocol", "fixture.spec.ts")).not.toContain(
      "@wi/test-support",
    );
    expect(allowedInternalDependenciesForSource("@wi/protocol", "fixture.ts")).not.toContain(
      "@wi/test-support",
    );
  });

  it("keeps SQLite drivers out of tests and main-thread storage clients", () => {
    const mainThreadStorageFiles = [
      "packages/storage/src/index.ts",
      "packages/storage/src/catalog/client.ts",
      "packages/storage/src/session/client.ts",
      "packages/storage/src/session/worker-pool.ts",
      "packages/storage/src/manager/session-store-manager.ts",
      "packages/storage/src/manager/catalog-reconciler.ts",
    ];
    const childOnlySqliteFixtures = new Set([
      join(root, "tests/process/catalog-v1-fixture.mjs"),
      join(root, "tests/process/milestone7-provenance-mutation-fixture.mjs"),
      join(root, "tests/process/provider-migration-fixture.mjs"),
      join(root, "tests/process/provider-orphan-lifecycle-fixture.mjs"),
      join(root, "tests/process/session-v1-fixture.mjs"),
      join(root, "tests/process/session-v3-fixture.mjs"),
    ]);
    const files = [
      ...sourceFiles("tests").filter((file) => !childOnlySqliteFixtures.has(file)),
      ...mainThreadStorageFiles.map((file) => join(root, file)),
    ];
    const violations = files.flatMap((file) =>
      importedSpecifiers(readFileSync(file, "utf8"), file)
        .filter((specifier) => harnessImplementationPatterns.slice(2).some((pattern) => pattern.test(specifier)))
        .map((specifier) => `${relative(root, file)} imports ${specifier}`),
    );

    expect(violations).toEqual([]);
  });

  it("keeps production dependencies directional and test-support out of production", () => {
    for (const directory of workspaceDirectories) {
      const manifest = manifestAt(directory);
      const dependencies = productionDependencies(manifest);
      const internalDependencies = dependencies.filter((name) => name.startsWith("@wi/"));
      const allowed = allowedInternalDependencies[manifest.name];

      expect(allowed, `${manifest.name} must be represented in the architecture map`).toBeDefined();
      expect(
        internalDependencies.filter((dependency) => !allowed?.includes(dependency)),
        `${manifest.name} has a forbidden internal dependency`,
      ).toEqual([]);
      expect(
        dependencies.filter((dependency) => moduleIsForbidden(dependency, manifest.name)),
        `${manifest.name} declares a forbidden production dependency`,
      ).toEqual([]);
      if (manifest.name !== "@wi/test-support") {
        expect(internalDependencies).not.toContain("@wi/test-support");
      }
    }
  });

  it("has no circular production dependencies", () => {
    const graph = new Map(
      workspaceDirectories.map((directory) => {
        const manifest = manifestAt(directory);
        return [
          manifest.name,
          productionDependencies(manifest).filter((dependency) => dependency.startsWith("@wi/")),
        ] as const;
      }),
    );
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const cycles: string[] = [];

    function visit(packageName: string, path: readonly string[]): void {
      if (visiting.has(packageName)) {
        cycles.push([...path, packageName].join(" -> "));
        return;
      }
      if (visited.has(packageName)) return;

      visiting.add(packageName);
      for (const dependency of graph.get(packageName) ?? []) {
        visit(dependency, [...path, packageName]);
      }
      visiting.delete(packageName);
      visited.add(packageName);
    }

    for (const packageName of graph.keys()) visit(packageName, []);
    expect(cycles).toEqual([]);
  });

  it("rejects forbidden source imports and excluded integrations", () => {
    const violations: string[] = [];

    for (const directory of workspaceDirectories) {
      const manifest = manifestAt(directory);
      for (const file of sourceFiles(join(directory, "src"))) {
        const source = readFileSync(file, "utf8");
        const allowed = allowedInternalDependenciesForSource(manifest.name, file);

        if (/\bEventSource\b/.test(source)) {
          violations.push(`${relative(root, file)} uses browser SSE EventSource`);
        }
        if (
          (manifest.name === "@wi/provider-connections" || manifest.name === "@wi/credentials") &&
          /\bfetch\s*\(/u.test(source)
        ) {
          violations.push(`${relative(root, file)} attempts provider network access`);
        }
        if (/codex[\s_-]+app[\s_-]+server/i.test(source)) {
          violations.push(`${relative(root, file)} contains excluded codex app-server integration`);
        }

        for (const specifier of importedSpecifiers(source, file)) {
          const internal = internalPackageName(specifier);

          if (moduleIsForbidden(specifier, manifest.name)) {
            violations.push(`${relative(root, file)} imports forbidden module ${specifier}`);
          }
          if (internal !== undefined && !allowed.includes(internal)) {
            violations.push(`${relative(root, file)} imports disallowed package ${internal}`);
          }
          if (internal !== undefined && specifier !== internal) {
            violations.push(`${relative(root, file)} deep-imports ${specifier}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
