import { GITHUB_INTEGRATION_INSTALLATION_PATH } from "@opentag/shared/browser";
import * as m from "../../paraglide/messages.js";
import { Button, buttonClassName, Text } from "../../ui/design-system.js";

/** Shared by the existing Account and Agent GitHub empty states. */
export function GitHubInstallationActions({ busy, onRefresh }: { busy: boolean; onRefresh: () => void }) {
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
        <Button disabled={busy} onClick={onRefresh} variant="ghost">
          {busy ? m.integrations_github_working() : m.integrations_github_refresh()}
        </Button>
      </div>
    </div>
  );
}
