import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CLOUD_SANDBOX_CA_ENVIRONMENT_KEYS, CLOUD_SANDBOX_CA_FILE } from "./sandbox-entry.js";

/**
 * Real-module form of the generated `sandbox-ca.mjs` program (#633): the mounted public CA is
 * root-owned and native CLIs refuse a CA not owned by the current Sandbox uid, so the worker
 * copies the public certificate into its own 0700 home as a 0600 file and rewrites every CA
 * environment path to that copy. Only the public certificate is copied; the CA private key never
 * leaves the trusted Runner.
 */
export function prepareSandboxCa(input: { destination: string; environment: NodeJS.ProcessEnv; mount: string }): {
  destination: string;
  environment: NodeJS.ProcessEnv;
} {
  const source = `${input.mount}/${CLOUD_SANDBOX_CA_FILE}`;
  const directory = dirname(input.destination);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  // Flag 'wx' never follows a pre-existing path, and the explicit chmod fixes the mode under any umask.
  writeFileSync(input.destination, readFileSync(source), { flag: "wx", mode: 0o600 });
  chmodSync(input.destination, 0o600);
  const rewritten: NodeJS.ProcessEnv = { ...input.environment };
  for (const key of CLOUD_SANDBOX_CA_ENVIRONMENT_KEYS) {
    if (rewritten[key] === source) rewritten[key] = input.destination;
  }
  return { destination: input.destination, environment: rewritten };
}
