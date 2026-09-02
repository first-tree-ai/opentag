import { useState } from "react";
import * as m from "../paraglide/messages.js";
import { Banner, Button } from "../ui/design-system.js";

/** An explicit destructive exit for correcting an Agent's immutable runtime during setup. */
export function AgentResetControl({
  agentName,
  busy,
  onDiscard,
}: {
  agentName: string;
  busy: boolean;
  onDiscard: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div>
        <Button disabled={busy} onClick={() => setConfirming(true)} variant="ghost">
          {m.onboarding_v2_change_agent_action()}
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-3" data-ui="onboarding-v2-agent-reset">
      <Banner description={m.onboarding_v2_change_agent_warning({ agentName })} role="alert" variant="alert" />
      <div className="flex flex-wrap gap-3">
        <Button disabled={busy} onClick={() => void onDiscard()} variant="danger">
          {busy ? m.onboarding_v2_change_agent_deleting() : m.onboarding_v2_change_agent_confirm()}
        </Button>
        <Button disabled={busy} onClick={() => setConfirming(false)} variant="secondary">
          {m.onboarding_v2_change_agent_cancel()}
        </Button>
      </div>
    </div>
  );
}
