import { rm } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import {
  buildServicePath,
  deriveServiceIdentity,
  invocationArguments,
  quoteSystemdEnvironment,
  quoteSystemdToken,
  readRegularFile,
  runRequired,
  writeFileAtomically,
} from "./shared.js";
import type { ResolvedCliInvocation, ServiceRunner } from "./types.js";
import { type DaemonServiceBackend, DaemonServiceError, type DaemonServiceInfo } from "./types.js";

const SYSTEMD_TIMEOUT_MS = 15_000;

export interface SystemdBackendOptions {
  home: string;
  invocation: ResolvedCliInvocation;
  runner: ServiceRunner;
  serviceId: string;
  systemctl?: string;
  uid?: number;
  userHome?: string;
  username?: string;
  xdgConfigHome?: string;
}

export function renderSystemdUnit(options: {
  home: string;
  invocation: ResolvedCliInvocation;
  path: string;
  serviceId: string;
}): string {
  const command = invocationArguments(options.invocation).map(quoteSystemdToken).join(" ");
  return `[Unit]
Description=OpenTag daemon (${options.serviceId})
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
ExecStart=${command}
Restart=on-failure
RestartSec=10
SuccessExitStatus=0
KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${options.serviceId}
${quoteSystemdEnvironment("PATH", options.path)}
${quoteSystemdEnvironment("OPENTAG_SERVICE_MODE", "1")}
${quoteSystemdEnvironment("OPENTAG_HOME", options.home)}

[Install]
WantedBy=default.target
`;
}

export function createSystemdBackend(options: SystemdBackendOptions): DaemonServiceBackend {
  const identity = deriveServiceIdentity(options.serviceId);
  const userHome = options.userHome ?? homedir();
  const uid = options.uid ?? userInfo().uid;
  const username = options.username ?? userInfo().username;
  const unitPath = join(
    options.xdgConfigHome ?? join(userHome, ".config"),
    "systemd",
    "user",
    identity.systemdUnitName,
  );
  const systemctl = options.systemctl ?? "systemctl";
  const servicePath = buildServicePath(options.invocation, "linux");
  const expected = renderSystemdUnit({
    home: options.home,
    invocation: options.invocation,
    path: servicePath,
    serviceId: options.serviceId,
  });

  const status = async (): Promise<DaemonServiceInfo> => {
    const definition = await readRegularFile(unitPath);
    if (definition === undefined) return info("not-installed", { drifted: true });
    const configuredHome = extractSystemdHome(definition);
    if (!configuredHome) {
      return info("unknown", {
        detail: "The installed systemd unit does not contain a valid OPENTAG_HOME",
        drifted: true,
      });
    }
    const active = await options.runner.run(systemctl, ["--user", "is-active", identity.systemdUnitName], {
      timeoutMs: SYSTEMD_TIMEOUT_MS,
    });
    if (active.timedOut) {
      return info("unknown", {
        configuredHome,
        detail: "systemctl is-active timed out",
        drifted: definition !== expected,
      });
    }
    if (active.code !== 0 && !["inactive", "failed", "deactivating"].includes(active.stdout.trim())) {
      return info("unknown", {
        configuredHome,
        detail: active.stderr || active.stdout || `systemctl exited with code ${active.code}`,
        drifted: definition !== expected,
      });
    }
    if (active.code !== 0) return info("inactive", { configuredHome, drifted: definition !== expected });

    const pidResult = await options.runner.run(
      systemctl,
      ["--user", "show", identity.systemdUnitName, "--property", "MainPID", "--value"],
      { timeoutMs: SYSTEMD_TIMEOUT_MS },
    );
    if (pidResult.timedOut) {
      return info("unknown", {
        configuredHome,
        detail: "systemctl MainPID query timed out",
        drifted: definition !== expected,
      });
    }
    if (pidResult.code !== 0) {
      return info("unknown", {
        configuredHome,
        detail: pidResult.stderr || pidResult.stdout || `systemctl MainPID query exited with code ${pidResult.code}`,
        drifted: definition !== expected,
      });
    }
    const parsedPid = Number.parseInt(pidResult.stdout, 10);
    if (!Number.isInteger(parsedPid) || parsedPid <= 0) {
      return info("unknown", {
        configuredHome,
        detail: "systemctl reported an invalid MainPID",
        drifted: definition !== expected,
      });
    }
    return info("active", {
      configuredHome,
      drifted: definition !== expected,
      pid: parsedPid,
    });
  };

  const preflight = async (): Promise<void> => {
    if (uid === 0) {
      throw new DaemonServiceError("UNSUPPORTED_PLATFORM", "OpenTag supports only non-root user systemd services");
    }
    const result = await options.runner.run(systemctl, ["--user", "show-environment"], {
      timeoutMs: SYSTEMD_TIMEOUT_MS,
    });
    if (result.code !== 0 || result.timedOut) {
      throw new DaemonServiceError(
        "MANAGER_UNAVAILABLE",
        `The user systemd manager is unavailable: ${result.timedOut ? "command timed out" : result.stderr || "unknown error"}`,
      );
    }
  };

  return {
    platform: "systemd",
    preflight,
    async installAndStart() {
      await preflight();
      const previous = await status();
      const drifted = previous.drifted ?? true;
      await writeFileAtomically(unitPath, expected, 0o644, 0o700);
      await runRequired(options.runner, systemctl, ["--user", "daemon-reload"], "systemd daemon-reload");
      await runRequired(options.runner, systemctl, ["--user", "enable", identity.systemdUnitName], "systemd enable");
      if ((previous.state === "active" || previous.state === "unknown") && drifted) {
        await runRequired(
          options.runner,
          systemctl,
          ["--user", "restart", identity.systemdUnitName],
          "systemd restart",
        );
      } else if (previous.state !== "active") {
        await runRequired(options.runner, systemctl, ["--user", "start", identity.systemdUnitName], "systemd start");
      }
      const linger = await options.runner.run("loginctl", ["enable-linger", username], {
        timeoutMs: SYSTEMD_TIMEOUT_MS,
      });
      const current = await status();
      if (current.state !== "active") {
        throw new DaemonServiceError(
          "OPERATION_FAILED",
          "systemd reported that the OpenTag service did not become active",
        );
      }
      return linger.code === 0
        ? current
        : {
            ...current,
            detail: `Service is active; enable lingering manually with: loginctl enable-linger ${username}`,
          };
    },
    async start() {
      await preflight();
      if ((await readRegularFile(unitPath)) === undefined) {
        throw new DaemonServiceError("NOT_INSTALLED", "The daemon service is not installed; run daemon install");
      }
      const current = await status();
      if (current.state !== "active") {
        await runRequired(options.runner, systemctl, ["--user", "start", identity.systemdUnitName], "systemd start");
      }
      return status();
    },
    async stop() {
      if ((await readRegularFile(unitPath)) === undefined) return info("not-installed", { drifted: true });
      const current = await status();
      if (current.state === "active" || current.state === "unknown") {
        await runRequired(options.runner, systemctl, ["--user", "stop", identity.systemdUnitName], "systemd stop");
      }
      return status();
    },
    async restart() {
      await preflight();
      if ((await readRegularFile(unitPath)) === undefined) {
        throw new DaemonServiceError("NOT_INSTALLED", "The daemon service is not installed; run daemon install");
      }
      await runRequired(options.runner, systemctl, ["--user", "restart", identity.systemdUnitName], "systemd restart");
      return status();
    },
    status,
    async uninstall() {
      const definition = await readRegularFile(unitPath);
      if (definition === undefined) return info("not-installed", { drifted: true });
      await runRequired(
        options.runner,
        systemctl,
        ["--user", "disable", "--now", identity.systemdUnitName],
        "systemd disable",
      );
      const afterStop = await options.runner.run(systemctl, ["--user", "is-active", identity.systemdUnitName], {
        timeoutMs: SYSTEMD_TIMEOUT_MS,
      });
      if (afterStop.timedOut || afterStop.code === 0 || !["inactive", "failed"].includes(afterStop.stdout.trim())) {
        throw new DaemonServiceError("OPERATION_FAILED", "systemd did not confirm that the service stopped");
      }
      await rm(unitPath);
      await runRequired(options.runner, systemctl, ["--user", "daemon-reload"], "systemd daemon-reload");
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
      definitionPath: unitPath,
      logHint: `journalctl --user -u ${identity.systemdUnitName} -f`,
      platform: "systemd",
      serviceId: options.serviceId,
      state,
      ...extra,
    };
  }
}

export function extractSystemdHome(definition: string): string | undefined {
  const match = definition.match(/^Environment="OPENTAG_HOME=(.*)"$/mu);
  if (!match?.[1]) return undefined;
  return match[1].replace(/%%/g, "%").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
