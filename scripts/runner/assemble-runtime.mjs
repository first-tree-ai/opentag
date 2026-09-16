#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CHANNEL_CONFIG } from "../channel-config.mjs";
import { materializeRuntimeDependencyClosure, writeDependencyClosureFile } from "../portable/runtime-dependencies.mjs";
import { installCatalogProviderClis } from "./docker-install-provider-clis.mjs";
import {
  downloadVerified,
  writeContextTreeShim,
  writeOpenTagShim,
  writePiShim,
  writeRunnerShim,
} from "./install-tools.mjs";
import { RUNNER_PINS } from "./pins.mjs";
import { assembleClientRuntimeClosure } from "./runtime-closure.mjs";

const SRC = process.env.OPENTAG_RUNNER_SRC ?? "/src";
const OUT = process.env.OPENTAG_RUNNER_OUT ?? "/out";
const RUNTIME = "/opt/opentag";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

export async function assembleRunnerRuntime({ src = SRC, out = OUT } = {}) {
  const opt = join(out, RUNTIME.slice(1));
  const toolsDir = join(opt, "tools/bin");
  const piDir = join(opt, "pi");
  const clientDir = join(opt, "client");
  const cliDir = join(opt, "cli");
  const usrBin = join(out, "usr/local/bin");
  mkdirSync(toolsDir, { recursive: true });
  mkdirSync(usrBin, { recursive: true });

  cpSync(join(src, "packages/client/dist"), join(clientDir, "dist"), { recursive: true });
  cpSync(join(src, "apps/cli/dist"), join(cliDir, "dist"), { recursive: true });
  cpSync(join(src, "runner-identity.json"), join(opt, "identity.json"));
  cpSync(join(src, "scripts/runner/entrypoint.sh"), join(usrBin, "runner-entrypoint"));
  chmodSync(join(usrBin, "runner-entrypoint"), 0o755);
  // Source-owned Git/gh/Slack/Lark skill guidance pinned to the installed CLIs (never host skills).
  cpSync(join(src, "scripts/runner/skills"), join(opt, "skills"), { recursive: true });

  const nodeModules = join(opt, "node_modules");
  const closure = materializeRuntimeDependencyClosure({
    sourceManifestPath: join(src, "apps/cli/package.json"),
    nodeModulesDir: nodeModules,
  });
  writeDependencyClosureFile(opt, closure);
  writeFileSync(join(opt, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
  mkdirSync(join(clientDir, "node_modules/@first-tree-ai"), { recursive: true });
  mkdirSync(join(cliDir, "node_modules/@first-tree-ai"), { recursive: true });
  cpSync(
    join(nodeModules, "@first-tree-ai/context-tree"),
    join(clientDir, "node_modules/@first-tree-ai/context-tree"),
    {
      recursive: true,
    },
  );
  cpSync(join(nodeModules, "@first-tree-ai/context-tree"), join(cliDir, "node_modules/@first-tree-ai/context-tree"), {
    recursive: true,
  });

  // The client bundle keeps its declared dependencies external; ship the exact frozen-install
  // closure (e.g. @opentag/shared, pino, semver, ws, zod) so the Runner and probes execute
  // relocated, not from the source checkout. Context Tree is already staged above.
  const preStaged = new Set(["@first-tree-ai/context-tree"]);
  assembleClientRuntimeClosure({
    clientManifestPath: join(src, "packages/client/package.json"),
    clientDistDir: join(clientDir, "dist"),
    nodeModulesDir: join(clientDir, "node_modules"),
    skip: preStaged,
  });

  mkdirSync(piDir, { recursive: true });
  cpSync(join(src, "scripts/runner/pi/package.json"), join(piDir, "package.json"));
  cpSync(join(src, "scripts/runner/pi/package-lock.json"), join(piDir, "package-lock.json"));
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: piDir });

  await installCatalogProviderClis({
    dest: toolsDir,
    catalogModulePath: join(src, "packages/client/dist/index.mjs"),
    runtimeBin: `${RUNTIME}/tools/bin`,
  });

  const nodePath = "/usr/local/bin/node";
  writePiShim({
    dest: toolsDir,
    nodePath,
    cliPath: `${RUNTIME}/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`,
  });
  writeContextTreeShim({
    dest: toolsDir,
    nodePath,
    cliPath: `${RUNTIME}/node_modules/@first-tree-ai/context-tree/dist/cli/index.mjs`,
  });
  writeRunnerShim({ dest: usrBin, nodePath, cliPath: `${RUNTIME}/client/dist/runner/bin.mjs` });
  const identity = JSON.parse(readFileSync(join(src, "runner-identity.json"), "utf8"));
  const binName = CHANNEL_CONFIG[identity.channel]?.binName ?? "opentag-dev";
  writeOpenTagShim({ dest: usrBin, nodePath, cliPath: `${RUNTIME}/cli/dist/cli/index.mjs`, binName });

  const archive = await downloadVerified(RUNNER_PINS.gh);
  const ghTmp = join(out, "gh.tar.gz");
  writeFileSync(ghTmp, archive);
  run("tar", ["-xzf", ghTmp, "-C", out]);
  cpSync(join(out, RUNNER_PINS.gh.archiveMember), join(toolsDir, "gh"));
  chmodSync(join(toolsDir, "gh"), 0o755);
  rmSync(ghTmp, { force: true });
}

const isProcessEntry = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isProcessEntry) {
  assembleRunnerRuntime().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
