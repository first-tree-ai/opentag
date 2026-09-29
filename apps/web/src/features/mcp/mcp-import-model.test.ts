import { MCPExtraHeadersSchema } from "@opentag/shared/browser";
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

/**
 * The end-to-end contract the shared redactor defines: a name it treats as a credential must never end
 * up in the Account-shared extra headers, in every casing and separator convention a paste may use.
 * This is the assertion an earlier round missed by exercising the predicate instead of the model.
 */
describe("no name the shared redactor treats as a credential reaches the shared headers", () => {
  const secret = "sk-end-to-end";

  const names = [
    "Authorization",
    "authorization",
    "proxy-authorization",
    "Cookie",
    "X-Client-Secret",
    "client_secret",
    "X-ClientSecret",
    "password",
    "X-Password",
    "X-Passwd",
    "X-Credential",
    "X-Credentials",
    "X-Token",
    "session_token",
    "X-Access-Token",
    "X-API-Key",
    "x-api-key",
    "X-ApiKey",
    "X-PrivateKey",
    "X-Private-Key",
    "x-privatekey",
    "X-BearerKey",
    "X-AccessKey",
    "X-RefreshKey",
    "X-Goog-Api-Key",
  ];

  it.each(names)("keeps %s out of the extra headers through the model", async (name) => {
    const outcome = await parse(
      JSON.stringify({ mcpServers: { jira: remote("https://jira.example.com/mcp", { headers: { [name]: secret } }) } }),
    );
    const entry = server(outcome, "jira");
    expect(entry.extraHeaders[Object.keys(entry.extraHeaders)[0] ?? ""]).not.toBe(secret);
    expect(JSON.stringify(entry.extraHeaders)).not.toContain(secret);
    // The value is either this Agent's credential or refused; never silently shared.
    expect(entry.credential?.token === secret || entry.refusedHeaders.includes(name.toLowerCase())).toBe(true);
    const { credential: _credential, ...shared } = entry;
    expect(JSON.stringify(shared)).not.toContain(secret);
  });

  it.each(["X-Payload", "X-Request-Body", "X-Prompt"])(
    "still shares the structural name %s, which is not a credential",
    async (name) => {
      const outcome = await parse(
        JSON.stringify({
          mcpServers: { docs: remote("https://docs.example.com/mcp", { headers: { [name]: "summary" } }) },
        }),
      );
      const entry = server(outcome, "docs");
      expect(entry.extraHeaders[name.toLowerCase()]).toBe("summary");
      expect(entry.credential).toBeUndefined();
    },
  );
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

describe("sensitive header names never reach shared configuration", () => {
  const secret = "sk-client-secret-9f3c";

  /**
   * The vocabulary is `../../observability/sensitive-names.js`, pinned to the repository redactor
   * there. These are the names a narrower allowlist used to miss.
   */
  it.each([
    "X-Client-Secret",
    "password",
    "X-Password",
    "client_secret",
    "x-refresh-token",
    "Cookie",
    "x-goog-api-key",
    "X-Credential",
    "X-Private-Key",
    "X-Bearer-Key",
    "X-Access-Key",
    "X-Refresh-Key",
    "X-Passwd",
    "X-ClientSecret",
  ])("treats %s as a credential rather than shared configuration", async (name) => {
    const outcome = await parse(
      JSON.stringify({ mcpServers: { jira: remote("https://jira.example.com/mcp", { headers: { [name]: secret } }) } }),
    );
    const entry = server(outcome, "jira");
    expect(entry.extraHeaders).toEqual({});
    expect(entry.credential?.token).toBe(secret);
    expect(JSON.stringify(entry.extraHeaders)).not.toContain(secret);
  });

  it("shares a structural name that is not a credential", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: { docs: remote("https://docs.example.com/mcp", { headers: { "X-Payload": "summary" } }) },
      }),
    );
    expect(server(outcome, "docs").extraHeaders).toEqual({ "x-payload": "summary" });
  });

  /**
   * HTTP header names are case-insensitive, so a paste may write `X-PrivateKey` and the caller
   * lowercases it before storage. Classification has to happen on a name that may already have lost
   * its case boundary, which is exactly what a lowercased-only predicate misses.
   */
  it.each(["X-PrivateKey", "X-BearerKey", "X-AccessKey", "X-RefreshKey", "x-privatekey", "XClientSecret"])(
    "treats the separatorless spelling %s as a credential through the model",
    async (name) => {
      const outcome = await parse(
        JSON.stringify({
          mcpServers: { jira: remote("https://jira.example.com/mcp", { headers: { [name]: secret } }) },
        }),
      );
      const entry = server(outcome, "jira");
      expect(entry.extraHeaders).toEqual({});
      expect(entry.credential?.token).toBe(secret);
      expect(entry.credential?.header).toBe(name.toLowerCase());
      expect(JSON.stringify(entry.extraHeaders)).not.toContain(secret);
    },
  );

  it("prefers the authorization header when several credential names are present", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: {
          jira: remote("https://jira.example.com/mcp", {
            headers: {
              "X-Token-Issuer": "https://issuer.example.com",
              Authorization: `Bearer ${secret}`,
            },
          }),
        },
      }),
    );
    const entry = server(outcome, "jira");
    expect(entry.credential).toEqual({ header: "authorization", scheme: "Bearer", token: secret });
    // The other credential-shaped name is refused rather than shared, even though its value is a URL.
    expect(entry.refusedHeaders).toEqual(["x-token-issuer"]);
    expect(entry.extraHeaders).toEqual({});
  });

  it("shares a non-secret header while the secret becomes this Agent's credential", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: {
          jira: remote("https://jira.example.com/mcp", {
            headers: { "X-Workspace-Id": "design", "X-Client-Secret": secret },
          }),
        },
      }),
    );
    const entry = server(outcome, "jira");
    expect(entry.credential).toEqual({ header: "x-client-secret", scheme: "", token: secret });
    expect(entry.extraHeaders).toEqual({ "x-workspace-id": "design" });
    expect(JSON.stringify(entry.extraHeaders)).not.toContain(secret);
  });

  it("keeps only the first credential and refuses the rest by name", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: {
          jira: remote("https://jira.example.com/mcp", {
            headers: {
              Authorization: `Bearer ${secret}`,
              "X-Client-Secret": "second-secret",
              Password: "third-secret",
            },
          }),
        },
      }),
    );
    const entry = server(outcome, "jira");
    expect(entry.credential).toEqual({ header: "authorization", scheme: "Bearer", token: secret });
    expect(entry.refusedHeaders).toEqual(["x-client-secret", "password"]);
    expect(entry.extraHeaders).toEqual({});
    expect(JSON.stringify(entry)).not.toContain("second-secret");
    expect(JSON.stringify(entry)).not.toContain("third-secret");
  });
});

describe("the shared extra-header bounds are enforced on the accumulated set", () => {
  const manyHeaders = (count: number, size: number) => {
    const headers: Record<string, string> = {};
    for (let index = 0; index < count; index++) headers[`x-h${index}`] = "a".repeat(size);
    return headers;
  };

  it("refuses the header that crosses the aggregate byte bound", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: { jira: remote("https://jira.example.com/mcp", { headers: manyHeaders(16, 600) }) },
      }),
    );
    expect(outcome.kind).toBe("parsed");
    const entry = server(outcome, "jira");
    expect(entry.refusedHeaders.length).toBeGreaterThan(0);
    expect(Object.keys(entry.extraHeaders).length + entry.refusedHeaders.length).toBe(16);
    // What the dialog would send must satisfy the shared schema, or the submit stays disabled later.
    expect(MCPExtraHeadersSchema.safeParse(entry.extraHeaders).success).toBe(true);
  });

  it("refuses headers past the shared count bound", async () => {
    const outcome = await parse(
      JSON.stringify({
        mcpServers: { jira: remote("https://jira.example.com/mcp", { headers: manyHeaders(20, 4) }) },
      }),
    );
    const entry = server(outcome, "jira");
    expect(Object.keys(entry.extraHeaders)).toHaveLength(16);
    expect(entry.refusedHeaders).toHaveLength(4);
    expect(MCPExtraHeadersSchema.safeParse(entry.extraHeaders).success).toBe(true);
  });
});

describe("a rejected URL keeps no credential", () => {
  const embedded = "secret-marker-754";

  it("drops userinfo from the URL it stores and renders", async () => {
    const outcome = await parse(
      JSON.stringify({ mcpServers: { bad: remote(`https://user:${embedded}@example.com/mcp`) } }),
    );
    expect(outcome.kind).toBe("invalid-url");
    expect(server(outcome, "bad")).toMatchObject({ reason: "invalid-url", url: "https://example.com/mcp" });
    expect(JSON.stringify(outcome)).not.toContain(embedded);
  });

  it("drops userinfo from a URL no parser can read", async () => {
    const outcome = await parse(JSON.stringify({ mcpServers: { bad: remote(`//user:${embedded}@example.com/mcp`) } }));
    expect(server(outcome, "bad").reason).toBe("invalid-url");
    expect(JSON.stringify(outcome)).not.toContain(embedded);
  });
});

describe("Codex static headers", () => {
  const inline = [
    "[mcp_servers.docs]",
    'url = "https://docs.example.com/mcp"',
    'http_headers = { Authorization = "Bearer sk-docs" }',
  ].join("\n");

  it("reads an http_headers inline table", async () => {
    const outcome = await parse(inline);
    expect(server(outcome, "docs").credential).toEqual({ header: "authorization", scheme: "Bearer", token: "sk-docs" });
  });

  it("reads a nested http_headers table", async () => {
    const outcome = await parse(
      [
        "[mcp_servers.docs]",
        'url = "https://docs.example.com/mcp"',
        "[mcp_servers.docs.http_headers]",
        'X-Workspace-Id = "design"',
      ].join("\n"),
    );
    const entry = server(outcome, "docs");
    expect(entry.extraHeaders).toEqual({ "x-workspace-id": "design" });
    expect(entry.credential).toBeUndefined();
  });

  it("never reads an environment variable name as a header value", async () => {
    const outcome = await parse(
      [
        "[mcp_servers.docs]",
        'url = "https://docs.example.com/mcp"',
        'env_http_headers = { Authorization = "DOCS_TOKEN" }',
      ].join("\n"),
    );
    const entry = server(outcome, "docs");
    expect(entry.credential).toBeUndefined();
    expect(entry.refusedHeaders).toEqual(["authorization"]);
    expect(entry.extraHeaders).toEqual({});
    expect(JSON.stringify(outcome)).not.toContain("DOCS_TOKEN");
  });

  it("refuses an environment-backed header instead of sharing an empty one", async () => {
    const outcome = await parse(
      [
        "[mcp_servers.docs]",
        'url = "https://docs.example.com/mcp"',
        'env_http_headers = { "X-Workspace-Id" = "WORKSPACE_ID" }',
      ].join("\n"),
    );
    const entry = server(outcome, "docs");
    // A real shared header with an empty value is not an import of anything.
    expect(entry.extraHeaders).toEqual({});
    expect(entry.refusedHeaders).toEqual(["x-workspace-id"]);
    expect(JSON.stringify(outcome)).not.toContain("WORKSPACE_ID");
  });

  it("does not let an environment-backed name overwrite a literal header of the same name", async () => {
    const outcome = await parse(
      [
        "[mcp_servers.docs]",
        'url = "https://docs.example.com/mcp"',
        'http_headers = { "X-Workspace-Id" = "design" }',
        'env_http_headers = { "X-Workspace-Id" = "WORKSPACE_ID" }',
      ].join("\n"),
    );
    const entry = server(outcome, "docs");
    // The declaration cannot be resolved, so neither value is sent and the name is reported once.
    expect(entry.extraHeaders).toEqual({});
    expect(entry.refusedHeaders).toEqual(["x-workspace-id"]);
  });

  /**
   * A name the paste declares through an environment variable declares no value, so it is not a
   * candidate credential: the literal twin must not be saved as one, which is what choosing before
   * filtering unresolved names would do.
   */
  it("does not save a credential the paste declares through an environment variable", async () => {
    const outcome = await parse(
      [
        "[mcp_servers.docs]",
        'url = "https://docs.example.com/mcp"',
        'http_headers = { Authorization = "Bearer literal-secret" }',
        'env_http_headers = { Authorization = "DOCS_TOKEN" }',
      ].join("\n"),
    );
    const entry = server(outcome, "docs");
    expect(entry.credential).toBeUndefined();
    expect(entry.extraHeaders).toEqual({});
    expect(entry.refusedHeaders).toEqual(["authorization"]);
    expect(JSON.stringify(outcome)).not.toContain("literal-secret");
  });

  it("does not save a custom credential name declared through an environment variable", async () => {
    const outcome = await parse(
      [
        "[mcp_servers.docs]",
        'url = "https://docs.example.com/mcp"',
        'http_headers = { "X-PrivateKey" = "literal-secret" }',
        'env_http_headers = { "X-PrivateKey" = "DOCS_KEY" }',
      ].join("\n"),
    );
    const entry = server(outcome, "docs");
    expect(entry.credential).toBeUndefined();
    expect(entry.extraHeaders).toEqual({});
    expect(entry.refusedHeaders).toEqual(["x-privatekey"]);
    expect(JSON.stringify(outcome)).not.toContain("literal-secret");
  });
});
