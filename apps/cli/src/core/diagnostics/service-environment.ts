import { readFile } from "node:fs/promises";
import { resolveOpenTagHome } from "@opentag/client";
import {
  createDaemonServiceManager,
  type DaemonServiceInfo,
  type DaemonServiceManager,
} from "../daemon/service/index.js";

/**
 * The PATH an installed daemon service actually runs with. It is a snapshot taken when the service
 * was installed, not the invoking shell's PATH, so it is the only PATH whose answer matches the
 * readiness the Server receives.
 */
export type DaemonServiceEnvironment =
  | { readonly definitionPath: string; readonly kind: "installed"; readonly path: string; readonly state: string }
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
  let info: DaemonServiceInfo;
  try {
    const manager =
      options.manager ??
      (await createDaemonServiceManager({
        ...(options.env ? { env: options.env } : {}),
        home: options.home ?? resolveOpenTagHome(options.env),
      }));
    info = await manager.status();
  } catch (error) {
    return { kind: "unreadable", reason: describe(error) };
  }
  if (info.state === "not-installed") return { kind: "not-installed" };
  let definition: string;
  try {
    definition = await (options.readDefinition ?? ((path: string) => readFile(path, "utf8")))(info.definitionPath);
  } catch (error) {
    return { definitionPath: info.definitionPath, kind: "unreadable", reason: describe(error) };
  }
  const path = info.platform === "systemd" ? systemdPath(definition) : launchdPath(definition);
  if (!path) {
    return {
      definitionPath: info.definitionPath,
      kind: "unreadable",
      reason: "the installed service definition declares no PATH",
    };
  }
  return { definitionPath: info.definitionPath, kind: "installed", path, state: info.state };
}

function launchdPath(definition: string): string | undefined {
  const match = definition.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/u);
  return match?.[1] === undefined ? undefined : unescapeXml(match[1]);
}

function systemdPath(definition: string): string | undefined {
  const match = definition.match(/^Environment="PATH=((?:[^"\\]|\\.)*)"$/mu);
  return match?.[1] === undefined ? undefined : unescapeSystemd(match[1]);
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
