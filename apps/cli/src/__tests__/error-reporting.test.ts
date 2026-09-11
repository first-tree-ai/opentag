import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOpenTagHomeLayout, writeCredentialsAtomically } from "@opentag/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNEL, CLI_VERSION } from "../build-info.js";
import { createProgram } from "../cli/program.js";
import { CommandError } from "../core/command/policy.js";
import {
  installCliProcessErrorReporting,
  reportCliError,
  reportCommandFailure,
  resolveCommandPath,
  resolveErrorReportServerUrl,
  shouldReportCommandError,
} from "../core/diagnostics/error-reporting.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "opentag-error-reporting-"));
  homes.push(home);
  return home;
}

async function loggedInHome(serverUrl: string): Promise<string> {
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

describe("resolveErrorReportServerUrl", () => {
  it("prefers Account credentials and tolerates an empty or corrupt home", async () => {
    expect(await resolveErrorReportServerUrl(await temporaryHome())).toBeUndefined();
    expect(await resolveErrorReportServerUrl(await loggedInHome("https://opentag.example"))).toBe(
      "https://opentag.example",
    );

    const corrupt = await temporaryHome();
    const layout = resolveOpenTagHomeLayout(corrupt);
    await mkdir(layout.config, { recursive: true });
    await writeFile(join(layout.config, "credentials.json"), "{not json", { mode: 0o600 });
    expect(await resolveErrorReportServerUrl(corrupt)).toBeUndefined();
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
