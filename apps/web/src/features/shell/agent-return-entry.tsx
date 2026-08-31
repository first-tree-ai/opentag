import * as m from "../../paraglide/messages.js";
import { Icon, LinkButton } from "../../ui/design-system.js";

/** Returns from an Agent-owned surface to the Account's Agent roster. */
export function AgentReturnEntry() {
  return (
    <nav className="-ml-2 mb-3" aria-label={m.shell_account_agents()}>
      <LinkButton href="/agents" icon={<Icon name="arrow-left" />} size="sm" variant="ghost">
        {m.shell_agents()}
      </LinkButton>
    </nav>
  );
}
