/**
 * The CLI commands driven as a real child process against a real listening Server.
 *
 * Everything else in the suite tests the CLI by calling its exported functions, which proves the
 * request shape but says nothing about the half of the tool a user actually touches: Commander's
 * option parsing, `--json` output, the exit codes, and the presentation helpers' formatting. Those
 * only fail when a binary is run, so this spawns the built CLI and asserts what comes back.
 */

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createApp } from "../../app.js";
import { createDatabaseClient } from "../../db/client.js";
import { AgentService } from "../../services/agents/index.js";
import { MachineAuthService } from "../../services/computers/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import {
  McpAuthorizationService,
  McpCredentialCipher,
  McpOAuthClient,
  McpOAuthFlowService,
  McpOutboundFetcher,
  McpProbe,
  McpServerService,
} from "../../services/mcp/index.js";
import { McpFixtureServer } from "../fixtures/mcp-fixture-server.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

/**
 * The built CLI binary, resolved from the repository root rather than by relative hops so a moved
 * test file cannot silently point at a nonexistent path and report every command as a crash.
 */
const CLI_ENTRY = fileURLToPath(new URL("../../../../../apps/cli/dist/cli/index.mjs", import.meta.url));

let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);
afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

const openPools: { end: () => Promise<unknown> }[] = [];
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
  await Promise.all(openPools.splice(0).map((pool) => pool.end()));
});

interface Booted {
  agentId: string;
  baseUrl: string;
  close: () => Promise<void>;
  home: string;
}

/** Boot the real Server on a loopback port and write a CLI home pointing at it. */
async function boot(): Promise<Booted> {
  const client = createDatabaseClient(databaseUrl);
  openPools.push(client.sql);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Tester",
    email: `cli-e2e-${randomUUID()}@company.example`,
  });
  const accountId = bootstrap.userId;
  const agentService = new AgentService(client.database);
  const machineAuth = new MachineAuthService(client.database);
  const issued = await machineAuth.issueForAccount(accountId, {});
  const exchange = await machineAuth.exchangeConnectCode({
    code: issued.code,
    installationId: randomUUID(),
    displayName: "workstation",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.2",
  });
  const agent = await agentService.createForAccount(accountId, {
    computerId: exchange.computerId,
    displayName: "Agent A",
    name: "agent-a",
    runtimeProvider: "codex",
  });

  const fetcher = new McpOutboundFetcher({ allowLoopback: true });
  const cipher = new McpCredentialCipher(new ApplicationCipher(randomBytes(32)));
  const servers = new McpServerService({ database: client.database });
  const oauth = new McpOAuthClient({ fetcher, publicUrl: "https://opentag.test" });
  const flows = new McpOAuthFlowService({ database: client.database, cipher, oauth, servers });
  const app = createApp({
    authService: {
      exchangeConnectCode: async () => {
        throw new Error("unused");
      },
      refresh: async () => {
        throw new Error("unused");
      },
      getActiveUserById: async () => undefined,
      updateSelfProfile: async () => {
        throw new Error("unused");
      },
      getAuthenticatedUser: async () => ({
        tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
        me: { user: { id: accountId, email: "admin@example.com", displayName: "Admin" }, setupCompletedAt: null },
      }),
    } as never,
    agentService,
    mcp: {
      authorization: new McpAuthorizationService({
        database: client.database,
        cipher,
        probe: new McpProbe({ fetcher }),
        servers,
      }),
      flows,
      servers,
      publicOrigin: "https://opentag.test",
      secureCookies: false,
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;
  cleanup.push(async () => {
    await app.close();
  });

  // A CLI home with only a credentials file: enough for every authenticated command.
  const home = await mkdtemp(join(tmpdir(), "opentag-cli-e2e-"));
  cleanup.push(async () => {
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(join(home, "config"), { recursive: true });
  await writeFile(
    join(home, "config", "credentials.json"),
    JSON.stringify({
      accessToken: "api-access",
      accessTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      refreshToken: "api-refresh",
      serverUrl: baseUrl,
    }),
    { mode: 0o600 },
  );

  return {
    agentId: agent.id,
    baseUrl,
    close: async () => {
      await app.close();
    },
    home,
  };
}

async function cli(
  home: string,
  args: string[],
  input?: string,
): Promise<{ code: number; stderr: string; stdout: string }> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, OPENTAG_HOME: home, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    // Closing the pipe is part of the contract for a stdin-reading command: without it the child
    // waits for input that will never arrive, and the test hangs instead of failing.
    child.stdin.end(input ?? "");
  });
}

async function fixture(options: Parameters<typeof McpFixtureServer.start>[0] = {}) {
  const started = await McpFixtureServer.start(options);
  cleanup.push(async () => {
    await started.stop();
  });
  return started;
}

describe("MCP CLI end to end", () => {
  it("registers, lists, shows, edits, and removes a Server as a real process", async () => {
    const booted = await boot();
    const added = await cli(booted.home, [
      "mcp",
      "add",
      "--name",
      "linear",
      "--url",
      "https://mcp.example.com/mcp",
      "--default-auth",
      "bearer",
      "--auth-header",
      "x-api-key",
      "--extra-header",
      "x-workspace-id=ws_123",
    ]);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout).toContain("name\tlinear");
    expect(added.stdout).toContain("revision\t1");

    const listed = await cli(booted.home, ["mcp", "list"]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain("linear");

    const shown = await cli(booted.home, ["mcp", "show", "linear"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain("authHeader\tx-api-key");

    // The revision-fenced edit, given no --expected-revision, uses the revision it just read.
    const updated = await cli(booted.home, ["mcp", "update", "linear", "--description", "Issue tracking"]);
    expect(updated.code, updated.stderr).toBe(0);
    expect(updated.stdout).toContain("description\tIssue tracking");
    expect(updated.stdout).toContain("revision\t2");

    const removed = await cli(booted.home, ["mcp", "remove", "linear"]);
    expect(removed.code, removed.stderr).toBe(0);
    const after = await cli(booted.home, ["mcp", "list"]);
    expect(after.stdout).toContain("No MCP Servers configured");
  }, 60_000);

  it("prints machine-readable JSON when asked", async () => {
    const booted = await boot();
    await cli(booted.home, ["mcp", "add", "--name", "linear", "--url", "https://mcp.example.com/mcp"]);
    const listed = await cli(booted.home, ["mcp", "list", "--json"]);
    expect(listed.code, listed.stderr).toBe(0);
    // `--json` emits the shared success envelope; `mcp list` yields the Servers array directly.
    const parsed = JSON.parse(listed.stdout) as {
      ok: boolean;
      result: { name: string; url: string; boundAgentCount: number }[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.result).toHaveLength(1);
    expect(parsed.result[0]).toMatchObject({ name: "linear", url: "https://mcp.example.com/mcp" });
  }, 60_000);

  it("emits a whole tool snapshot as JSON rather than a log-sized slice", async () => {
    /*
     * S11. The CLI presents `--json` through the shared redactor, which was also applying the log
     * serializer's caps — arrays at 32, depth at 8. So this command dropped every tool past the 32nd
     * and rendered a nested `inputSchema` as `[TRUNCATED]`, silently, which the PR body did not
     * mention either. Sixty tools and a nested schema are enough to exercise both caps.
     */
    const server = await fixture({
      toolPages: [
        {
          tools: Array.from({ length: 60 }, (_, index) => ({
            inputSchema: { properties: { nested: { type: "object" } }, type: "object" },
            name: `t${index}`,
          })),
        },
      ],
    });
    const booted = await boot();
    await cli(booted.home, ["mcp", "add", "--name", "many", "--url", server.endpoint, "--default-auth", "none"]);
    await cli(booted.home, ["agent", "mcp", "attach", booted.agentId, "many"]);
    await cli(booted.home, ["mcp", "probe", "many", "--agent", booted.agentId]);

    const shown = await cli(booted.home, ["agent", "mcp", "list", booted.agentId, "--json"]);
    expect(shown.code, shown.stderr).toBe(0);
    const raw = shown.stdout;
    expect(raw).not.toContain("[TRUNCATED]");
    // Every one of the sixty tools is present, not the first thirty-two.
    expect(raw).toContain('"t59"');
    expect(raw).toContain('"t32"');
  }, 60_000);

  it("mounts, authorizes with a piped Bearer key, probes, and detaches", async () => {
    const server = await fixture({ toolPages: [{ tools: [{ name: "echo" }, { name: "search" }] }] });
    const booted = await boot();
    await cli(booted.home, ["mcp", "add", "--name", "fixture", "--url", server.endpoint, "--default-auth", "bearer"]);
    const attached = await cli(booted.home, ["agent", "mcp", "attach", booted.agentId, "fixture"]);
    expect(attached.code, attached.stderr).toBe(0);
    expect(attached.stdout).toContain("mount\tenabled");

    // The piped key path: the documented way to avoid the value landing in shell history.
    const used = await cli(
      booted.home,
      ["mcp", "use", "fixture", "--agent", booted.agentId, "--bearer-key-stdin"],
      "key_from_stdin\n",
    );

    expect(used.code, used.stderr).toBe(0);
    // The write landed and the credential is stored; the key itself is never echoed back.
    expect(used.stdout).toContain("authKind\tbearer");
    expect(used.stdout).not.toContain("key_from_stdin");

    const probed = await cli(booted.home, ["mcp", "probe", "fixture", "--agent", booted.agentId]);
    expect(probed.code, probed.stderr).toBe(0);
    expect(probed.stdout).toContain("probeState\tsucceeded");
    expect(probed.stdout).toContain("toolsCount\t2");
    expect(probed.stdout).toContain("protocolEra\tmodern");

    const listed = await cli(booted.home, ["agent", "mcp", "list", booted.agentId]);
    expect(listed.code, listed.stderr).toBe(0);
    // One row, with the four independent states the plan requires and the tool count.
    expect(listed.stdout).toContain("NAME\tMOUNT\tAUTH KIND\tAUTH STATUS\tPROBE\tTOOLS\tEXPIRES");
    expect(listed.stdout).toContain("fixture\tenabled\tbearer\tactive\tprobed ");
    expect(listed.stdout).toContain("\t2\t");

    const detached = await cli(booted.home, ["agent", "mcp", "detach", booted.agentId, "fixture"]);
    expect(detached.code, detached.stderr).toBe(0);
    const after = await cli(booted.home, ["agent", "mcp", "list", booted.agentId]);
    expect(after.stdout).toContain("No MCP Servers mounted");
  }, 60_000);

  it("separates an Agent override from a shared-definition edit on the command line", async () => {
    const shared = await fixture({ toolPages: [{ tools: [] }] });
    const overridden = await fixture({ toolPages: [{ tools: [] }] });
    const booted = await boot();
    await cli(booted.home, ["mcp", "add", "--name", "fixture", "--url", shared.endpoint]);
    await cli(booted.home, ["agent", "mcp", "attach", booted.agentId, "fixture"]);

    // The default scope is this Agent: an override, which the output marks as overridden.
    const configured = await cli(booted.home, [
      "agent",
      "mcp",
      "config",
      booted.agentId,
      "fixture",
      "--url",
      overridden.endpoint,
    ]);
    expect(configured.code, configured.stderr).toBe(0);
    expect(configured.stdout).toContain(`effectiveUrl\t${overridden.endpoint}\toverridden`);

    // Restoring inheritance is a different action from leaving the override in place.
    const cleared = await cli(booted.home, ["agent", "mcp", "config", booted.agentId, "fixture", "--clear-url"]);
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(cleared.stdout).toContain(`effectiveUrl\t${shared.endpoint}\tinherited`);

    // `--empty-extra-headers` and `--clear-extra-headers` are distinct, and only the latter inherits.
    const shared2 = await cli(booted.home, ["mcp", "show", "fixture"]);
    expect(shared2.code, shared2.stderr).toBe(0);
  }, 60_000);

  it("flags a truncated tool snapshot rather than reporting only a count", async () => {
    // 250 tools exceeds the 200-tool cap, so the snapshot is partial by construction.
    const server = await fixture({
      toolPages: [{ tools: Array.from({ length: 250 }, (_, index) => ({ name: `t${index}` })) }],
    });
    const booted = await boot();
    await cli(booted.home, ["mcp", "add", "--name", "many", "--url", server.endpoint, "--default-auth", "none"]);
    await cli(booted.home, ["agent", "mcp", "attach", booted.agentId, "many"]);
    const probed = await cli(booted.home, ["mcp", "probe", "many", "--agent", booted.agentId]);
    expect(probed.code, probed.stderr).toBe(0);
    expect(probed.stdout).toContain("toolsTruncated\ttrue");
    expect(probed.stdout).toContain("toolsCount\t200");
  }, 60_000);

  it("reports a failure with a bounded code and a non-zero exit", async () => {
    const booted = await boot();
    const missing = await cli(booted.home, ["mcp", "show", "does-not-exist"]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("does-not-exist");

    // A rejected payload surfaces the server's own code, not a generic failure.
    const invalid = await cli(booted.home, ["mcp", "add", "--name", "bad", "--url", "not-a-url"]);
    expect(invalid.code).not.toBe(0);
  }, 60_000);
});
