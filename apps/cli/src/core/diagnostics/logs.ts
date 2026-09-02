import { readdir, readFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { resolveOpenTagHome, resolveOpenTagHomeLayout } from "@opentag/client";
import { redactForLog } from "@opentag/shared";
import { CHANNEL, CLI_VERSION } from "../../build-info.js";

export interface LogsOptions {
  environment?: NodeJS.ProcessEnv;
  home?: string;
}

export interface LogBundleFile {
  content: string;
  name: string;
}

export interface LogsResult {
  environment: {
    arch: string;
    channel: string;
    cliVersion: string;
    homeConfigured: boolean;
    logLevel: string;
    nodeEnv: string;
    nodeVersion: string;
    osRelease: string;
    platform: string;
    serverConfigured: boolean;
    serviceMode: boolean;
  };
  files: LogBundleFile[];
}

const CLIENT_LOG_NAME = "client.log";
const CLIENT_LOG_PATTERN = /^client\.log(?:\.\d+)?$/u;

/** Read the local client log set and safe runtime metadata for support diagnostics. */
export async function runLogs(options: LogsOptions = {}): Promise<LogsResult> {
  const environment = options.environment ?? process.env;
  const home = options.home ?? resolveOpenTagHome(environment);
  const layout = resolveOpenTagHomeLayout(home);
  const files = await readClientLogs(layout.logs);
  return redactForLog({
    environment: {
      arch: arch(),
      channel: CHANNEL,
      cliVersion: CLI_VERSION,
      homeConfigured: Boolean(environment.OPENTAG_HOME),
      logLevel: environment.OPENTAG_LOG_LEVEL ?? "default",
      nodeEnv: environment.NODE_ENV ?? "unset",
      nodeVersion: process.version,
      osRelease: release(),
      platform: platform(),
      serverConfigured: Boolean(environment.OPENTAG_SERVER_URL),
      serviceMode: environment.OPENTAG_SERVICE_MODE === "1",
    },
    files,
  });
}

export function formatLogs(result: LogsResult): string {
  const safe = redactForLog(result);
  const lines = ["OpenTag logs", "Environment:", JSON.stringify(safe.environment) ?? "{}", "", "Client log files:"];
  if (safe.files.length === 0) {
    lines.push("(no client log files found)");
    return lines.join("\n");
  }
  for (const file of safe.files) {
    lines.push(`--- ${file.name} ---`, file.content.replace(/\s+$/u, ""));
  }
  return lines.join("\n");
}

async function readClientLogs(directory: string): Promise<LogBundleFile[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
  const names = entries
    .filter((entry) => entry.isFile() && CLIENT_LOG_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareLogNames);
  const files: LogBundleFile[] = [];
  for (const name of names) {
    try {
      files.push({ content: redactLogContent(await readFile(`${directory}/${name}`, "utf8")), name });
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
  }
  return files;
}

function redactLogContent(content: string): string {
  return content
    .split(/(?<=\n)/u)
    .map((line) => {
      const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
      try {
        return `${JSON.stringify(redactForLog(JSON.parse(trimmed)))}${line.endsWith("\n") ? "\n" : ""}`;
      } catch {
        return redactForLog(line);
      }
    })
    .join("");
}

function compareLogNames(left: string, right: string): number {
  if (left === CLIENT_LOG_NAME) return -1;
  if (right === CLIENT_LOG_NAME) return 1;
  return Number(left.slice(CLIENT_LOG_NAME.length + 1)) - Number(right.slice(CLIENT_LOG_NAME.length + 1));
}

function isMissingPath(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}
