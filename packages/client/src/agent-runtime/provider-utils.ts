import { AgentProviderError, AgentRuntimeError } from "./errors.js";
import type { AgentRunConfiguration, JsonValue } from "./types.js";
import { assertConfigurationStrings, assertJsonValue } from "./validation.js";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolveValue!: (value: T) => void;
  let rejectValue!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
}

export function protocolError(message: string): AgentProviderError {
  return new AgentProviderError("provider_protocol_error", message);
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function requireRecord(value: unknown, message: string): Record<string, unknown> {
  const result = record(value);
  if (!result) throw protocolError(message);
  return result;
}

export function requireArray(value: unknown, message: string): readonly unknown[] {
  if (!Array.isArray(value)) throw protocolError(message);
  return value;
}

export function requireProtocolString(value: unknown, message: string, allowEmpty: boolean, maxBytes: number): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw protocolError(message);
  }
  return value;
}

export function requireIndex(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw protocolError(message);
  return value as number;
}

export function requireUuid(value: unknown, field: string): string {
  const result = requireProtocolString(value, `${field} must be a UUID`, false, 8 * 1024 * 1024);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw protocolError(`${field} must be a UUID`);
  }
  return result;
}

export function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function toJsonValue(value: unknown, source: string): JsonValue {
  assertJsonValue(value, source);
  return value as JsonValue;
}

export function providerConfiguration<T extends object>(parse: (value: JsonValue | undefined) => T) {
  function validate(configuration: AgentRunConfiguration | undefined): void {
    if (!configuration) return;
    assertConfigurationStrings(configuration);
    parse(configuration.provider);
  }

  function merge(
    base: AgentRunConfiguration | undefined,
    override: AgentRunConfiguration | undefined,
  ): AgentRunConfiguration | undefined {
    if (!base) {
      validate(override);
      return override;
    }
    if (!override) return base;
    const merged: AgentRunConfiguration = {
      ...base,
      ...override,
      provider: { ...parse(base.provider), ...parse(override.provider) } as JsonValue,
    };
    validate(merged);
    return merged;
  }

  return { validate, merge };
}

export function parseHttpMcpGateway(
  value: unknown,
  provider: string,
): { readonly url: string; readonly token: string } | undefined {
  if (value === undefined) return undefined;
  const object = record(value);
  if (!object) throw new AgentRuntimeError("configuration_invalid", `${provider} mcpGateway must be an object`);
  const { url, token } = object;
  if (typeof url !== "string" || typeof token !== "string" || token.length === 0) {
    throw new AgentRuntimeError("configuration_invalid", `${provider} mcpGateway requires a url and a token`);
  }
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new AgentRuntimeError("configuration_invalid", `${provider} mcpGateway url must be absolute`);
  }
  if (protocol !== "https:" && protocol !== "http:") {
    throw new AgentRuntimeError("configuration_invalid", `${provider} mcpGateway url must be http or https`);
  }
  return { url, token };
}
