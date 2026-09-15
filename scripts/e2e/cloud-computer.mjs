#!/usr/bin/env node
/**
 * OpenTag Cloud Computer acceptance harness.
 *
 * Commands:
 *   local-pi          E1 real local Pi Computer (unchanged harness)
 *   cloud-identities  E2 Cloud Computer / Sandbox identity acceptance
 *
 * Usage:
 *   node scripts/e2e/cloud-computer.mjs --help
 *   node scripts/e2e/cloud-computer.mjs local-pi
 *   node scripts/e2e/cloud-computer.mjs local-pi --help
 *   node scripts/e2e/cloud-computer.mjs cloud-identities
 *   node scripts/e2e/cloud-computer.mjs cloud-identities --help
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const HELP = `OpenTag Cloud Computer acceptance

Usage:
  node scripts/e2e/cloud-computer.mjs --help
  node scripts/e2e/cloud-computer.mjs local-pi [--help]
  node scripts/e2e/cloud-computer.mjs cloud-identities [--help]

Commands:
  local-pi          E1 real local Pi Computer acceptance against a disposable Postgres.
  cloud-identities  E2 Cloud Computer and Sandbox identity acceptance. No Pi/model/GCP/IM.

Requirements for local-pi:
  - Docker, used only to start a disposable postgres:17-alpine container
  - A built workspace (\`pnpm build\`) so Server and CLI dist entries exist
  - A real \`pi\` CLI on PATH (0.80.6+) with a configured model credential
    (this machine's ~/.pi/agent DeepSeek config is used by copying needed
    files into an owned 0700 fixture; the source directory is never printed)
  - Node.js ^22.22.2 || ^24.15.0 || ^26.0.0
  - Loopback-only Server (127.0.0.1)

Product admission that this harness does not implement:
  - Provider \`pi\` must already be admitted in shared schemas, Server provider
    admission, and production createClientRuntime. Missing admission or
    unusable live Pi readiness fails the run.

What this harness will not do:
  - Mock Pi, hardcode token responses, or fake RuntimeConnection
  - Count a direct PiAgentRuntimeFactory smoke as product acceptance
  - Read or write the canonical Context Tree
  - Call real Slack/Feishu APIs or use production OpenTag home/data
  - Drop or reset an arbitrary existing database
  - Commit, push, or allocate Cloud resources

E1-only substitutions (reported in the run summary, not hidden):
  - Synthetic NormalizedInboundImEvent via ImMessageInbox.ingest
    (real IM webhooks are E4)
  - Fixture Slack IM binding with encrypted dummy credentials
    (not OAuth; credential grant still goes through production
    ImBindingService)
  - Harmless local \`slack\` CLI substitute that answers version/surface
    probes and auth.test identity checks without touching Slack

Not substituted:
  - PostgreSQL schema via Server auto-migrate
  - Server Fastify app, auth, ConnectionRegistry, RuntimeDomainOwner,
    PostgresRuntimeCustodyStore, ImDeliveryWorker
  - MachineAuthService computer connect and the CLI daemon's
    RuntimeConnection + createClientRuntime
  - Real Pi process, model, session file, and sessionFileHash binding

Active stop:
  SIGTERM closes the real Client runtime and must terminate Pi plus its child.
  A cancelled/client_shutdown receipt must reach the Server after restart.
  Agent suspend currently refuses active Turns; Server stop/status is E4 work.

Artifacts:
  Sanitized summary.json plus Server/daemon logs are kept in
  OPENTAG_E1_ARTIFACTS, or a unique directory under the process temp dir.
  Auth tokens, encryption keys, and Pi config contents are never written
  there.

Environment:
  OPENTAG_E1_ARTIFACTS     Artifact directory for local-pi (created if missing)
  OPENTAG_E1_PORT          local-pi Server port (default 8131)
  OPENTAG_E1_KEEP          Set to "on" to keep the local-pi Postgres container
  PI_CODING_AGENT_DIR      Optional source of Pi config to copy silently
  OPENTAG_E2_ARTIFACTS     Artifact directory for cloud-identities
  OPENTAG_E2_PORT          cloud-identities Server port (optional; otherwise allocated)
`;

function printHelp() {
  process.stdout.write(`${HELP}\n`);
}

const args = process.argv.slice(2);
const unknownOption = args.find((value) => value.startsWith("-") && value !== "--help" && value !== "-h");
if (unknownOption) {
  process.stderr.write(`Unknown option: ${unknownOption}\n`);
  process.exit(2);
}
const command = args.find((value) => !value.startsWith("-"));
const wantsHelp = args.includes("--help") || args.includes("-h") || args.length === 0;

if (!command && wantsHelp) {
  printHelp();
  process.exit(0);
}

if (command === "cloud-identities") {
  const { runCloudIdentities } = await import("./cloud-computer/cloud-identities.mjs");
  process.exitCode = await runCloudIdentities({ repositoryRoot, args });
} else if (command === "local-pi") {
  if (wantsHelp) {
    printHelp();
    process.exit(0);
  }
  const { runLocalPi } = await import("./cloud-computer/local-pi.mjs");
  process.exitCode = await runLocalPi({ repositoryRoot, args });
} else if (command) {
  process.stderr.write(`Unknown command: ${command}\n\n${HELP}\n`);
  process.exit(2);
}
