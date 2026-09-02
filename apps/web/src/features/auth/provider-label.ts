import type { AuthProvidersResponse } from "@opentag/shared/browser";
import * as m from "../../paraglide/messages.js";

export type AuthProviderId = AuthProvidersResponse["providers"][number]["id"];

/**
 * What a sign-in method is called, in the reader's locale.
 *
 * The sign-in button used to interpolate `provider.id` directly, so it read "Continue with dev" --
 * the Server's vocabulary, chosen for storage and routing, shown to a person. That is the same
 * defect messaging had before `messagingProviderLabel`: an identifier reaching a reader because
 * nobody ever decided how it should read.
 *
 * The switch is exhaustive rather than a lookup so that adding a sign-in method fails to compile
 * here until somebody gives it a name. Only `Google` is a brand and stays as written; the others
 * describe a way to sign in, so their words are translated and come from the catalogue.
 */
export function authProviderLabel(provider: AuthProviderId): string {
  switch (provider) {
    case "google":
      return "Google";
    case "dev":
      return m.auth_provider_dev();
    case "password":
      return m.auth_provider_password();
    default:
      return assertNeverAuthProvider(provider);
  }
}

function assertNeverAuthProvider(provider: never): never {
  throw new Error(`Unlabelled auth provider: ${String(provider)}`);
}
