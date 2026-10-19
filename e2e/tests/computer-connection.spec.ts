import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { AccountComputerSummary, CreateAgentRequest } from "@opentag/shared/browser";
import type { Locator, Page } from "@playwright/test";
import { baseURL, repositoryRoot } from "../playwright.config.js";
import { expectAccessible, expectNoPageOverflow } from "./browser-contract.js";
import { expect, test } from "./fixtures.js";

const execFileAsync = promisify(execFile);
const cli = join(repositoryRoot, "apps/cli/dist/cli/index.mjs");
const codePattern = /\bconnect --server\s+'?([^\s']+)'?\s+--\s+'?(otcc_[A-Za-z0-9_-]+)'?/u;

function connectCode(task: string): string {
  const match = codePattern.exec(task);
  if (!match?.[2]) throw new Error("Connect task did not contain an authorization");
  expect(match[1]).toBe(baseURL);
  return match[2];
}

test.use({ storageState: { cookies: [], origins: [] } });

async function signUp(page: Page): Promise<string> {
  await page.goto("/login");
  const response = await page.request.post("/api/v1/auth/email/sign-up", {
    headers: { Origin: baseURL },
    data: {
      email: `computer-${randomUUID()}@opentag.local`,
      displayName: "Computer E2E",
      password: "computer-e2e-password",
    },
  });
  expect(response.status()).toBe(204);
  const me = await page.request.get("/api/v1/me");
  expect(me.ok()).toBe(true);
  return ((await me.json()) as { user: { id: string } }).user.id;
}

async function post(page: Page, path: string, data: unknown = {}) {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "opentag_csrf")?.value;
  if (!csrf) throw new Error("Missing E2E CSRF cookie");
  const response = await page.request.post(path, { headers: { Origin: baseURL, "x-opentag-csrf": csrf }, data });
  expect(response.ok(), `POST ${path}: ${response.status()}`).toBe(true);
  return response;
}

async function createAgent(page: Page): Promise<string> {
  return (
    (await (
      await post(page, "/api/v1/agents", {
        creationIntentId: randomUUID(),
        name: `computer-${randomUUID()}`,
        displayName: "Connection reviewer",
        runtimeProvider: "claude-code",
      } satisfies CreateAgentRequest)
    ).json()) as { id: string }
  ).id;
}

async function computers(page: Page): Promise<AccountComputerSummary[]> {
  const response = await page.request.get("/api/v1/computers", { headers: { "x-opentag-computer-access": "1" } });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { computers: AccountComputerSummary[] }).computers;
}

async function registerOffline(page: Page, displayName: string): Promise<string> {
  const issued = (await (await post(page, "/api/v1/computer-connect-codes", { mode: "create" })).json()) as {
    bootstrapCommand: string;
  };
  const code = connectCode(issued.bootstrapCommand);
  const response = await page.request.post("/api/v1/computer/connect/exchange", {
    data: { code, installationId: randomUUID(), displayName, platform: "linux", arch: "x64", clientVersion: "e2e" },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { computerId: string }).computerId;
}

async function copyTask(page: Page, scope: Page | Locator = page): Promise<string> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const copy = scope.getByRole("button", { name: "Copy for AI assistant", exact: true });
  await expect(copy).toBeVisible();
  await copy.click();
  await expect(scope.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  return page.evaluate(() => navigator.clipboard.readText());
}

/** Executes the copied authorization with the built CLI in a disposable system-user home. */
async function temporaryComputer() {
  const directory = await mkdtemp(join(tmpdir(), "opentag-computer-flow-e2e-"));
  const home = join(directory, "home");
  const openTagHome = join(directory, "opentag");
  const bin = join(directory, "bin");
  await Promise.all([mkdir(join(home, ".claude"), { recursive: true }), mkdir(openTagHome), mkdir(bin)]);
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(repositoryRoot, "e2e/scripts/claude-stub.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    HOME: home,
    OPENTAG_HOME: openTagHome,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
  };
  let daemon: ReturnType<typeof spawn> | undefined;
  return {
    async connect(task: string): Promise<string> {
      const code = connectCode(task);
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(
          process.execPath,
          [
            cli,
            "computer",
            "connect",
            "--no-start",
            "--no-prepare-provider-clis",
            "--json",
            "--server",
            baseURL,
            "--",
            code,
          ],
          { env, cwd: directory, timeout: 30_000 },
        ));
      } catch (cause) {
        const failure = cause as Error & { stderr?: string };
        if (!failure.stderr) throw cause;
        const output = failure.stderr.split("\n").find((line) => line.startsWith("{"));
        if (!output) throw cause;
        const result = JSON.parse(output) as { error?: { code: string }; result?: { connected: boolean } };
        // Missing provider CLIs are expected here; the connection must nevertheless have committed.
        if (result.error?.code !== "LOCAL_COMPUTER_PREPARATION_INCOMPLETE" || result.result?.connected !== true)
          throw cause;
        stdout = output;
      }
      const result = JSON.parse(stdout) as {
        result: { connected: boolean; connection: { computerId: string; persistenceError?: unknown } };
      };
      expect(result.result.connected).toBe(true);
      expect(result.result.connection.persistenceError).toBeUndefined();
      return result.result.connection.computerId;
    },
    start() {
      daemon = spawn(process.execPath, [cli, "daemon", "service-run"], { env, cwd: directory, stdio: "ignore" });
    },
    async dispose() {
      if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
        const exited = new Promise<void>((resolve) => daemon?.once("exit", () => resolve()));
        daemon.kill("SIGTERM");
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
        if (daemon.exitCode === null && daemon.signalCode === null) {
          daemon.kill("SIGKILL");
          await exited;
        }
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("copies the current-computer task and waits for its actual daemon before continuing", async ({ page }) => {
  await signUp(page);
  const agentId = await createAgent(page);
  await page.goto(`/agents/setup?agentId=${agentId}`);
  await expect(page.getByRole("heading", { name: "Connect your computer", exact: true })).toBeVisible();
  await expect(page.getByText("Copy the task to your AI assistant on this computer.", { exact: true })).toBeVisible();
  const task = await copyTask(page);
  expect(task).toContain("Preserve a working connection");
  expect(task).toContain("server-side online status");
  const machine = await temporaryComputer();
  try {
    const computerId = await machine.connect(task);
    // An Agent-targeted connection binds on exchange before the daemon starts. Wait for the
    // observed bound-offline state, then verify setup remains blocked without a live daemon.
    await expect(page.locator('[data-ui="agent-setup-computer-summary"]')).toContainText("Offline");
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
    expect(await computers(page)).toMatchObject([{ computerId, connectionStatus: "offline" }]);
    machine.start();
    await expect(page.getByRole("heading", { name: "Prepare this computer", exact: true })).toBeVisible();
    expect(await computers(page)).toMatchObject([{ computerId, connectionStatus: "online" }]);
  } finally {
    await machine.dispose();
  }
});

test("automatically repairs the sole disconnected Computer in place", async ({ page }) => {
  await signUp(page);
  const computerId = await registerOffline(page, "Office Linux");
  await post(page, `/api/v1/computers/${computerId}/disconnect`);
  const agentId = await createAgent(page);
  const issued: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/computer-connect-codes"))
      issued.push(request.postDataJSON());
  });
  await page.goto(`/agents/setup?agentId=${agentId}`);
  await expect(
    page.getByText("Copy the task to your AI assistant on Office Linux to restore the connection.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Use this computer:/ })).toHaveCount(0);
  const task = await copyTask(page);
  expect(task).toContain(`Computer ID: ${computerId}`);
  expect(issued).toEqual([{ mode: "repair", targetAgentId: agentId, targetComputerId: computerId }]);
  const machine = await temporaryComputer();
  try {
    expect(await machine.connect(task)).toBe(computerId);
    machine.start();
    await expect(page.getByRole("heading", { name: "Prepare this computer", exact: true })).toBeVisible();
    expect(await computers(page)).toMatchObject([{ computerId, connectionStatus: "online" }]);
    const config = (await (await page.request.get(`/api/v1/agents/${agentId}/config`)).json()) as {
      computerId: string;
    };
    expect(config.computerId).toBe(computerId);
  } finally {
    await machine.dispose();
  }
});

test("lists multiple disconnected Computers without creating a connection or selecting until the user chooses", async ({
  page,
}, testInfo) => {
  await signUp(page);
  const officeId = await registerOffline(page, "Office Linux");
  const homeId = await registerOffline(page, "Home Mac");
  await post(page, `/api/v1/computers/${officeId}/disconnect`);
  await post(page, `/api/v1/computers/${homeId}/disconnect`);
  const agentId = await createAgent(page);
  const issued: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/computer-connect-codes"))
      issued.push(request.postDataJSON());
  });
  await page.goto(`/agents/setup?agentId=${agentId}`);
  await expect(page.getByRole("heading", { name: "Choose a computer for this Agent", exact: true })).toBeVisible();
  await expect(page.getByText("No computer selected for this Agent", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Use this computer:/ })).toHaveCount(2);
  expect(issued).toEqual([]);
  const config = (await (await page.request.get(`/api/v1/agents/${agentId}/config`)).json()) as {
    computerId: string | null;
  };
  expect(config.computerId).toBeNull();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoPageOverflow(page);
    await expectAccessible(page);
    if (width === 390 || width === 1440)
      await testInfo.attach(`computer-choice-${width}`, { body: await page.screenshot(), contentType: "image/png" });
  }
  await page.getByRole("button", { name: "Use this computer: Office Linux", exact: true }).focus();
  await page.keyboard.press("Enter");
  const task = await copyTask(page);
  expect(task).toContain(`Computer ID: ${officeId}`);
  expect(issued).toEqual([{ mode: "repair", targetAgentId: agentId, targetComputerId: officeId }]);
});

test("connects another Computer without moving an existing Agent", async ({ page, e2eRuntime }) => {
  const accountId = await signUp(page);
  await e2eRuntime.setSetupComplete(accountId);
  const existingId = await registerOffline(page, "Office Linux");
  const agentId = await createAgent(page);
  await post(page, `/api/v1/agents/${agentId}/computer/rebind`, { computerId: existingId });
  await page.goto("/agents/computers");
  await page.getByRole("button", { name: "Connect another computer", exact: true }).click();
  await expect(
    page.getByText(
      "Copy the task to your AI assistant on the target computer. Return here to continue setup when it connects.",
      { exact: true },
    ),
  ).toBeVisible();
  const task = await copyTask(page, page.locator('[data-ui="computer-connect"]'));
  expect(task).toContain("this computer's current environment");
  const machine = await temporaryComputer();
  try {
    const newId = await machine.connect(task);
    expect(newId).not.toBe(existingId);
    await expect(page.getByRole("button", { name: "Connect another computer", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Office Linux", exact: true })).toBeVisible();
    machine.start();
    await expect(page.getByRole("button", { name: "Connect another computer", exact: true })).toBeVisible();
    expect(await computers(page)).toHaveLength(2);
    const config = (await (await page.request.get(`/api/v1/agents/${agentId}/config`)).json()) as {
      computerId: string;
    };
    expect(config.computerId).toBe(existingId);
  } finally {
    await machine.dispose();
  }
});

test("uses first-Local guidance when the inventory contains only Cloud", async ({ page, e2eRuntime }) => {
  const accountId = await signUp(page);
  await e2eRuntime.setSetupComplete(accountId);
  const cloud: AccountComputerSummary = {
    computerId: randomUUID(),
    displayName: "Cloud",
    kind: "cloud",
    platform: "linux",
    connectionStatus: "online",
    connectedAt: new Date().toISOString(),
    lastSeenAt: null,
    observedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    agentIds: [],
  };
  // The harness has Cloud disabled. Only this read-only inventory row is simulated; auth and
  // issuance still use the real Server and this test's isolated Account.
  await page.route("**/api/v1/computers", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { computers: AccountComputerSummary[] };
    await route.fulfill({ response, json: { ...body, computers: [cloud, ...body.computers] } });
  });
  await page.goto("/agents/computers");
  await expect(page.getByRole("heading", { name: "Cloud", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect another computer", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Connect computer", exact: true }).click();
  await expect(page.getByText("Copy the task to your AI assistant on this computer.", { exact: true })).toBeVisible();
  expect(await copyTask(page)).toContain("Preserve a working connection");
  await expectNoPageOverflow(page);
  await expectAccessible(page);
});
