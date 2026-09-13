import { expect, startServer, test } from "./fixtures/wi-test.js";
import {
  startRestartableServer,
  type ProviderRecoveryFailpoint,
} from "./fixtures/restartable-server.js";

test("manages a safe environment connection and exposes explicit session selection", async ({ page }) => {
  const running = await startServer();
  try {
    await page.goto(running.api.origin);
    await expect(page.locator(".connection")).toContainText("Connected");
    const providerRead = await page.evaluate(async () => {
      const response = await fetch("/api/provider-connections", { credentials: "same-origin" });
      return { status: response.status, body: await response.text() };
    });
    expect(providerRead.status, providerRead.body).toBe(200);
    await page.getByText("Provider connections", { exact: true }).click();
    await expect(page.getByText(/pnpm credentials:provision/u)).toBeVisible();
    await expect(page.getByText(/credential-cli\.js --api-key-fd 3/u)).toBeVisible();
    await expect(page.getByText(/Paste only the returned/u)).toContainText("provref_…");
    await expect(page.getByText(/credentials\/stage|stage.*claim/u)).toHaveCount(0);
    await page.getByLabel("Connection display name", { exact: true }).fill("Missing environment account");
    await page.getByLabel("Environment variable name").fill("WI_E2E_MISSING_PROVIDER_KEY");
    await page.getByRole("button", { name: "Add environment" }).click();
    await expect(page.getByText("Command accepted.", { exact: true })).toBeVisible();
    await expect.poll(async () => page.evaluate(async () => {
      const response = await fetch("/api/provider-connections", { credentials: "same-origin" });
      return response.text();
    })).toContain("Missing environment account");
    await expect(page.locator(".provider-panel__list")).toContainText(
      "Missing environment account — unavailable · environment",
      { timeout: 10_000 },
    );
    await page.getByLabel("Connection display name", { exact: true }).fill("Second environment account");
    await page.getByLabel("Environment variable name").fill("WI_E2E_SECOND_MISSING_KEY");
    await page.getByRole("button", { name: "Add environment" }).click();
    await expect(page.locator(".provider-panel__list")).toContainText(
      "Second environment account — unavailable · environment",
      { timeout: 10_000 },
    );
    const environmentConnections = await page.evaluate(async () => {
      const response = await fetch("/api/provider-connections", { credentials: "same-origin" });
      const body = await response.json() as { connections: Array<{
        connectionId: string;
        displayName: string;
      }> };
      return body.connections.filter((connection) =>
        connection.displayName === "Missing environment account" ||
        connection.displayName === "Second environment account"
      );
    });
    const firstEnvironmentId = environmentConnections.find((connection) =>
      connection.displayName === "Missing environment account"
    )?.connectionId;
    const secondEnvironmentId = environmentConnections.find((connection) =>
      connection.displayName === "Second environment account"
    )?.connectionId;
    expect(firstEnvironmentId).toMatch(/^pconn_/u);
    expect(secondEnvironmentId).toMatch(/^pconn_/u);
    if (firstEnvironmentId === undefined || secondEnvironmentId === undefined) {
      throw new Error("Environment connection identity is missing");
    }
    const fileProvisioningRef = await running.api.stageProviderKey("file-create");
    await page.getByLabel("Connection display name", { exact: true }).fill("File account");
    await page.getByLabel("Provisioning reference", { exact: true }).fill(fileProvisioningRef);
    await page.getByRole("button", { name: "Claim staged key" }).click();
    await expect(page.locator(".provider-panel__list")).toContainText(
      "File account — ready · file",
      { timeout: 10_000 },
    );

    const secondPage = await page.context().newPage();
    await secondPage.goto(running.api.origin);
    await expect(secondPage.locator(".connection")).toContainText("Connected");
    await secondPage.getByText("Provider connections", { exact: true }).click();
    await expect(secondPage.locator(".provider-panel__list")).toContainText(
      "Missing environment account",
      { timeout: 10_000 },
    );
    await expect(secondPage.locator(".provider-panel__list")).toContainText(
      "File account — ready · file",
      { timeout: 10_000 },
    );

    await page.getByLabel("Manage connection").selectOption(firstEnvironmentId);
    await page.getByLabel("Renamed connection display name", { exact: true }).fill("Renamed environment account");
    await page.getByRole("button", { name: "Rename connection" }).click();
    await expect.poll(async () => page.evaluate(async () => {
      const response = await fetch("/api/provider-connections", { credentials: "same-origin" });
      return response.text();
    })).toContain("Renamed environment account");
    await expect(secondPage.locator(".provider-panel__list")).toContainText(
      "Renamed environment account",
      { timeout: 10_000 },
    );
    await page.getByLabel("Manage connection").selectOption(secondEnvironmentId);
    await page.getByLabel("Renamed connection display name", { exact: true }).fill("Renamed environment account");
    await page.getByRole("button", { name: "Rename connection" }).click();
    await expect.poll(async () => page.evaluate(async () => {
      const response = await fetch("/api/provider-connections", { credentials: "same-origin" });
      const body = await response.json() as { connections: Array<{ displayName: string }> };
      return body.connections.filter((connection) =>
        connection.displayName === "Renamed environment account"
      ).length;
    })).toBe(2);
    await expect.poll(async () => {
      const labels = await page.getByLabel("Manage connection").locator("option").allTextContents();
      return [firstEnvironmentId, secondEnvironmentId].filter((connectionId) =>
        labels.some((label) =>
          label.includes("Renamed environment account") && label.includes(connectionId)
        )
      ).length;
    }).toBe(2);

    const firstRenamedRow = page.locator(".provider-panel__list li").filter({
      hasText: firstEnvironmentId,
    });
    await firstRenamedRow.getByRole("button", { name: "Disable" }).click();
    await expect(secondPage.locator(".provider-panel__list li").filter({
      hasText: firstEnvironmentId,
    })).toContainText("disabled", { timeout: 10_000 });
    await expect(secondPage.locator(".provider-panel__list li").filter({
      hasText: secondEnvironmentId,
    })).toContainText("unavailable", { timeout: 10_000 });

    const fileConnectionId = await page.getByLabel("Manage connection").locator("option").filter({
      hasText: "File account",
    }).getAttribute("value");
    expect(fileConnectionId).toMatch(/^pconn_/u);
    if (fileConnectionId === null) throw new Error("File connection identity is missing");
    await page.getByLabel("Manage connection").selectOption(fileConnectionId);
    const replacementProvisioningRef = await running.api.stageProviderKey("file-replace");
    await page.getByLabel("Replacement provisioning reference").fill(replacementProvisioningRef);
    await page.getByRole("button", { name: "Replace file credential" }).click();
    await expect.poll(async () => page.evaluate(async () => {
      const response = await fetch("/api/provider-connections", { credentials: "same-origin" });
      const body = await response.json() as { connections: Array<{
        displayName: string;
        credentialGeneration: number;
      }> };
      return body.connections.find((connection) => connection.displayName === "File account")
        ?.credentialGeneration;
    })).toBe(2);
    await expect(page.locator(".provider-panel__list li").filter({
      hasText: "File account",
    })).toContainText("generation 2", { timeout: 10_000 });
    const fileRow = page.locator(".provider-panel__list li").filter({ hasText: "File account" });
    await fileRow.getByRole("button", { name: "Logout" }).click();
    await expect(fileRow).toContainText("reauth_required", { timeout: 10_000 });
    await fileRow.getByRole("button", { name: "Delete" }).click();
    await expect(secondPage.locator(".provider-panel__list li").filter({
      hasText: "File account",
    })).toContainText("unavailable", { timeout: 10_000 });

    await page.getByLabel("New session title").fill("Explicit provider session");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Explicit provider session" })).toBeVisible();
    const sessionConnectionLabels = await page.getByLabel("Session connection").locator("option").allTextContents();
    expect(sessionConnectionLabels.some((label) => label.includes(firstEnvironmentId))).toBe(true);
    expect(sessionConnectionLabels.some((label) => label.includes(secondEnvironmentId))).toBe(true);
    await expect(page.getByText(/private-file-key|WI_E2E_MISSING_PROVIDER_KEY=/u)).toHaveCount(0);
  } finally {
    await running.close();
  }
});

test("revalidates an unavailable environment connection across two tabs", async ({ page, context }) => {
  const previousFlag = process.env.WI_E2E_REVALIDATE_INITIAL;
  const previousValue = process.env.WI_E2E_REVALIDATE_KEY;
  process.env.WI_E2E_REVALIDATE_INITIAL = "1";
  process.env.WI_E2E_REVALIDATE_KEY = "e2e-initial-environment-value";
  const restartable = await startRestartableServer({ providerScenario: "plain-text" });
  delete process.env.WI_E2E_REVALIDATE_INITIAL;
  try {
    await page.goto(restartable.origin);
    await expect(page.locator(".connection")).toContainText("Connected");
    await page.getByText("Provider connections", { exact: true }).click();
    await page.getByLabel("Connection display name", { exact: true }).fill("Environment revalidation");
    await page.getByLabel("Environment variable name").fill("WI_E2E_REVALIDATE_KEY");
    await page.getByRole("button", { name: "Add environment" }).click();
    const row = page.locator(".provider-panel__list li").filter({ hasText: "Environment revalidation" });
    await expect(row).toContainText("unavailable", { timeout: 10_000 });

    const second = await context.newPage();
    await second.goto(restartable.origin);
    await expect(second.locator(".connection")).toContainText("Connected");
    await second.getByText("Provider connections", { exact: true }).click();
    const secondRow = second.locator(".provider-panel__list li").filter({ hasText: "Environment revalidation" });
    await expect(secondRow).toContainText("unavailable", { timeout: 10_000 });

    await restartable.restoreProviderEnvironment();
    await restartable.armLifecyclePrepare();
    await row.getByRole("button", { name: "Revalidate environment" }).click();
    const firstCommand = await restartable.waitForProviderCommand(
      "providerConnection.environment.revalidate",
    );
    const blocked = await restartable.waitForLifecyclePrepareBlock();
    await secondRow.getByRole("button", { name: "Revalidate environment" }).click();
    const secondCommand = await restartable.waitForProviderCommand(
      "providerConnection.environment.revalidate",
    );
    await expect.poll(async () => restartable.providerOperation(secondCommand)).toMatchObject({
      phase: "failed",
      targetConnectionId: blocked.connectionId,
      failureCode: "provider.operation_in_progress",
    });
    restartable.releaseLifecyclePrepare(firstCommand);
    await expect(row).toContainText("ready", { timeout: 10_000 });
    await expect(secondRow).toContainText("ready", { timeout: 10_000 });
  } finally {
    await restartable.close();
    if (previousFlag === undefined) delete process.env.WI_E2E_REVALIDATE_INITIAL;
    else process.env.WI_E2E_REVALIDATE_INITIAL = previousFlag;
    if (previousValue === undefined) delete process.env.WI_E2E_REVALIDATE_KEY;
    else process.env.WI_E2E_REVALIDATE_KEY = previousValue;
  }
});

test("shows a lifecycle-owner conflict and converges after the initiating tab closes", async ({ page, context }) => {
  const restartable = await startRestartableServer({ providerScenario: "plain-text" });
  try {
    await page.goto(restartable.origin);
    await expect(page.locator(".connection")).toContainText("Connected");
    await page.getByText("Provider connections", { exact: true }).click();
    const initialRef = await restartable.stageProviderKey("lifecycle-race-initial");
    await page.getByLabel("Connection display name", { exact: true }).fill("Lifecycle race file");
    await page.getByLabel("Provisioning reference", { exact: true }).fill(initialRef);
    await page.getByRole("button", { name: "Claim staged key" }).click();
    const row = page.locator(".provider-panel__list li").filter({ hasText: "Lifecycle race file" });
    await expect(row).toContainText("ready", { timeout: 10_000 });
    const connectionId = await page.getByLabel("Manage connection").locator("option").filter({
      hasText: "Lifecycle race file",
    }).getAttribute("value");
    if (connectionId === null) throw new Error("Lifecycle-race connection identity is missing");

    const second = await context.newPage();
    await second.goto(restartable.origin);
    await expect(second.locator(".connection")).toContainText("Connected");
    await second.getByText("Provider connections", { exact: true }).click();
    const staleSecondRow = second.locator(".provider-panel__list li").filter({ hasText: connectionId });
    await expect(staleSecondRow).toContainText("ready", { timeout: 10_000 });
    await second.route("**/api/provider-connections", (route) => route.abort());

    const replacementRef = await restartable.stageProviderKey("lifecycle-race-replacement");
    await restartable.armLifecyclePrepare();
    await page.getByLabel("Manage connection").selectOption(connectionId);
    await page.getByLabel("Replacement provisioning reference").fill(replacementRef);
    await page.getByRole("button", { name: "Replace file credential" }).click();
    const blocked = await restartable.waitForLifecyclePrepareBlock();
    expect(blocked.connectionId).toBe(connectionId);
    await staleSecondRow.getByRole("button", { name: "Disable" }).click();
    const conflictCommandId = await restartable.waitForProviderCommand(
      "providerConnection.disable",
    );
    await expect.poll(async () => {
      try {
        return await restartable.providerOperation(conflictCommandId);
      } catch {
        return null;
      }
    }).toMatchObject({
      phase: "failed",
      targetConnectionId: connectionId,
      failureCode: "provider.operation_in_progress",
    });
    await second.unroute("**/api/provider-connections");

    await page.close();
    restartable.releaseLifecyclePrepare(blocked.commandId);
    await expect(staleSecondRow).toContainText("generation 2", { timeout: 10_000 });
    await expect(staleSecondRow).toContainText("ready");
  } finally {
    await restartable.close();
  }
});

test("pins an active selected run and never falls back from an unavailable default", async ({ page }) => {
  test.setTimeout(60_000);
  const restartable = await startRestartableServer({ providerScenario: "slow-stream" });
  try {
    await page.goto(restartable.origin);
    await expect(page.locator(".connection")).toContainText("Connected");
    await page.getByText("Provider connections", { exact: true }).click();
    for (const name of ["Pinned file A", "Healthy file B"] as const) {
      const ref = await restartable.stageProviderKey(name.replaceAll(" ", "-"));
      await page.getByLabel("Connection display name", { exact: true }).fill(name);
      await page.getByLabel("Provisioning reference", { exact: true }).fill(ref);
      await page.getByRole("button", { name: "Claim staged key" }).click();
      await expect(page.locator(".provider-panel__list li").filter({ hasText: name }))
        .toContainText("ready", { timeout: 10_000 });
    }
    const optionValue = async (name: string): Promise<string> => {
      const value = await page.getByLabel("Session connection").locator("option").filter({
        hasText: name,
      }).getAttribute("value");
      if (value === null) throw new Error(`${name} connection identity is missing`);
      return value;
    };

    const createSession = async (title: string): Promise<void> => {
      await page.getByLabel("New session title").fill(title);
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    };
    const useConnection = async (connectionId: string): Promise<void> => {
      await page.getByLabel("Session connection").selectOption(connectionId);
      await expect(page.getByLabel("Provider model", { exact: true })).not.toHaveValue("");
      await page.getByRole("button", { name: "Use for future runs" }).click();
    };

    await createSession("No fallback session");
    const connectionA = await optionValue("Pinned file A");
    const connectionB = await optionValue("Healthy file B");
    await useConnection(connectionA);
    await createSession("Pinned active session");
    await useConnection(connectionA);

    await page.getByLabel("Message", { exact: true }).fill("active pinned request");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await restartable.waitForProviderRequest();
    await useConnection(connectionB);
    const rowA = page.locator(".provider-panel__list li").filter({ hasText: connectionA });
    await rowA.getByRole("button", { name: "Disable" }).click();
    await expect(rowA).toContainText("disabled", { timeout: 10_000 });

    await page.getByRole("button", { name: /^No fallback session/u }).click();
    await page.getByLabel("Message", { exact: true }).fill("must not use healthy fallback");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText(/selected provider connection is unavailable/u)).toBeVisible();
    await expect.poll(() => restartable.providerRequestCount()).toBe(1);

    await restartable.releaseProvider("slow");
    await page.getByRole("button", { name: /^Pinned active session/u }).click();
    await expect(page.getByText("Slow fake response.", { exact: true })).toBeVisible();
    await page.getByLabel("Message", { exact: true }).fill("future run uses healthy B");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await restartable.waitForProviderRequest();
    await restartable.releaseProvider("slow");
    await expect.poll(() => restartable.providerRequestCount()).toBe(2);
  } finally {
    await restartable.close();
  }
});

test("synchronizes connection and model defaults across sessions", async ({ page }) => {
  test.setTimeout(60_000);
  const running = await startServer();
  try {
    await page.goto(running.api.origin);
    await expect(page.locator(".connection")).toContainText("Connected");
    await page.getByText("Provider connections", { exact: true }).click();
    for (const [displayName, secret] of [
      ["Model A account", "model-a"],
      ["Model B account", "model-b"],
    ] as const) {
      const provisioningRef = await running.api.stageProviderKey(secret);
      await page.getByLabel("Connection display name", { exact: true }).fill(displayName);
      await page.getByLabel("Provisioning reference", { exact: true }).fill(provisioningRef);
      await page.getByRole("button", { name: "Claim staged key" }).click();
      await expect(page.locator(".provider-panel__list")).toContainText(
        `${displayName} — ready · file`,
        { timeout: 10_000 },
      );
    }
    const connectionIds = await page.evaluate(async () => {
      const response = await fetch("/api/provider-connections", { credentials: "same-origin" });
      const body = await response.json() as { connections: Array<{
        connectionId: string;
        displayName: string;
      }> };
      return Object.fromEntries(body.connections.map((connection) => [
        connection.displayName,
        connection.connectionId,
      ]));
    });
    const connectionA = connectionIds["Model A account"];
    const connectionB = connectionIds["Model B account"];
    if (connectionA === undefined || connectionB === undefined) {
      throw new Error("Model fixture connections are missing");
    }
    for (const [connectionId, modelId] of [
      [connectionA, "fixture-model-a"],
      [connectionB, "fixture-model-b"],
    ] as const) {
      const capabilityRead = await page.evaluate(async ({ targetConnectionId }) => {
        const response = await fetch(
          `/api/provider-connections/${encodeURIComponent(targetConnectionId)}/capabilities`,
          { credentials: "same-origin" },
        );
        return { status: response.status, body: await response.text() };
      }, { targetConnectionId: connectionId });
      expect(capabilityRead.status, capabilityRead.body).toBe(200);
      expect(capabilityRead.body).toContain(modelId);
    }

    const createSession = async (title: string): Promise<void> => {
      await page.getByLabel("New session title").fill(title);
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    };
    await createSession("Provider default A");
    await page.getByLabel("Session connection").selectOption(connectionA);
    await expect(page.getByLabel("Provider model", { exact: true })).toHaveValue(
      "fixture-model-a",
      { timeout: 15_000 },
    );
    await page.getByRole("button", { name: "Use for future runs" }).click();

    await createSession("Provider default B");
    await page.getByLabel("Session connection").selectOption(connectionB);
    await expect(page.getByLabel("Provider model", { exact: true })).toHaveValue("fixture-model-b");
    await page.getByRole("button", { name: "Use for future runs" }).click();

    await page.getByRole("button", { name: /^Provider default A/u }).click();
    await expect(page.getByLabel("Session connection")).toHaveValue(connectionA);
    await expect(page.getByLabel("Provider model", { exact: true })).toHaveValue("fixture-model-a");
    await page.getByLabel("Session connection").selectOption(connectionB);
    await expect(page.getByLabel("Provider model", { exact: true })).toHaveValue("fixture-model-b");
    await page.getByLabel("Session connection").selectOption(connectionA);
    await expect(page.getByLabel("Provider model", { exact: true })).toHaveValue("fixture-model-a");

    await page.getByRole("button", { name: /^Provider default B/u }).click();
    await expect(page.getByLabel("Session connection")).toHaveValue(connectionB);
    await expect(page.getByLabel("Provider model", { exact: true })).toHaveValue("fixture-model-b");
  } finally {
    await running.close();
  }
});

for (const failpoint of [
  "after_recovery_admission",
  "after_recovery_prepare",
  "after_provider_file_observed",
  "after_provider_lifecycle_terminal_before_ack",
] as const satisfies readonly ProviderRecoveryFailpoint[]) {
  test(`reconciles credential recovery after process death at ${failpoint}`, async ({ page }) => {
    test.setTimeout(60_000);
    const restartable = await startRestartableServer({ providerRecovery: true });
    try {
      await page.goto(restartable.origin);
      await expect(page.locator(".connection")).toContainText("Connected");
      await page.getByText("Provider connections", { exact: true }).click();
      await page.getByRole("button", { name: "Scan orphaned credentials" }).click();
      await expect(page.getByRole("button", { name: "Recover original connection" })).toBeVisible();
      await restartable.armProviderFailpoint(failpoint);
      await page.getByRole("button", { name: "Recover original connection" }).click();
      const persisted = await page.evaluate(() =>
        sessionStorage.getItem("wi:v1:credential-recovery-reconciliation")
      );
      expect(persisted).not.toBeNull();
      expect(persisted).not.toContain("recref_");
      const parsed = JSON.parse(persisted ?? "[]") as Array<{ commandId: string }>;
      const commandId = parsed[0]?.commandId;
      expect(commandId).toMatch(/^cmd_/u);
      if (commandId === undefined) throw new Error("Recovery command identity was not journaled");

      await restartable.restartAfterCrash();
      await page.reload();
      await expect(page.locator(".connection")).toContainText("Connected");
      await page.getByText("Provider connections", { exact: true }).click();
      await expect.poll(async () => page.evaluate(() =>
        sessionStorage.getItem("wi:v1:credential-recovery-reconciliation")
      ), { timeout: 10_000 }).toBeNull();

      const operation = await restartable.providerOperation(commandId);
      expect(operation.targetConnectionId).toBe("pconn_e2eRecovery");
      if (failpoint === "after_recovery_admission") {
        expect(operation).toMatchObject({
          phase: "failed",
          failureCode: "credential.recovery_ref_expired",
          result: null,
        });
        await expect(page.locator(".provider-panel__list")).not.toContainText(
          "Recovered openai_platform — ready",
        );
      } else {
        expect(operation).toMatchObject({
          phase: "succeeded",
          failureCode: null,
          result: { connectionId: "pconn_e2eRecovery" },
        });
        await expect(page.locator(".provider-panel__list")).toContainText(
          "Recovered openai_platform — ready · file · generation 2",
          { timeout: 10_000 },
        );
      }
    } finally {
      await restartable.close();
    }
  });
}

test("reconciles memory-only credential recovery across browser reload", async ({ page }) => {
  const running = await startServer({
    childArguments: ["-", "-", "-", "-", "recovery"],
  });
  try {
    await page.goto(running.api.origin);
    await expect(page.locator(".connection")).toContainText("Connected");
    await page.getByText("Provider connections", { exact: true }).click();
    await page.route("**/api/provider-connections/recovery-scan", async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { expiresAtMs: number };
      await route.fulfill({ response, json: { ...body, expiresAtMs: Date.now() + 250 } });
    });
    await page.getByRole("button", { name: "Scan orphaned credentials" }).click();
    await expect(page.getByRole("button", { name: "Recover original connection" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Recover original connection" })).toHaveCount(0, {
      timeout: 2_000,
    });
    await page.unroute("**/api/provider-connections/recovery-scan");
    await page.getByRole("button", { name: "Scan orphaned credentials" }).click();
    await expect(page.getByRole("button", { name: "Recover original connection" })).toBeVisible();

    await running.api.armRecoveryBeforeRoute();
    await page.getByRole("button", { name: "Recover original connection" }).click();
    await expect(page.getByRole("button", { name: "Recover original connection" })).toHaveCount(0);
    const commandId = await running.api.waitForRecoveryBeforeRouteBlock();
    const persisted = await page.evaluate(() =>
      sessionStorage.getItem("wi:v1:credential-recovery-reconciliation")
    );
    expect(persisted).toContain(commandId);
    expect(persisted).not.toContain("recref_");

    await page.reload();
    await expect(page.locator(".connection")).toContainText("Connected");
    await page.getByText("Provider connections", { exact: true }).click();
    running.api.releaseBeforeRoute(commandId);
    await expect(page.locator(".provider-panel__list")).toContainText(
      "Recovered openai_platform — ready · file · generation 2",
      { timeout: 10_000 },
    );
    await expect.poll(async () => page.evaluate(() =>
      sessionStorage.getItem("wi:v1:credential-recovery-reconciliation")
    ), { timeout: 10_000 }).toBeNull();
    await expect(page.getByText("Recovered openai_platform recovery completed.")).toBeVisible();
  } finally {
    await running.close();
  }
});
