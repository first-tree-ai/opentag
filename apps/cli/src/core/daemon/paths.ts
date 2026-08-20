import { join } from "node:path";
import { resolveOpenTagHomeLayout } from "@opentag/client";

export interface DaemonPaths {
  clientLog: string;
  config: string;
  daemonEnvironment: string;
  daemonOwner: string;
  daemonState: string;
  daemonStderrLog: string;
  daemonStdoutLog: string;
  home: string;
  logs: string;
  serviceOperation: string;
  serviceState: string;
  serviceTargetOperation: string;
  serviceWrapper(serviceId: string): string;
}

export function resolveDaemonPaths(home: string): DaemonPaths {
  const layout = resolveOpenTagHomeLayout(home);
  return {
    clientLog: join(layout.logs, "client.log"),
    config: layout.config,
    daemonEnvironment: join(layout.config, "daemon.env"),
    daemonOwner: join(layout.daemonState, "owner.json"),
    daemonState: layout.daemonState,
    daemonStderrLog: join(layout.logs, "daemon.stderr.log"),
    daemonStdoutLog: join(layout.logs, "daemon.stdout.log"),
    home: layout.home,
    logs: layout.logs,
    serviceOperation: join(layout.serviceState, "operation.json"),
    serviceState: layout.serviceState,
    serviceTargetOperation: join(layout.serviceState, "target-operation.json"),
    serviceWrapper: (serviceId) => join(layout.serviceState, serviceId),
  };
}
