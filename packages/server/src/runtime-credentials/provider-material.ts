import type { RuntimeCredentialProvider } from "@opentag/shared";

/** Fixed upstream origins: the binding brand decides, never the caller. */
export const FEISHU_BRAND_ORIGINS = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
} as const;

export const SLACK_FIXED_ORIGIN = "https://slack.com" as const;

export type FeishuBrand = keyof typeof FEISHU_BRAND_ORIGINS;

export function feishuOriginForBrand(brand: string | null | undefined): string {
  return FEISHU_BRAND_ORIGINS[brand === "lark" ? "lark" : "feishu"];
}

export function fixedOriginForProvider(provider: RuntimeCredentialProvider, brand?: string | null): string {
  return provider === "slack" ? SLACK_FIXED_ORIGIN : feishuOriginForBrand(brand);
}

/**
 * The pinned credential generation vocabulary shared by the broker (scope issuance) and the
 * material resolver (per-request verification). Slack pins both the binding and the installation
 * generation; Feishu pins the binding generation; GitHub pins the connection credential generation.
 */
export function imCredentialGenerationPin(
  provider: RuntimeCredentialProvider,
  bindingGeneration: number,
  installationGeneration?: number,
): string {
  if (provider === "slack") return `${bindingGeneration}:${installationGeneration ?? 0}`;
  return String(bindingGeneration);
}

export function imAuthorizationRevision(
  provider: RuntimeCredentialProvider,
  bindingGeneration: number,
  installationGeneration?: number,
): string {
  if (provider === "slack") return `slack:${bindingGeneration}:${installationGeneration ?? 0}`;
  if (provider === "feishu") return `feishu:${bindingGeneration}`;
  return `github:${bindingGeneration}`;
}

export interface RuntimeProviderMaterial {
  kind: "bearer";
  token: string;
  origin: string;
  /** Platform-reported expiry (ms epoch) when known; the platform response remains authoritative. */
  expiresAt?: number;
}

export interface RuntimeProviderMaterialInput {
  executionId: string;
  provider: RuntimeCredentialProvider;
  bindingId: string;
  accountId: string;
  agentId: string;
  /** The credential generation the capability pinned; a live row mismatch must resolve undefined. */
  credentialGeneration: string;
  signal?: AbortSignal;
}

export interface RuntimeProviderMaterialResolver {
  resolve(input: RuntimeProviderMaterialInput): Promise<RuntimeProviderMaterial | undefined>;
}
