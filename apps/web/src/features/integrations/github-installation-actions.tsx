import { GITHUB_INTEGRATION_INSTALLATION_PATH } from "@opentag/shared/browser";
import * as m from "../../paraglide/messages.js";
import { Button, buttonClassName, Text } from "../../ui/design-system.js";

/** Shared by the existing Account and Agent GitHub installation sections. */
export function GitHubInstallationActions({
  busy,
  refreshing,
  onRefresh,
}: {
  busy: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="grid gap-2">
      <Text as="p" variant="secondary">
        {m.integrations_github_install_description()}
      </Text>
      <div className="flex flex-wrap gap-2">
        <a
          className={buttonClassName({ variant: "secondary" })}
          href={GITHUB_INTEGRATION_INSTALLATION_PATH}
          rel="noopener noreferrer"
          target="_blank"
        >
          {m.integrations_github_install()}
        </a>
        {/* Keep keyboard focus while the parent fences duplicate requests. */}
        <Button
          aria-disabled={busy}
          aria-busy={refreshing}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (!busy) onRefresh();
          }}
          variant="ghost"
        >
          {refreshing ? m.integrations_github_refreshing() : m.integrations_github_refresh()}
        </Button>
      </div>
    </div>
  );
}
