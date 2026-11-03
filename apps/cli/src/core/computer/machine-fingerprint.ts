import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DOMAIN = "opentag-machine-v1\0";
const LINUX_MACHINE_ID_PATHS = ["/etc/machine-id", "/var/lib/dbus/machine-id"] as const;

export interface MachineFingerprintSources {
  readonly platform: NodeJS.Platform;
  readonly uid: number | undefined;
  readonly readText: (path: string) => Promise<string>;
  readonly macPlatformUuid: () => Promise<string>;
  readonly realpath: (path: string) => Promise<string>;
}

const defaultSources: MachineFingerprintSources = {
  platform: process.platform,
  uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  readText: (path) => readFile(path, "utf8"),
  macPlatformUuid: async () => {
    const { stdout } = await execFileAsync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
      timeout: 5_000,
    });
    return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)?.[1] ?? "";
  },
  realpath,
};

/**
 * A hex SHA-256 naming this machine, OS user, and openTag home, so the Server can recognize a
 * reconnect after the local identity was lost. Only the hash leaves the machine. Returns `undefined`
 * when no stable machine ID is readable; the connect then behaves as it did without one.
 */
export async function readMachineFingerprint(
  home: string,
  sources: MachineFingerprintSources = defaultSources,
): Promise<string | undefined> {
  const machineId = await readMachineId(sources);
  if (!machineId || sources.uid === undefined) return undefined;
  const resolvedHome = await sources.realpath(home).catch(() => home);
  return createHash("sha256").update(`${DOMAIN}${machineId}\0${sources.uid}\0${resolvedHome}`, "utf8").digest("hex");
}

async function readMachineId(sources: MachineFingerprintSources): Promise<string | undefined> {
  if (sources.platform === "darwin") return usable(await sources.macPlatformUuid().catch(() => ""));
  if (sources.platform !== "linux") return undefined;
  for (const path of LINUX_MACHINE_ID_PATHS) {
    const id = usable(await sources.readText(path).catch(() => ""));
    if (id) return id;
  }
  return undefined;
}

function usable(value: string): string | undefined {
  const id = value.trim().toLowerCase();
  return id && id !== "uninitialized" ? id : undefined;
}
