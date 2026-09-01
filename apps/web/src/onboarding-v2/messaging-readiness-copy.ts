import type { ProviderCliHandoffProgress } from "@opentag/shared/browser";
import { messagingProviderLabelInSentence } from "../im/provider-label.js";
import * as m from "../paraglide/messages.js";
import type { MessagingProvider, MessagingState } from "./flow.js";

function providerCliWaitingCopy(progress: ProviderCliHandoffProgress): string {
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

export function messagingCliMissingCopy(provider: MessagingProvider): string {
  return m.onboarding_v2_messaging_cli_missing({
    provider: messagingProviderLabelInSentence(provider),
  });
}

export function messagingWaitingReason(input: {
  cliFailed: boolean;
  computerOnline: boolean | undefined;
  messaging: MessagingState;
  provider: MessagingProvider | undefined;
}): string | undefined {
  if (input.computerOnline === false) return m.onboarding_v2_messaging_computer_offline();
  if (input.messaging.kind === "waiting-handoff" && input.messaging.providerCli) {
    return providerCliWaitingCopy(input.messaging.providerCli);
  }
  return input.cliFailed && input.provider ? messagingCliMissingCopy(input.provider) : undefined;
}
