#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { buildRunnerImage } from "../../runner/build-image.mjs";
import { runWithCleanup } from "../../runner/cleanup.mjs";
import { RUNNER_PINS } from "../../runner/pins.mjs";
import { runOfflineSmoke } from "./offline-smoke.mjs";
import { runRealSmoke } from "./real-smoke.mjs";

const KNOWN = new Set(["channel", "version", "allow-dirty", "tag", "image", "mode", "pi-config-dir", "provider"]);

const USAGE = `Usage: run.mjs [options]

Options:
  --channel <dev|staging|prod>  Build channel (default: dev)
  --version <version>           Externally resolved version (required for staging)
  --allow-dirty <true|false>    Permit a dirty source tree (development only)
  --tag <tag>                   Image tag to build (default: opentag-runner:e2e-<random>)
  --image <tag>                 Reuse an already built image instead of building
  --mode <offline|real>         offline (default) never uses credentials; real requires config
  --pi-config-dir <path>        Isolated Pi config directory (real mode only)
  --provider <name>             Selected provider for real mode (currently: deepseek)
  --help                        Show this help
`;

function parseStrict(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument sequence near "${key ?? ""}"`);
    }
    const name = key.slice(2);
    if (!KNOWN.has(name)) throw new Error(`unknown option --${name}`);
    options[name] = value;
  }
  return options;
}

export async function runRunnerToolchain(options) {
  const mode = options.mode ?? "offline";
  if (mode !== "offline" && mode !== "real") throw new Error("--mode must be offline or real");
  if (mode === "real" && !options.piConfigDir) throw new Error("real mode requires --pi-config-dir");
  if (mode === "real" && !options.provider) throw new Error("real mode requires --provider");
  if (mode === "offline" && (options.piConfigDir || options.provider)) {
    throw new Error("offline mode ignores credentials; omit --pi-config-dir/--provider or use --mode real");
  }
  const tag = options.image ?? options.tag ?? `opentag-runner:e2e-${randomBytes(3).toString("hex")}`;
  let built;
  if (!options.image) {
    built = await buildRunnerImage({
      channel: options.channel ?? "dev",
      version: options.version,
      allowDirty: options.allowDirty === true,
      tag,
    });
  }
  const prefix = `opentag-runner-${randomBytes(3).toString("hex")}`;
  const smoke = await runOfflineSmoke({ image: tag, prefix });
  if (mode === "real") {
    const real = await runRealSmoke({
      image: tag,
      prefix,
      piConfigDir: options.piConfigDir,
      provider: options.provider,
    });
    return {
      identity: built?.identity,
      image: smoke.image,
      inspect: real.inspect,
      startupMs: real.startupMs,
      durations: { ...smoke.durations, acceptanceMs: real.acceptanceMs },
      firstTaskMs: real.firstTaskMs,
      memoryPeak: real.memoryPeak,
      emulation: smoke.emulation,
      daemonArch: smoke.daemonArch,
      platform: RUNNER_PINS.image.platform,
      offline: smoke.offline,
      model: "passed",
      real: { report: real.report, startupMs: real.startupMs },
      cleanup: { ...smoke.cleanup, realRemoved: true },
    };
  }
  return {
    identity: built?.identity,
    image: smoke.image,
    inspect: smoke.inspect,
    startupMs: smoke.startupMs,
    durations: smoke.durations,
    memoryPeak: smoke.memoryPeak,
    emulation: smoke.emulation,
    daemonArch: smoke.daemonArch,
    platform: RUNNER_PINS.image.platform,
    offline: smoke.offline,
    model: "skipped",
    cleanup: smoke.cleanup,
  };
}

/** Strict CLI entry; exported so a tiny dispatcher can reuse this exact argument parsing. */
export async function main(argv, out = console.log, err = console.error) {
  if (argv.includes("--help")) {
    out(USAGE);
    return;
  }
  let options;
  try {
    options = parseStrict(argv);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  const result = await runWithCleanup(() =>
    runRunnerToolchain({
      channel: options.channel ?? "dev",
      version: options.version,
      allowDirty: options["allow-dirty"] === "true",
      tag: options.tag,
      image: options.image,
      mode: options.mode,
      piConfigDir: options["pi-config-dir"],
      provider: options.provider,
    }),
  );
  out(JSON.stringify(result, null, 2));
}

const isProcessEntry = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isProcessEntry) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[runner-toolchain] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
