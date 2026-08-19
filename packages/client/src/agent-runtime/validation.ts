import { AgentRuntimeError } from "./errors.js";
import {
  AGENT_RUNTIME_BINDING_MAX_BYTES,
  AGENT_RUNTIME_ID_MAX_BYTES,
  AGENT_RUNTIME_TEXT_MAX_BYTES,
  type AgentInput,
  type AgentPromptRequest,
  type AgentRuntimeBinding,
  type AgentRuntimeManifest,
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
      for (const item of candidate) visit(item);
    } else {
      for (const item of Object.values(candidate)) visit(item);
    }
    seen.delete(candidate);
  };
  visit(value);
}

export function sameBinding(left: AgentRuntimeBinding | undefined, right: AgentRuntimeBinding): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}
