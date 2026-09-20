import type { MCPAgentServer, MCPServer, MCPServerDetail } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import * as mcpOperations from "../core/mcp/operations.js";

/**
 * These suites drive the real Commander program, because the uncovered branches in
 * `commands/mcp/index.ts` are option parsing and action wiring: they only run through `parseAsync`.
 * The `core/` operations are spied so each assertion lands on the wiring rather than on the API
 * client, which is why every command here is exercised with and without its optional flags.
 */

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";

const server: MCPServer = {
  id: "d91ba522-498b-4d5e-845b-06f8dc9d562c",
  name: "tools",
  description: null,
  url: "https://tools.example.test/mcp",
  defaultAuthKind: "oauth",
  authHeader: "authorization",
  authScheme: "",
  extraHeaders: {},
  revision: 4,
  boundAgentCount: 1,
  authorizedAgentCount: 1,
  lastProbedAt: null,
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
};

const mount: MCPAgentServer = {
  mcpServerId: server.id,
  name: server.name,
  description: null,
  discoveredDescription: null,
  enabled: true,
  effective: { url: server.url, authHeader: "authorization", authScheme: "", extraHeaders: {} },
  overridden: { url: false, authHeader: false, authScheme: false, extraHeaders: false },
  authorization: null,
  snapshot: null,
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
};

const detail: MCPServerDetail = { server, agents: [] };

/** Run one command line, capture what the process wrote, and restore the process state afterwards. */
async function runCommand(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(["node", "opentag", ...args]);
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    out.mockRestore();
    err.mockRestore();
    process.exitCode = previousExitCode;
  }
}

function spyAll() {
  return {
    create: vi.spyOn(mcpOperations, "runMcpCreate").mockResolvedValue(server),
    list: vi.spyOn(mcpOperations, "runMcpList").mockResolvedValue([server]),
    show: vi.spyOn(mcpOperations, "runMcpShow").mockResolvedValue({ server: detail }),
    update: vi.spyOn(mcpOperations, "runMcpUpdate").mockResolvedValue(server),
    remove: vi.spyOn(mcpOperations, "runMcpRemove").mockResolvedValue(server),
    use: vi.spyOn(mcpOperations, "runMcpUse").mockResolvedValue(mount),
    authorize: vi.spyOn(mcpOperations, "runMcpAuthorize").mockResolvedValue({
      server,
      started: { authorizationUrl: "https://auth.example.test/authorize", expiresAt: "2030-01-01T00:10:00.000Z" },
    }),
    revoke: vi.spyOn(mcpOperations, "runMcpRevoke").mockResolvedValue(mount),
    probe: vi.spyOn(mcpOperations, "runMcpProbe").mockResolvedValue({
      probeState: "succeeded",
      probeError: null,
      toolsCount: 3,
      toolsTruncated: false,
      protocolEra: "modern",
      protocolVersion: "2030-01-01",
    }),
    agentList: vi.spyOn(mcpOperations, "runAgentMcpList").mockResolvedValue([mount]),
    attach: vi.spyOn(mcpOperations, "runAgentMcpAttach").mockResolvedValue(mount),
    detach: vi.spyOn(mcpOperations, "runAgentMcpDetach").mockResolvedValue(undefined),
    enable: vi.spyOn(mcpOperations, "runAgentMcpEnable").mockResolvedValue(mount),
    config: vi.spyOn(mcpOperations, "runAgentMcpConfig").mockResolvedValue(mount),
    stdin: vi.spyOn(mcpOperations, "readBearerKeyFromStdin").mockResolvedValue("piped-key"),
    prompt: vi.spyOn(mcpOperations, "promptForBearerKey").mockResolvedValue("prompted-key"),
  };
}

type Spies = ReturnType<typeof spyAll>;

function restore(spies: Spies): void {
  for (const spy of Object.values(spies)) spy.mockRestore();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mcp command registration", () => {
  it("advertises exactly the Account-level subcommands, with no Account-level enable switch", () => {
    const mcp = createProgram().commands.find((command) => command.name() === "mcp");
    expect(mcp?.commands.map((command) => command.name())).toEqual([
      "add",
      "list",
      "show",
      "update",
      "remove",
      "use",
      "authorize",
      "revoke",
      "probe",
    ]);
    // The Server definition carries no switch: enabling is strictly per Agent.
    expect(mcp?.options.map((option) => option.long)).not.toContain("--enable");
    expect(
      mcp?.commands.find((command) => command.name() === "add")?.options.map((option) => option.long),
    ).not.toContain("--description");
  });

  it("advertises exactly the Agent-level subcommands, including both switch directions", () => {
    const agent = createProgram().commands.find((command) => command.name() === "agent");
    const mcp = agent?.commands.find((command) => command.name() === "mcp");
    expect(mcp?.commands.map((command) => command.name())).toEqual([
      "list",
      "attach",
      "detach",
      "enable",
      "disable",
      "config",
    ]);
  });
});

describe("mcp add", () => {
  it("defaults the auth kind and omits every option the caller did not give", async () => {
    const spies = spyAll();
    try {
      const result = await runCommand(["mcp", "add", "--name", "tools", "--url", "https://tools.example.test/mcp"]);
      // `--extra-header` is declared with a default of `[]`, so an unused flag arrives as an empty
      // list rather than as absent: `optionalList` reports the array as-is and `whenDefined` keeps it.
      expect(spies.create).toHaveBeenCalledWith({
        name: "tools",
        url: "https://tools.example.test/mcp",
        defaultAuthKind: "oauth",
        extraHeader: [],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("name\ttools");
    } finally {
      restore(spies);
    }
  });

  it("forwards every optional flag, including an empty scheme and a repeated header", async () => {
    const spies = spyAll();
    try {
      await runCommand([
        "mcp",
        "add",
        "--name",
        "tools",
        "--url",
        "https://tools.example.test/mcp",
        "--default-auth",
        "bearer",
        "--auth-header",
        "x-key",
        "--auth-scheme",
        "",
        "--extra-header",
        "X-A=1",
        "--extra-header",
        "X-B=2",
      ]);
      expect(spies.create).toHaveBeenCalledWith({
        name: "tools",
        url: "https://tools.example.test/mcp",
        defaultAuthKind: "bearer",
        authHeader: "x-key",
        authScheme: "",
        extraHeader: ["X-A=1", "X-B=2"],
      });
    } finally {
      restore(spies);
    }
  });

  it("rejects a default auth kind outside the three the API models", async () => {
    const spies = spyAll();
    try {
      const result = await runCommand([
        "mcp",
        "add",
        "--name",
        "tools",
        "--url",
        "https://tools.example.test/mcp",
        "--default-auth",
        "basic",
      ]);
      expect(spies.create).not.toHaveBeenCalled();
      // A plain Error thrown in an action is classified from the action's declared phase, so an
      // option error here reports the internal exit code rather than the usage one.
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--default-auth must be oauth, bearer, or none");
    } finally {
      restore(spies);
    }
  });

  it("reports a definition failure as a non-zero command result", async () => {
    const spies = spyAll();
    spies.create.mockRejectedValue(new Error("the name is already taken"));
    try {
      const result = await runCommand(["mcp", "add", "--name", "tools", "--url", "https://tools.example.test/mcp"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("the name is already taken");
    } finally {
      restore(spies);
    }
  });
});

describe("mcp list, show, update, remove", () => {
  it("lists the Account's definitions in both human and JSON form", async () => {
    const spies = spyAll();
    try {
      const human = await runCommand(["mcp", "list"]);
      expect(human.stdout).toContain("NAME\tURL\tAGENTS\tAUTHORIZED\tLAST PROBED");
      const json = await runCommand(["mcp", "list", "--json"]);
      expect(JSON.parse(json.stdout)).toMatchObject({ ok: true });
    } finally {
      restore(spies);
    }
  });

  it("says so when there are no definitions at all", async () => {
    const spies = spyAll();
    spies.list.mockResolvedValue([]);
    try {
      const result = await runCommand(["mcp", "list"]);
      expect(result.stdout).toContain("No MCP Servers configured");
    } finally {
      restore(spies);
    }
  });

  it("asks for the definition alone when --agent was not given", async () => {
    const spies = spyAll();
    try {
      await runCommand(["mcp", "show", "tools"]);
      expect(spies.show).toHaveBeenCalledWith("tools", {});
    } finally {
      restore(spies);
    }
  });

  it("asks for one Agent's effective view when --agent was given", async () => {
    const spies = spyAll();
    try {
      await runCommand(["mcp", "show", "tools", "--agent", agentId]);
      expect(spies.show).toHaveBeenCalledWith("tools", { agentId });
    } finally {
      restore(spies);
    }
  });

  it("passes only the flags the caller gave to update", async () => {
    const spies = spyAll();
    try {
      await runCommand(["mcp", "update", "tools"]);
      expect(spies.update).toHaveBeenCalledWith("tools", { extraHeader: [] });
      await runCommand([
        "mcp",
        "update",
        "tools",
        "--description",
        "probed",
        "--url",
        "https://new.example.test/mcp",
        "--default-auth",
        "none",
        "--auth-header",
        "x-auth",
        "--auth-scheme",
        "",
        "--extra-header",
        "x-tenant=a",
        "--expected-revision",
        "7",
      ]);
      expect(spies.update).toHaveBeenLastCalledWith("tools", {
        description: "probed",
        url: "https://new.example.test/mcp",
        defaultAuthKind: "none",
        authHeader: "x-auth",
        authScheme: "",
        extraHeader: ["x-tenant=a"],
        expectedRevision: 7,
      });
    } finally {
      restore(spies);
    }
  });

  it("maps both header-clearing spellings onto the one definition-level action", async () => {
    const spies = spyAll();
    try {
      await runCommand(["mcp", "update", "tools", "--clear-extra-headers"]);
      expect(spies.update).toHaveBeenLastCalledWith("tools", { extraHeader: [], clearExtraHeaders: true });
      await runCommand(["mcp", "update", "tools", "--empty-extra-headers"]);
      expect(spies.update).toHaveBeenLastCalledWith("tools", { extraHeader: [], emptyExtraHeaders: true });
    } finally {
      restore(spies);
    }
  });

  it("reports the removed Server by name", async () => {
    const spies = spyAll();
    try {
      const result = await runCommand(["mcp", "remove", "tools"]);
      expect(spies.remove).toHaveBeenCalledWith("tools");
      expect(result.stdout).toContain("Removed MCP Server tools");
    } finally {
      restore(spies);
    }
  });

  it("presents a failed removal as a non-zero result on stderr", async () => {
    const spies = spyAll();
    spies.remove.mockRejectedValue(new Error("still mounted"));
    try {
      const result = await runCommand(["mcp", "remove", "tools", "--json"]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false });
    } finally {
      restore(spies);
    }
  });
});

describe("mcp use", () => {
  it("declares an anonymous authorization without reading any key", async () => {
    const spies = spyAll();
    try {
      await runCommand(["mcp", "use", "tools", "--agent", agentId, "--kind", "none"]);
      expect(spies.use).toHaveBeenCalledWith(agentId, "tools", { kind: "none" });
      expect(spies.stdin).not.toHaveBeenCalled();
      expect(spies.prompt).not.toHaveBeenCalled();
    } finally {
      restore(spies);
    }
  });

  it("reads a piped key when --bearer-key-stdin was given", async () => {
    const spies = spyAll();
    try {
      await runCommand(["mcp", "use", "tools", "--agent", agentId, "--bearer-key-stdin"]);
      expect(spies.stdin).toHaveBeenCalledOnce();
      expect(spies.use).toHaveBeenCalledWith(agentId, "tools", { kind: "bearer", bearerKey: "piped-key" });
    } finally {
      restore(spies);
    }
  });

  it("prompts when no key source was given at all", async () => {
    const spies = spyAll();
    try {
      await runCommand(["mcp", "use", "tools", "--agent", agentId]);
      expect(spies.prompt).toHaveBeenCalledOnce();
      expect(spies.use).toHaveBeenCalledWith(agentId, "tools", { kind: "bearer", bearerKey: "prompted-key" });
    } finally {
      restore(spies);
    }
  });

  it("takes the visible argument as the last resort", async () => {
    const spies = spyAll();
    try {
      await runCommand(["mcp", "use", "tools", "--agent", agentId, "--bearer-key", "argument-key"]);
      expect(spies.use).toHaveBeenCalledWith(agentId, "tools", { kind: "bearer", bearerKey: "argument-key" });
      expect(spies.prompt).not.toHaveBeenCalled();
    } finally {
      restore(spies);
    }
  });

  it("refuses an anonymous declaration that also carries a key", async () => {
    const spies = spyAll();
    try {
      const result = await runCommand([
        "mcp",
        "use",
        "tools",
        "--agent",
        agentId,
        "--kind",
        "none",
        "--bearer-key",
        "must-not-be-forwarded",
      ]);
      expect(spies.use).not.toHaveBeenCalled();
      expect(result.stderr).toContain("An anonymous authorization carries no key");
    } finally {
      restore(spies);
    }
  });

  it("refuses --kind oauth, naming the command that owns OAuth", async () => {
    const spies = spyAll();
    try {
      const result = await runCommand(["mcp", "use", "tools", "--agent", agentId, "--kind", "oauth"]);
      expect(spies.use).not.toHaveBeenCalled();
      expect(result.stderr).toContain("use `mcp authorize` to start an OAuth flow");
    } finally {
      restore(spies);
    }
  });

  it("requires --agent, because authorization is strictly per Agent", async () => {
    const spies = spyAll();
    try {
      await expect(runCommand(["mcp", "use", "tools"])).rejects.toMatchObject({
        code: "commander.missingMandatoryOptionValue",
      });
      expect(spies.use).not.toHaveBeenCalled();
    } finally {
      restore(spies);
    }
  });
});

describe("mcp authorize", () => {
  it("waits by default and asks for the scopes it was given", async () => {
    const spies = spyAll();
    try {
      await runCommand(["mcp", "authorize", "tools", "--agent", agentId, "--scopes", "read, write"]);
      expect(spies.authorize).toHaveBeenCalledWith(
        agentId,
        "tools",
        { scopes: ["read", "write"] },
        expect.objectContaining({ onStarted: expect.any(Function) }),
      );
    } finally {
      restore(spies);
    }
  });

  it("returns as soon as the URL exists with --no-wait, and asks for no scopes", async () => {
    const spies = spyAll();
    try {
      await runCommand(["mcp", "authorize", "tools", "--agent", agentId, "--no-wait"]);
      expect(spies.authorize).toHaveBeenCalledWith(
        agentId,
        "tools",
        { noWait: true },
        expect.objectContaining({ onStarted: expect.any(Function) }),
      );
    } finally {
      restore(spies);
    }
  });

  it("publishes the URL on stderr the moment it exists, so --json keeps stdout to one document", async () => {
    const spies = spyAll();
    try {
      let stdout = "";
      let stderr = "";
      const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        stdout += String(chunk);
        return true;
      });
      const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
        stderr += String(chunk);
        return true;
      });
      const previousExitCode = process.exitCode;
      process.exitCode = undefined;
      try {
        await createProgram().parseAsync([
          "node",
          "opentag",
          "mcp",
          "authorize",
          "tools",
          "--agent",
          agentId,
          "--json",
        ]);
        const onStarted = spies.authorize.mock.calls[0]?.[3]?.onStarted;
        onStarted?.({ authorizationUrl: "https://auth.example.test/authorize", expiresAt: "2030-01-01T00:10:00.000Z" });
        expect(stderr).toContain("Open this URL to authorize:");
        expect(stderr).toContain("https://auth.example.test/authorize");
        expect(() => JSON.parse(stdout)).not.toThrow();
      } finally {
        out.mockRestore();
        err.mockRestore();
        process.exitCode = previousExitCode;
      }
    } finally {
      restore(spies);
    }
  });

  it("declares an anonymous authorization with --kind none instead of starting a flow", async () => {
    const spies = spyAll();
    try {
      await runCommand(["mcp", "authorize", "tools", "--agent", agentId, "--kind", "none"]);
      expect(spies.authorize).not.toHaveBeenCalled();
      expect(spies.use).toHaveBeenCalledWith(agentId, "tools", { kind: "none" });
    } finally {
      restore(spies);
    }
  });

  it("rejects --kind bearer, naming the command that owns Bearer keys", async () => {
    const spies = spyAll();
    try {
      const result = await runCommand(["mcp", "authorize", "tools", "--agent", agentId, "--kind", "bearer"]);
      expect(spies.authorize).not.toHaveBeenCalled();
      // The message is redacted on the way out, so `Bearer key` prints as `Bearer [REDACTED]`; the
      // part that names the owning command survives intact.
      expect(result.stderr).toContain("must be oauth or none; use `mcp use` to write a Bearer");
      expect(result.exitCode).toBe(2);
    } finally {
      restore(spies);
    }
  });

  it("treats an explicit --kind oauth as the ordinary path", async () => {
    const spies = spyAll();
    try {
      await runCommand(["mcp", "authorize", "tools", "--agent", agentId, "--kind", "oauth", "--no-wait"]);
      expect(spies.authorize).toHaveBeenCalledOnce();
    } finally {
      restore(spies);
    }
  });
});

describe("mcp revoke and probe", () => {
  it("drops one Agent's credential", async () => {
    const spies = spyAll();
    try {
      await runCommand(["mcp", "revoke", "tools", "--agent", agentId]);
      expect(spies.revoke).toHaveBeenCalledWith(agentId, "tools");
    } finally {
      restore(spies);
    }
  });

  it("re-probes one Agent's credential", async () => {
    const spies = spyAll();
    try {
      const result = await runCommand(["mcp", "probe", "tools", "--agent", agentId]);
      expect(spies.probe).toHaveBeenCalledWith(agentId, "tools");
      expect(result.stdout).toContain("probeState\tsucceeded");
    } finally {
      restore(spies);
    }
  });

  it("requires --agent for both, because both are per-Agent operations", async () => {
    const spies = spyAll();
    try {
      await expect(runCommand(["mcp", "revoke", "tools"])).rejects.toMatchObject({
        code: "commander.missingMandatoryOptionValue",
      });
      await expect(runCommand(["mcp", "probe", "tools"])).rejects.toMatchObject({
        code: "commander.missingMandatoryOptionValue",
      });
    } finally {
      restore(spies);
    }
  });
});

describe("agent mcp", () => {
  it("lists one Agent's mounts", async () => {
    const spies = spyAll();
    try {
      const result = await runCommand(["agent", "mcp", "list", agentId]);
      expect(spies.agentList).toHaveBeenCalledWith(agentId);
      expect(result.stdout).toContain("NAME\tMOUNT\tAUTH KIND\tAUTH STATUS\tPROBE\tTOOLS\tEXPIRES");
    } finally {
      restore(spies);
    }
  });

  it("mounts a Server enabled unless --disabled was given", async () => {
    const spies = spyAll();
    try {
      await runCommand(["agent", "mcp", "attach", agentId, "tools"]);
      expect(spies.attach).toHaveBeenLastCalledWith(agentId, "tools", true);
      await runCommand(["agent", "mcp", "attach", agentId, "tools", "--disabled"]);
      expect(spies.attach).toHaveBeenLastCalledWith(agentId, "tools", false);
    } finally {
      restore(spies);
    }
  });

  it("reports a detach by name and Agent id", async () => {
    const spies = spyAll();
    try {
      const result = await runCommand(["agent", "mcp", "detach", agentId, "tools"]);
      expect(spies.detach).toHaveBeenCalledWith(agentId, "tools");
      expect(result.stdout).toContain(`Detached tools from Agent ${agentId}`);
    } finally {
      restore(spies);
    }
  });

  it("carries the switch direction of each generated enable/disable command", async () => {
    const spies = spyAll();
    try {
      await runCommand(["agent", "mcp", "enable", agentId, "tools"]);
      expect(spies.enable).toHaveBeenLastCalledWith(agentId, "tools", true);
      await runCommand(["agent", "mcp", "disable", agentId, "tools"]);
      expect(spies.enable).toHaveBeenLastCalledWith(agentId, "tools", false);
    } finally {
      restore(spies);
    }
  });

  it("writes an Agent's overrides, keeping inheritance and an explicit empty set apart", async () => {
    const spies = spyAll();
    try {
      await runCommand(["agent", "mcp", "config", agentId, "tools"]);
      expect(spies.config).toHaveBeenLastCalledWith(agentId, "tools", { extraHeader: [] });
      await runCommand([
        "agent",
        "mcp",
        "config",
        agentId,
        "tools",
        "--url",
        "https://agent.example.test/mcp",
        "--auth-header",
        "x-key",
        "--auth-scheme",
        "",
        "--extra-header",
        "x-tenant=private",
      ]);
      expect(spies.config).toHaveBeenLastCalledWith(agentId, "tools", {
        url: "https://agent.example.test/mcp",
        authHeader: "x-key",
        authScheme: "",
        extraHeader: ["x-tenant=private"],
      });
      await runCommand([
        "agent",
        "mcp",
        "config",
        agentId,
        "tools",
        "--clear-url",
        "--clear-auth-header",
        "--clear-auth-scheme",
        "--clear-extra-headers",
      ]);
      expect(spies.config).toHaveBeenLastCalledWith(agentId, "tools", {
        clearUrl: true,
        clearAuthHeader: true,
        clearAuthScheme: true,
        clearExtraHeaders: true,
        extraHeader: [],
      });
      await runCommand(["agent", "mcp", "config", agentId, "tools", "--empty-extra-headers"]);
      expect(spies.config).toHaveBeenLastCalledWith(agentId, "tools", { extraHeader: [], emptyExtraHeaders: true });
    } finally {
      restore(spies);
    }
  });
});
