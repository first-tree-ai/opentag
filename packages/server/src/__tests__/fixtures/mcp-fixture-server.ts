import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local MCP Server that is also the authorization server for it.
 *
 * Everything binds to `127.0.0.1` on an ephemeral port and no test reaches the public network. The
 * fixture records every request it receives — method, headers, and body — because the headers a
 * request arrived with are the only ground truth for whether the authorization header construction
 * is right.
 *
 * It can be told to answer with redirected URLs, so the discovery chain's SSRF policy can be
 * exercised against a peer that genuinely tries to send this deployment somewhere private.
 */

export interface RecordedRequest {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  method: string;
  url: string;
}

export interface McpFixtureToolsPage {
  nextCursor?: string;
  tools: { description?: string; inputSchema?: unknown; name: string }[];
}

export interface McpFixtureOptions {
  /** What the Server advertises this client may do; a `tools` key makes the probe fetch tools. */
  capabilities?: Record<string, unknown>;
  /** When set, `server/discover` answers `404` with a non-modern body so the client downgrades. */
  legacy?: boolean;
  /** The `WWW-Authenticate` challenge. Defaults to a challenge naming this fixture's PRM document. */
  challenge?: (self: string) => string;
  /** The Protected Resource Metadata document; `authorization_servers` is the interesting field. */
  protectedResourceMetadata?: (self: string) => Record<string, unknown>;
  /** The Authorization Server metadata document. */
  authorizationServerMetadata?: (self: string) => Record<string, unknown>;
  /** Reject any request that does not carry this exact header pair. */
  requireHeader?: { name: string; value: string };
  /** The tool pages, served in order while `nextCursor` keeps the client paginating. */
  toolPages?: McpFixtureToolsPage[];
  /** Answer the token endpoint with this error code, for the refresh failure classification. */
  tokenError?: string;
  /** The `iss` value the authorize redirect carries; `undefined` omits it. */
  issuerParameter?: string;
  /** Answer the authorize endpoint with `error=access_denied` instead of a code. */
  denyAuthorization?: boolean;
  /**
   * The `serverInfo.description` this fixture publishes, in both the modern `_meta` slot and the
   * legacy `initialize` result.
   *
   * Optional and omitted by default, because the specification makes it optional: a test that wants
   * "the Server described itself" has to ask for it, and the default keeps the shape every other
   * test already relies on.
   */
  serverDescription?: string;
}

/**
 * The fixture, started on a loopback port. Every URL it publishes points at itself, so the tests
 * exercise the real discovery order without any external dependency.
 */
export class McpFixtureServer {
  readonly #options: McpFixtureOptions;
  readonly #requests: RecordedRequest[] = [];
  #authorizationServer = "";
  #code: string | undefined;
  #pkceChallenge: string | undefined;
  #server: Server | undefined;
  #tokensIssued = 0;
  #tokenError: string | undefined;

  constructor(options: McpFixtureOptions = {}) {
    this.#options = options;
    this.#tokenError = options.tokenError;
  }

  /**
   * Make the token endpoint start refusing, without restarting the fixture.
   *
   * Restarting would move the port, and the port is part of the authorization row's AAD — a changed
   * issuer legitimately invalidates the stored envelope, which is a different property than the one
   * under test here. Switching the behaviour in place keeps the issuer stable.
   */
  failTokenEndpoint(error: string | undefined): void {
    this.#tokenError = error;
  }

  static async start(options: McpFixtureOptions = {}): Promise<McpFixtureServer> {
    const fixture = new McpFixtureServer(options);
    await fixture.#listen();
    return fixture;
  }

  /**
   * The `serverInfo` both eras publish. One builder rather than two literals, so the modern and
   * legacy paths cannot drift into describing two different Servers.
   */
  #serverInfo(): Record<string, unknown> {
    const { serverDescription } = this.#options;
    return {
      name: "fixture",
      version: "1.0.0",
      ...(serverDescription === undefined ? {} : { description: serverDescription }),
    };
  }

  get endpoint(): string {
    return `${this.#authorizationServer}/mcp`;
  }

  /** The recorded requests, oldest first. */
  get requests(): readonly RecordedRequest[] {
    return this.#requests;
  }

  /** How many times the token endpoint has issued an access token, for the refresh assertions. */
  get tokensIssued(): number {
    return this.#tokensIssued;
  }

  /** Requests whose `Mcp-Method` header names the given method. */
  requestsFor(method: string): RecordedRequest[] {
    return this.#requests.filter((request) => request.headers["mcp-method"] === method);
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async #listen(): Promise<void> {
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "fixture_failure" }));
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    const address = this.#server.address() as AddressInfo;
    this.#authorizationServer = `http://127.0.0.1:${address.port}`;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    const url = request.url ?? "/";
    this.#requests.push({ body, headers: request.headers, method: request.method ?? "GET", url });

    if (this.#credentialRefused(request)) {
      this.#unauthorized(response);
      return;
    }
    if (this.#route(response, url, body)) return;

    this.#unauthorized(response);
  }

  /** Whether this request must be refused for a missing or wrong required header. */
  #credentialRefused(request: IncomingMessage): boolean {
    const required = this.#options.requireHeader;
    if (!required) return false;
    return request.headers[required.name] !== required.value;
  }

  /**
   * The 401 challenge. It is also how a probe learns the credential is wrong, and it names the
   * protected resource metadata document the way a real Server does.
   */
  #unauthorized(response: ServerResponse): void {
    response.writeHead(401, { "content-type": "application/json", "www-authenticate": this.#challenge() });
    response.end(JSON.stringify({ error: "unauthorized" }));
  }

  /** Returns true when this URL belonged to a fixture route and a response was sent. */
  #route(response: ServerResponse, url: string, body: unknown): boolean {
    if (url.startsWith("/.well-known/oauth-protected-resource")) {
      json(response, 200, this.#protectedResourceMetadata());
      return true;
    }
    if (url.startsWith("/.well-known/")) {
      json(response, 200, this.#authorizationServerDoc());
      return true;
    }
    if (url === "/register") {
      json(response, 200, { client_id: "fixture-client", client_secret: "fixture-secret" });
      return true;
    }
    if (url.startsWith("/authorize")) {
      this.#authorize(response, url);
      return true;
    }
    if (url === "/token") {
      this.#token(response, body);
      return true;
    }
    if (url === "/mcp" || url.startsWith("/mcp?")) {
      this.#mcp(response, body);
      return true;
    }
    return false;
  }

  #challenge(): string {
    if (this.#options.challenge) return this.#options.challenge(this.#authorizationServer);
    return `Bearer resource_metadata="${this.#authorizationServer}/.well-known/oauth-protected-resource/mcp", scope="mcp.read"`;
  }

  #protectedResourceMetadata(): Record<string, unknown> {
    if (this.#options.protectedResourceMetadata)
      return this.#options.protectedResourceMetadata(this.#authorizationServer);
    return {
      resource: `${this.#authorizationServer}/mcp`,
      authorization_servers: [this.#authorizationServer],
      scopes_supported: ["mcp.read", "mcp.write"],
    };
  }

  #authorizationServerDoc(): Record<string, unknown> {
    if (this.#options.authorizationServerMetadata) {
      return this.#options.authorizationServerMetadata(this.#authorizationServer);
    }
    return {
      issuer: this.#authorizationServer,
      authorization_endpoint: `${this.#authorizationServer}/authorize`,
      token_endpoint: `${this.#authorizationServer}/token`,
      registration_endpoint: `${this.#authorizationServer}/register`,
      scopes_supported: ["mcp.read", "mcp.write"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  #authorize(response: ServerResponse, url: string): void {
    const params = new URL(url, this.#authorizationServer).searchParams;
    const state = params.get("state") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    this.#pkceChallenge = params.get("code_challenge") ?? undefined;
    if (this.#options.denyAuthorization) {
      response.writeHead(302, { location: `${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}` });
      response.end();
      return;
    }
    this.#code = `code-${++this.#tokensIssued}`;
    // No UI: the fixture approves immediately, which is what makes the callback path testable.
    const target = new URL(redirectUri);
    target.searchParams.set("code", this.#code);
    target.searchParams.set("state", state);
    if (this.#options.issuerParameter !== undefined) target.searchParams.set("iss", this.#options.issuerParameter);
    else target.searchParams.set("iss", this.#authorizationServer);
    response.writeHead(302, { location: target.toString() });
    response.end();
  }

  #token(response: ServerResponse, body: unknown): void {
    if (this.#tokenError) {
      json(response, 400, { error: this.#tokenError });
      return;
    }
    const params = new URLSearchParams(typeof body === "string" ? body : "");
    const grant = params.get("grant_type");
    if (grant === "authorization_code") {
      // Verify the PKCE challenge the authorize request recorded, so the round trip is genuinely
      // checked rather than assumed.
      const verifier = params.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (this.#pkceChallenge && challenge !== this.#pkceChallenge) {
        json(response, 400, { error: "invalid_grant" });
        return;
      }
      this.#code = undefined;
    }
    this.#tokensIssued += 1;
    json(response, 200, {
      access_token: `at_${this.#tokensIssued}`,
      refresh_token: `rt_${this.#tokensIssued}`,
      expires_in: 3600,
      scope: "mcp.read",
      token_type: "Bearer",
    });
  }

  #mcp(response: ServerResponse, body: unknown): void {
    const request = body as { id?: unknown; method?: string; params?: { cursor?: string } };
    const method = request.method ?? "";
    if (method === "server/discover") {
      if (this.#options.legacy) {
        // A pre-modern Server answers a method it does not know with a non-modern body.
        response.writeHead(404, { "content-type": "text/html" });
        response.end("<html>Not Found</html>");
        return;
      }
      rpc(response, request.id, {
        capabilities: this.#options.capabilities ?? { tools: {} },
        instructions: "Fixture instructions.",
        _meta: { "io.modelcontextprotocol/serverInfo": this.#serverInfo() },
      });
      return;
    }
    if (method === "initialize") {
      rpc(response, request.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: this.#serverInfo(),
      });
      return;
    }
    if (method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    if (method === "tools/list") {
      const pages = this.#options.toolPages ?? [{ tools: [{ name: "echo" }] }];
      const index = request.params?.cursor ? Number(request.params.cursor.replace("page-", "")) : 0;
      const page = pages[index] ?? { tools: [] };
      rpc(response, request.id, {
        tools: page.tools,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "no method" } }));
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? safeJson(raw) : undefined;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function rpc(response: ServerResponse, id: unknown, result: unknown): void {
  json(response, 200, { jsonrpc: "2.0", id: id ?? "1", result });
}
