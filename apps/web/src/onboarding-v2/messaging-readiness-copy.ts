import type { ImProvider, ProviderCliHandoffProgress } from "@opentag/shared/browser";
import { spaceScriptBoundary } from "../i18n/format.js";
import { messagingProviderLabel } from "../im/provider-label.js";
import * as m from "../paraglide/messages.js";

export function providerCliWaitingCopy(progress: ProviderCliHandoffProgress): string {
  if (progress.phase === "preparing_cli") return m.onboarding_v2_messaging_cli_preparing();
  if (progress.phase === "checking_credentials") return m.onboarding_v2_messaging_cli_checking_credentials();
  if (!progress.reason) return m.onboarding_v2_messaging_cli_unavailable();
  if (progress.reason === "upgrade_required") return m.onboarding_v2_messaging_cli_upgrade_required();
  if (progress.reason === "credential_rejected") return m.onboarding_v2_messaging_cli_credential_rejected();
  if (progress.reason === "identity_mismatch") return m.onboarding_v2_messaging_cli_identity_mismatch();
  if (progress.reason === "scope_missing") return m.onboarding_v2_messaging_cli_scope_missing();
  if (progress.reason === "provider_unreachable") return m.onboarding_v2_messaging_cli_provider_unreachable();
  return m.onboarding_v2_messaging_cli_rate_limited();
}

export function messagingCliMissingCopy(provider: ImProvider): string {
  return spaceScriptBoundary(m.onboarding_v2_messaging_cli_missing({ provider: messagingProviderLabel(provider) }));
}
