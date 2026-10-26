import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeSessionSchema } from "@first-tree-ai/context-tree/contracts";
import {
  type ContextTreeConnection,
  ContextTreeConnectionSchema,
  contextTreeIdentity,
  contextTreeName,
  contextTreeSelector,
} from "@opentag/shared";
import { z } from "zod";
import type { RuntimeCredentialRelay } from "./runtime-credential-relay.js";

const LIMIT = 1024 * 1024;
const RequestSchema = z.object({ args: z.array(z.string().max(4096)).min(1).max(16) }).strict();
const SessionHintSchema = z.object({ id: z.string().uuid(), source: ContextTreeConnectionSchema }).strict();
export interface ContextTreeCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface ContextTreeCommandOptions {
  parent: RuntimeCredentialRelay;
  sources: readonly ContextTreeConnection[];
  workspace: string;
  stateDirectory: string;
  environment: () => Record<string, string | undefined>;
  execute: (
    args: readonly string[],
    environment: Readonly<Record<string, string | undefined>>,
    signal: AbortSignal,
  ) => Promise<ContextTreeCommandResult>;
}

export class ContextTreeCommandGateway {
  readonly #options: ContextTreeCommandOptions;
  readonly #abort = new AbortController();
  #server?: http.Server;
  #directory?: string;
  #relay?: RuntimeCredentialRelay;
  #busy = false;
  #settled?: Promise<void>;
  #settle?: () => void;
  #closed = false;
  socketPath?: string;
  port?: number;

  constructor(options: ContextTreeCommandOptions) {
    this.#options = options;
  }
  get relay(): RuntimeCredentialRelay | undefined {
    return this.#relay;
  }
  get workspace(): string {
    return this.#options.workspace;
  }
  configure(workspace: string, sources: readonly ContextTreeConnection[]): void {
    if (
      resolve(workspace) === this.#options.workspace &&
      JSON.stringify(sources) === JSON.stringify(this.#options.sources)
    )
      return;
    if (this.#busy) throw new Error("Context Tree operation is in progress");
    this.#options.workspace = resolve(workspace);
    this.#options.sources = sources;
  }

  async listen(kind: "socket" | "tcp"): Promise<void> {
    const server = http.createServer((request, response) => {
      void (async () => {
        if (
          request.method !== "POST" ||
          request.url !== "/command" ||
          request.headers.origin ||
          request.headers["content-type"] !== "application/json"
        ) {
          response.writeHead(400).end();
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 16 * 1024) {
            response.writeHead(413).end();
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        const input = RequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const abort = new AbortController();
        response.once("close", () => {
          if (!response.writableEnded) abort.abort();
        });
        const result = await this.run(input.args, abort.signal);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
      })().catch(() => {
        if (!response.headersSent) response.writeHead(409);
        response.end(
          JSON.stringify({
            code: 1,
            stdout: "",
            stderr: "Context Tree operation unavailable; retained work has not been discarded.\n",
          }),
        );
      });
    });
    this.#server = server;
    server.requestTimeout = 125_000;
    server.headersTimeout = 5_000;
    if (kind === "socket") {
      this.#directory = await mkdtemp(join(tmpdir(), "ot-tree-"));
      this.socketPath = join(this.#directory, "tree.sock");
      await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen(this.socketPath, done);
      });
      await chmod(this.socketPath, 0o600);
    } else {
      await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", done);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Context Tree listener has no port");
      this.port = address.port;
    }
  }

  async run(raw: readonly string[], callerSignal?: AbortSignal): Promise<ContextTreeCommandResult> {
    if (this.#closed || this.#busy || this.#options.parent.signal.aborted)
      throw new Error("Context Tree execution unavailable");
    const args = RequestSchema.parse({ args: raw }).args;
    const command = this.#command(args);
    this.#busy = true;
    this.#settled = new Promise<void>((done) => {
      this.#settle = done;
    });
    const signal = AbortSignal.any([
      this.#abort.signal,
      this.#options.parent.signal,
      AbortSignal.timeout(120_000),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    try {
      return await this.#runCommand(command, signal);
    } finally {
      this.#settle?.();
      this.#settle = undefined;
      this.#busy = false;
    }
  }

  async #runCommand(command: ManagedCommand, signal: AbortSignal): Promise<ContextTreeCommandResult> {
    if (command.operation === "sync" && !command.source) return this.#syncAll(command.offline === true, signal);
    const source = command.source ?? (command.id ? await this.#sessionSource(command.id) : undefined);
    if (!source) throw new Error("Choose a configured Context Tree");
    const result = await this.#execute(source, command.argv, signal);
    if (result.code !== 0) return result;
    if (command.operation === "prepare") await this.#rememberSession(result.stdout, source);
    if (command.id && (command.operation === "abort" || JSON.parse(result.stdout || "{}").outcome === "published"))
      await rm(this.#hint(command.id), { force: true });
    return result;
  }

  async #syncAll(offline: boolean, signal: AbortSignal): Promise<ContextTreeCommandResult> {
    const results: unknown[] = [];
    for (const source of this.#options.sources) {
      const result = await this.#execute(
        source,
        [
          "sync",
          "--tree",
          contextTreeSelector(source),
          "--project-path",
          this.#project(),
          ...(offline ? ["--offline"] : []),
        ],
        signal,
      );
      if (result.code !== 0) return result;
      results.push(...(JSON.parse(result.stdout) as { connections: unknown[] }).connections);
    }
    return { code: 0, stdout: JSON.stringify({ schemaVersion: 3, connections: results }), stderr: "" };
  }

  async #rememberSession(stdout: string, source: ContextTreeConnection): Promise<void> {
    const session = writeSessionSchema.parse(JSON.parse(stdout));
    if (
      session.connection.source.kind !== "git" ||
      contextTreeIdentity(session.connection.source) !== contextTreeIdentity(source) ||
      session.connection.projectRoot !== this.#project()
    )
      throw new Error("Context Tree preparation target changed");
    await mkdir(this.#options.stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(this.#hint(session.id), JSON.stringify({ id: session.id, source }), { mode: 0o600, flag: "wx" });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    this.#server?.closeAllConnections();
    if (this.#settled) await this.#settled;
    try {
      await this.#relay?.close("context_tree_closed");
    } finally {
      this.#server?.closeAllConnections();
      if (this.#server) await new Promise<void>((done) => this.#server?.close(() => done()));
      if (this.#directory) await rm(this.#directory, { recursive: true, force: true });
    }
  }

  #project(): string {
    return join(this.#options.workspace, ".opentag", "context-tree", "project");
  }
  #hint(id: string): string {
    return join(this.#options.stateDirectory, `${z.string().uuid().parse(id)}.json`);
  }
  async #sessionSource(id: string): Promise<ContextTreeConnection> {
    const bytes = await readFile(this.#hint(id));
    if (bytes.length > 4096) throw new Error("Invalid Context Tree routing hint");
    const hint = SessionHintSchema.parse(JSON.parse(bytes.toString("utf8")));
    const source = this.#options.sources.find(
      (candidate) => contextTreeIdentity(candidate) === contextTreeIdentity(hint.source),
    );
    if (hint.id !== id || !source) throw new Error("Context Tree no longer configured");
    return source;
  }

  #command(args: readonly string[]): ManagedCommand {
    const operation = commandOperation(args);
    const { options, positional } = commandOptions(args.slice(args[0] === "sync" ? 1 : 2), OPERATION_FLAGS[operation]);
    const project = options.get("--project-path");
    if (project !== undefined && resolve(project) !== this.#project())
      throw new Error("Unmanaged Context Tree project");
    const source = selectSource(options.get("--tree"), this.#options.sources);
    if (operation === "sync") {
      if (positional.length) throw new Error("Unexpected Context Tree argument");
      const offline = options.has("--offline");
      return {
        operation,
        source,
        offline,
        argv: [
          "sync",
          "--tree",
          source ? contextTreeSelector(source) : "",
          "--project-path",
          this.#project(),
          ...(offline ? ["--offline"] : []),
        ],
      };
    }
    if (operation === "prepare") {
      if (!source || positional.length) throw new Error("Choose a configured Context Tree");
      return {
        operation,
        source,
        argv: ["write", "prepare", "--tree", contextTreeSelector(source), "--project-path", this.#project()],
      };
    }
    return writeSessionCommand(operation, positional, options);
  }

  async #execute(
    source: ContextTreeConnection,
    args: readonly string[],
    signal: AbortSignal,
  ): Promise<ContextTreeCommandResult> {
    const relay = await this.#options.parent.openContextTree(source, signal);
    this.#relay = relay;
    try {
      const environment = {
        ...this.#options.environment(),
        GH_TOKEN: relay.localHandleFor("github"),
        GITHUB_TOKEN: undefined,
        GH_ENTERPRISE_TOKEN: undefined,
        GITHUB_ENTERPRISE_TOKEN: undefined,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_PARAMETERS: undefined,
        GIT_ASKPASS: undefined,
        SSH_AUTH_SOCK: undefined,
        GIT_CONFIG_COUNT: "7",
        GIT_CONFIG_KEY_2: "http.https://github.com.proxy",
        GIT_CONFIG_VALUE_2: this.#options.environment().OPENTAG_PROVIDER_PROXY_URL ?? "",
        GIT_CONFIG_KEY_3: "http.https://github.com.sslCAInfo",
        GIT_CONFIG_VALUE_3: this.#options.environment().OPENTAG_PROVIDER_CA_PATH ?? "",
        GIT_CONFIG_KEY_4: "http.proxy",
        GIT_CONFIG_VALUE_4: "",
        GIT_CONFIG_KEY_5: "http.sslVerify",
        GIT_CONFIG_VALUE_5: "true",
        GIT_CONFIG_KEY_6: "core.hooksPath",
        GIT_CONFIG_VALUE_6: "/dev/null",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_KEY_1: "credential.helper",
        GIT_CONFIG_VALUE_1: "!f() { printf 'username=x-access-token\\npassword=%s\\n' \"$GH_TOKEN\"; }; f",
        OPENTAG_CONTEXT_TREE_SOCKET: undefined,
        OPENTAG_CONTEXT_TREE_URL: undefined,
      };
      const result = await this.#options.execute(args, environment, signal);
      if (Buffer.byteLength(JSON.stringify(result)) > LIMIT) throw new Error("Context Tree output exceeded its limit");
      return result;
    } finally {
      this.#relay = undefined;
      await relay.close("context_tree_complete");
    }
  }
}

type CommandOperation = "sync" | "prepare" | "finish" | "abort";
interface ManagedCommand {
  operation: CommandOperation;
  argv: string[];
  source?: ContextTreeConnection;
  id?: string;
  offline?: boolean;
}
const OPERATION_FLAGS: Record<CommandOperation, ReadonlySet<string>> = {
  sync: new Set(["--tree", "--project-path", "--offline", "--json"]),
  prepare: new Set(["--tree", "--project-path", "--json"]),
  finish: new Set(["--message", "--publish", "--json"]),
  abort: new Set(["--json"]),
};
const BOOLEAN_FLAGS = new Set(["--offline", "--json", "--publish"]);
function writeSessionCommand(
  operation: "finish" | "abort",
  positional: readonly string[],
  options: ReadonlyMap<string, string>,
): ManagedCommand {
  if (positional.length !== 1) throw new Error("A Context Tree session is required");
  const id = z.string().uuid().parse(positional[0]);
  const argv = ["write", operation, id];
  if (operation === "finish") {
    argv.push("--message", options.get("--message") ?? "Update Context Tree");
    if (options.has("--publish")) argv.push("--publish");
  }
  return { operation, id, argv };
}
function commandOperation(args: readonly string[]): CommandOperation {
  if (args[0] === "sync") return "sync";
  const operation = args[1];
  if (args[0] === "write" && (operation === "prepare" || operation === "finish" || operation === "abort"))
    return operation;
  throw new Error("Context Tree operation is not supported");
}
function commandOptions(args: readonly string[], allowed: ReadonlySet<string>) {
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!allowed.has(arg) || options.has(arg)) throw new Error("Unexpected or duplicate Context Tree option");
    const value = BOOLEAN_FLAGS.has(arg) ? "" : args[++index];
    if (value === undefined) throw new Error("Missing Context Tree option value");
    options.set(arg, value);
  }
  return { options, positional };
}
function selectSource(
  selector: string | undefined,
  sources: readonly ContextTreeConnection[],
): ContextTreeConnection | undefined {
  const matches = sources.filter(
    (source) =>
      selector === undefined ||
      selector === contextTreeSelector(source) ||
      selector === contextTreeName(source) ||
      selector.toLowerCase() === source.repository.toLowerCase(),
  );
  const selected = matches.length === 1 ? matches[0] : undefined;
  if (selector !== undefined && !selected) throw new Error("Context Tree selector is not configured or is ambiguous");
  return selected;
}

export function requestContextTreeCommand(
  endpoint: { socketPath?: string; url?: string },
  args: readonly string[],
  signal?: AbortSignal,
): Promise<ContextTreeCommandResult> {
  return new Promise((done, reject) => {
    const target = endpoint.url ? new URL(endpoint.url) : undefined;
    if (
      target &&
      (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.username || target.password)
    ) {
      reject(new Error("Invalid Context Tree endpoint"));
      return;
    }
    const request = http.request(
      {
        ...(endpoint.socketPath ? { socketPath: endpoint.socketPath } : { hostname: "127.0.0.1", port: target?.port }),
        path: "/command",
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        timeout: 125_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > LIMIT) response.destroy(new Error("Context Tree response exceeded its limit"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            if (response.statusCode !== 200) throw new Error("Context Tree operation unavailable");
            done(
              z
                .object({ code: z.number().int(), stdout: z.string(), stderr: z.string() })
                .strict()
                .parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
            );
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Context Tree command timed out")));
    request.end(JSON.stringify({ args }));
  });
}

export const CONTEXT_TREE_COMMAND_CLIENT_SOURCE = `
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const [cli, ...args] = process.argv.slice(2);
const managed = args[0] === 'sync' || args[0] === 'write';
const manifest = process.env.OPENTAG_CONTEXT_TREE_MANIFEST;
let environment = process.env;
if (manifest) {
  try { environment = JSON.parse(readFileSync(manifest, 'utf8')).environment ?? {}; }
  catch { environment = {}; }
}
const socketPath = environment.OPENTAG_CONTEXT_TREE_SOCKET;
const url = environment.OPENTAG_CONTEXT_TREE_URL;
if (managed && (socketPath || url)) {
  const target = url ? new URL(url) : undefined;
  if (target && (target.protocol !== 'http:' || target.hostname !== '127.0.0.1')) throw new Error('Invalid Context Tree endpoint');
  const request = http.request({ ...(socketPath ? { socketPath } : { hostname: '127.0.0.1', port: target.port }), path: '/command', method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 125000 }, response => {
    const chunks = []; let size = 0;
    response.on('data', chunk => { size += chunk.length; if (size > 1048576) response.destroy(); else chunks.push(chunk); });
    response.on('error', () => { console.error('Context Tree response unavailable; retain unpublished work.'); process.exitCode = 1; });
    response.on('end', () => { try { if (response.statusCode !== 200) throw new Error(); const result = JSON.parse(Buffer.concat(chunks).toString()); process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.code; } catch { console.error('Context Tree operation unavailable; retain unpublished work.'); process.exitCode = 1; } });
  });
  request.on('error', () => { console.error('Context Tree execution unavailable; do not fall back to GitHub CLI.'); process.exitCode = 1; });
  request.on('timeout', () => request.destroy()); request.end(JSON.stringify({ args }));
} else if (managed && manifest) {
  console.error('Context Tree execution unavailable; retain unpublished work.'); process.exitCode = 1;
} else {
  const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit' });
  child.on('error', () => { process.exitCode = 1; }); child.on('exit', code => { process.exitCode = code ?? 1; });
}
`;
