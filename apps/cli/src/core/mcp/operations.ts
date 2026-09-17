import type {
  CreateMCPServerRequest,
  MCPAuthKind,
  MCPProbeResponse,
  MCPServer,
  MCPServerDetail,
  SetMCPAuthorizationRequest,
  StartMCPOAuthResponse,
  UpdateMCPBindingRequest,
  UpdateMCPServerRequest,
} from "@opentag/shared";
import { extraHeadersFrom, type McpCommandDependencies, resolveMcpCommandContext, resolveMcpServer } from "./shared.js";

/**
 * The MCP operations the CLI performs, each a thin call over the management API.
 *
 * Two rules are enforced here rather than left to the caller:
 *
 * - A bearer key is never accepted as a positional argument by default. `--bearer-key` exists for
 *   scripts that have no other choice, but the documented paths are `--bearer-key-stdin` and the
 *   hidden interactive prompt, because a command-line argument lands in shell history and in `ps`.
 * - "Restore inheritance" and "override with nothing" are separate actions for the extra headers, so
 *   a user can drop the shared `x-workspace-id` for one Agent without deleting it for everyone.
 */

export interface McpCreateOptions {
  name: string;
  url: string;
  defaultAuthKind?: MCPAuthKind;
  authHeader?: string;
  authScheme?: string;
  extraHeader?: string[];
}

export async function runMcpCreate(
  options: McpCreateOptions,
  dependencies: McpCommandDependencies = {},
): Promise<MCPServer> {
  const { api, accessToken } = await resolveMcpCommandContext(dependencies);
  const headers = extraHeadersFrom(options.extraHeader);
  const input: CreateMCPServerRequest = {
    name: options.name,
    url: options.url,
    defaultAuthKind: options.defaultAuthKind ?? "oauth",
    ...(options.authHeader === undefined ? {} : { authHeader: options.authHeader }),
    ...(options.authScheme === undefined ? {} : { authScheme: options.authScheme }),
    ...(headers === undefined ? {} : { extraHeaders: headers }),
  };
  return await api.createMcpServer(accessToken, input);
}

export async function runMcpList(options: McpCommandDependencies = {}): Promise<MCPServer[]> {
  const { api, accessToken } = await resolveMcpCommandContext(options);
  return (await api.listMcpServers(accessToken)).servers;
}

export async function runMcpShow(
  reference: string,
  options: McpCommandDependencies & { agentId?: string } = {},
): Promise<{ server: MCPServerDetail; agentView?: Awaited<ReturnType<typeof loadAgentView>> }> {
  const { api, accessToken } = await resolveMcpCommandContext(options);
  const server = await resolveMcpServer(reference, options);
  const detail = await api.getMcpServer(accessToken, server.id);
  if (!options.agentId) return { server: detail };
  return { server: detail, agentView: await loadAgentView(server.id, options.agentId, api, accessToken) };
}

async function loadAgentView(
  mcpServerId: string,
  agentId: string,
  api: Awaited<ReturnType<typeof resolveMcpCommandContext>>["api"],
  accessToken: string,
) {
  const { servers } = await api.listAgentMcpServers(accessToken, agentId);
  const entry = servers.find((candidate) => candidate.mcpServerId === mcpServerId);
  if (!entry) throw new Error("The Agent does not mount this MCP Server");
  return entry;
}

export interface McpUpdateOptions {
  description?: string;
  url?: string;
  defaultAuthKind?: MCPAuthKind;
  authHeader?: string;
  authScheme?: string;
  extraHeader?: string[];
  /**
   * Both spellings clear the definition's extra headers, and they are one action here.
   *
   * At the Agent level the pair is genuinely different — `null` restores inheritance while `{}`
   * means "send none" — but the shared definition has no inherited value to restore, so its
   * `extra_headers` is never null and "clear" and "empty" are the same write. The flag is still
   * accepted so a user who learned the Agent-level vocabulary is not surprised by an error.
   */
  clearExtraHeaders?: boolean;
  emptyExtraHeaders?: boolean;
  expectedRevision?: number;
}

export async function runMcpUpdate(
  reference: string,
  options: McpUpdateOptions,
  dependencies: McpCommandDependencies = {},
): Promise<MCPServer> {
  const { api, accessToken } = await resolveMcpCommandContext(dependencies);
  const server = await resolveMcpServer(reference, dependencies);
  const headers = extraHeadersFrom(options.extraHeader);
  const input: UpdateMCPServerRequest = {
    expectedRevision: options.expectedRevision ?? server.revision,
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(options.defaultAuthKind === undefined ? {} : { defaultAuthKind: options.defaultAuthKind }),
    ...(options.authHeader === undefined ? {} : { authHeader: options.authHeader }),
    ...(options.authScheme === undefined ? {} : { authScheme: options.authScheme }),
    ...(headers === undefined ? {} : { extraHeaders: headers }),
    ...(options.clearExtraHeaders === true || options.emptyExtraHeaders === true ? { clearExtraHeaders: true } : {}),
  };
  return await api.updateMcpServer(accessToken, server.id, input);
}

export async function runMcpRemove(reference: string, options: McpCommandDependencies = {}): Promise<MCPServer> {
  const { api, accessToken } = await resolveMcpCommandContext(options);
  const server = await resolveMcpServer(reference, options);
  await api.removeMcpServer(accessToken, server.id);
  return server;
}

export async function runAgentMcpList(agentId: string, options: McpCommandDependencies = {}) {
  const { api, accessToken } = await resolveMcpCommandContext(options);
  return (await api.listAgentMcpServers(accessToken, agentId)).servers;
}

export async function runAgentMcpAvailable(agentId: string, options: McpCommandDependencies = {}) {
  const { api, accessToken } = await resolveMcpCommandContext(options);
  return (await api.listAvailableMcpServers(accessToken, agentId)).servers;
}

export async function runAgentMcpAttach(
  agentId: string,
  reference: string,
  enabled: boolean,
  options: McpCommandDependencies = {},
) {
  const { api, accessToken } = await resolveMcpCommandContext(options);
  const server = await resolveMcpServer(reference, options);
  return await api.attachMcpServer(accessToken, agentId, { mcpServerId: server.id, enabled });
}

export async function runAgentMcpDetach(
  agentId: string,
  reference: string,
  options: McpCommandDependencies = {},
): Promise<void> {
  const { api, accessToken } = await resolveMcpCommandContext(options);
  const server = await resolveMcpServer(reference, options);
  await api.detachMcpServer(accessToken, agentId, server.id);
}

export async function runAgentMcpEnable(
  agentId: string,
  reference: string,
  enabled: boolean,
  options: McpCommandDependencies = {},
) {
  const { api, accessToken } = await resolveMcpCommandContext(options);
  const server = await resolveMcpServer(reference, options);
  return await api.updateAgentMcpServer(accessToken, agentId, server.id, { enabled });
}

export interface AgentMcpConfigOptions {
  url?: string;
  authHeader?: string;
  authScheme?: string;
  extraHeader?: string[];
  clearUrl?: boolean;
  clearAuthHeader?: boolean;
  clearAuthScheme?: boolean;
  clearExtraHeaders?: boolean;
  emptyExtraHeaders?: boolean;
}

/**
 * Write this Agent's overrides. `--clear-*` restores inheritance, while `--empty-extra-headers`
 * records an explicit empty set; the two are different states and the API models both.
 */
export async function runAgentMcpConfig(
  agentId: string,
  reference: string,
  options: AgentMcpConfigOptions,
  dependencies: McpCommandDependencies = {},
) {
  const { api, accessToken } = await resolveMcpCommandContext(dependencies);
  const server = await resolveMcpServer(reference, dependencies);
  const headers = extraHeadersFrom(options.extraHeader);
  const input: UpdateMCPBindingRequest = {
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(options.clearUrl === true ? { clearUrl: true } : {}),
    ...(options.authHeader === undefined ? {} : { authHeader: options.authHeader }),
    ...(options.clearAuthHeader === true ? { clearAuthHeader: true } : {}),
    ...(options.authScheme === undefined ? {} : { authScheme: options.authScheme }),
    ...(options.clearAuthScheme === true ? { clearAuthScheme: true } : {}),
    ...(headers === undefined ? {} : { extraHeaders: headers }),
    ...(options.clearExtraHeaders === true ? { clearExtraHeaders: true } : {}),
    ...(options.emptyExtraHeaders === true ? { emptyExtraHeaders: true } : {}),
  };
  return await api.updateAgentMcpServer(accessToken, agentId, server.id, input);
}

/**
 * Write this Agent's Bearer key (or declare it anonymous). Exactly one of the three key sources is
 * used, and the interactive prompt is preferred over `--bearer-key` because an argument is visible
 * to any other process on the machine and lands in the shell's history file.
 */
export async function runMcpUse(
  agentId: string,
  reference: string,
  input: { kind: "bearer" | "none"; bearerKey?: string },
  dependencies: McpCommandDependencies = {},
) {
  const { api, accessToken } = await resolveMcpCommandContext(dependencies);
  const server = await resolveMcpServer(reference, dependencies);
  const body: SetMCPAuthorizationRequest =
    input.kind === "bearer" ? { kind: "bearer", bearerKey: requireKey(input.bearerKey) } : { kind: "none" };
  return await api.setMcpAuthorization(accessToken, agentId, server.id, body);
}

function requireKey(value: string | undefined): string {
  if (!value || value.length === 0) throw new Error("A bearer key is required for a bearer authorization");
  return value;
}

export async function readBearerKeyFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (value.length === 0) throw new Error("No bearer key was read from standard input");
  return value;
}

/** A hidden interactive read: the typed key is never echoed and never enters the process arguments. */
export async function promptForBearerKey(): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY) {
    throw new Error("A bearer key is required; pipe it with --bearer-key-stdin when not interactive");
  }
  output.write("Bearer key: ");
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  try {
    const key = await readHiddenLine(input);
    output.write("\n");
    if (key.length === 0) throw new Error("No bearer key was entered");
    return key;
  } catch (error) {
    output.write("\n");
    throw error;
  } finally {
    input.setRawMode(wasRaw);
    input.pause();
  }
}

/**
 * Accumulate raw-mode keystrokes until Enter. Escapes are handled by code unit, because in raw mode
 * each key arrives as its own escape sequence: `\u007f` is the terminal's backspace, and `\u0003` is
 * the user aborting rather than a character to store.
 */
async function readHiddenLine(input: NodeJS.ReadStream): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      const outcome = consumeKeystrokes(value, chunk.toString("utf8"));
      value = outcome.value;
      if (outcome.done === undefined) return;
      input.off("data", onData);
      if (outcome.done instanceof Error) reject(outcome.done);
      else resolve(outcome.value);
    };
    input.on("data", onData);
  });
}

type KeystrokeOutcome = { value: string; done?: undefined } | { value: string; done: Error | true };

function consumeKeystrokes(current: string, chunk: string): KeystrokeOutcome {
  let value = current;
  for (const character of chunk) {
    if (character === "\u0003") return { value, done: new Error("Cancelled") };
    if (character === "\r" || character === "\n") return { value, done: true };
    if (character === "\u007f") value = value.slice(0, -1);
    else value += character;
  }
  return { value };
}

export async function runMcpAuthorize(
  agentId: string,
  reference: string,
  options: { scopes?: string[]; noWait?: boolean },
  dependencies: McpCommandDependencies & {
    /**
     * Called the moment the URL exists, before any waiting.
     *
     * The wait below can last the flow's full ten minutes, and the URL is the one thing the user
     * must act on to make it end. Reporting it only after the wait — which is what happened when the
     * command returned a single formatted result — meant the default invocation printed nothing at
     * all and then timed out, so `--no-wait` was the only usable form.
     */
    onStarted?: (started: StartMCPOAuthResponse) => void;
  } = {},
): Promise<{ server: MCPServer; started: StartMCPOAuthResponse; probe?: MCPProbeResponse }> {
  const { api, accessToken } = await resolveMcpCommandContext(dependencies);
  const server = await resolveMcpServer(reference, dependencies);
  const started = await api.startMcpOAuth(accessToken, agentId, server.id, {
    ...(options.scopes ? { scopes: options.scopes } : {}),
  });
  dependencies.onStarted?.(started);
  if (options.noWait) return { server, started };
  const probe = await waitForAuthorization(api, accessToken, agentId, server.id);
  return { server, started, ...(probe ? { probe } : {}) };
}

/**
 * Poll until the row is authorized and probed, or the state's own 10-minute lifetime lapses. The
 * timeout matches the flow's expiry rather than being an independent guess, so the CLI never waits
 * on a state the server has already discarded.
 */
async function waitForAuthorization(
  api: Awaited<ReturnType<typeof resolveMcpCommandContext>>["api"],
  accessToken: string,
  agentId: string,
  mcpServerId: string,
  timeoutMs = 10 * 60 * 1000,
  intervalMs = 2_000,
): Promise<MCPProbeResponse | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { servers } = await api.listAgentMcpServers(accessToken, agentId);
    const entry = servers.find((candidate) => candidate.mcpServerId === mcpServerId);
    const authorization = entry?.authorization;
    /*
     * A failure code ends the wait.
     *
     * A denial or a terminal exchange failure on a row that already held a working credential leaves
     * `status: active` deliberately — the old credential is still valid and must not be destroyed — so
     * `status` alone cannot tell this wait that the flow ended. `failureCode` is what records it.
     */
    if (authorization?.failureCode) {
      throw new Error(`The authorization failed with ${authorization.failureCode}`);
    }
    if (authorization?.status === "active" && authorization.probeState !== "pending") {
      return {
        probeState: authorization.probeState,
        probeError: authorization.probeError,
        toolsCount: authorization.toolsCount,
        toolsTruncated: authorization.toolsTruncated,
        protocolEra: entry?.snapshot?.protocolEra ?? null,
        protocolVersion: entry?.snapshot?.protocolVersion ?? null,
      };
    }
    if (authorization && authorization.status !== "pending" && authorization.status !== "active") {
      throw new Error(`The authorization ended in state "${authorization.status}"`);
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the authorization to finish");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function runMcpRevoke(agentId: string, reference: string, options: McpCommandDependencies = {}) {
  const { api, accessToken } = await resolveMcpCommandContext(options);
  const server = await resolveMcpServer(reference, options);
  return await api.revokeMcpAuthorization(accessToken, agentId, server.id);
}

export async function runMcpProbe(
  agentId: string,
  reference: string,
  options: McpCommandDependencies = {},
): Promise<MCPProbeResponse> {
  const { api, accessToken } = await resolveMcpCommandContext(options);
  const server = await resolveMcpServer(reference, options);
  return await api.probeMcpServer(accessToken, agentId, server.id);
}
