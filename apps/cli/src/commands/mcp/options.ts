import type { MCPAuthKind } from "@opentag/shared";

/**
 * The raw Commander option bags, mapped into the typed inputs the core operations take.
 *
 * These live apart from the command wiring so each mapping is a plain function of its options: the
 * command actions stay one call each, and an option's absence-versus-empty distinction is stated in
 * one place instead of being re-derived inline for every command.
 */

export interface RawOptions {
  [key: string]: unknown;
}

/** Repeated `--extra-header <name=value>` flags arrive as a growing array. */
export function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value);
}

export function optionalNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : Number(value);
}

export function optionalList(values: unknown): string[] | undefined {
  return Array.isArray(values) ? (values as string[]) : undefined;
}

export function authKindOf(value: unknown): MCPAuthKind {
  if (value === "none" || value === "bearer" || value === "oauth") return value;
  throw new Error("--default-auth must be oauth, bearer, or none");
}

export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Resolve how `mcp use` should obtain the Bearer key: an explicit `--kind none` declaration, a piped
 * stdin read, the hidden prompt, or — as a last resort — the visible `--bearer-key` argument.
 *
 * The order is deliberate: the piped and prompted paths are preferred over the argument because an
 * argument is readable by every other process on the machine and lands in the shell's history file,
 * and a caller that asked for `none` while also supplying a key is confused rather than intentional.
 */
export function resolveBearerKeySource(options: {
  kind?: unknown;
  bearerKey?: unknown;
  bearerKeyStdin?: unknown;
}): { kind: "none" } | { kind: "bearer"; source: "stdin" | "prompt" | "argument"; value?: string } {
  if (options.kind === "none") {
    if (options.bearerKey !== undefined || options.bearerKeyStdin === true) {
      throw new Error("An anonymous authorization carries no key");
    }
    return { kind: "none" };
  }
  /*
   * `oauth` is not this command's kind. It used to fall through to Bearer, so
   * `mcp use --kind oauth --bearer-key <value>` wrote a Bearer key while the caller believed they
   * were starting an OAuth flow — a silent kind change, which is exactly what this feature's per-Agent
   * authorization must not do. `mcp authorize` owns OAuth and is named in the message.
   */
  if (options.kind !== undefined && options.kind !== "bearer") {
    throw new Error("--kind must be bearer or none; use `mcp authorize` to start an OAuth flow");
  }
  if (options.bearerKeyStdin === true) return { kind: "bearer", source: "stdin" };
  if (options.bearerKey === undefined) return { kind: "bearer", source: "prompt" };
  return { kind: "bearer", source: "argument", value: String(options.bearerKey) };
}

/** Spread-friendly form: the key is present only when the flag was given. */
export function whenDefined<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

export function whenTrue(key: string, value: unknown): Record<string, true> {
  return value === true ? { [key]: true } : {};
}
