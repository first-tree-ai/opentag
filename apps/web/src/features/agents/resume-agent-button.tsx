import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { syncAgentQueries } from "../../query/agent-sync.js";
import { Button } from "../../ui/design-system.js";

/**
 * Resumes a paused Agent where the reader noticed it was paused, instead of sending them to the
 * settings page that has the same button. A failure says so on the spot and leaves the Agent paused.
 */
export function ResumeAgentButton({ agentId }: { readonly agentId: string }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function resume() {
    setBusy(true);
    setFailed(false);
    try {
      await browserApi.reactivateAgent(agentId);
      await syncAgentQueries(queryClient, agentId);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid justify-items-start gap-1">
      <Button size="compact" variant="outline" disabled={busy} onClick={() => void resume()}>
        {m.agent_settings_resume_button()}
      </Button>
      {failed ? (
        <p role="alert" className="m-0 text-sm text-kumo-danger">
          {m.agent_settings_resume_failed()}
        </p>
      ) : null}
    </div>
  );
}
