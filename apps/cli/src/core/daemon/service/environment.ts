import { DaemonServiceError } from "./types.js";

const MANAGED_KEYS = new Set(["PATH", "OPENTAG_HOME", "OPENTAG_SERVICE_MODE"]);
const PLIST_ENVIRONMENT = /(<key>EnvironmentVariables<\/key>\s*<dict>)([\s\S]*?)(<\/dict>)/u;

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
  if ((installed?.match(/<key>EnvironmentVariables<\/key>/gu)?.length ?? 0) > 1) throw invalidEnvironment();
  const environment = installed?.match(PLIST_ENVIRONMENT);
  if (!environment) {
    if (installed?.includes("<key>EnvironmentVariables</key>")) throw invalidEnvironment();
    return template;
  }
  const body = (environment[2] ?? "").replace(/<!--[\s\S]*?-->/gu, "");
  const pair = /\s*<key>([^<]*)<\/key>\s*(?:<string>[^<]*<\/string>|<string\s*\/>)/guy;
  const entries: string[] = [];
  const keys = new Set<string>();
  let offset = 0;
  while (body.slice(offset).trim()) {
    pair.lastIndex = offset;
    const entry = pair.exec(body);
    if (!entry) throw invalidEnvironment();
    const key = (entry[1] ?? "").replace(/&#(?:x([0-9a-f]+)|([0-9]+));/giu, (_, hex: string, decimal: string) =>
      String.fromCodePoint(Number.parseInt(hex ?? decimal, hex ? 16 : 10)),
    );
    if (keys.has(key)) throw invalidEnvironment();
    keys.add(key);
    if (!MANAGED_KEYS.has(key)) entries.push(entry[0].trim());
    offset = pair.lastIndex;
  }
  return entries.length === 0
    ? template
    : template.replace(
        PLIST_ENVIRONMENT,
        (_, start: string, managed: string, end: string) => `${start}${managed}    ${entries.join("\n    ")}\n  ${end}`,
      );
}

function invalidEnvironment(): DaemonServiceError {
  return new DaemonServiceError(
    "CONFIGURATION",
    "The LaunchAgent environment cannot be safely preserved; use a flat string dictionary or config/daemon.env",
  );
}
