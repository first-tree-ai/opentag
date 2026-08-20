import { AgentRuntimeError } from "./errors.js";
import {
  AGENT_RUNTIME_BINDING_MAX_BYTES,
  AGENT_RUNTIME_ID_MAX_BYTES,
  AGENT_RUNTIME_TEXT_MAX_BYTES,
  type AgentHostedTools,
  type AgentInput,
  type AgentPromptRequest,
  type AgentRuntimeBinding,
  type AgentRuntimeManifest,
  type AgentRuntimePolicy,
} from "./types.js";

export function assertIdentifier(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > AGENT_RUNTIME_ID_MAX_BYTES
  ) {
    throw new AgentRuntimeError("invalid_request", `${field} must be a non-empty bounded string`);
  }
}

export function assertAgentInput(input: AgentInput): void {
  if (!input || !Array.isArray(input.items) || input.items.length === 0) {
    throw new AgentRuntimeError("invalid_request", "input must contain at least one item");
  }
  let bytes = 0;
  for (const item of input.items) {
    if (item?.type !== "text" || typeof item.text !== "string" || item.text.length === 0) {
      throw new AgentRuntimeError("invalid_request", "input contains an invalid text item");
    }
    bytes += Buffer.byteLength(item.text, "utf8");
  }
  if (bytes > AGENT_RUNTIME_TEXT_MAX_BYTES) {
    throw new AgentRuntimeError("invalid_request", "input exceeds the text size limit");
  }
}

export function assertPromptRequest(request: AgentPromptRequest): void {
  if (!request || typeof request !== "object") {
    throw new AgentRuntimeError("invalid_request", "prompt request is required");
  }
  assertIdentifier(request.runId, "runId");
  assertAgentInput(request.input);
  if (request.signal?.aborted) {
    throw new AgentRuntimeError("invalid_request", "the run signal is already aborted");
  }
  const configuration = request.configuration;
  if (configuration?.model !== undefined) assertIdentifier(configuration.model, "configuration.model");
  if (configuration?.reasoningEffort !== undefined) {
    assertIdentifier(configuration.reasoningEffort, "configuration.reasoningEffort");
  }
  if (configuration?.provider !== undefined) assertJsonValue(configuration.provider, "configuration.provider");
}

export function assertHostedTools(policy: AgentRuntimePolicy, hostedTools: AgentHostedTools | undefined): void {
  if (policy.tools.mode === "provider-default") {
    if (hostedTools !== undefined) {
      throw new AgentRuntimeError("configuration_invalid", "provider-default policy cannot declare hosted tools");
    }
    return;
  }
  if (!hostedTools || typeof hostedTools.handler !== "function" || !Array.isArray(hostedTools.definitions)) {
    throw new AgentRuntimeError(
      "configuration_invalid",
      "allow-list policy requires hosted tool definitions and a handler",
    );
  }

  const allowed = new Set<string>();
  for (const name of policy.tools.names) {
    assertToolName(name, "policy.tools.names");
    if (allowed.has(name)) throw new AgentRuntimeError("configuration_invalid", "tool allow-list contains duplicates");
    allowed.add(name);
  }

  const defined = new Set<string>();
  for (const definition of hostedTools.definitions) {
    if (!definition || typeof definition !== "object") {
      throw new AgentRuntimeError("configuration_invalid", "hosted tool definition is invalid");
    }
    assertToolName(definition.name, "hostedTools.definitions.name");
    if (defined.has(definition.name)) {
      throw new AgentRuntimeError("configuration_invalid", "hosted tool definitions contain duplicates");
    }
    defined.add(definition.name);
    if (definition.description !== undefined) {
      assertIdentifier(definition.description, "hostedTools.definitions.description");
    }
    assertJsonValue(definition.inputSchema, "hostedTools.definitions.inputSchema");
    assertToolInputSchema(definition.inputSchema);
  }

  if (allowed.size !== defined.size || [...allowed].some((name) => !defined.has(name))) {
    throw new AgentRuntimeError(
      "configuration_invalid",
      "hosted tool definitions must exactly match the tool allow-list",
    );
  }
}

export function assertBinding(binding: AgentRuntimeBinding, manifest: AgentRuntimeManifest): void {
  if (!binding || typeof binding !== "object") {
    throw new AgentRuntimeError("binding_incompatible", "binding is required");
  }
  if (binding.providerId !== manifest.providerId || binding.schemaVersion !== manifest.bindingSchemaVersion) {
    throw new AgentRuntimeError("binding_incompatible", "binding provider or schema version is incompatible");
  }
  assertJsonValue(binding.payload, "binding.payload", "binding_incompatible");
  if (Buffer.byteLength(JSON.stringify(binding), "utf8") > AGENT_RUNTIME_BINDING_MAX_BYTES) {
    throw new AgentRuntimeError("binding_incompatible", "binding exceeds the size limit");
  }
}

export function assertJsonValue(
  value: unknown,
  field: string,
  code: "binding_incompatible" | "invalid_request" = "invalid_request",
): void {
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return;
    if (typeof candidate === "number") {
      if (Number.isFinite(candidate)) return;
      throw new AgentRuntimeError(code, `${field} must contain finite JSON numbers`);
    }
    if (typeof candidate !== "object") throw new AgentRuntimeError(code, `${field} must be JSON-compatible`);
    if (seen.has(candidate)) throw new AgentRuntimeError(code, `${field} must not contain cycles`);
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      const keys = Reflect.ownKeys(candidate);
      if (
        keys.some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= candidate.length),
        ) ||
        candidate.length !== Object.keys(candidate).length
      ) {
        throw new AgentRuntimeError(code, `${field} must contain dense JSON arrays without custom properties`);
      }
      for (const item of candidate) visit(item);
    } else {
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new AgentRuntimeError(code, `${field} must contain only plain JSON objects`);
      }
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key !== "string") {
          throw new AgentRuntimeError(code, `${field} must not contain symbol properties`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new AgentRuntimeError(code, `${field} must contain enumerable data properties`);
        }
        visit(descriptor.value);
      }
    }
    seen.delete(candidate);
  };
  visit(value);
}

export function sameBinding(left: AgentRuntimeBinding | undefined, right: AgentRuntimeBinding): boolean {
  return left !== undefined && sameJsonValue(left as unknown as JsonComparable, right as unknown as JsonComparable);
}

export async function runWithAbortSignal<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation();
  signal.throwIfAborted();
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = () => rejectAborted(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation(signal), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

type JsonComparable = boolean | number | string | null | readonly JsonComparable[] | JsonComparableObject;
interface JsonComparableObject {
  readonly [key: string]: JsonComparable;
}

function sameJsonValue(left: JsonComparable, right: JsonComparable): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index] as JsonComparable))
    );
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const leftObject = left as JsonComparableObject;
  const rightObject = right as JsonComparableObject;
  const leftKeys = Object.keys(leftObject);
  const rightKeys = Object.keys(rightObject);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightObject, key) &&
        sameJsonValue(leftObject[key] as JsonComparable, rightObject[key] as JsonComparable),
    )
  );
}

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SCHEMA_PROPERTY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const SCHEMA_KEYS = new Set([
  "additionalProperties",
  "description",
  "format",
  "items",
  "properties",
  "required",
  "type",
]);
const SCHEMA_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

function assertToolName(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !TOOL_NAME_PATTERN.test(value)) {
    throw new AgentRuntimeError(
      "configuration_invalid",
      `${field} must use portable tool-name characters and start with a letter`,
    );
  }
}

function assertToolInputSchema(value: unknown): void {
  if (!isRecord(value) || value.type !== "object") {
    throw new AgentRuntimeError("configuration_invalid", "hosted tool input schema must be an object JSON Schema");
  }
  validateSchema(value, 0);
}

function validateSchema(schema: Record<string, unknown>, depth: number): void {
  if (depth > 16 || Object.keys(schema).some((key) => !SCHEMA_KEYS.has(key))) invalidSchema();
  if (typeof schema.type !== "string" || !SCHEMA_TYPES.has(schema.type)) invalidSchema();
  if (schema.description !== undefined && (typeof schema.description !== "string" || schema.description.length === 0)) {
    invalidSchema();
  }
  if (schema.format !== undefined && (schema.type !== "string" || schema.format !== "uuid")) invalidSchema();

  if (schema.type === "object") {
    if (schema.items !== undefined || schema.format !== undefined) invalidSchema();
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") invalidSchema();
    const properties = schema.properties ?? {};
    if (!isRecord(properties)) invalidSchema();
    for (const [name, property] of Object.entries(properties)) {
      if (!SCHEMA_PROPERTY_PATTERN.test(name) || !isRecord(property)) invalidSchema();
      validateSchema(property, depth + 1);
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required)) invalidSchema();
      const required = new Set<string>();
      for (const name of schema.required) {
        if (typeof name !== "string" || required.has(name) || !Object.hasOwn(properties, name)) invalidSchema();
        required.add(name);
      }
    }
    return;
  }

  if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
    invalidSchema();
  }
  if (schema.type === "array") {
    if (!isRecord(schema.items)) invalidSchema();
    validateSchema(schema.items, depth + 1);
  } else if (schema.items !== undefined) {
    invalidSchema();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function invalidSchema(): never {
  throw new AgentRuntimeError(
    "configuration_invalid",
    "hosted tool input schema is not in the portable JSON Schema subset",
  );
}
