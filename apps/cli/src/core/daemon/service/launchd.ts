import { rm } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { ensurePrivateDirectory } from "@opentag/client";
import { resolveDaemonPaths } from "../paths.js";
import {
  buildServicePath,
  deriveServiceIdentity,
  escapeXml,
  invocationArguments,
  isManagerNotLoaded,
  quotePosix,
  readRegularFile,
  runRequired,
  sleep,
  writeFileAtomically,
} from "./shared.js";
import type { DaemonServiceBackend, DaemonServiceInfo, ResolvedCliInvocation, ServiceRunner } from "./types.js";
import { DaemonServiceError } from "./types.js";

const LAUNCHD_TIMEOUT_MS = 15_000;

export interface LaunchdBackendOptions {
  activationAttempts?: number;
  activationDelayMs?: number;
  evictionAttempts?: number;
  evictionDelayMs?: number;
  home: string;
  invocation: ResolvedCliInvocation;
  launchctl?: string;
  runner: ServiceRunner;
  serviceId: string;
  sourcePath?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  uid?: number;
  userHome?: string;
}

export function renderLaunchdWrapper(invocation: ResolvedCliInvocation): string {
  return `#!/bin/sh\nexec ${invocationArguments(invocation).map(quotePosix).join(" ")}\n`;
}

export function renderLaunchdPlist(options: {
  home: string;
  label: string;
  path: string;
  stderrPath: string;
  stdoutPath: string;
  wrapperPath: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(options.wrapperPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(options.path)}</string>
    <key>OPENTAG_SERVICE_MODE</key>
    <string>1</string>
    <key>OPENTAG_HOME</key>
    <string>${escapeXml(options.home)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(options.stderrPath)}</string>
</dict>
</plist>
`;
}

export function createLaunchdBackend(options: LaunchdBackendOptions): DaemonServiceBackend {
  const identity = deriveServiceIdentity(options.serviceId);
  const uid = options.uid ?? userInfo().uid;
  const userHome = options.userHome ?? homedir();
  const domain = `gui/${uid}`;
  const target = `${domain}/${identity.launchdLabel}`;
  const launchctl = options.launchctl ?? "launchctl";
  const plistPath = join(userHome, "Library", "LaunchAgents", identity.launchdPlistName);
  const paths = resolveDaemonPaths(options.home);
  const wrapperPath = paths.serviceWrapper(identity.launchdWrapperName);
  const logDirectory = paths.logs;
  const stdoutPath = paths.daemonStdoutLog;
  const stderrPath = paths.daemonStderrLog;
  const servicePath = buildServicePath(options.invocation, "darwin", options.sourcePath);
  const expectedWrapper = renderLaunchdWrapper(options.invocation);
  const expectedPlist = renderLaunchdPlist({
    home: options.home,
    label: identity.launchdLabel,
    path: servicePath,
    stderrPath,
    stdoutPath,
    wrapperPath,
  });
  const wait = options.sleep ?? sleep;
  const activationAttempts = options.activationAttempts ?? 50;
  const activationDelayMs = options.activationDelayMs ?? 100;
  const evictionAttempts = options.evictionAttempts ?? 20;
  const evictionDelayMs = options.evictionDelayMs ?? 100;

  const status = async (): Promise<DaemonServiceInfo> => {
    const plist = await readRegularFile(plistPath);
    if (plist === undefined) {
      const orphaned = await options.runner.run(launchctl, ["print", target], { timeoutMs: LAUNCHD_TIMEOUT_MS });
      if (orphaned.timedOut) {
        return info("unknown", {
          detail: "launchctl could not verify whether a definition-less service target is loaded",
          drifted: true,
        });
      }
      if (orphaned.code === 0) {
        return info("unknown", {
          detail: "launchd still has the service target loaded even though its plist definition is missing",
          drifted: true,
        });
      }
      return isManagerNotLoaded(orphaned)
        ? info("not-installed", { drifted: true })
        : info("unknown", {
            detail: orphaned.stderr || orphaned.stdout || `launchctl exited with code ${orphaned.code}`,
            drifted: true,
          });
    }
    const wrapper = await readRegularFile(wrapperPath);
    const configuredHome = extractLaunchdHome(plist);
    if (!configuredHome) {
      return info("unknown", {
        detail: "The installed LaunchAgent does not contain a valid OPENTAG_HOME",
        drifted: true,
      });
    }
    const result = await options.runner.run(launchctl, ["print", target], { timeoutMs: LAUNCHD_TIMEOUT_MS });
    const drifted = plist !== expectedPlist || wrapper !== expectedWrapper;
    if (result.timedOut) return info("unknown", { configuredHome, detail: "launchctl print timed out", drifted });
    if (result.code !== 0) {
      return isManagerNotLoaded(result)
        ? info("inactive", { configuredHome, drifted })
        : info("unknown", { configuredHome, detail: result.stderr || "launchctl print failed", drifted });
    }
    const pid = parseLaunchdPid(result.stdout);
    const processState = parseLaunchdState(result.stdout);
    if (processState === "running" && pid) return info("active", { configuredHome, drifted, pid });
    if (processState && processState !== "running") {
      return info("inactive", {
        configuredHome,
        detail: `LaunchAgent is loaded but process state is ${processState}`,
        drifted,
      });
    }
    return info("unknown", {
      configuredHome,
      detail:
        processState === "running"
          ? "LaunchAgent is running without a valid PID"
          : "LaunchAgent process state is unavailable",
      drifted,
    });
  };

  const preflight = async (): Promise<void> => {
    const result = await options.runner.run(launchctl, ["print", domain], { timeoutMs: LAUNCHD_TIMEOUT_MS });
    if (result.code !== 0 || result.timedOut) {
      throw new DaemonServiceError(
        "MANAGER_UNAVAILABLE",
        `The launchd user domain is unavailable: ${result.timedOut ? "command timed out" : result.stderr || "unknown error"}`,
      );
    }
  };

  const bootout = async (): Promise<void> => {
    const result = await options.runner.run(launchctl, ["bootout", target], { timeoutMs: LAUNCHD_TIMEOUT_MS });
    if (result.code !== 0 && !isManagerNotLoaded(result)) {
      throw new DaemonServiceError("OPERATION_FAILED", `launchd bootout failed: ${result.stderr || "unknown error"}`);
    }
  };

  const waitForEviction = async (): Promise<void> => {
    for (let attempt = 0; attempt < evictionAttempts; attempt += 1) {
      const result = await options.runner.run(launchctl, ["print", target], { timeoutMs: LAUNCHD_TIMEOUT_MS });
      if (isManagerNotLoaded(result)) return;
      if (result.timedOut) throw new DaemonServiceError("OPERATION_FAILED", "launchd eviction check timed out");
      await wait(evictionDelayMs);
    }
    throw new DaemonServiceError("OPERATION_FAILED", `launchd did not evict ${identity.launchdLabel}`);
  };

  const bootstrap = async (): Promise<void> => {
    let result = await options.runner.run(launchctl, ["bootstrap", domain, plistPath], {
      timeoutMs: LAUNCHD_TIMEOUT_MS,
    });
    if (result.code !== 0 || result.timedOut) {
      await wait(evictionDelayMs);
      result = await options.runner.run(launchctl, ["bootstrap", domain, plistPath], { timeoutMs: LAUNCHD_TIMEOUT_MS });
    }
    if (result.code !== 0 || result.timedOut) {
      throw new DaemonServiceError(
        "OPERATION_FAILED",
        `launchd bootstrap failed: ${result.timedOut ? "command timed out" : result.stderr || "unknown error"}`,
      );
    }
  };

  const waitForActivation = async (): Promise<DaemonServiceInfo> => {
    let current: DaemonServiceInfo | undefined;
    for (let attempt = 0; attempt < activationAttempts; attempt += 1) {
      current = await status();
      if (current.state === "active") return current;
      if (attempt + 1 < activationAttempts) await wait(activationDelayMs);
    }
    const lastState = current ? `; last state: ${current.state}${current.detail ? ` (${current.detail})` : ""}` : "";
    throw new DaemonServiceError(
      "OPERATION_FAILED",
      `launchd reported that the OpenTag service did not become active${lastState}`,
    );
  };

  return {
    platform: "launchd",
    preflight,
    async installAndStart() {
      await preflight();
      await ensurePrivateDirectory(paths.home, logDirectory);
      await writeFileAtomically(wrapperPath, expectedWrapper, 0o700, 0o700, paths.home);
      await writeFileAtomically(plistPath, expectedPlist, 0o644, 0o700);
      await bootout();
      await waitForEviction();
      await bootstrap();
      await runRequired(options.runner, launchctl, ["enable", target], "launchd enable");
      return waitForActivation();
    },
    async start() {
      await preflight();
      if ((await readRegularFile(plistPath)) === undefined) {
        throw new DaemonServiceError("NOT_INSTALLED", "The daemon service is not installed; run daemon install");
      }
      const current = await status();
      if (current.state === "active") return current;
      const loaded = await options.runner.run(launchctl, ["print", target], { timeoutMs: LAUNCHD_TIMEOUT_MS });
      if (loaded.timedOut) {
        throw new DaemonServiceError("OPERATION_FAILED", "launchd start state check timed out");
      }
      if (loaded.code === 0) {
        await runRequired(options.runner, launchctl, ["kickstart", "-k", target], "launchd kickstart");
      } else if (isManagerNotLoaded(loaded)) {
        await bootstrap();
      } else {
        throw new DaemonServiceError(
          "OPERATION_FAILED",
          `launchd start state check failed: ${loaded.stderr || "unknown error"}`,
        );
      }
      return waitForActivation();
    },
    async stop() {
      if ((await readRegularFile(plistPath)) === undefined) return info("not-installed", { drifted: true });
      await bootout();
      await waitForEviction();
      return status();
    },
    async restart() {
      await preflight();
      if ((await readRegularFile(plistPath)) === undefined) {
        throw new DaemonServiceError("NOT_INSTALLED", "The daemon service is not installed; run daemon install");
      }
      await bootout();
      await waitForEviction();
      await bootstrap();
      return waitForActivation();
    },
    status,
    async uninstall() {
      if ((await readRegularFile(plistPath)) === undefined) return info("not-installed", { drifted: true });
      await bootout();
      await waitForEviction();
      await rm(plistPath);
      await rm(wrapperPath, { force: true });
      return info("not-installed", { drifted: true });
    },
  };

  function info(
    state: DaemonServiceInfo["state"],
    extra: Partial<
      Omit<DaemonServiceInfo, "currentHome" | "definitionPath" | "logHint" | "platform" | "serviceId" | "state">
    > = {},
  ): DaemonServiceInfo {
    return {
      currentHome: options.home,
      definitionPath: plistPath,
      logHint: `${paths.clientLog} (fallback: ${stdoutPath} / ${stderrPath})`,
      platform: "launchd",
      serviceId: options.serviceId,
      state,
      ...extra,
    };
  }
}

export function extractLaunchdHome(plist: string): string | undefined {
  const match = plist.match(/<key>OPENTAG_HOME<\/key>\s*<string>([^<]*)<\/string>/u);
  return match?.[1]
    ?.replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function parseLaunchdPid(output: string): number | undefined {
  const match = output.match(/\bpid\s*=\s*(\d+)/u);
  if (!match?.[1]) return undefined;
  const pid = Number.parseInt(match[1], 10);
  return pid > 0 ? pid : undefined;
}

function parseLaunchdState(output: string): string | undefined {
  return output.match(/^\s*state\s*=\s*([^\s]+)\s*$/mu)?.[1]?.toLowerCase();
}
