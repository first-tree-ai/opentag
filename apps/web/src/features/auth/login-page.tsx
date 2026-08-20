import type { AuthProvidersResponse } from "@opentag/shared/browser";
import { useLocation } from "react-router-dom";
import { browserApi } from "../../api.js";
import { useResource } from "../../lib/resource.js";
import { AsyncState } from "../../ui/async-state.js";

export function LoginPage() {
  const providers = useResource(() => browserApi.auth.providers(), "auth-providers");
  const next = new URLSearchParams(useLocation().search).get("next") ?? "/agents";
  return (
    <main className="center-card">
      <span className="eyebrow">OpenTag</span>
      <h1>Sign in</h1>
      <p>Choose an available sign-in method. Team permissions are checked by the server on every request.</p>
      <AsyncState state={providers}>
        {(value) => (
          <div className="actions">
            {value.providers
              .filter((provider: AuthProvidersResponse["providers"][number]) => provider.enabled && provider.startUrl)
              .map((provider: AuthProvidersResponse["providers"][number]) => (
                <a className="button" href={`${provider.startUrl}?next=${encodeURIComponent(next)}`} key={provider.id}>
                  Continue with {provider.id === "google" ? "Google" : provider.id}
                </a>
              ))}
          </div>
        )}
      </AsyncState>
    </main>
  );
}
