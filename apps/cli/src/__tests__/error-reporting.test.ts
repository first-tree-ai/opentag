import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveOpenTagHomeLayout,
  writeComputerIdentityAtomically,
  writeCredentialsAtomically,
  writeMachineCredentialsAtomically,
} from "@opentag/client";
import { ErrorReportRequestSchema } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNEL, CLI_VERSION } from "../build-info.js";
import { createProgram } from "../cli/program.js";
import { CommandError } from "../core/command/policy.js";
import {
  installCliProcessErrorReporting,
  reportCliError,
  reportCommandFailure,
  resolveCommandPath,
  resolveErrorReportTarget,
  shouldReportCommandError,
} from "../core/diagnostics/error-reporting.js";

const COMPUTER_ID = "c0000000-0000-4000-8000-000000000000";
const INSTALLATION_ID = "10000000-0000-4000-8000-000000000000";
const MACHINE_INSTALLATION_ID = "20000000-0000-4000-8000-000000000000";
const ACCOUNT_ID = "a0000000-0000-4000-8000-000000000000";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "opentag-error-reporting-"));
  homes.push(home);
  return home;
}

async function writeConfigFile(home: string, name: string, content: string): Promise<void> {
  const layout = resolveOpenTagHomeLayout(home);
  await mkdir(layout.config, { recursive: true, mode: 0o700 });
  await writeFile(join(layout.config, name), content, { mode: 0o600 });
}

async function connectHome(home: string, computerId = COMPUTER_ID, installationId = MACHINE_INSTALLATION_ID) {
  await writeMachineCredentialsAtomically(
    {
      version: 3,
      computer: { computerId, installationId, machineToken: "otmc_test", serverUrl: "https://opentag.example" },
    },
    home,
  );
}

async function loggedInHome(serverUrl: string, userId?: string): Promise<string> {
  const home = await temporaryHome();
  await writeCredentialsAtomically(
    {
      accessToken: "access-token",
      accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
      refreshToken: "refresh-token",
      serverUrl,
      ...(userId ? { userId } : {}),
    },
    home,
  );
  return home;
}

describe("resolveCommandPath", () => {
  const program = createProgram();

  it("keeps the subcommand path and drops options and user arguments", () => {
    expect(resolveCommandPath(program, ["agent", "list", "--json"])).toBe("agent list");
    expect(resolveCommandPath(program, ["--json", "doctor"])).toBe("doctor");
    expect(resolveCommandPath(program, ["daemon", "service-run"])).toBe("daemon service-run");
    expect(resolveCommandPath(program, ["login", "--server", "https://opentag.example", "--", "CODE"])).toBe("login");
  });

  it("stops at the first token that is not a registered subcommand", () => {
    expect(resolveCommandPath(program, ["agent", "create", "my-agent-name"])).toBe("agent create");
    expect(resolveCommandPath(program, ["unknown", "agent"])).toBeUndefined();
    expect(resolveCommandPath(program, [])).toBeUndefined();
  });
});

describe("shouldReportCommandError", () => {
  it("reports program defects and leaves caller-facing answers alone", () => {
    const of = (category: CommandError["category"]) =>
      new CommandError({ code: "X", category, retryability: "never", phase: "unknown" }, "message");
    expect(shouldReportCommandError(of("internal"))).toBe(true);
    expect(shouldReportCommandError(of("dependency"))).toBe(true);
    expect(shouldReportCommandError(of("protocol"))).toBe(true);
    for (const category of [
      "validation",
      "auth",
      "authorization",
      "not_found",
      "configuration",
      "cancelled",
    ] as const) {
      expect(shouldReportCommandError(of(category))).toBe(false);
    }
  });
});

describe("resolveErrorReportTarget", () => {
  it("prefers Account credentials and tolerates an empty or corrupt home", async () => {
    expect(await resolveErrorReportTarget(await temporaryHome())).toEqual({
      serverUrl: undefined,
      userId: undefined,
      computerId: undefined,
      installationId: undefined,
    });
    expect((await resolveErrorReportTarget(await loggedInHome("https://opentag.example"))).serverUrl).toBe(
      "https://opentag.example",
    );

    const corrupt = await temporaryHome();
    await writeConfigFile(corrupt, "credentials.json", "{not json");
    await writeConfigFile(corrupt, "computer.json", '{"version":2}');
    await writeConfigFile(corrupt, "computer-credentials.json", '{"version":3,"computer":"nope"}');
    expect(await resolveErrorReportTarget(corrupt)).toEqual({
      serverUrl: undefined,
      userId: undefined,
      computerId: undefined,
      installationId: undefined,
    });
  });

  it("reads each identity file on its own, so one malformed file silences nothing else", async () => {
    // Valid credentials beside a malformed local identity: the Account still addresses the report.
    const brokenIdentity = await loggedInHome("https://opentag.example", ACCOUNT_ID);
    await writeConfigFile(brokenIdentity, "computer.json", '{"version":2,"computerId":"not-a-uuid"}');
    await connectHome(brokenIdentity);
    expect(await resolveErrorReportTarget(brokenIdentity)).toEqual({
      serverUrl: "https://opentag.example",
      userId: ACCOUNT_ID,
      computerId: COMPUTER_ID,
      installationId: MACHINE_INSTALLATION_ID,
    });

    // Valid credentials beside a malformed machine credential.
    const brokenMachine = await loggedInHome("https://opentag.example", ACCOUNT_ID);
    await writeComputerIdentityAtomically(brokenMachine, {
      version: 2,
      computerId: INSTALLATION_ID,
      serverUrl: "https://opentag.example",
    });
    await writeConfigFile(brokenMachine, "computer-credentials.json", "{not json");
    expect(await resolveErrorReportTarget(brokenMachine)).toEqual({
      serverUrl: "https://opentag.example",
      userId: ACCOUNT_ID,
      computerId: undefined,
      installationId: INSTALLATION_ID,
    });

    // Malformed credentials beside a valid machine credential: the Computer still addresses it.
    const brokenCredentials = await temporaryHome();
    await writeConfigFile(brokenCredentials, "credentials.json", "{not json");
    await connectHome(brokenCredentials);
    expect(await resolveErrorReportTarget(brokenCredentials)).toEqual({
      serverUrl: "https://opentag.example",
      userId: undefined,
      computerId: COMPUTER_ID,
      installationId: MACHINE_INSTALLATION_ID,
    });
  });

  it("names the Account Computer from the machine credential and the installation from its own identity", async () => {
    const home = await loggedInHome("https://opentag.example", ACCOUNT_ID);
    await writeComputerIdentityAtomically(home, {
      version: 2,
      computerId: INSTALLATION_ID,
      serverUrl: "https://opentag.example",
    });
    await connectHome(home, COMPUTER_ID, MACHINE_INSTALLATION_ID);

    // Four distinct values, so a swap between the two records cannot pass.
    expect(await resolveErrorReportTarget(home)).toEqual({
      serverUrl: "https://opentag.example",
      userId: ACCOUNT_ID,
      computerId: COMPUTER_ID,
      installationId: INSTALLATION_ID,
    });

    // A home whose local identity is missing still reports the installation the credential names.
    const identityless = await temporaryHome();
    await connectHome(identityless, COMPUTER_ID, MACHINE_INSTALLATION_ID);
    expect(await resolveErrorReportTarget(identityless)).toMatchObject({
      computerId: COMPUTER_ID,
      installationId: MACHINE_INSTALLATION_ID,
    });
  });
});

describe("reportCliError", () => {
  it("posts to the connected server with the build identity and the command path", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const home = await loggedInHome("https://opentag.example");

    const result = await reportCliError(new Error("boom"), { command: "agent create", home, fetchImpl });

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://opentag.example/api/v1/error-reports");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      source: "cli",
      message: "boom",
      version: CLI_VERSION,
      channel: CHANNEL,
      command: "agent create",
    });
  });

  it("names the Account, the machine, and the Agent a turn failure belongs to", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const home = await loggedInHome("https://opentag.example", "account-1");
    await writeComputerIdentityAtomically(home, {
      version: 2,
      computerId: INSTALLATION_ID,
      serverUrl: "https://opentag.example",
    });
    await connectHome(home);

    await reportCliError(new Error("boom"), {
      home,
      fetchImpl,
      agent: { agentId: "agent-1", sessionId: "session-1", turnId: "turn-1", provider: "claude-code" },
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(ErrorReportRequestSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      userId: "account-1",
      computerId: COMPUTER_ID,
      installationId: INSTALLATION_ID,
      agentId: "agent-1",
      sessionId: "session-1",
      turnId: "turn-1",
      provider: "claude-code",
      platform: `${process.platform} ${process.arch} node-${process.version}`,
    });
    expect(body.reportId).toEqual(expect.any(String));
  });

  it("stays silent when no server is known and never throws", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const home = await temporaryHome();

    await expect(reportCliError(new Error("boom"), { home, fetchImpl })).resolves.toEqual({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      reportCliError(new Error("boom"), {
        home,
        environment: { OPENTAG_HOME: "\u0000" },
        fetchImpl: () => {
          throw new Error("unreachable");
        },
      }),
    ).resolves.toEqual({ ok: false });
  });
});

describe("reportCommandFailure", () => {
  it("relays a defect once per thrown value and skips caller-facing categories", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const home = await loggedInHome("https://opentag.example");
    const failure = new Error("boom");
    const internal = new CommandError(
      { code: "INTERNAL_ERROR", category: "internal", retryability: "never", phase: "unknown" },
      "boom",
    );
    const validation = new CommandError(
      { code: "VALIDATION_ERROR", category: "validation", retryability: "never", phase: "validation" },
      "bad input",
    );

    await expect(reportCommandFailure(failure, internal, { home, fetchImpl })).resolves.toEqual({ ok: true });
    await expect(reportCommandFailure(failure, internal, { home, fetchImpl })).resolves.toEqual({ ok: false });
    await expect(reportCommandFailure(new Error("x"), validation, { home, fetchImpl })).resolves.toEqual({ ok: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("installCliProcessErrorReporting", () => {
  it("registers both process handlers and removes them again", () => {
    const exceptions = process.listenerCount("uncaughtException");
    const rejections = process.listenerCount("unhandledRejection");

    const uninstall = installCliProcessErrorReporting({ command: "doctor" });
    expect(process.listenerCount("uncaughtException")).toBe(exceptions + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(rejections + 1);

    uninstall();
    expect(process.listenerCount("uncaughtException")).toBe(exceptions);
    expect(process.listenerCount("unhandledRejection")).toBe(rejections);
  });
});
