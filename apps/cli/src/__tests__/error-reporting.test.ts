import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCOUNT_IDENTITY_FILE_NAME,
  credentialsFingerprint,
  removeAccountIdentity,
  resolveOpenTagHomeLayout,
  writeAccountIdentityAtomically,
  writeComputerIdentityAtomically,
  writeCredentialsAtomically,
  writeMachineCredentialsAtomically,
} from "@opentag/client";
import { ErrorReportRequestSchema } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNEL, CLI_VERSION } from "../build-info.js";
import { createProgram } from "../cli/program.js";
import { runLogin } from "../core/auth/login.js";
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

async function connectHome(
  home: string,
  computerId = COMPUTER_ID,
  installationId = MACHINE_INSTALLATION_ID,
  serverUrl = "https://opentag.example",
) {
  await writeMachineCredentialsAtomically(
    { version: 3, computer: { computerId, installationId, machineToken: "otmc_test", serverUrl } },
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
    },
    home,
  );
  // The Account lives in its own file, beside the credentials rather than inside them, bound to
  // them by a fingerprint of the refresh token just written.
  if (userId) await writeAccountIdentityAtomically(accountIdentity(userId, serverUrl), home);
  return home;
}

/** An identity bound to the credentials `loggedInHome` writes; another server or token unbinds it. */
function accountIdentity(userId: string, serverUrl: string, refreshToken = "refresh-token") {
  return { userId, serverUrl, credentialsFingerprint: credentialsFingerprint({ refreshToken }) };
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

  it("names the Account only from an identity file that matches the credentials' server", async () => {
    // No identity file: signed in, but before the file existed or after it was removed.
    const anonymous = await loggedInHome("https://opentag.example");
    expect((await resolveErrorReportTarget(anonymous)).userId).toBeUndefined();

    // Malformed identity file: costs the report its Account and nothing else.
    const malformed = await loggedInHome("https://opentag.example");
    await writeConfigFile(malformed, ACCOUNT_IDENTITY_FILE_NAME, '{"userId":"account-1"}');
    expect(await resolveErrorReportTarget(malformed)).toMatchObject({
      serverUrl: "https://opentag.example",
      userId: undefined,
    });

    // An identity a sign-in to another server left behind is not this sign-in's Account.
    const elsewhere = await loggedInHome("https://opentag.example");
    await writeAccountIdentityAtomically(accountIdentity("account-1", "https://other.example"), elsewhere);
    expect((await resolveErrorReportTarget(elsewhere)).userId).toBeUndefined();

    // Without credentials there is nothing the identity can be proved against, so it is not attached
    // even though the Computer's server is the destination it names.
    const orphaned = await temporaryHome();
    await writeAccountIdentityAtomically(accountIdentity("account-1", "https://opentag.example"), orphaned);
    await connectHome(orphaned);
    expect(await resolveErrorReportTarget(orphaned)).toMatchObject({
      serverUrl: "https://opentag.example",
      userId: undefined,
      computerId: COMPUTER_ID,
    });

    // An identity written beside other credentials — a different refresh token — is not attached.
    const rebound = await loggedInHome("https://opentag.example");
    await writeAccountIdentityAtomically(accountIdentity("account-1", "https://opentag.example", "b-token"), rebound);
    expect((await resolveErrorReportTarget(rebound)).userId).toBeUndefined();

    // Signing out is forgetting the Account: once removed, the next report names none.
    const signedOut = await loggedInHome("https://opentag.example", ACCOUNT_ID);
    expect((await resolveErrorReportTarget(signedOut)).userId).toBe(ACCOUNT_ID);
    await removeAccountIdentity(signedOut);
    expect((await resolveErrorReportTarget(signedOut)).userId).toBeUndefined();
  });

  it("drops the Account once an older CLI has signed in as someone else beside it", async () => {
    // The supported rollback sequence: sign in as A with this CLI, roll back, sign in as B with the
    // older CLI (which rewrites only credentials.json, in main's strict shape), upgrade, report.
    const home = await temporaryHome();
    const exchangeConnectCode = vi.fn().mockResolvedValue({
      accessToken: "a-access",
      refreshToken: "a-refresh",
      tokenType: "Bearer",
      expiresIn: 900,
    });
    await runLogin({
      api: { exchangeConnectCode, me: async () => ({ user: { id: "account-a" } }) } as unknown as Parameters<
        typeof runLogin
      >[0]["api"],
      code: "one-time-secret",
      home,
      serverUrl: "https://opentag.example",
    });
    expect((await resolveErrorReportTarget(home)).userId).toBe("account-a");

    await writeConfigFile(
      home,
      "credentials.json",
      JSON.stringify({
        accessToken: "b-access",
        accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
        refreshToken: "b-refresh",
        serverUrl: "https://opentag.example",
      }),
    );

    // The refresh token belongs to B; the identity file still names A and must not be believed.
    expect(await resolveErrorReportTarget(home)).toMatchObject({
      serverUrl: "https://opentag.example",
      userId: undefined,
    });

    // A fresh sign-in as A with this CLI binds the identity to the new credentials again.
    await runLogin({
      api: { exchangeConnectCode, me: async () => ({ user: { id: "account-a" } }) } as unknown as Parameters<
        typeof runLogin
      >[0]["api"],
      code: "one-time-secret",
      home,
      serverUrl: "https://opentag.example",
    });
    expect((await resolveErrorReportTarget(home)).userId).toBe("account-a");
  });

  it("attaches machine identifiers only from records naming the server the report goes to", async () => {
    const identity = (serverUrl: string) => ({ version: 2 as const, computerId: INSTALLATION_ID, serverUrl });

    // Signed in to one server, Computer connected to another: the report goes to the Account's
    // server and must not carry the other deployment's identifiers.
    const split = await loggedInHome("https://account.example", ACCOUNT_ID);
    await writeComputerIdentityAtomically(split, identity("https://computer.example"));
    await connectHome(split, COMPUTER_ID, MACHINE_INSTALLATION_ID, "https://computer.example");
    expect(await resolveErrorReportTarget(split)).toEqual({
      serverUrl: "https://account.example",
      userId: ACCOUNT_ID,
      computerId: undefined,
      installationId: undefined,
    });

    // No Account at all: the Computer's server is the destination and both identifiers belong to it.
    const computerOnly = await temporaryHome();
    await writeComputerIdentityAtomically(computerOnly, identity("https://computer.example"));
    await connectHome(computerOnly, COMPUTER_ID, MACHINE_INSTALLATION_ID, "https://computer.example");
    expect(await resolveErrorReportTarget(computerOnly)).toEqual({
      serverUrl: "https://computer.example",
      userId: undefined,
      computerId: COMPUTER_ID,
      installationId: INSTALLATION_ID,
    });

    // Machine credential on the destination, local identity on another server: the pair comes
    // from the machine credential alone.
    const machineMatches = await loggedInHome("https://opentag.example", ACCOUNT_ID);
    await writeComputerIdentityAtomically(machineMatches, identity("https://elsewhere.example"));
    await connectHome(machineMatches);
    expect(await resolveErrorReportTarget(machineMatches)).toEqual({
      serverUrl: "https://opentag.example",
      userId: ACCOUNT_ID,
      computerId: COMPUTER_ID,
      installationId: MACHINE_INSTALLATION_ID,
    });

    // Local identity on the destination, machine credential on another server: the installation is
    // known, the Computer is not, and the other server's Computer uuid never fills the gap.
    const identityMatches = await loggedInHome("https://opentag.example", ACCOUNT_ID);
    await writeComputerIdentityAtomically(identityMatches, identity("https://opentag.example"));
    await connectHome(identityMatches, COMPUTER_ID, MACHINE_INSTALLATION_ID, "https://elsewhere.example");
    expect(await resolveErrorReportTarget(identityMatches)).toEqual({
      serverUrl: "https://opentag.example",
      userId: ACCOUNT_ID,
      computerId: undefined,
      installationId: INSTALLATION_ID,
    });
  });

  it("compares servers by normalized origin, so a trailing slash or letter case is the same server", async () => {
    const home = await loggedInHome("https://opentag.example", ACCOUNT_ID);
    await writeComputerIdentityAtomically(home, {
      version: 2,
      computerId: INSTALLATION_ID,
      serverUrl: "https://OpenTag.example/",
    });
    await connectHome(home, COMPUTER_ID, MACHINE_INSTALLATION_ID, "HTTPS://opentag.example");

    expect(await resolveErrorReportTarget(home)).toEqual({
      serverUrl: "https://opentag.example",
      userId: ACCOUNT_ID,
      computerId: COMPUTER_ID,
      installationId: INSTALLATION_ID,
    });

    // A Computer record whose server is not an OpenTag server URL at all counts as another server,
    // and a destination taken from such a record is no destination.
    const unparseable = await loggedInHome("https://opentag.example", ACCOUNT_ID);
    await writeComputerIdentityAtomically(unparseable, { version: 2, computerId: INSTALLATION_ID, serverUrl: "nope" });
    expect(await resolveErrorReportTarget(unparseable)).toMatchObject({
      userId: ACCOUNT_ID,
      installationId: undefined,
    });
    const nowhere = await temporaryHome();
    await writeComputerIdentityAtomically(nowhere, { version: 2, computerId: INSTALLATION_ID, serverUrl: "nope" });
    expect(await resolveErrorReportTarget(nowhere)).toEqual({
      serverUrl: undefined,
      userId: undefined,
      computerId: undefined,
      installationId: undefined,
    });

    // Candidates are normalized one by one: an unusable computer.json yields the destination to a
    // valid machine credential instead of silencing the report, and costs only the local identity.
    const yielded = await temporaryHome();
    await writeComputerIdentityAtomically(yielded, { version: 2, computerId: INSTALLATION_ID, serverUrl: "nope" });
    await connectHome(yielded, COMPUTER_ID, MACHINE_INSTALLATION_ID, "https://computer.example");
    expect(await resolveErrorReportTarget(yielded)).toEqual({
      serverUrl: "https://computer.example",
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
