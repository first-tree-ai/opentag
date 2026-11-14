import { describe, expect, it } from "vitest";
import {
  createLaunchdHandoffReadiness,
  lastOnDemandTransition,
  parseLaunchdDomainHandle,
} from "../core/daemon/service/launchd-readiness.js";
import type { CommandResult, ServiceRunner } from "../core/daemon/service/types.js";

const DOMAIN_PRINT = [
  "gui/501 = {",
  "\ttype = login",
  "\thandle = 100014",
  "\tactive count = 459",
  "\tsession = Aqua",
  "\tproperties = gui | gui login",
  "}",
].join("\n");

function event(subsystem: string, eventMessage: string): string {
  return JSON.stringify({ eventMessage, processID: 1, subsystem, timestamp: "2026-11-14 01:05:03.348924+0800" });
}

function ok(stdout: string): CommandResult {
  return { code: 0, stderr: "", stdout, timedOut: false };
}

function fakeRunner(results: { launchctl: CommandResult; log?: CommandResult }) {
  const calls: Array<{ args: readonly string[]; program: string }> = [];
  const runner: ServiceRunner = {
    async run(program, args) {
      calls.push({ args, program });
      if (program === "launchctl") return results.launchctl;
      if (program === "log" && results.log) return results.log;
      throw new Error(`unexpected command ${program}`);
    },
  };
  return { calls, runner };
}

describe("launchd handoff readiness", () => {
  it("parses the domain handle from launchctl print", () => {
    expect(parseLaunchdDomainHandle(DOMAIN_PRINT)).toBe("100014");
    expect(parseLaunchdDomainHandle("gui/501 = {\n\ttype = login\n}")).toBeUndefined();
  });

  it("reads the newest on-demand transition for the current domain instance", () => {
    const subsystem = "gui/501 [100014]";
    const output = [
      event(subsystem, "entering ondemand mode"),
      event(subsystem, "exiting ondemand mode"),
      event("gui/501 [100021]", "entering ondemand mode"),
      "not json",
      '{"count":3,"finished":1}',
    ].join("\n");
    expect(lastOnDemandTransition(output, subsystem)).toBe("exiting");
    expect(lastOnDemandTransition(`${output}\n${event(subsystem, "entering ondemand mode")}`, subsystem)).toBe(
      "entering",
    );
    expect(lastOnDemandTransition('{"count":0,"finished":1}', subsystem)).toBeUndefined();
  });

  it("blocks the handoff while the GUI domain is in on-demand-only mode", async () => {
    const { calls, runner } = fakeRunner({
      launchctl: ok(DOMAIN_PRINT),
      log: ok(
        [event("gui/501 [100014]", "exiting ondemand mode"), event("gui/501 [100014]", "entering ondemand mode")].join(
          "\n",
        ),
      ),
    });
    await expect(createLaunchdHandoffReadiness({ runner, uid: 501 })()).resolves.toEqual({
      ready: false,
      reason: "launchd domain gui/501 [100014] is in on-demand-only mode",
    });
    expect(calls[0]).toEqual({ args: ["print", "gui/501"], program: "launchctl" });
    expect(calls[1]?.program).toBe("log");
    expect(calls[1]?.args).toEqual([
      "show",
      "--style",
      "ndjson",
      "--last",
      "7d",
      "--predicate",
      'processID == 1 AND subsystem == "gui/501 [100014]" AND (eventMessage == "entering ondemand mode" OR eventMessage == "exiting ondemand mode")',
    ]);
  });

  it("allows the handoff after the domain left on-demand-only mode or never entered it", async () => {
    const exited = fakeRunner({
      launchctl: ok(DOMAIN_PRINT),
      log: ok(
        [event("gui/501 [100014]", "entering ondemand mode"), event("gui/501 [100014]", "exiting ondemand mode")].join(
          "\n",
        ),
      ),
    });
    await expect(createLaunchdHandoffReadiness({ runner: exited.runner, uid: 501 })()).resolves.toEqual({
      ready: true,
    });
    const quiet = fakeRunner({ launchctl: ok(DOMAIN_PRINT), log: ok('{"count":0,"finished":1}') });
    await expect(createLaunchdHandoffReadiness({ runner: quiet.runner, uid: 501 })()).resolves.toEqual({
      ready: true,
    });
  });

  it("reports uncertainty instead of blocking when launchd state cannot be read", async () => {
    const printFailed = fakeRunner({
      launchctl: { code: 113, stderr: "Could not find domain for", stdout: "", timedOut: false },
    });
    await expect(createLaunchdHandoffReadiness({ runner: printFailed.runner, uid: 501 })()).resolves.toEqual({
      ready: true,
      uncertain: "launchctl print gui/501 failed: Could not find domain for",
    });

    const noHandle = fakeRunner({ launchctl: ok("gui/501 = {\n}") });
    await expect(createLaunchdHandoffReadiness({ runner: noHandle.runner, uid: 501 })()).resolves.toEqual({
      ready: true,
      uncertain: "launchctl print gui/501 did not report a domain handle",
    });

    const logTimedOut = fakeRunner({
      launchctl: ok(DOMAIN_PRINT),
      log: { code: null, stderr: "", stdout: "", timedOut: true },
    });
    await expect(createLaunchdHandoffReadiness({ runner: logTimedOut.runner, uid: 501 })()).resolves.toEqual({
      ready: true,
      uncertain: "log show for gui/501 [100014] failed: command timed out",
    });
  });
});
