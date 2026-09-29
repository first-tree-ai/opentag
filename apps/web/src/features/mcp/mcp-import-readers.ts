/**
 * Reading a pasted MCP configuration into raw server entries.
 *
 * This module is the grammar half of the import: it decides which reader handles a paste, and which
 * of the dialect's keys hold servers. What an entry then means — whether it is remote, what it is
 * called, and which of its headers is a credential — is `./mcp-import-model.ts`.
 *
 * The paste is untrusted text and may carry a live credential, so nothing here logs or echoes it; a
 * header value is carried verbatim to the model and nowhere else.
 */

export type HeaderPair = { name: string; value: string };

export type RawEntry = {
  sourceName: string;
  transport: "remote" | "local" | "unrecognized";
  url?: string;
  headers: HeaderPair[];
};

/** The wrapper keys every supported dialect puts its servers under. */
const SERVER_MAP_KEYS = ["mcp", "mcpServers", "servers", "mcp_servers"] as const;

/** Type labels that declare a local process rather than an HTTP endpoint. */
const LOCAL_TYPE_LABELS = new Set(["local", "stdio", "command", "process"]);

/**
 * Fields only a local process has. They outrank a URL on purpose: `npx -y mcp-remote <url>` carries
 * an HTTPS URL and is still a local server, and reading it as remote would create a definition
 * OpenTag can never reach.
 */
const LOCAL_MARKERS = ["command", "args", "env"] as const;

const TOML_TABLE_LINE = /^\s*\[\[?[^\]\n]+\]\]?\s*(?:#.*)?$/;
const TOML_KEY_LINE = /^\s*[A-Za-z0-9_."'-]+\s*=/;

const CLI_PREFIX = /^(?:claude|codex)\s+mcp\s+add\b/i;

type ReaderId = "json" | "yaml" | "toml";

/**
 * Read the paste's entries. `undefined` means no reader recognized the text at all; an empty array
 * means a document was read but holds no server entry — the two are different outcomes for the user.
 */
export async function readEntries(text: string): Promise<RawEntry[] | undefined> {
  const command = readCliCommand(text);
  if (command) return [command];
  const document = await readDocument(text);
  if (!document) return undefined;
  const entries: RawEntry[] = [];
  for (const key of SERVER_MAP_KEYS) {
    const map = asRecord(document[key]);
    if (!map) continue;
    for (const [sourceName, value] of Object.entries(map)) {
      const record = asRecord(value);
      if (record) entries.push({ sourceName, ...entryFromRecord(record) });
    }
  }
  return entries;
}

/**
 * Read the paste with the reader its shape suggests, and fall back to the others so a mis-sniffed
 * document still parses. The first reader that yields an object wins, which keeps the result
 * deterministic for text that is valid under more than one grammar.
 */
async function readDocument(text: string): Promise<Record<string, unknown> | undefined> {
  for (const reader of readerOrder(text)) {
    const record = asRecord(await READERS[reader](text));
    if (record) return record;
  }
  return undefined;
}

const READERS: Record<ReaderId, (text: string) => Promise<unknown>> = {
  json: readJson,
  yaml: readYaml,
  toml: readToml,
};

function readerOrder(text: string): ReaderId[] {
  if (text.startsWith("{") || text.startsWith("[")) return ["json", "yaml", "toml"];
  return looksLikeToml(text) ? ["toml", "yaml", "json"] : ["yaml", "toml", "json"];
}

/** TOML assigns with `=` and heads tables with `[name]`; YAML keys end in `:`. */
function looksLikeToml(text: string): boolean {
  return text.split("\n").some((line) => TOML_TABLE_LINE.test(line) || TOML_KEY_LINE.test(line));
}

/**
 * JSON first, then the same text with comments and trailing commas removed: the OpenCode and VS Code
 * configs this feature targets routinely carry `//` comments, and reporting that as unparseable
 * would look like an OpenTag bug.
 */
async function readJson(text: string): Promise<unknown> {
  const direct = tryJson(text);
  if (direct !== undefined) return direct;
  const stripped = stripJsonc(text);
  return stripped === text ? undefined : tryJson(stripped);
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function readYaml(text: string): Promise<unknown> {
  const { parse } = await import("yaml");
  try {
    // Bounded alias expansion: the paste is user input, and an alias bomb must not cost more than
    // reading it did.
    return parse(text, { maxAliasCount: 100 }) as unknown;
  } catch {
    return undefined;
  }
}

async function readToml(text: string): Promise<unknown> {
  const { parse } = await import("smol-toml");
  try {
    return parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Remove `//` and block comments plus trailing commas, ignoring anything inside a JSON string. */
function stripJsonc(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const character = text[index] ?? "";
    if (character === '"') {
      const end = endOfString(text, index);
      result += text.slice(index, end);
      index = end;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      index = endOfLineComment(text, index);
      result += "\n";
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      index = endOfBlockComment(text, index);
      continue;
    }
    if (character === "," && closesAfter(text, index)) {
      index++;
      continue;
    }
    result += character;
    index++;
  }
  return result;
}

function endOfString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const character = text[index] ?? "";
    if (character === "\\") {
      index += 2;
      continue;
    }
    index++;
    if (character === '"') break;
  }
  return index;
}

function endOfLineComment(text: string, start: number): number {
  let index = start;
  while (index < text.length && text[index] !== "\n") index++;
  return index;
}

function endOfBlockComment(text: string, start: number): number {
  const end = text.indexOf("*/", start + 2);
  return end === -1 ? text.length : end + 2;
}

function closesAfter(text: string, index: number): boolean {
  for (let lookahead = index + 1; lookahead < text.length; lookahead++) {
    const character = text[lookahead] ?? "";
    if (/\s/.test(character)) continue;
    return character === "}" || character === "]";
  }
  return false;
}

function entryFromRecord(record: Record<string, unknown>): Omit<RawEntry, "sourceName"> {
  const headers = recordHeaders(record);
  const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
  if (LOCAL_TYPE_LABELS.has(type) || LOCAL_MARKERS.some((marker) => record[marker] !== undefined))
    return { transport: "local", headers };
  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (url) return { transport: "remote", url, headers };
  return { transport: "unrecognized", headers };
}

/** `headers` is an object in most dialects and an array of `Name: value` lines in a few. */
function recordHeaders(record: Record<string, unknown>): HeaderPair[] {
  return [
    ...headerPairs(record.headers),
    // Codex spells its literal static headers `http_headers`; the two names describe the same field.
    ...headerPairs(record.http_headers),
    // `env_http_headers` maps a header name to the *name of an environment variable*. There is no
    // value to import and the variable name is not a secret, so the header is refused by name rather
    // than read as an empty credential.
    ...headerNames(record.env_http_headers),
  ];
}

function headerPairs(raw: unknown): HeaderPair[] {
  const record = asRecord(raw);
  if (record) {
    const pairs: HeaderPair[] = [];
    for (const [name, value] of Object.entries(record)) {
      if (typeof value === "string") pairs.push({ name, value });
    }
    return pairs;
  }
  if (!Array.isArray(raw)) return [];
  const pairs: HeaderPair[] = [];
  for (const item of raw) {
    if (typeof item === "string") pairs.push(...headerFromLine(item));
  }
  return pairs;
}

function headerNames(raw: unknown): HeaderPair[] {
  const record = asRecord(raw);
  if (!record) return [];
  return Object.keys(record).map((name) => ({ name, value: "" }));
}

function headerFromLine(line: string): HeaderPair[] {
  const separator = line.indexOf(":");
  if (separator <= 0) return [];
  return [{ name: line.slice(0, separator), value: line.slice(separator + 1).trim() }];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** What a parsed CLI line says, before it is turned into an entry the model can classify. */
type CliParts = { transport: string; command: boolean; headers: HeaderPair[]; url?: string };

/** Value-taking flags, mapped to what they record. */
const CLI_FLAG_HANDLERS: Record<string, (parts: CliParts, value: string) => void> = {
  "--transport": (parts, value) => {
    parts.transport = value.toLowerCase();
  },
  "-t": (parts, value) => {
    parts.transport = value.toLowerCase();
  },
  "--url": (parts, value) => {
    parts.url = value;
  },
  "-u": (parts, value) => {
    parts.url = value;
  },
  "--header": (parts, value) => {
    parts.headers.push(...headerFromLine(value));
  },
  "-H": (parts, value) => {
    parts.headers.push(...headerFromLine(value));
  },
};

/** Value-taking flags that say nothing about where the server lives. Their value is only consumed. */
const CLI_IGNORED_VALUE_FLAGS = new Set([
  "--env",
  "-e",
  "--scope",
  "-s",
  "--bearer-token-env-var",
  "--client-secret",
  "--callback-port",
]);

function readCliCommand(text: string): RawEntry | undefined {
  if (!CLI_PREFIX.test(text)) return undefined;
  const tokens = tokenizeShell(text);
  const parts = readCliTokens(tokens.slice(4));
  const sourceName = tokens[3] ?? "";
  const local = parts.command || parts.transport === "stdio" || parts.transport === "local";
  if (local) return { sourceName, transport: "local", headers: parts.headers, ...urlField(parts) };
  if (parts.url !== undefined) return { sourceName, transport: "remote", headers: parts.headers, url: parts.url };
  return { sourceName, transport: "unrecognized", headers: parts.headers };
}

function urlField(parts: CliParts): { url?: string } {
  return parts.url === undefined ? {} : { url: parts.url };
}

function readCliTokens(tokens: string[]): CliParts {
  const parts: CliParts = { transport: "", command: false, headers: [] };
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (token === "--") {
      parts.command = index + 1 < tokens.length;
      break;
    }
    const handler = CLI_FLAG_HANDLERS[token];
    if (handler) {
      handler(parts, tokens[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (CLI_IGNORED_VALUE_FLAGS.has(token)) {
      index += 2;
      continue;
    }
    if (token.startsWith("-")) {
      index++;
      continue;
    }
    readPositional(parts, token);
    index++;
  }
  return parts;
}

/**
 * A bare token is the URL when none is known yet, and otherwise the command of a stdio transport.
 * A stray token after a URL is ignored: an HTTP transport takes no command arguments.
 */
function readPositional(parts: CliParts, token: string): void {
  if (parts.url !== undefined) return;
  if (/^https?:\/\//i.test(token)) {
    parts.url = token;
    return;
  }
  parts.command = true;
}

/** Split a shell-ish command line, honouring single quotes, double quotes, and backslash escapes. */
function tokenizeShell(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index] ?? "";
    if (character === '"' || character === "'") {
      const quoted = readQuoted(text, index, character);
      current += quoted.value;
      started = true;
      index = quoted.next;
      continue;
    }
    if (character === "\\" && index + 1 < text.length) {
      current += text[index + 1] ?? "";
      started = true;
      index += 2;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      index++;
      continue;
    }
    current += character;
    started = true;
    index++;
  }
  if (started) tokens.push(current);
  return tokens;
}

function readQuoted(text: string, start: number, quote: string): { value: string; next: number } {
  let value = "";
  let index = start + 1;
  while (index < text.length) {
    const character = text[index] ?? "";
    if (character === quote) return { value, next: index + 1 };
    if (character === "\\" && quote === '"' && index + 1 < text.length) {
      value += text[index + 1] ?? "";
      index += 2;
      continue;
    }
    value += character;
    index++;
  }
  return { value, next: index };
}
