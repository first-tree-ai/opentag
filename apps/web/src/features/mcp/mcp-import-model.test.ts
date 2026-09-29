import { describe, expect, it } from "vitest";
import {
  MCP_IMPORT_MAX_PASTE_BYTES,
  type MCPImportOutcome,
  type MCPImportServer,
  normalizeImportName,
  parseMcpImport,
} from "./mcp-import-model.js";

const parse = (text: string, takenNames: readonly string[] = []) => parseMcpImport({ text, takenNames });

function server(outcome: MCPImportOutcome, sourceName: string): MCPImportServer {
  const found = outcome.servers.find((entry) => entry.sourceName === sourceName);
  if (!found) throw new Error(`Missing detected server ${sourceName}`);
  return found;
}

const remote = (url: string, extra: Record<string, unknown> = {}) => ({
  type: "http",
  url,
  ...extra,
});

describe("paste bound", () => {
  it("refuses a paste over the byte bound before any parser sees it", async () => {
    // Unparseable content proves the bound short-circuits: text this long would otherwise be reported
    // as unparseable, never as too large.
    const outcome = await parse("x".repeat(MCP_IMPORT_MAX_PASTE_BYTES + 1));
    expect(outcome.kind).toBe("too-large");
    expect(outcome.servers).toEqual([]);
  });

  it("counts the bound in UTF-8 bytes rather than code units", async () => {
    const outcome = await parse("é".repeat(MCP_IMPORT_MAX_PASTE_BYTES / 2 + 1));
    expect(outcome.kind).toBe("too-large");
  });

  it("treats an empty paste as unparseable", async () => {
    expect((await parse("   \n ")).kind).toBe("unparseable");
  });
});

describe("recognized configuration shapes", () => {
  it("reads an OpenCode-style mcp fragment with a remote type", async () => {
    const outcome = await parse(
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: true } },
      }),
    );
    expect(outcome.kind).toBe("parsed");
    expect(server(outcome, "jira")).toMatchObject({
      name: "jira",
      transport: "remote",
      url: "https://jira.example.com/mcp",
    });
  });

  it("reads an mcpServers fragment with an http type", async () => {
    const outcome = await parse(
      JSON.stringify({ mcpServers: { nevent: { type: "http", url: "https://mcp.nevent.ai" } } }),
    );
    expect(outcome.kind).toBe("parsed");
    expect(server(outcome, "nevent")).toMatchObject({ name: "nevent", url: "https://mcp.nevent.ai" });
  });

  it("reads a servers fragment with an http type", async () => {
    const outcome = await parse(
      JSON.stringify({ servers: { nevent: { type: "http", url: "https://mcp.nevent.ai" } } }),
    );
    expect(outcome.kind).toBe("parsed");
    expect(server(outcome, "nevent").url).toBe("https://mcp.nevent.ai");
  });

  it("reads the same key shapes from YAML", async () => {
    const outcome = await parse(
      ["mcpServers:", "  nevent:", "    type: http", "    url: https://mcp.nevent.ai"].join("\n"),
    );
    expect(outcome.kind).toBe("parsed");
    expect(server(outcome, "nevent").url).toBe("https://mcp.nevent.ai");
  });

  it("reads a YAML mcp block with a remote type", async () => {
    const outcome = await parse(
      ["mcp:", "  jira:", "    type: remote", "    url: https://jira.example.com/mcp"].join("\n"),
    );
    expect(outcome.kind).toBe("parsed");
    expect(server(outcome, "jira").url).toBe("https://jira.example.com/mcp");
  });

  it("reads a TOML mcp_servers table", async () => {
    const outcome = await parse(
      [
        "[mcp_servers.remote_search]",
        'url = "https://example.com"',
        "# Optional: specify custom timeouts or enable flags if needed",
        "enabled = true",
        "startup_timeout = 10",
      ].join("\n"),
    );
    expect(outcome.kind).toBe("parsed");
    expect(server(outcome, "remote_search")).toMatchObject({
      name: "remote-search",
      url: "https://example.com",
    });
  });

  it("reads a commented JSON document with a trailing comma", async () => {
    const outcome = await parse(
      [
        "{",
        "  // The Jira server the team uses.",
        '  "mcpServers": {',
        '    "jira": { "type": "http", "url": "https://jira.example.com/mcp" },',
        "  },",
        "}",
      ].join("\n"),
    );
    expect(outcome.kind).toBe("parsed");
    expect(server(outcome, "jira").url).toBe("https://jira.example.com/mcp");
  });

  it("keeps a URL inside a comment from being read as a server", async () => {
    const outcome = await parse('{ // https://jira.example.com/mcp\n  "permissions": {}\n}');
    expect(outcome.kind).toBe("no-servers");
  });

  it("reports text no reader parses, including a broken JSON fragment", async () => {
    expect((await parse("{{ this is not json or yaml")).kind).toBe("unparseable");
    expect((await parse("@@@ not a configuration @@@")).kind).toBe("unparseable");
  });

  it("reports a valid document that carries no server entry", async () => {
    expect((await parse('{"permissions": {"allow": []}}')).kind).toBe("no-servers");
    expect((await parse("theme: dark\n")).kind).toBe("no-servers");
    expect((await parse('{"mcpServers": {}}')).kind).toBe("no-servers");
  });
});

describe("CLI commands", () => {
  it("reads a Claude Code http command", async () => {
    const outcome = await parse("claude mcp add nevent --transport http https://mcp.nevent.ai");
    expect(outcome.kind).toBe("parsed");
    expect(server(outcome, "nevent")).toMatchObject({ name: "nevent", url: "https://mcp.nevent.ai" });
  });

  it("reads a Codex command with --url", async () => {
    const outcome = await parse("codex mcp add nevent --url https://mcp.nevent.ai");
    expect(outcome.kind).toBe("parsed");
    expect(server(outcome, "nevent").url).toBe("https://mcp.nevent.ai");
  });

  it("reads the short transport flag and header options", async () => {
    const outcome = await parse(
      'claude mcp add nevent -t http https://mcp.nevent.ai --header "X-Workspace-Id: design" -H "Authorization: Bearer sk-live-1"',
    );
    const entry = server(outcome, "nevent");
    expect(entry.extraHeaders).toEqual({ "x-workspace-id": "design" });
    expect(entry.credential).toMatchObject({ header: "authorization", scheme: "Bearer", token: "sk-live-1" });
  });

  it("ignores environment options instead of reading them as a URL", async () => {
    const outcome = await parse(
      "codex mcp add nevent --url https://mcp.nevent.ai --env API_KEY=abcdef https://ignored.example.com/mcp",
    );
    expect(server(outcome, "nevent").url).toBe("https://mcp.nevent.ai");
  });

  it("classifies a stdio command instead of failing to parse it", async () => {
    const outcome = await parse(
      "claude mcp add local-tools --transport stdio -- npx -y @modelcontextprotocol/server-everything",
    );
    expect(outcome.kind).toBe("unsupported-only");
    expect(server(outcome, "local-tools")).toMatchObject({ transport: "local", reason: "local-transport" });
  });

  it("classifies a bare stdio command with no transport flag", async () => {
    const outcome = await parse("claude mcp add filesystem npx -y @modelcontextprotocol/server-filesystem /tmp");
    expect(server(outcome, "filesystem")).toMatchObject({ transport: "local", reason: "local-transport" });
  });

  it("treats a command with a URL argument as local", async () => {
    const outcome = await parse("claude mcp add proxied npx -y mcp-remote https://example.com/mcp");
    expect(server(outcome, "proxied")).toMatchObject({ transport: "local", reason: "local-transport" });
    expect(server(outcome, "proxied").url).toBeUndefined();
  });
});

describe("local transports", () => {
  it("reads the repeated command form as local", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: {
          everything: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-everything"],
            env: { LOG_LEVEL: "info" },
          },
        },
      }),
    );
    expect(outcome.kind).toBe("unsupported-only");
    expect(server(outcome, "everything").reason).toBe("local-transport");
  });

  it("keeps an HTTPS URL in a command's arguments from making it remote", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: {
          proxied: { command: "npx", args: ["-y", "mcp-remote", "https://example.com/mcp"] },
        },
      }),
    );
    expect(outcome.kind).toBe("unsupported-only");
    expect(server(outcome, "proxied")).toMatchObject({ transport: "local", reason: "local-transport" });
    expect(server(outcome, "proxied").url).toBeUndefined();
  });

  it("reports a local type label even when a URL is present", async () => {
    const outcome = await parse(
      JSON.stringify({ mcp: { helper: { type: "local", url: "https://example.com/mcp", command: "node" } } }),
    );
    expect(server(outcome, "helper")).toMatchObject({ transport: "local", reason: "local-transport" });
  });

  it("lists a local entry beside a remote one in a mixed paste", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: {
          linear: remote("https://mcp.linear.app/mcp"),
          everything: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
        },
      }),
    );
    expect(outcome.kind).toBe("parsed");
    expect(server(outcome, "linear").transport).toBe("remote");
    expect(server(outcome, "everything")).toMatchObject({ transport: "local", reason: "local-transport" });
  });

  it("reports an entry that is neither a URL nor a recognizable command", async () => {
    const outcome = await parse(JSON.stringify({ mcpServers: { mystery: { enabled: false } } }));
    expect(outcome.kind).toBe("unsupported-only");
    expect(server(outcome, "mystery")).toMatchObject({ transport: "unrecognized", reason: "unrecognized" });
  });
});

describe("names", () => {
  it("normalizes dialect keys into OpenTag names", async () => {
    expect(normalizeImportName("remote_search")).toBe("remote-search");
    expect(normalizeImportName("My Server")).toBe("my-server");
    expect(normalizeImportName("Nevent")).toBe("nevent");
    expect(normalizeImportName("!!!")).toBe("");
  });

  it("normalizes the name a paste carries", async () => {
    const outcome = await parse(JSON.stringify({ mcpServers: { My_Server: remote("https://example.com/mcp") } }));
    expect(server(outcome, "My_Server").name).toBe("my-server");
  });

  it("falls back to the host when the key carries nothing usable", async () => {
    const outcome = await parse(JSON.stringify({ mcpServers: { "!!!": remote("https://mcp.nevent.ai/mcp") } }));
    expect(server(outcome, "!!!").name).toBe("nevent");
  });

  it("avoids a name already used in the Account", async () => {
    const outcome = await parse(JSON.stringify({ mcpServers: { nevent: remote("https://mcp.nevent.ai") } }), [
      "nevent",
    ]);
    expect(server(outcome, "nevent").name).toBe("nevent-2");
  });

  it("avoids a collision between two entries of one paste", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: { nevent: remote("https://a.example.com/mcp"), Nevent: remote("https://b.example.com/mcp") },
      }),
    );
    expect(server(outcome, "nevent").name).toBe("nevent");
    expect(server(outcome, "Nevent").name).toBe("nevent-2");
  });

  it("does not let a refused entry consume a name", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: { helper: { command: "node", args: ["server.js"] }, Helper: remote("https://example.com/mcp") },
      }),
    );
    expect(server(outcome, "Helper").name).toBe("helper");
  });
});

describe("URL validation", () => {
  it("accepts http and https", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: {
          secure: remote("https://example.com/mcp"),
          plain: remote("http://example.com/mcp"),
        },
      }),
    );
    expect(outcome.kind).toBe("parsed");
    expect(server(outcome, "plain").reason).toBeUndefined();
  });

  it("refuses a non-HTTP scheme", async () => {
    const outcome = await parse(JSON.stringify({ mcpServers: { bad: remote("ftp://example.com") } }));
    expect(outcome.kind).toBe("invalid-url");
    expect(server(outcome, "bad")).toMatchObject({ reason: "invalid-url", url: "ftp://example.com" });
  });

  it("refuses embedded credentials", async () => {
    const outcome = await parse(JSON.stringify({ mcpServers: { bad: remote("https://user:secret@example.com/mcp") } }));
    expect(outcome.kind).toBe("invalid-url");
    expect(server(outcome, "bad").reason).toBe("invalid-url");
  });

  it("refuses a fragment", async () => {
    const outcome = await parse(JSON.stringify({ mcpServers: { bad: remote("https://example.com/mcp#frag") } }));
    expect(outcome.kind).toBe("invalid-url");
    expect(server(outcome, "bad").reason).toBe("invalid-url");
  });

  it("keeps a valid entry importable when a sibling has a bad URL", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: { good: remote("https://example.com/mcp"), bad: remote("ftp://example.com") },
      }),
    );
    expect(outcome.kind).toBe("parsed");
    expect(server(outcome, "bad").reason).toBe("invalid-url");
  });
});

describe("headers and credentials", () => {
  it("maps an Authorization bearer header to this Agent's credential", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: { jira: remote("https://jira.example.com/mcp", { headers: { Authorization: "Bearer sk-team" } }) },
      }),
    );
    const entry = server(outcome, "jira");
    expect(entry.credential).toEqual({ header: "authorization", scheme: "Bearer", token: "sk-team" });
    expect(entry.extraHeaders).toEqual({});
  });

  it("sends a custom credential header verbatim", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: { jira: remote("https://jira.example.com/mcp", { headers: { "X-API-Key": "sk-team" } }) },
      }),
    );
    expect(server(outcome, "jira").credential).toEqual({ header: "x-api-key", scheme: "", token: "sk-team" });
  });

  it("keeps a non-credential header as an extra header, lowercased", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: { jira: remote("https://jira.example.com/mcp", { headers: { "X-Workspace-Id": "design" } }) },
      }),
    );
    const entry = server(outcome, "jira");
    expect(entry.extraHeaders).toEqual({ "x-workspace-id": "design" });
    expect(entry.credential).toBeUndefined();
  });

  it("reads header lines given as an array", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: { jira: remote("https://jira.example.com/mcp", { headers: ["X-Workspace-Id: design"] }) },
      }),
    );
    expect(server(outcome, "jira").extraHeaders).toEqual({ "x-workspace-id": "design" });
  });

  it("refuses a transport-owned header by name and keeps the rest", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: {
          jira: remote("https://jira.example.com/mcp", {
            headers: { "Content-Type": "application/json", "Mcp-Session-Id": "abc", "X-Workspace-Id": "design" },
          }),
        },
      }),
    );
    const entry = server(outcome, "jira");
    expect(entry.refusedHeaders).toEqual(["content-type", "mcp-session-id"]);
    expect(entry.extraHeaders).toEqual({ "x-workspace-id": "design" });
  });

  it("refuses a second credential-shaped header rather than sharing it", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: {
          jira: remote("https://jira.example.com/mcp", {
            headers: { Authorization: "Bearer sk-team", "X-API-Key": "sk-second" },
          }),
        },
      }),
    );
    const entry = server(outcome, "jira");
    expect(entry.credential).toMatchObject({ token: "sk-team" });
    expect(entry.refusedHeaders).toEqual(["x-api-key"]);
    expect(entry.extraHeaders).toEqual({});
  });

  it("carries no credential for an entry that cannot be imported", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: { bad: remote("ftp://example.com", { headers: { Authorization: "Bearer sk-team" } }) },
      }),
    );
    expect(server(outcome, "bad").credential).toBeUndefined();
  });
});

describe("credentials stay out of messages", () => {
  const token = "sk-do-not-echo-gfhnj2rr";

  it("returns no trace of a token that could not be attached to an import", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: {
          bad: remote("ftp://example.com", { headers: { Authorization: `Bearer ${token}` } }),
          proxied: { command: "npx", args: ["-y", "mcp-remote", `https://example.com/${token}`] },
        },
      }),
    );
    expect(outcome.kind).toBe("unsupported-only");
    expect(JSON.stringify(outcome)).not.toContain(token);
    expect(JSON.stringify(outcome)).not.toContain("do-not-echo");
  });

  it("exposes a token only on the credential field", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: {
          nevent: remote("https://mcp.nevent.ai", { headers: { Authorization: `Bearer ${token}` } }),
        },
      }),
    );
    const entry = server(outcome, "nevent");
    expect(entry.credential?.token).toBe(token);
    const { credential: _credential, ...rest } = entry;
    expect(JSON.stringify(rest)).not.toContain(token);
    expect(JSON.stringify(rest)).not.toContain("do-not-echo");
  });
});
