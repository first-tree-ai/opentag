import { readFile } from "node:fs/promises";
import { resolveOpenTagHome } from "@opentag/client";
import {
  createDaemonServiceManager,
  type DaemonServiceInfo,
  type DaemonServiceManager,
} from "../daemon/service/index.js";
import { canonicalizeServiceHome } from "../daemon/service/shared.js";

/**
 * What an installed daemon service actually runs with. A launchd or systemd unit does not inherit
 * the operator's shell, so only the variables its definition declares — plus the account-level ones
 * the service manager itself provides — describe the environment that publishes readiness.
 */
export type DaemonServiceEnvironment =
  | {
      readonly definitionPath: string;
      readonly environment: Readonly<Record<string, string>>;
      readonly kind: "installed";
      readonly path: string;
      readonly platform: "launchd" | "systemd";
      readonly serviceHome: string;
      readonly state: string;
    }
  | {
      readonly definitionPath: string;
      readonly kind: "home-mismatch";
      readonly requestedHome: string;
      readonly serviceHome: string;
    }
  | { readonly kind: "not-installed" }
  | { readonly kind: "unsupported"; readonly platform: string }
  | { readonly definitionPath?: string; readonly kind: "unreadable"; readonly reason: string };

export interface ReadDaemonServiceEnvironmentOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly manager?: DaemonServiceManager;
  readonly platform?: NodeJS.Platform;
  readonly readDefinition?: (path: string) => Promise<string>;
}

export async function readDaemonServiceEnvironment(
  options: ReadDaemonServiceEnvironmentOptions = {},
): Promise<DaemonServiceEnvironment> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return { kind: "unsupported", platform };
  const requestedHome = options.home ?? resolveOpenTagHome(options.env);
  let info: DaemonServiceInfo;
  try {
    const manager =
      options.manager ??
      (await createDaemonServiceManager({ ...(options.env ? { env: options.env } : {}), home: requestedHome }));
    info = await manager.status();
  } catch (error) {
    return { kind: "unreadable", reason: describe(error) };
  }
  if (info.state === "not-installed") return { kind: "not-installed" };
  if (info.platform !== "launchd" && info.platform !== "systemd") {
    return { definitionPath: info.definitionPath, kind: "unreadable", reason: "unsupported service platform" };
  }
  let definition: string;
  try {
    definition = await (options.readDefinition ?? ((path: string) => readFile(path, "utf8")))(info.definitionPath);
  } catch (error) {
    return { definitionPath: info.definitionPath, kind: "unreadable", reason: describe(error) };
  }
  const environment = info.platform === "systemd" ? systemdEnvironment(definition) : launchdEnvironment(definition);
  const path = environment.PATH;
  if (!path) {
    return {
      definitionPath: info.definitionPath,
      kind: "unreadable",
      reason: "the installed service definition declares no PATH",
    };
  }
  // The running service belongs to whichever home its definition names. Probing a different home's
  // provider configuration would answer for a Computer this service does not run.
  const declaredHome = info.configuredHome ?? environment.OPENTAG_HOME;
  if (!declaredHome) {
    return {
      definitionPath: info.definitionPath,
      kind: "unreadable",
      reason: "the installed service definition declares no OPENTAG_HOME",
    };
  }
  let serviceHome: string;
  let canonicalRequestedHome: string;
  try {
    [serviceHome, canonicalRequestedHome] = await Promise.all([
      canonicalizeServiceHome(declaredHome),
      canonicalizeServiceHome(requestedHome),
    ]);
  } catch (error) {
    return { definitionPath: info.definitionPath, kind: "unreadable", reason: describe(error) };
  }
  if (serviceHome !== canonicalRequestedHome) {
    return {
      definitionPath: info.definitionPath,
      kind: "home-mismatch",
      requestedHome: canonicalRequestedHome,
      serviceHome,
    };
  }
  return {
    definitionPath: info.definitionPath,
    environment,
    kind: "installed",
    path,
    platform: info.platform,
    serviceHome,
    state: info.state,
  };
}

function launchdEnvironment(definition: string): Readonly<Record<string, string>> {
  const marker = definition.indexOf("<key>EnvironmentVariables</key>");
  if (marker < 0) return {};
  const open = definition.indexOf("<dict>", marker);
  if (open < 0) return {};
  const close = definition.indexOf("</dict>", open);
  if (close < 0) return {};
  const body = definition.slice(open, close);
  const environment: Record<string, string> = {};
  for (const match of body.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/gu)) {
    const key = match[1];
    const value = match[2];
    if (key === undefined || value === undefined) continue;
    environment[unescapeXml(key)] = unescapeXml(value);
  }
  return environment;
}

function systemdEnvironment(definition: string): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const match of definition.matchAll(/^Environment="((?:[^"\\]|\\.)*)"$/gmu)) {
    const declaration = match[1];
    if (declaration === undefined) continue;
    const assignment = unescapeSystemd(declaration);
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;
    environment[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }
  return environment;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function unescapeSystemd(value: string): string {
  return value.replace(/%%/gu, "%").replace(/\\([\\"nrt])/gu, (_match, escaped: string) => {
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    return escaped;
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
