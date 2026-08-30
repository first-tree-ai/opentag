import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import semver from "semver";
import type { ProviderCliCatalogEntry } from "./catalog.js";

/** Injectable bounded child-process runner; the default never uses a shell. */
export type ProviderCliExecFile = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; windowsHide: boolean },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

export const defaultProviderCliExecFile: ProviderCliExecFile = async (file, args, options) => {
  const result = await execFileAsync(file, [...args], {
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    windowsHide: options.windowsHide,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

/**
 * Probes run with a scrubbed environment: no provider credentials, no caller PATH
 * influence beyond the absolute target, and no provider API requests. `probeHome` is a
 * fresh private temporary directory, never the real account home, so provider config,
 * tokens, and logs cannot be read from or written to the user's normal CLI state. The
 * running Node.js directory is first on PATH so `#!/usr/bin/env node` wrappers execute
 * with the same Node runtime as OpenTag.
 */
export function providerCliProbeEnvironment(probeHome: string, execDir = dirname(process.execPath)): NodeJS.ProcessEnv {
  return {
    HOME: probeHome,
    PATH: [execDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
    TMPDIR: join(probeHome, "tmp"),
    TMP: join(probeHome, "tmp"),
    TEMP: join(probeHome, "tmp"),
    XDG_CONFIG_HOME: join(probeHome, "config"),
    XDG_CACHE_HOME: join(probeHome, "cache"),
    XDG_STATE_HOME: join(probeHome, "state"),
    XDG_RUNTIME_DIR: join(probeHome, "runtime"),
  };
}

export type ProviderCliProbeOutcome =
  | { readonly status: "ok"; readonly version: string }
  | { readonly status: "failed"; readonly code: "probe_failed" | "version_incompatible" | "unparseable_version" };

/**
 * Run the reviewed probe contract against one absolute executable: version probe,
 * version parse and compatibility check, then the required command-surface probe.
 * Raw child output never leaves this function.
 */
export async function probeProviderCliExecutable(
  target: string,
  entry: ProviderCliCatalogEntry,
  options: {
    execFile?: ProviderCliExecFile;
    /** False when the target launcher already prepends the catalog-managed arguments. */
    includeManagedArguments?: boolean;
  },
): Promise<ProviderCliProbeOutcome> {
  let probeHome: string | undefined;
  try {
    probeHome = await mkdtemp(join(tmpdir(), "opentag-provider-cli-probe-"));
    await chmod(probeHome, 0o700);
    for (const child of ["tmp", "config", "cache", "state", "runtime"]) {
      await mkdir(join(probeHome, child), { mode: 0o700 });
    }
    if (entry.provider === "slack") await mkdir(join(probeHome, "slack"), { mode: 0o700 });

    const run = options.execFile ?? defaultProviderCliExecFile;
    const env = {
      ...providerCliProbeEnvironment(probeHome),
      // Update suppression is safe for every probe, including external candidates.
      ...entry.managedEnvironment,
    };
    const execution = {
      env,
      maxBuffer: entry.probes.maxOutputBytes,
      timeout: entry.probes.timeoutMs,
      windowsHide: true,
    } as const;
    const prefix = options.includeManagedArguments === false ? [] : [...entry.managedArguments];
    if (entry.provider === "slack" && !prefix.includes("--config-dir")) {
      prefix.push("--config-dir", join(probeHome, "slack"));
    }

    let versionOutput: string;
    try {
      versionOutput = (await run(target, [...prefix, ...entry.probes.versionArgs], execution)).stdout;
    } catch {
      return { status: "failed", code: "probe_failed" };
    }
    const match = new RegExp(entry.probes.versionPattern).exec(versionOutput);
    const version = match?.[1];
    if (!version || !semver.valid(version)) {
      return { status: "failed", code: "unparseable_version" };
    }
    if (!semver.satisfies(version, entry.compatibility)) {
      return { status: "failed", code: "version_incompatible" };
    }
    try {
      await run(target, [...prefix, ...entry.probes.surfaceArgs], execution);
    } catch {
      return { status: "failed", code: "probe_failed" };
    }
    return { status: "ok", version };
  } catch {
    return { status: "failed", code: "probe_failed" };
  } finally {
    if (probeHome) await rm(probeHome, { force: true, recursive: true }).catch(() => undefined);
  }
}
