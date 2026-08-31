import type { AgentAdminConfig, ListAgentsResponse } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import * as m from "../../../paraglide/messages.js";
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
  initialConfig,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  initialConfig: AgentAdminConfig;
  onAgentChanged: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [config, setConfig] = useState(initialConfig);
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
      setConfig(
        action === "suspend" ? await browserApi.suspendAgent(config.id) : await browserApi.reactivateAgent(config.id),
      );
      setMessage(action === "suspend" ? m.agent_settings_agent_paused() : m.agent_settings_agent_reactivated());
      setRestorePauseFocus(confirmation === "pause");
      setConfirmation(undefined);
      onAgentChanged();
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : m.agent_settings_change_status_failed();
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
      setConfirmationError(cause instanceof Error ? cause.message : m.agent_settings_delete_agent_failed());
      setBusy(false);
    }
  }
  function closeConfirmation() {
    setConfirmation(undefined);
    setConfirmationError(undefined);
  }
  return (
    <section className="grid gap-4">
      <header className="grid gap-2">
        <Text as="h1" size="lg" variant="heading">
          {m.agent_settings_manage_title()}
        </Text>
      </header>
      <SettingsList>
        <SettingsRow
          description={
            config.status === "active"
              ? m.agent_settings_pause_description()
              : m.agent_settings_reactivate_description()
          }
          label={
            config.status === "active"
              ? m.agent_settings_pause_agent_label()
              : m.agent_settings_reactivate_agent_label()
          }
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
            {config.status === "active" ? m.agent_settings_pause_action() : m.agent_settings_reactivate_action()}
          </Button>
        </SettingsRow>
        <SettingsRow
          description={
            config.status === "active"
              ? "Pause this Agent before deleting it permanently."
              : m.agent_settings_delete_description_inactive()
          }
          label={m.agent_settings_delete_agent_label()}
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
            {m.agent_settings_delete_permanently_action()}
          </Button>
        </SettingsRow>
      </SettingsList>
      {message ? <p role="status">{message}</p> : null}
      {confirmation === "pause" ? (
        <Dialog
          busy={busy}
          description={m.agent_settings_pause_confirmation_description()}
          returnFocusRef={pauseButtonRef}
          title={m.agent_settings_pause_confirmation_title({ displayName: config.displayName })}
          onClose={closeConfirmation}
        >
          {confirmationError ? <Banner variant="error" role="alert" description={confirmationError} /> : null}
          <div className="flex flex-wrap justify-end gap-3">
            <Button disabled={busy} variant="ghost" onClick={closeConfirmation}>
              {m.agent_settings_keep_active_action()}
            </Button>
            <Button disabled={busy} variant="primary" onClick={() => void changeLifecycle("suspend")}>
              {busy ? m.agent_settings_pausing_action() : m.agent_settings_pause_agent_label()}
            </Button>
          </div>
        </Dialog>
      ) : null}
      {confirmation === "delete" ? (
        <Dialog
          busy={busy}
          description={m.agent_settings_delete_confirmation_description()}
          returnFocusRef={deleteButtonRef}
          title={m.agent_settings_delete_confirmation_title({ displayName: config.displayName })}
          onClose={closeConfirmation}
        >
          <div className="grid gap-4">
            <Field
              htmlFor="agent-delete-confirmation"
              label={<>{m.agent_settings_type_name_to_confirm({ displayName: config.displayName })}</>}
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
                {m.agent_settings_cancel_action()}
              </Button>
              <Button
                disabled={busy || confirmationText !== config.displayName}
                variant="danger"
                onClick={() => void deleteAgent()}
              >
                {busy ? m.agent_settings_deleting_action() : m.agent_settings_delete_permanently_action()}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
