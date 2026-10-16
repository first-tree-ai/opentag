import { DaemonServiceError } from "./types.js";

const MANAGED_KEYS = new Set(["PATH", "OPENTAG_HOME", "OPENTAG_SERVICE_MODE"]);
const PLIST_ENVIRONMENT = /(<key>EnvironmentVariables<\/key>\s*<dict\s*>)([\s\S]*?)(<\/dict\s*>)/u;
const XML_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

/** Keep user environment directives verbatim; the entrypoint owns the managed values. */
export function preserveSystemdEnvironment(template: string, installed: string | undefined): string {
  const preserved: string[] = [];
  const lines = (installed ?? "").split(/\r?\n/u);
  let service = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/u);
    if (section) service = section[1] === "Service";
    if (!service || !/^\s*(?:Environment|EnvironmentFile|PassEnvironment|UnsetEnvironment)\s*=/u.test(line)) continue;
    const directive = readSystemdDirective(lines, index);
    index += directive.length - 1;
    // These are the single-assignment lines OpenTag itself renders. Combined user assignments
    // remain intact, including quoting, specifiers, resets and continuation lines.
    if (
      directive.length === 1 &&
      /^Environment="(?:PATH|OPENTAG_HOME|OPENTAG_SERVICE_MODE)=(?:[^"\\]|\\.)*"$/u.test(line)
    )
      continue;
    preserved.push(directive.join("\n"));
  }
  return preserved.length === 0
    ? template
    : template.replace(/^Environment="PATH=/mu, () => `${preserved.join("\n")}\nEnvironment="PATH=`);
}

function readSystemdDirective(lines: string[], start: number): string[] {
  const directive = [lines[start] ?? ""];
  let continued = /(?:^|[^\\])(?:\\\\)*\\$/u.test(directive[0] ?? "");
  while (continued && start + directive.length < lines.length) {
    const line = lines[start + directive.length] ?? "";
    if (/^\s*\[/u.test(line)) throw invalidSystemdEnvironment();
    directive.push(line);
    if (!/^\s*[#;]/u.test(line)) continued = /(?:^|[^\\])(?:\\\\)*\\$/u.test(line);
  }
  if (continued) throw invalidSystemdEnvironment();
  return directive;
}

function invalidSystemdEnvironment(): DaemonServiceError {
  return new DaemonServiceError(
    "CONFIGURATION",
    "The systemd environment contains an unfinished continuation; fix it before refreshing the service",
  );
}

/** A launchd environment is a flat string dictionary; reject unsupported content before writing. */
export function preserveLaunchdEnvironment(template: string, installed: string | undefined): string {
  const source = normalizeEnvironmentKey(installed ?? "");
  if ((source.match(/<key>EnvironmentVariables<\/key>/gu)?.length ?? 0) > 1) throw invalidEnvironment();
  const environment = source.match(PLIST_ENVIRONMENT);
  if (!environment) {
    if (source.includes("<key>EnvironmentVariables</key>")) throw invalidEnvironment();
    return template;
  }
  const entries = readLaunchdEntries(environment[2] ?? "");
  return entries.length === 0
    ? template
    : template.replace(
        PLIST_ENVIRONMENT,
        (_, start: string, managed: string, end: string) => `${start}${managed}    ${entries.join("\n    ")}\n  ${end}`,
      );
}

function readLaunchdEntries(body: string): string[] {
  const pair = /\s*<key\s*>([^<]*)<\/key\s*>\s*(?:<string\s*>([^<]*)<\/string\s*>|<string\s*\/>)/guy;
  const entries: string[] = [];
  const keys = new Set<string>();
  let offset = 0;
  while (body.slice(offset).trim()) {
    pair.lastIndex = offset;
    const entry = pair.exec(body);
    if (!entry) throw invalidEnvironment();
    const key = decodeXmlText(entry[1] ?? "");
    decodeXmlText(entry[2] ?? "");
    if (keys.has(key)) throw invalidEnvironment();
    keys.add(key);
    if (!MANAGED_KEYS.has(key)) entries.push(entry[0].trim());
    offset = pair.lastIndex;
  }
  return entries;
}

function normalizeEnvironmentKey(installed: string): string {
  const source = installed.replace(/<!--[\s\S]*?-->/gu, "");
  const encoding = source.match(/<\?xml\b[^?]*\bencoding\s*=\s*["']([^"']+)["']/u)?.[1];
  let keys = 0;
  const normalized = source.replace(/<key\s*>([^<]*)<\/key\s*>/gu, (entry, text: string) => {
    keys += 1;
    return decodeXmlText(text) === "EnvironmentVariables" ? "<key>EnvironmentVariables</key>" : entry;
  });
  // Unsupported key encodings and binary plists must never look like a missing environment.
  if (
    source.startsWith("bplist") ||
    source.includes("\0") ||
    (encoding && encoding.toLowerCase() !== "utf-8") ||
    (source.match(/<key\b/gu)?.length ?? 0) !== keys
  )
    throw invalidEnvironment();
  return normalized;
}

function decodeXmlText(value: string): string {
  for (const character of value) {
    if (!isXmlCharacter(character.codePointAt(0) ?? 0)) throw invalidEnvironment();
  }
  return value.replace(/\r\n?/gu, "\n").replace(/&([^;]*);|&/gu, (_, entity: string | undefined) => {
    const predefined = XML_ENTITIES.get(entity ?? "");
    if (predefined !== undefined) return predefined;
    const numeric = entity?.match(/^#(?:x([0-9a-fA-F]+)|([0-9]+))$/u);
    if (!numeric) throw invalidEnvironment();
    const point = Number.parseInt(numeric[1] ?? numeric[2] ?? "", numeric[1] ? 16 : 10);
    if (!isXmlCharacter(point)) throw invalidEnvironment();
    return String.fromCodePoint(point);
  });
}

function isXmlCharacter(point: number): boolean {
  return (
    [9, 10, 13].includes(point) ||
    (point >= 0x20 && point <= 0xd7ff) ||
    (point >= 0xe000 && point <= 0xfffd) ||
    (point >= 0x10000 && point <= 0x10ffff)
  );
}

function invalidEnvironment(): DaemonServiceError {
  return new DaemonServiceError(
    "CONFIGURATION",
    "The LaunchAgent environment cannot be safely preserved; use UTF-8 XML with a flat string dictionary or config/daemon.env",
  );
}
