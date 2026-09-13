import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { BootstrapResponseSchema } from "@wi/protocol";

import { startRestartableServer } from "./fixtures/restartable-server.js";
import { expect, startServer, test, type WiTestServer } from "./fixtures/wi-test.js";

async function openWi(page: Page, wi: WiTestServer, sessionId?: string): Promise<void> {
  const url = sessionId === undefined ? wi.origin : `${wi.origin}/?session=${sessionId}`;
  await page.goto(url);
  await expect(page.locator(".connection")).toContainText("Connected");
}

async function createSession(page: Page, title: string): Promise<string> {
  await page.getByLabel("New session title").fill(title);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByLabel("New session title")).toHaveValue("");
  const sessionId = new URL(page.url()).searchParams.get("session");
  if (sessionId === null) throw new Error("Created session was not selected");
  await expect(page.getByText("Session state: live")).toBeVisible();
  return sessionId;
}

async function selectSession(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(`^${title}`) }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByText("Session state: live")).toBeVisible();
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("timeline-user").filter({ hasText: text })).toHaveCount(1);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as Error & { readonly code?: string }).code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

async function expectRunState(page: Page, state: string): Promise<void> {
  await expect(page.getByLabel("Current run status").getByText(state, { exact: true })).toBeVisible();
}

function maximumJsonContainerDepth(text: string): number {
  let depth = 0;
  let maximumDepth = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      maximumDepth = Math.max(maximumDepth, depth);
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }
  return maximumDepth;
}

test("cleans child processes and temporary homes when fixture startup fails", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "wi-e2e-startup-test-"));
  const childScript = new URL("./fixtures/startup-failure-process.mjs", import.meta.url);
  try {
    for (const scenario of [
      { mode: "exit", timeoutMs: 2_000, error: "exited early" },
      { mode: "hang", timeoutMs: 50, error: "Timed out" },
    ] as const) {
      let childPid: number | null = null;
      await expect(
        startServer({
          childScript,
          childArguments: [scenario.mode],
          readyTimeoutMs: scenario.timeoutMs,
          temporaryDirectory,
          onChildStarted: (child) => {
            childPid = child.pid ?? null;
          },
        }),
      ).rejects.toThrow(scenario.error);
      expect(await readdir(temporaryDirectory)).toEqual([]);
      if (childPid === null) throw new Error("Startup fixture child had no process ID");
      expect(processIsAlive(childPid)).toBe(false);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("refreshes bootstrap authentication after a same-origin backend restart", async ({ page }) => {
  const restartable = await startRestartableServer();
  let bootstrapRequests = 0;
  try {
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/bootstrap") bootstrapRequests += 1;
    });
    await page.addInitScript(() => {
      const browser = globalThis as unknown as {
        WebSocket: new (url: string, protocols?: string | readonly string[]) => {
          addEventListener(type: string, listener: (event: unknown) => void): void;
        };
        readonly document: {
          querySelector(selector: string): { readonly textContent: string | null } | null;
        };
        setInterval(callback: () => void, delayMs: number): unknown;
        __wiRestartProbe?: {
          attempts: number;
          closes: Array<{ readonly code: number | null; readonly reason: string }>;
          errors: number;
          transitions: string[];
        };
      };
      const NativeWebSocket = browser.WebSocket;
      browser.__wiRestartProbe = { attempts: 0, closes: [], errors: 0, transitions: [] };
      browser.WebSocket = class extends NativeWebSocket {
        constructor(url: string, protocols?: string | readonly string[]) {
          super(url, protocols);
          const probe = browser.__wiRestartProbe;
          if (probe !== undefined) probe.attempts += 1;
          this.addEventListener("error", () => {
            if (probe !== undefined) probe.errors += 1;
          });
          this.addEventListener("close", (event) => {
            const close = event as { readonly code?: number; readonly reason?: string };
            probe?.closes.push({ code: close.code ?? null, reason: close.reason ?? "" });
          });
        }
      };
      let previous = "";
      browser.setInterval(() => {
        const text = browser.document.querySelector(".connection")?.textContent?.trim() ?? "";
        if (text !== "" && text !== previous) {
          browser.__wiRestartProbe?.transitions.push(text);
          previous = text;
        }
      }, 10);
    });

    await page.goto(restartable.origin);
    await expect(page.locator(".connection")).toContainText("Connected");
    expect(bootstrapRequests).toBe(1);
    await restartable.restart();

    await expect(page.locator(".connection")).toContainText("Connected", { timeout: 15_000 });
    await expect.poll(() => bootstrapRequests).toBeGreaterThanOrEqual(2);
    expect(bootstrapRequests).toBeLessThanOrEqual(3);
    const probe = await page.evaluate(() =>
      (globalThis as unknown as {
        readonly __wiRestartProbe: {
          readonly attempts: number;
          readonly closes: readonly { readonly code: number | null; readonly reason: string }[];
          readonly errors: number;
          readonly transitions: readonly string[];
        };
      }).__wiRestartProbe,
    );
    expect(probe.attempts).toBeGreaterThanOrEqual(4);
    expect(probe.closes.length).toBeGreaterThanOrEqual(3);
    expect(probe.closes.every((close) => close.code !== null)).toBe(true);
    expect(probe.errors).toBeGreaterThanOrEqual(1);
    expect(probe.transitions.some((transition) => transition.includes("reconnecting"))).toBe(true);
    expect(probe.transitions.at(-1)).toContain("Connected");
  } finally {
    await restartable.close();
  }
});

test("preserves title and message drafts until durable acceptance", async ({ page, wi }) => {
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as {
        readonly kind?: string;
        readonly commandId?: string;
        readonly method?: string;
        readonly params?: { readonly title?: string; readonly text?: string };
      };
      const rejectTitle =
        message.method === "session.create" && message.params?.title === "Rejected title draft";
      const rejectMessage =
        message.method === "message.submit" && message.params?.text === "Rejected message draft";
      if (
        message.kind === "command" &&
        message.commandId !== undefined &&
        (rejectTitle || rejectMessage)
      ) {
        browserSocket.send(
          JSON.stringify({
            v: 1,
            kind: "command.rejected",
            commandId: message.commandId,
            code: "storage.worker_failed",
            message: "Synthetic durable rejection.",
            diagnosticId: "err_draftRejected",
            recoverable: true,
          }),
        );
        return;
      }
      serverSocket.send(frame);
    });
    serverSocket.onMessage((frame) => browserSocket.send(frame));
  });

  await openWi(page, wi);
  const title = page.getByLabel("New session title");
  await title.fill("Rejected title draft");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator('[data-error-code="storage.worker_failed"]')).toBeVisible();
  await expect(title).toHaveValue("Rejected title draft");

  await title.fill("Accepted title after rejection");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Accepted title after rejection" })).toBeVisible();
  await expect(title).toHaveValue("");
  await expect(page.getByText("Session state: live")).toBeVisible();

  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("Rejected message draft");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator('[data-error-code="storage.worker_failed"]')).toHaveCount(2);
  await expect(composer).toHaveValue("Rejected message draft");

  await composer.fill("Accepted message after rejection");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByTestId("timeline-user").filter({ hasText: "Accepted message after rejection" }),
  ).toHaveCount(1);
  await expect(composer).toHaveValue("");
});

test("reloads a queued pre-welcome session create with the same command identity", async ({
  page,
  wi,
}) => {
  const releases: Array<() => void> = [];
  const capturedCommandIds: string[] = [];
  let welcomeCount = 0;
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    const queued: Array<string | Buffer> = [];
    let released = false;
    releases.push(() => {
      released = true;
      for (const frame of queued) browserSocket.send(frame);
      queued.length = 0;
    });
    browserSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as {
        readonly kind?: string;
        readonly commandId?: string;
      };
      if (message.kind === "command" && message.commandId !== undefined) {
        capturedCommandIds.push(message.commandId);
      }
      serverSocket.send(frame);
    });
    serverSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as { readonly kind?: string };
      if (message.kind === "welcome") welcomeCount += 1;
      if (released) browserSocket.send(frame);
      else queued.push(frame);
    });
  });

  await page.goto(wi.origin);
  await expect.poll(() => welcomeCount).toBe(1);
  await expect(page.locator(".connection")).toContainText("handshaking");
  const title = page.getByLabel("New session title");
  await title.fill("Queued refresh-safe create");
  const routedBefore = await wi.commandRouteCount();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("button", { name: "Creating…", exact: true })).toBeDisabled();
  expect(await wi.commandRouteCount()).toBe(routedBefore);

  const beforeReload = await page.evaluate(() =>
    (globalThis as unknown as { readonly sessionStorage: { getItem(key: string): string | null } })
      .sessionStorage.getItem("wi:v1:tab-command-journal"),
  );
  if (beforeReload === null) throw new Error("Queued command was not journaled");
  const stored = JSON.parse(beforeReload) as {
    readonly items: readonly { readonly type?: string; readonly commandJson?: string }[];
  };
  const storedCommand = stored.items.find((item) => item.type === "command")?.commandJson;
  if (storedCommand === undefined) throw new Error("Journal contained no queued command");
  const commandId = (JSON.parse(storedCommand) as { readonly commandId: string }).commandId;

  await page.reload();
  await expect.poll(() => welcomeCount).toBe(2);
  await expect(title).toHaveValue("Queued refresh-safe create");
  const secondRelease = releases[1];
  if (secondRelease === undefined) throw new Error("Reloaded WebSocket was not intercepted");
  secondRelease();

  await expect(page.locator(".connection")).toContainText("Connected");
  await expect(page.getByRole("heading", { name: "Queued refresh-safe create", exact: true })).toBeVisible();
  await expect(title).toHaveValue("");
  await expect(page.getByText("Session state: live")).toBeVisible();
  expect(capturedCommandIds).toEqual([commandId]);
  expect(await wi.commandRouteCount()).toBe(routedBefore + 1);
  expect(
    await page.evaluate(() =>
      (globalThis as unknown as { readonly sessionStorage: { getItem(key: string): string | null } })
        .sessionStorage.getItem("wi:v1:tab-command-journal"),
    ),
  ).toBeNull();
});

test("reloads a committed command with a lost acknowledgement using the same ID", async ({
  page,
  wi,
}) => {
  const capturedCommandIds: string[] = [];
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as {
        readonly kind?: string;
        readonly commandId?: string;
        readonly method?: string;
      };
      if (
        message.kind === "command" &&
        message.method === "message.submit" &&
        message.commandId !== undefined
      ) {
        capturedCommandIds.push(message.commandId);
      }
      serverSocket.send(frame);
    });
    serverSocket.onMessage((frame) => browserSocket.send(frame));
  });

  await openWi(page, wi);
  const sessionId = await createSession(page, "Reload lost acknowledgement");
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("[lost-ack] reload with exact identity");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const commandId = await wi.waitForAcknowledgementBlock();
  await expect(
    page.getByTestId("timeline-user").filter({ hasText: "[lost-ack] reload with exact identity" }),
  ).toHaveCount(1);

  const journalBeforeReload = await page.evaluate(() =>
    (globalThis as unknown as { readonly sessionStorage: { getItem(key: string): string | null } })
      .sessionStorage.getItem("wi:v1:tab-command-journal"),
  );
  expect(journalBeforeReload).toContain(commandId);
  await page.reload();
  wi.releaseAcknowledgement(commandId);

  await expect(page.locator(".connection")).toContainText("Connected");
  await expect(page.getByText("Command reconciled after reconnect.", { exact: true })).toBeVisible();
  await expect(
    page.getByTestId("timeline-user").filter({ hasText: "[lost-ack] reload with exact identity" }),
  ).toHaveCount(1);
  await expectRunState(page, "completed");
  expect(capturedCommandIds.filter((candidate) => candidate === commandId)).toHaveLength(2);
  expect(await wi.sessionHead(sessionId)).toBe(
    Number(await page.getByTestId("timeline").getAttribute("data-last-sequence")),
  );
  expect(
    await page.evaluate(() =>
      (globalThis as unknown as { readonly sessionStorage: { getItem(key: string): string | null } })
        .sessionStorage.getItem("wi:v1:tab-command-journal"),
    ),
  ).toBeNull();
});

test("keeps cloned tabs from sharing unresolved journal authority", async ({
  page,
  context,
  wi,
}) => {
  await openWi(page, wi);
  await page.getByLabel("New session title").fill("Original tab-only draft");
  const popupPromise = context.waitForEvent("page");
  await page.evaluate((origin) => {
    (globalThis as unknown as { open(url: string, target: string): unknown }).open(origin, "_blank");
  }, wi.origin);
  const cloned = await popupPromise;
  await cloned.waitForLoadState();
  await expect(cloned.locator(".connection")).toContainText("Connected");
  await expect(cloned.getByLabel("New session title")).toHaveValue("");
  await expect(page.getByLabel("New session title")).toHaveValue("Original tab-only draft");

  const owners = await Promise.all([
    page.evaluate(() => (globalThis as unknown as { readonly name: string }).name),
    cloned.evaluate(() => (globalThis as unknown as { readonly name: string }).name),
  ]);
  expect(owners[0]).not.toBe(owners[1]);
  await cloned.getByLabel("New session title").fill("Cloned tab independent draft");
  await expect(page.getByLabel("New session title")).toHaveValue("Original tab-only draft");
});

test("rejects oversized message and input drafts without closing the connection", async ({
  page,
  wi,
}) => {
  let sendToBrowser: ((message: string) => void) | null = null;
  let forwardedInputResponses = 0;
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    sendToBrowser = (message) => browserSocket.send(message);
    browserSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as { readonly kind?: string; readonly method?: string };
      if (message.kind === "command" && message.method === "input.respond") {
        forwardedInputResponses += 1;
      }
      serverSocket.send(frame);
    });
    serverSocket.onMessage((frame) => browserSocket.send(frame));
  });

  await openWi(page, wi);
  const sessionId = await createSession(page, "Bounded browser drafts");
  const oversizedMessage = "🔥".repeat(20_000);
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("retained bounded message draft");
  await composer.fill(oversizedMessage);
  await expect(page.locator('.composer [role="alert"]')).toContainText(
    "server limit is 65536",
  );
  await expect(composer).toHaveValue("retained bounded message draft");
  await expect(page.locator(".connection")).toContainText("Connected");
  await expect(page.getByTestId("timeline-user")).toHaveCount(0);

  if (sendToBrowser === null) throw new Error("WebSocket route was not established");
  (sendToBrowser as (message: string) => void)(
    JSON.stringify({
      v: 1,
      kind: "event",
      sessionId,
      sequence: 2,
      eventId: "evt_oversizedInputRequested",
      eventType: "input.requested",
      createdAtMs: 2,
      data: {
        eventVersion: 1,
        runId: "run_oversizedInput",
        inputId: "input_oversizedInput",
        prompt: "Provide a bounded JSON response.",
      },
    }),
  );
  const oversizedInput = JSON.stringify("x".repeat(70_000));
  const input = page.getByLabel("Response as JSON");
  await input.fill('"retained bounded input draft"');
  await input.fill(oversizedInput);
  await expect(page.getByTestId("pending-input-panel").getByRole("alert")).toContainText(
    /server limit is 65536|exceeds the server limit of 65536/u,
  );
  await expect(input).toHaveValue('"retained bounded input draft"');
  expect(forwardedInputResponses).toBe(0);
  await expect(page.locator(".connection")).toContainText("Connected");
});

test("uses lower server command limits without a terminal frame close", async ({ browser }) => {
  const running = await startServer({ childArguments: [String(32 * 1_024)] });
  const page = await browser.newPage();
  try {
    const bootstrap = BootstrapResponseSchema.parse(
      await (await fetch(`${running.api.origin}/bootstrap`)).json(),
    );
    expect(bootstrap.commandLimits.maximumFrameBytes).toBe(32 * 1_024);

    await openWi(page, running.api);
    const sessionId = await createSession(page, "Negotiated lower command limit");
    const routedBeforeMessage = await running.api.commandRouteCount();
    const emptyCommand = {
      v: 1,
      kind: "command",
      commandId: `cmd_${"x".repeat(32)}`,
      sessionId,
      method: "message.submit",
      params: { text: "" },
    } as const;
    const emptyBytes = new TextEncoder().encode(JSON.stringify(emptyCommand)).byteLength;
    const exactText = "x".repeat(bootstrap.commandLimits.maximumFrameBytes - emptyBytes);
    const composer = page.getByLabel("Message", { exact: true });

    await composer.fill(exactText);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(composer).toHaveValue("");
    expect(await running.api.commandRouteCount()).toBe(routedBeforeMessage + 1);

    const oneByteOver = `${exactText}x`;
    await composer.fill(oneByteOver);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator('.composer [role="alert"]')).toContainText(
      "complete command is 32769 UTF-8 bytes; the server limit is 32768",
    );
    await expect(composer).toHaveValue(oneByteOver);
    expect(await running.api.commandRouteCount()).toBe(routedBeforeMessage + 1);
    await expect(page.locator(".connection")).toContainText("Connected");
  } finally {
    await page.close();
    await running.close();
  }
});

test("composes raw input depth with the minimum real server frame depth", async ({ browser }) => {
  const running = await startServer({ childArguments: ["-", "-", "3"] });
  const page = await browser.newPage();
  const helloFrames: string[] = [];
  const inputFrames: string[] = [];
  let sendToBrowser: ((message: string) => void) | null = null;
  try {
    await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
      const serverSocket = browserSocket.connectToServer();
      sendToBrowser = (message) => browserSocket.send(message);
      browserSocket.onMessage((frame) => {
        const text = typeof frame === "string" ? frame : frame.toString("utf8");
        const message = JSON.parse(text) as { readonly kind?: string; readonly method?: string };
        if (message.kind === "hello") helloFrames.push(text);
        if (message.kind === "command" && message.method === "input.respond") {
          inputFrames.push(text);
        }
        serverSocket.send(frame);
      });
      serverSocket.onMessage((frame) => browserSocket.send(frame));
    });

    const bootstrap = BootstrapResponseSchema.parse(
      await (await fetch(`${running.api.origin}/bootstrap`)).json(),
    );
    expect(bootstrap.commandLimits.maximumJsonDepth).toBe(1);
    await openWi(page, running.api);
    const sessionId = await createSession(page, "Minimum depth input");
    await page.reload();
    await expect(page.locator(".connection")).toContainText("Connected");
    await expect(page.getByText("Session state: live")).toBeVisible();
    await expect.poll(() => helloFrames.length).toBe(2);
    expect(maximumJsonContainerDepth(helloFrames[1] as string)).toBe(3);

    if (sendToBrowser === null) throw new Error("WebSocket route was not established");
    (sendToBrowser as (message: string) => void)(
      JSON.stringify({
        v: 1,
        kind: "event",
        sessionId,
        sequence: 2,
        eventId: "evt_minimumDepthInputRequested",
        eventType: "input.requested",
        createdAtMs: 2,
        data: {
          eventVersion: 1,
          runId: "run_minimumDepthInput",
          inputId: "input_minimumDepthInput",
          prompt: "Provide a depth-one JSON value.",
        },
      }),
    );

    const input = page.getByLabel("Response as JSON");
    const respond = page.getByRole("button", { name: "Respond", exact: true });
    const routedBefore = await running.api.commandRouteCount();
    await input.fill("[]");
    await respond.click();
    await expect.poll(() => running.api.commandRouteCount()).toBe(routedBefore + 1);
    await expect(respond).toBeEnabled();
    expect(inputFrames).toHaveLength(1);
    expect(maximumJsonContainerDepth(inputFrames[0] as string)).toBe(3);

    await input.fill("[[]]");
    await respond.click();
    await expect(page.getByTestId("pending-input-panel").locator('p[role="alert"]')).toContainText(
      "nesting limit of 1",
    );
    await expect(input).toHaveValue("[[]]");
    expect(await running.api.commandRouteCount()).toBe(routedBefore + 1);
    expect(inputFrames).toHaveLength(1);
    expect(
      await page.evaluate(() => {
        const browser = globalThis as unknown as {
          readonly sessionStorage: { getItem(key: string): string | null };
        };
        const serialized = browser.sessionStorage.getItem("wi:v1:tab-command-journal");
        if (serialized === null) return 0;
        const journal = JSON.parse(serialized) as {
          readonly items: readonly { readonly type?: string }[];
        };
        return journal.items.filter((item) => item.type === "command").length;
      }),
    ).toBe(0);
    await expect(page.locator(".connection")).toContainText("Connected");
  } finally {
    await page.close();
    await running.close();
  }
});

test("opens and commands the exact deep-linked session omitted from 1,001 bootstrap rows", async ({
  page,
  wi,
}) => {
  const seeded = await wi.seedBoundedSessionIndex();
  const clientFrames: Array<Record<string, unknown>> = [];
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      clientFrames.push(JSON.parse(text) as Record<string, unknown>);
      serverSocket.send(frame);
    });
    serverSocket.onMessage((frame) => browserSocket.send(frame));
  });

  await openWi(page, wi, seeded.omittedSessionId);
  await expect(page.getByRole("heading", { name: seeded.title, exact: true })).toBeVisible();
  await expect(page.getByText("Session state: live")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("session")).toBe(seeded.omittedSessionId);
  await expect(page.locator(".session-list li")).toHaveCount(1_000);
  await expect(page.getByText("Only the most recently updated sessions are shown.")).toBeVisible();
  expect(clientFrames).toContainEqual(
    expect.objectContaining({
      kind: "hello",
      resume: [
        expect.objectContaining({ sessionId: seeded.omittedSessionId, afterSequence: 0 }),
      ],
    }),
  );

  await sendMessage(page, "command the omitted durable target");
  expect(clientFrames).toContainEqual(
    expect.objectContaining({
      kind: "command",
      sessionId: seeded.omittedSessionId,
      method: "message.submit",
    }),
  );
  await expectRunState(page, "completed");
});

test("keeps a valid unknown deep link instead of opening the first ready session", async ({
  page,
  wi,
}) => {
  const clientFrames: Array<Record<string, unknown>> = [];
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      clientFrames.push(JSON.parse(text) as Record<string, unknown>);
      serverSocket.send(frame);
    });
    serverSocket.onMessage((frame) => browserSocket.send(frame));
  });

  await openWi(page, wi);
  await createSession(page, "Ready session must not replace target");
  const unknownSessionId = "ses_validUnknownTarget";
  await openWi(page, wi, unknownSessionId);

  await expect(page.getByRole("heading", { name: unknownSessionId, exact: true })).toBeVisible();
  await expect(page.getByText(/Requested session ses_validUnknownTarget is outside/u)).toBeVisible();
  await expect(page.getByText(/Session integrity error:.*does not exist/iu)).toBeVisible();
  expect(new URL(page.url()).searchParams.get("session")).toBe(unknownSessionId);
  expect(clientFrames).toContainEqual(
    expect.objectContaining({
      kind: "hello",
      resume: [expect.objectContaining({ sessionId: unknownSessionId, afterSequence: 0 })],
    }),
  );
  await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
});

test("keeps an unavailable deep link instead of opening a ready fallback", async ({ page, wi }) => {
  const seeded = await wi.seedUnavailableSession();
  const clientFrames: Array<Record<string, unknown>> = [];
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      clientFrames.push(JSON.parse(text) as Record<string, unknown>);
      serverSocket.send(frame);
    });
    serverSocket.onMessage((frame) => browserSocket.send(frame));
  });

  await openWi(page, wi, seeded.sessionId);
  await expect(page.getByRole("heading", { name: seeded.title, exact: true })).toBeVisible();
  await expect(page.getByText(/is marked unavailable.*No fallback session was selected/iu)).toBeVisible();
  await expect(page.getByText(/Session integrity error:/u)).toBeVisible();
  await expect(page.getByRole("heading", { name: seeded.fallbackTitle, exact: true })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("session")).toBe(seeded.sessionId);
  expect(clientFrames).toContainEqual(
    expect.objectContaining({
      kind: "hello",
      resume: [expect.objectContaining({ sessionId: seeded.sessionId, afterSequence: 0 })],
    }),
  );
});

test("creates two sessions and runs both concurrently", async ({ page, wi }) => {
  await openWi(page, wi);
  await createSession(page, "Concurrent A");
  await sendMessage(page, "[slow] first concurrent run");
  await createSession(page, "Concurrent B");
  await sendMessage(page, "[slow] second concurrent run");
  await wi.waitForProviderRequest(2);

  await wi.releaseProvider("slow");
  await selectSession(page, "Concurrent A");
  await expect(page.getByText("Slow fake response.", { exact: true })).toBeVisible();
  await expectRunState(page, "completed");
  await selectSession(page, "Concurrent B");
  await expect(page.getByText("Slow fake response.", { exact: true })).toBeVisible();
  await expectRunState(page, "completed");
});

test("two tabs converge and all tabs can close without cancelling backend work", async ({
  page,
  context,
  wi,
}) => {
  await openWi(page, wi);
  const sessionId = await createSession(page, "Disposable tabs");
  await sendMessage(page, "[slow] survive every browser tab closing");
  await wi.waitForProviderRequest();
  await expect(page.getByText("Slow", { exact: true })).toBeVisible();

  const second = await context.newPage();
  await openWi(second, wi, sessionId);
  await expect(second.getByText("Slow", { exact: true })).toBeVisible();
  const beforeCloseSequence = Number(
    await second.getByTestId("timeline").getAttribute("data-last-sequence"),
  );
  expect(beforeCloseSequence).toBeGreaterThan(0);

  await Promise.all([page.close(), second.close()]);
  await wi.releaseProvider("slow");

  const reopened = await context.newPage();
  await openWi(reopened, wi, sessionId);
  await expect(reopened.getByText("Slow fake response.", { exact: true })).toBeVisible();
  await expectRunState(reopened, "completed");
  const durableHead = await wi.sessionHead(sessionId);
  await expect(reopened.getByTestId("timeline")).toHaveAttribute(
    "data-last-sequence",
    String(durableHead),
  );
});

test("approval remains durable across refresh and resolves once across tabs", async ({
  page,
  context,
  wi,
}) => {
  await openWi(page, wi);
  const sessionId = await createSession(page, "Guarded approval");
  await sendMessage(page, "[approval] guarded action");
  await expect(page.getByTestId("approval-panel")).toBeVisible();

  await page.reload();
  await expect(page.locator(".connection")).toContainText("Connected");
  await expect(page.getByTestId("approval-panel")).toBeVisible();

  const second = await context.newPage();
  await openWi(second, wi, sessionId);
  await expect(second.getByTestId("approval-panel")).toBeVisible();

  const approvalId = await page.getByTestId("approval-panel").getAttribute("data-approval-id");
  if (approvalId === null) throw new Error("Approval panel did not expose its durable ID");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByTestId("approval-panel")).toHaveCount(0);
  await expect(second.getByTestId("approval-panel")).toHaveCount(0);
  await expectRunState(page, "completed");
  await expectRunState(second, "completed");
  await expect(page.getByText("Guarded echo completed.", { exact: true })).toBeVisible();
  await expect(second.getByText("Guarded echo completed.", { exact: true })).toBeVisible();

  const rejection = (await second.evaluate(
    async ({ currentSessionId, currentApprovalId }) => {
      const browser = globalThis as unknown as {
        readonly location: { readonly href: string };
        readonly WebSocket: new (url: string, protocol: string) => {
          onopen: (() => void) | null;
          onmessage: ((event: { readonly data: unknown }) => void) | null;
          onerror: (() => void) | null;
          send(data: string): void;
          close(): void;
        };
        setTimeout(callback: () => void, delayMs: number): number;
        clearTimeout(handle: number): void;
      };
      const url = new URL("/ws", browser.location.href);
      url.protocol = "ws:";
      return new Promise<unknown>((resolve, reject) => {
        const socket = new browser.WebSocket(url.href, "wi.v1");
        let commandSent = false;
        const timer = browser.setTimeout(() => {
          socket.close();
          reject(new Error("Timed out waiting for second approval resolution"));
        }, 5_000);
        socket.onopen = () => {
          socket.send(
            JSON.stringify({
              v: 1,
              kind: "hello",
              clientId: "client_secondResolution",
              resume: [],
            }),
          );
        };
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as {
            readonly kind?: string;
            readonly commandId?: string;
          };
          if (message.kind === "welcome" && !commandSent) {
            commandSent = true;
            socket.send(
              JSON.stringify({
                v: 1,
                kind: "command",
                commandId: "cmd_secondResolution",
                sessionId: currentSessionId,
                method: "approval.resolve",
                params: { approvalId: currentApprovalId, resolution: "denied" },
              }),
            );
          }
          if (message.kind === "command.rejected" && message.commandId === "cmd_secondResolution") {
            browser.clearTimeout(timer);
            socket.close();
            resolve(message);
          }
        };
        socket.onerror = () => {
          browser.clearTimeout(timer);
          reject(new Error("Second approval WebSocket failed"));
        };
      });
    },
    { currentSessionId: sessionId, currentApprovalId: approvalId },
  )) as { readonly code?: string; readonly message?: string };
  expect(rejection).toMatchObject({
    code: "approval.already_resolved",
    message: "This approval was already resolved.",
  });
});

test("disables state-changing controls after a terminal connection failure", async ({ page, wi }) => {
  let closeConnection: (() => void) | null = null;
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    browserSocket.connectToServer();
    closeConnection = () => browserSocket.close({ code: 1008, reason: "terminal policy" });
  });
  await openWi(page, wi);
  await createSession(page, "Terminal controls");
  await sendMessage(page, "[approval] terminal control state");
  await expect(page.getByTestId("approval-panel")).toBeVisible();

  if (closeConnection === null) throw new Error("WebSocket route was not established");
  (closeConnection as () => void)();
  await expect(page.locator(".connection")).toContainText("error");
  await expect(page.getByLabel("New session title")).toBeDisabled();
  await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cancel run", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reload Wi", exact: true })).toBeVisible();
});

test("isolates a fatal session projection while leaving global session creation available", async ({
  page,
  wi,
}) => {
  let sendToBrowser: ((message: string) => void) | null = null;
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    browserSocket.connectToServer();
    sendToBrowser = (message) => browserSocket.send(message);
  });
  await openWi(page, wi);
  const sessionId = await createSession(page, "Fatal projection controls");
  await sendMessage(page, "[approval] projection must be trusted");
  await expect(page.getByTestId("approval-panel")).toBeVisible();

  if (sendToBrowser === null) throw new Error("WebSocket route was not established");
  (sendToBrowser as (message: string) => void)(
    JSON.stringify({
      v: 1,
      kind: "protocol.error",
      sessionId,
      code: "replay.sequence_conflict",
      message: "The session replay detected conflicting committed history.",
      diagnosticId: "err_fatalProjection",
      recoverable: false,
    }),
  );

  await expect(page.getByText(/Session integrity error:/u)).toBeVisible();
  await expect(page.getByLabel("New session title")).toBeEnabled();
  await expect(page.getByLabel("Message", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cancel run", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reload session", exact: true })).toBeVisible();
});

test("retries the same command ID after disconnect before routing", async ({ page, wi }) => {
  await openWi(page, wi);
  const sessionId = await createSession(page, "Before route retry");
  await page.getByLabel("Message", { exact: true }).fill("[before-route] exactly once");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const commandId = await wi.waitForBeforeRouteBlock();
  await expect(
    page.getByText("Message command pending durable acceptance.", { exact: true }),
  ).toBeVisible();
  expect(await wi.disconnect()).toBe(1);

  await expect(page.locator(".connection")).toContainText("Connected");
  await wi.waitForBeforeRouteRetry(commandId);
  wi.releaseBeforeRoute(commandId);
  await expect(
    page.getByTestId("timeline-user").filter({ hasText: "[before-route] exactly once" }),
  ).toHaveCount(1);
  await expectRunState(page, "completed");
  const head = await wi.sessionHead(sessionId);
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-last-sequence", String(head));
});

test("disconnects during historical replay and recovers the exact cursor", async ({
  page,
  context,
  wi,
}) => {
  await openWi(page, wi);
  const sessionId = await createSession(page, "Disconnect during replay");
  await sendMessage(page, "durable replay history");
  await expectRunState(page, "completed");
  const head = await wi.sessionHead(sessionId);
  await page.close();

  await wi.armReplay(sessionId);
  const reopened = await context.newPage();
  await reopened.goto(`${wi.origin}/?session=${sessionId}`);
  await expect(reopened.locator(".connection")).toContainText("Connected");
  await wi.waitForReplayBlock(sessionId);
  expect(await wi.disconnect()).toBe(1);
  wi.releaseReplay(sessionId);

  await expect(reopened.locator(".connection")).toContainText("Connected");
  await expect(reopened.getByText("Session state: live")).toBeVisible();
  await expect(reopened.getByTestId("timeline")).toHaveAttribute(
    "data-last-sequence",
    String(head),
  );
  await expectRunState(reopened, "completed");
});

test("reconciles approval resolution after disconnect before acknowledgement", async ({
  page,
  context,
  wi,
}) => {
  await openWi(page, wi);
  const sessionId = await createSession(page, "Approval acknowledgement reconnect");
  await sendMessage(page, "[approval] reconnect resolution");
  await expect(page.getByTestId("approval-panel")).toBeVisible();
  const second = await context.newPage();
  await openWi(second, wi, sessionId);
  await expect(second.getByTestId("approval-panel")).toBeVisible();

  await wi.armApprovalAcknowledgement();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const commandId = await wi.waitForApprovalAcknowledgementBlock();
  expect(await wi.disconnect()).toBe(2);
  wi.releaseApprovalAcknowledgement(commandId);

  await expect(page.locator(".connection")).toContainText("Connected");
  await expect(second.locator(".connection")).toContainText("Connected");
  await expectRunState(page, "completed");
  await expectRunState(second, "completed");
  await expect(page.getByText("Command reconciled after reconnect.", { exact: true })).toBeVisible();
  await expect(page.getByText("Guarded echo completed.", { exact: true })).toHaveCount(1);
  await expect(second.getByText("Guarded echo completed.", { exact: true })).toHaveCount(1);
});

test("serializes a simultaneous two-tab approval race through both UIs", async ({
  page,
  context,
  wi,
}) => {
  await openWi(page, wi);
  const sessionId = await createSession(page, "Approval UI race");
  await sendMessage(page, "[approval] simultaneous UI race");
  await expect(page.getByTestId("approval-panel")).toBeVisible();
  const second = await context.newPage();
  await openWi(second, wi, sessionId);
  await expect(second.getByTestId("approval-panel")).toBeVisible();

  await wi.armApprovalRace();
  await Promise.all([
    page
      .getByRole("button", { name: "Approve", exact: true })
      .evaluate((button) => (button as unknown as { click(): void }).click()),
    second
      .getByRole("button", { name: "Approve", exact: true })
      .evaluate((button) => (button as unknown as { click(): void }).click()),
  ]);
  const commandIds = await wi.waitForApprovalRace();
  expect(new Set(commandIds).size).toBe(2);
  wi.releaseApprovalRace();

  await expect(page.getByTestId("approval-panel")).toHaveCount(0);
  await expect(second.getByTestId("approval-panel")).toHaveCount(0);
  await expectRunState(page, "completed");
  await expectRunState(second, "completed");
  await expect
    .poll(async () =>
      (await page.locator('[data-error-code="approval.already_resolved"]').count()) +
      (await second.locator('[data-error-code="approval.already_resolved"]').count()),
    )
    .toBe(1);
  await expect(page.getByText("Guarded echo completed.", { exact: true })).toHaveCount(1);
  await expect(second.getByText("Guarded echo completed.", { exact: true })).toHaveCount(1);
});

test("restores keyboard focus after approval and cancel controls disappear", async ({ page, wi }) => {
  await openWi(page, wi);
  await createSession(page, "Keyboard focus approval");
  await sendMessage(page, "[approval] keyboard focus");
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await approve.focus();
  await page.keyboard.press("Enter");
  await expectRunState(page, "completed");
  await expect
    .poll(() =>
      page
        .getByLabel("Current run status")
        .evaluate((element) => element === element.ownerDocument.activeElement),
    )
    .toBe(true);

  await createSession(page, "Keyboard focus cancel");
  await sendMessage(page, "[slow] keyboard cancellation");
  const cancel = page.getByRole("button", { name: "Cancel run", exact: true });
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expectRunState(page, "cancelled");
  await expect
    .poll(() =>
      page
        .getByLabel("Current run status")
        .evaluate((element) => element === element.ownerDocument.activeElement),
    )
    .toBe(true);
});

test("restores keyboard focus after a pending-input response disappears", async ({ page, wi }) => {
  let sendToBrowser: ((message: string) => void) | null = null;
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    sendToBrowser = (message) => browserSocket.send(message);
    browserSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as {
        readonly kind?: string;
        readonly method?: string;
        readonly commandId?: string;
        readonly sessionId?: string;
      };
      if (
        message.kind === "command" &&
        message.method === "input.respond" &&
        message.commandId !== undefined &&
        message.sessionId !== undefined
      ) {
        browserSocket.send(
          JSON.stringify({
            v: 1,
            kind: "command.accepted",
            commandId: message.commandId,
            sessionId: message.sessionId,
            acceptedSequence: 3,
            result: {},
            duplicate: false,
          }),
        );
        browserSocket.send(
          JSON.stringify({
            v: 1,
            kind: "event",
            sessionId: message.sessionId,
            sequence: 3,
            eventId: "evt_focusInputResolved",
            eventType: "input.resolved",
            createdAtMs: 3,
            data: {
              eventVersion: 1,
              runId: "run_focusInput",
              inputId: "input_focusInput",
              value: "yes",
            },
          }),
        );
        return;
      }
      serverSocket.send(frame);
    });
    serverSocket.onMessage((frame) => browserSocket.send(frame));
  });

  await openWi(page, wi);
  const sessionId = await createSession(page, "Keyboard focus input");
  if (sendToBrowser === null) throw new Error("WebSocket route was not established");
  (sendToBrowser as (message: string) => void)(
    JSON.stringify({
      v: 1,
      kind: "event",
      sessionId,
      sequence: 2,
      eventId: "evt_focusInputRequested",
      eventType: "input.requested",
      createdAtMs: 2,
      data: {
        eventVersion: 1,
        runId: "run_focusInput",
        inputId: "input_focusInput",
        prompt: "Continue with keyboard focus?",
      },
    }),
  );

  await page.getByLabel("Response as JSON").fill('"yes"');
  const respond = page.getByRole("button", { name: "Respond", exact: true });
  await respond.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("pending-input-panel")).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .getByLabel("Message", { exact: true })
        .evaluate((element) => element === element.ownerDocument.activeElement),
    )
    .toBe(true);
});

test("does not steal newer focus after delayed approval and cancel removal", async ({
  page,
  wi,
}) => {
  let releaseCancel: (() => void) | null = null;
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as { readonly kind?: string; readonly method?: string };
      if (message.kind === "command" && message.method === "run.cancel") {
        releaseCancel = () => serverSocket.send(frame);
        return;
      }
      serverSocket.send(frame);
    });
    serverSocket.onMessage((frame) => browserSocket.send(frame));
  });

  await openWi(page, wi);
  await createSession(page, "Delayed approval focus");
  await sendMessage(page, "[approval] preserve newer focus");
  await wi.armApprovalRace();
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await approve.focus();
  await page.keyboard.press("Enter");
  await wi.waitForApprovalRace(1);
  const title = page.getByLabel("New session title");
  await title.focus();
  wi.releaseApprovalRace();
  await expectRunState(page, "completed");
  await expect
    .poll(() => title.evaluate((element) => element === element.ownerDocument.activeElement))
    .toBe(true);

  await createSession(page, "Delayed cancel focus");
  await sendMessage(page, "[slow] preserve newer cancel focus");
  const cancel = page.getByRole("button", { name: "Cancel run", exact: true });
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => releaseCancel !== null).toBe(true);
  await title.focus();
  if (releaseCancel === null) throw new Error("Cancel command was not gated");
  (releaseCancel as () => void)();
  await expectRunState(page, "cancelled");
  await expect
    .poll(() => title.evaluate((element) => element === element.ownerDocument.activeElement))
    .toBe(true);
});

test("does not steal newer focus after delayed pending-input removal", async ({ page, wi }) => {
  let sendToBrowser: ((message: string) => void) | null = null;
  let releaseInput: (() => void) | null = null;
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    sendToBrowser = (message) => browserSocket.send(message);
    browserSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as {
        readonly kind?: string;
        readonly method?: string;
        readonly commandId?: string;
        readonly sessionId?: string;
      };
      if (
        message.kind === "command" &&
        message.method === "input.respond" &&
        message.commandId !== undefined &&
        message.sessionId !== undefined
      ) {
        releaseInput = () => {
          browserSocket.send(
            JSON.stringify({
              v: 1,
              kind: "command.accepted",
              commandId: message.commandId,
              sessionId: message.sessionId,
              acceptedSequence: 3,
              result: {},
              duplicate: false,
            }),
          );
          browserSocket.send(
            JSON.stringify({
              v: 1,
              kind: "event",
              sessionId: message.sessionId,
              sequence: 3,
              eventId: "evt_delayedFocusInputResolved",
              eventType: "input.resolved",
              createdAtMs: 3,
              data: {
                eventVersion: 1,
                runId: "run_delayedFocusInput",
                inputId: "input_delayedFocusInput",
                value: "yes",
              },
            }),
          );
        };
        return;
      }
      serverSocket.send(frame);
    });
    serverSocket.onMessage((frame) => browserSocket.send(frame));
  });

  await openWi(page, wi);
  const sessionId = await createSession(page, "Delayed input focus");
  if (sendToBrowser === null) throw new Error("WebSocket route was not established");
  (sendToBrowser as (message: string) => void)(
    JSON.stringify({
      v: 1,
      kind: "event",
      sessionId,
      sequence: 2,
      eventId: "evt_delayedFocusInputRequested",
      eventType: "input.requested",
      createdAtMs: 2,
      data: {
        eventVersion: 1,
        runId: "run_delayedFocusInput",
        inputId: "input_delayedFocusInput",
        prompt: "Keep the later focus?",
      },
    }),
  );
  await page.getByLabel("Response as JSON").fill('"yes"');
  const respond = page.getByRole("button", { name: "Respond", exact: true });
  await respond.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => releaseInput !== null).toBe(true);
  const title = page.getByLabel("New session title");
  await title.focus();
  if (releaseInput === null) throw new Error("Input response was not gated");
  (releaseInput as () => void)();

  await expect(page.getByTestId("pending-input-panel")).toHaveCount(0);
  await expect
    .poll(() => title.evaluate((element) => element === element.ownerDocument.activeElement))
    .toBe(true);
});

test("clears failed local cancel focus intent before another tab resolves the run", async ({
  page,
  context,
  wi,
}) => {
  await openWi(page, wi);
  const sessionId = await createSession(page, "Local cancel validation focus");
  await sendMessage(page, "[slow] local cancel validation focus");
  await expect(page.getByRole("button", { name: "Cancel run", exact: true })).toBeVisible();

  const constrained = await context.newPage();
  await constrained.route("**/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      commandLimits: {
        v: 1;
        maximumFrameBytes: number;
        maximumDurablePayloadBytes: number;
        maximumRawInputCodeUnits: number;
        maximumRawInputUtf8Bytes: number;
        maximumJsonDepth: number;
        maximumJsonNodes: number;
      };
    };
    body.commandLimits = {
      v: 1,
      maximumFrameBytes: 1,
      maximumDurablePayloadBytes: 1,
      maximumRawInputCodeUnits: 1,
      maximumRawInputUtf8Bytes: 1,
      maximumJsonDepth: 0,
      maximumJsonNodes: 1,
    };
    await route.fulfill({ response, json: body });
  });
  await openWi(constrained, wi, sessionId);
  const constrainedCancel = constrained.getByRole("button", { name: "Cancel run", exact: true });
  await constrainedCancel.focus();
  await constrained.keyboard.press("Enter");
  await expect(constrained.getByText(/complete command is/iu)).toBeVisible();
  const title = constrained.getByLabel("New session title");
  await title.focus();

  await page.getByRole("button", { name: "Cancel run", exact: true }).click();
  await expectRunState(constrained, "cancelled");
  await expect
    .poll(() => title.evaluate((element) => element === element.ownerDocument.activeElement))
    .toBe(true);
});

test("reconnects after forced close and reconciles a lost acknowledgement without duplication", async ({
  page,
  wi,
}) => {
  await openWi(page, wi);
  const sessionId = await createSession(page, "Reconnect commands");
  expect(await wi.disconnect(4409, "slow consumer")).toBe(1);
  await expect(page.locator(".connection")).not.toContainText("Connected");
  await expect(page.locator(".connection")).toContainText("Connected");

  await page.getByLabel("Message", { exact: true }).fill("[lost-ack] exactly once");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const commandId = await wi.waitForAcknowledgementBlock();
  await expect(page.getByText("Message command pending durable acceptance.", { exact: true })).toBeVisible();
  await expect(
    page.getByTestId("timeline-user").filter({ hasText: "[lost-ack] exactly once" }),
  ).toHaveCount(1);
  expect(await wi.disconnect()).toBe(1);
  wi.releaseAcknowledgement(commandId);

  await expect(page.locator(".connection")).toContainText("Connected");
  await expect(page.getByText("Command reconciled after reconnect.", { exact: true })).toBeVisible();
  await expect(
    page.getByTestId("timeline-user").filter({ hasText: "[lost-ack] exactly once" }),
  ).toHaveCount(1);
  await expectRunState(page, "completed");
  const head = await wi.sessionHead(sessionId);
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-last-sequence", String(head));
});

test("renders interrupted and XSS-shaped provider output safely", async ({ page, wi }) => {
  await openWi(page, wi);
  await createSession(page, "Interrupted output");
  await sendMessage(page, "[interrupt] preserve partial output");
  await expect(page.getByText("Visible partial output.", { exact: true })).toBeVisible();
  await expect(
    page.getByTestId("timeline-assistant").getByText("Interrupted partial output", { exact: true }),
  ).toBeVisible();
  await expectRunState(page, "interrupted");

  await createSession(page, "Untrusted output");
  await sendMessage(page, "[xss] render model output as text");
  const payload = '<img src=x onerror="globalThis.__wiXss=1"><script>globalThis.__wiXss=2</script>javascript:alert(1)';
  await expect(page.getByText(payload, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as { __wiXss?: number }).__wiXss)).toBeUndefined();
  await expect(page.locator(".timeline-item img, .timeline-item script, .timeline-item a")).toHaveCount(0);
  expect(
    await page.evaluate(async () => {
      const browser = globalThis as unknown as {
        readonly document: { readonly cookie: string };
        readonly localStorage: { readonly length: number; key(index: number): string | null };
        readonly sessionStorage: { readonly length: number; key(index: number): string | null };
        readonly indexedDB: { databases(): Promise<readonly { readonly name?: string }[]> };
      };
      const keys = (storage: { readonly length: number; key(index: number): string | null }) =>
        Array.from({ length: storage.length }, (_, index) => storage.key(index));
      return {
        cookie: browser.document.cookie,
        localStorageKeys: keys(browser.localStorage),
        sessionStorageKeys: keys(browser.sessionStorage),
        databases: (await browser.indexedDB.databases()).map((database) => database.name),
      };
    }),
  ).toEqual({ cookie: "", localStorageKeys: [], sessionStorageKeys: [], databases: [] });
});

test("retries a recoverable replay failure and returns to live", async ({ page, wi }) => {
  let injected = false;
  let subscribeCount = 0;
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as {
        readonly kind?: string;
        readonly sessionId?: string;
      };
      if (message.kind === "subscribe") subscribeCount += 1;
      serverSocket.send(frame);
    });
    serverSocket.onMessage((frame) => {
      browserSocket.send(frame);
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as {
        readonly kind?: string;
        readonly sessionId?: string;
      };
      if (!injected && message.kind === "replay.complete" && message.sessionId !== undefined) {
        injected = true;
        browserSocket.send(
          JSON.stringify({
            v: 1,
            kind: "protocol.error",
            sessionId: message.sessionId,
            code: "replay.query_failed",
            message: "The session subscription could not be completed safely.",
            diagnosticId: "err_recoverableReplay",
            recoverable: true,
          }),
        );
      }
    });
  });

  await openWi(page, wi);
  await createSession(page, "Recoverable replay");
  await expect.poll(() => subscribeCount).toBeGreaterThanOrEqual(2);
  await expect(page.getByText("Session state: live")).toBeVisible();
  await sendMessage(page, "events still arrive after replay recovery");
  await expectRunState(page, "completed");
});

test("recovers when replay-complete advertises one missing tail event", async ({
  page,
  context,
  wi,
}) => {
  await openWi(page, wi);
  const sessionId = await createSession(page, "Replay complete mismatch");
  await sendMessage(page, "build a durable history before replay mismatch");
  await expectRunState(page, "completed");
  const head = await wi.sessionHead(sessionId);
  expect(head).toBeGreaterThan(1);

  const reopened = await context.newPage();
  let droppedTail = false;
  await reopened.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    serverSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as {
        readonly kind?: string;
        readonly sequence?: number;
      };
      if (!droppedTail && message.kind === "event" && message.sequence === head) {
        droppedTail = true;
        return;
      }
      browserSocket.send(frame);
    });
  });

  await openWi(reopened, wi, sessionId);
  await expect(reopened.getByText("Session state: live")).toBeVisible();
  await expect(reopened.getByTestId("timeline")).toHaveAttribute(
    "data-last-sequence",
    String(head),
  );
  await expectRunState(reopened, "completed");
  expect(droppedTail).toBe(true);
});

test("reconciles a session selected during delayed hello and welcome", async ({
  page,
  context,
  wi,
}) => {
  await openWi(page, wi);
  const firstSessionId = await createSession(page, "Handshake A");
  await createSession(page, "Handshake B");

  const delayed = await context.newPage();
  let releaseWelcome: (() => void) | null = null;
  let markWelcomeCaptured: (() => void) | null = null;
  const welcomeCaptured = new Promise<void>((resolve) => {
    markWelcomeCaptured = resolve;
  });
  await delayed.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    const queued: Array<string | Buffer> = [];
    let released = false;
    releaseWelcome = () => {
      released = true;
      for (const frame of queued) browserSocket.send(frame);
      queued.length = 0;
    };
    serverSocket.onMessage((frame) => {
      if (released) {
        browserSocket.send(frame);
        return;
      }
      queued.push(frame);
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as { readonly kind?: string };
      if (message.kind === "welcome") markWelcomeCaptured?.();
    });
  });

  await delayed.goto(`${wi.origin}/?session=${firstSessionId}`);
  await welcomeCaptured;
  await delayed.getByRole("button", { name: /^Handshake B/u }).click();
  if (releaseWelcome === null) throw new Error("Delayed WebSocket route was not established");
  (releaseWelcome as () => void)();

  await expect(delayed.locator(".connection")).toContainText("Connected");
  await expect(delayed.getByRole("heading", { name: "Handshake B", exact: true })).toBeVisible();
  await expect(delayed.getByText("Session state: live")).toBeVisible();
});

test("ignores a stale event after its session is intentionally closed", async ({ page, wi }) => {
  const subscribeCounts = new Map<string, number>();
  let sendToBrowser: ((message: string) => void) | null = null;
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    sendToBrowser = (message) => browserSocket.send(message);
    browserSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as {
        readonly kind?: string;
        readonly sessionId?: string;
      };
      if (message.kind === "subscribe" && message.sessionId !== undefined) {
        subscribeCounts.set(message.sessionId, (subscribeCounts.get(message.sessionId) ?? 0) + 1);
      }
      serverSocket.send(frame);
    });
    serverSocket.onMessage((frame) => browserSocket.send(frame));
  });

  await openWi(page, wi);
  const firstSessionId = await createSession(page, "Closed subscription A");
  await createSession(page, "Closed subscription B");
  expect(subscribeCounts.get(firstSessionId)).toBe(1);
  if (sendToBrowser === null) throw new Error("WebSocket route was not established");
  (sendToBrowser as (message: string) => void)(
    JSON.stringify({
      v: 1,
      kind: "event",
      sessionId: firstSessionId,
      sequence: 2,
      eventId: "evt_staleClosedSession",
      eventType: "user.message.appended",
      createdAtMs: 2,
      data: {
        eventVersion: 1,
        messageId: "msg_staleClosedSession",
        runId: "run_staleClosedSession",
        text: "stale closed-session frame",
      },
    }),
  );

  await sendMessage(page, "selected session remains authoritative");
  await expectRunState(page, "completed");
  expect(subscribeCounts.get(firstSessionId)).toBe(1);
});

test("detects a dropped event and resynchronizes the exact replay suffix", async ({ page, wi }) => {
  let dropped = false;
  await page.routeWebSocket(/\/ws$/u, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    serverSocket.onMessage((frame) => {
      const text = typeof frame === "string" ? frame : frame.toString("utf8");
      const message = JSON.parse(text) as { readonly kind?: string; readonly eventType?: string };
      if (!dropped && message.kind === "event" && message.eventType === "run.created") {
        dropped = true;
        return;
      }
      browserSocket.send(frame);
    });
  });

  await openWi(page, wi);
  const sessionId = await createSession(page, "Replay gap");
  await sendMessage(page, "complete after a forced sequence gap");
  await expectRunState(page, "completed");
  expect(dropped).toBe(true);
  await expect(page.getByText("A sequence gap was detected. Replaying from the last trusted event.", { exact: true })).toBeVisible();
  await expect(page.getByText("Session state: live")).toBeVisible();
  const head = await wi.sessionHead(sessionId);
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-last-sequence", String(head));
});
