import type {
  RuntimeCredentialProvider,
  RuntimeCredentialRevokedCode,
  RuntimeExecutionProvider,
  RuntimeExecutionSandbox,
  RuntimeExecutionService,
  RuntimeExecutionSource,
  RuntimeProviderCliMetadata,
} from "@opentag/shared";

export type RuntimeCredentialClock = () => Date;

/** Non-secret CLI metadata surfaced to the trusted Runner. Never tokens or signed URLs. */
export type RuntimeCliMetadata = RuntimeProviderCliMetadata;

export type RuntimeExecutionPurpose = "execution" | "validation";

export type RuntimeExecutionProviderBinding = RuntimeExecutionProvider;

/**
 * Correlates a provider with its discriminated CLI metadata at construction time so the wire
 * result never carries mismatched provider/metadata pairs.
 */
export function runtimeExecutionProviderBinding(
  provider: RuntimeCredentialProvider,
  bindingId: string,
  cli: RuntimeCliMetadata,
): RuntimeExecutionProviderBinding {
  if (provider === "feishu" && cli.provider === "feishu") return { provider, bindingId, cli };
  if (provider === "slack" && cli.provider === "slack") return { provider, bindingId, cli };
  if (provider === "github" && cli.provider === "github") return { provider, bindingId, cli };
  throw new Error("The provider CLI metadata does not match its provider");
}

export interface RuntimeExecutionRecord {
  executionId: string;
  runId: string;
  accountId: string;
  agentId: string;
  agentRevision: number;
  sessionId: string;
  computerId: string;
  instanceId: string;
  connectionId: string;
  placementGeneration: number;
  source: RuntimeExecutionSource;
  purpose: RuntimeExecutionPurpose;
  computerKind: "local" | "cloud";
  /** Server-owned admission for a negotiated Cloud internal Session; never supplies an IM provider. */
  internalAuthority?: "cloud-session-collaboration";
  sandbox?: RuntimeExecutionSandbox;
  /** Present only for a Server-issued validation execution; replaces the Session fence. */
  validation?: { provider: RuntimeCredentialProvider; bindingId: string };
  providers: ReadonlyMap<string, RuntimeExecutionProviderBinding>;
  /**
   * Granted platform services (currently only `web`) with their exact authorized scopes. Platform
   * services are not provider CLI bindings: they authorize fixed Server routes and never mint
   * provider material. Absent/empty means the execution carries no service authorization.
   */
  services?: readonly RuntimeExecutionService[];
  createdAt: number;
  expiresAt: number;
}

export interface RuntimeExecutionCloseEvent {
  executionId: string;
  record: RuntimeExecutionRecord;
  code: RuntimeCredentialRevokedCode;
}

export function runtimeExecutionProviderKey(provider: RuntimeCredentialProvider, bindingId: string): string {
  return `${provider}:${bindingId}`;
}

/** Slot key for the capability store, scoped per execution. */
export function capabilitySlotKey(executionId: string, provider: RuntimeCredentialProvider, bindingId: string): string {
  return `${executionId}:${provider}:${bindingId}`;
}

export function runtimeConnectionKey(computerId: string, instanceId: string, connectionId: string): string {
  return `${computerId}:${instanceId}:${connectionId}`;
}
