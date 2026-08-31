import type { AgentAdminConfig, ListAgentsResponse } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import { queryKeys } from "../../../query/keys.js";
import {
  Banner,
  Button,
  Dialog,
  Field,
  KumoInputControl,
  SettingsList,
  SettingsRow,
  Text,
} from "../../../ui/design-system.js";
import type { AgentDetailView } from "../agent-model.js";

export function AgentManageSettings({
  agent,
  config,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  config: AgentAdminConfig;
  onAgentChanged: (saved: AgentAdminConfig) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Status and name are read from the shared record rather than copied here: this block sits beside
  // four others editing the same Agent, and a copy taken at mount is a copy that goes stale.
  const [message, setMessage] = useState<string>();
  const [confirmation, setConfirmation] = useState<"delete" | "pause">();
  const [confirmationError, setConfirmationError] = useState<string>();
  const [confirmationText, setConfirmationText] = useState("");
  const [busy, setBusy] = useState(false);
  const [restorePauseFocus, setRestorePauseFocus] = useState(false);
  const pauseButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmation || !restorePauseFocus) return;
    pauseButtonRef.current?.focus();
    setRestorePauseFocus(false);
  }, [confirmation, restorePauseFocus]);
  async function changeLifecycle(action: "suspend" | "reactivate") {
    try {
      setBusy(true);
      setMessage(undefined);
      setConfirmationError(undefined);
      const updated =
        action === "suspend" ? await browserApi.suspendAgent(config.id) : await browserApi.reactivateAgent(config.id);
      setMessage(action === "suspend" ? "Agent paused." : "Agent reactivated.");
      setRestorePauseFocus(confirmation === "pause");
      setConfirmation(undefined);
      onAgentChanged(updated);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "Unable to change Agent status";
      if (confirmation === "pause") setConfirmationError(error);
      else setMessage(error);
    } finally {
      setBusy(false);
    }
  }
  async function deleteAgent() {
    try {
      setBusy(true);
      setMessage(undefined);
      setConfirmationError(undefined);
      await browserApi.deleteAgent(config.id);
      // A confirmed delete is stronger than a later list revalidation. Evict the Agent from every
      // cached list and remove its detail/config/evidence entries before the navigation can render
      // stale data after a transient list failure.
      //
      // Cancel first: the list is watched on a 30-second interval and on focus, so a read that left
      // before the delete is an ordinary thing to be holding here, and its late success would write
      // the Agent straight back over the eviction.
      await queryClient.cancelQueries({ queryKey: queryKeys.agents.listRoot() });
      await queryClient.cancelQueries({ queryKey: queryKeys.agents.all(config.id) });
      queryClient.setQueriesData<ListAgentsResponse>({ queryKey: queryKeys.agents.listRoot() }, (current) =>
        current ? { ...current, agents: current.agents.filter((item) => item.id !== config.id) } : current,
      );
      queryClient.removeQueries({ queryKey: queryKeys.agents.all(config.id) });
      void navigate({ to: "/agents" });
    } catch (cause) {
      setConfirmationError(cause instanceof Error ? cause.message : "Unable to delete Agent");
      setBusy(false);
    }
  }
  function closeConfirmation() {
    setConfirmation(undefined);
    setConfirmationError(undefined);
  }
  return (
    <section aria-labelledby="agent-danger-zone-heading" className="grid gap-4">
      <header className="grid gap-2">
        <Text as="h2" id="agent-danger-zone-heading" variant="heading">
          Danger zone
        </Text>
      </header>
      <SettingsList>
        <SettingsRow
          description={
            config.status === "active" ? "Stop accepting new requests until reactivated." : "Allow new requests again."
          }
          label={config.status === "active" ? "Pause Agent" : "Reactivate Agent"}
        >
          <Button
            ref={pauseButtonRef}
            variant="secondary"
            onClick={() => {
              if (config.status === "active" && agent.activity.state === "working") {
                setConfirmationError(undefined);
                setConfirmation("pause");
                return;
              }
              void changeLifecycle(config.status === "active" ? "suspend" : "reactivate");
            }}
          >
            {config.status === "active" ? "Pause" : "Reactivate"}
          </Button>
        </SettingsRow>
        <SettingsRow
          description={
            config.status === "active"
              ? "Pause this Agent before deleting it permanently."
              : "Permanently remove this Agent. This cannot be undone."
          }
          label="Delete Agent"
        >
          <Button
            disabled={config.status === "active"}
            ref={deleteButtonRef}
            variant="danger"
            onClick={() => {
              setConfirmationText("");
              setConfirmationError(undefined);
              setConfirmation("delete");
            }}
          >
            Delete permanently
          </Button>
        </SettingsRow>
      </SettingsList>
      {message ? <p role="status">{message}</p> : null}
      {confirmation === "pause" ? (
        <Dialog
          busy={busy}
          description="This Agent is handling a request. Pausing it stops new requests, but the current request may continue until it reaches a safe stopping point."
          returnFocusRef={pauseButtonRef}
          title={`Pause ${config.displayName}?`}
          onClose={closeConfirmation}
        >
          {confirmationError ? <Banner variant="error" role="alert" description={confirmationError} /> : null}
          <div className="flex flex-wrap justify-end gap-3">
            <Button disabled={busy} variant="ghost" onClick={closeConfirmation}>
              Keep active
            </Button>
            <Button disabled={busy} variant="primary" onClick={() => void changeLifecycle("suspend")}>
              {busy ? "Pausing…" : "Pause Agent"}
            </Button>
          </div>
        </Dialog>
      ) : null}
      {confirmation === "delete" ? (
        <Dialog
          busy={busy}
          description="This permanently removes the Agent and its messaging connection. The Agent cannot be restored."
          returnFocusRef={deleteButtonRef}
          title={`Delete ${config.displayName}?`}
          onClose={closeConfirmation}
        >
          <div className="grid gap-4">
            <Field
              htmlFor="agent-delete-confirmation"
              label={
                <>
                  Type <strong>{config.displayName}</strong> to confirm
                </>
              }
            >
              <KumoInputControl
                autoComplete="off"
                id="agent-delete-confirmation"
                value={confirmationText}
                onChange={(event) => setConfirmationText(event.currentTarget.value)}
              />
            </Field>
            {confirmationError ? <Banner variant="error" role="alert" description={confirmationError} /> : null}
            <div className="flex flex-wrap justify-end gap-3">
              <Button disabled={busy} variant="ghost" onClick={closeConfirmation}>
                Cancel
              </Button>
              <Button
                disabled={busy || confirmationText !== config.displayName}
                variant="danger"
                onClick={() => void deleteAgent()}
              >
                {busy ? "Deleting…" : "Delete permanently"}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
