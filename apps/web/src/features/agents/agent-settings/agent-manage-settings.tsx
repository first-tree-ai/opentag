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
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string }>();
  const [confirmation, setConfirmation] = useState<"delete" | "pause">();
  const [confirmationError, setConfirmationError] = useState<string>();
  const [confirmationText, setConfirmationText] = useState("");
  const [busy, setBusy] = useState(false);
  const [restorePauseFocus, setRestorePauseFocus] = useState(false);
  const pauseButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const statusDescriptionId = `agent-status-description-${config.id}`;
  const deleteDescriptionId = `agent-delete-description-${config.id}`;

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
      setMessage({
        kind: "success",
        text: action === "suspend" ? m.agent_settings_agent_paused() : m.agent_settings_agent_resumed(),
      });
      setRestorePauseFocus(confirmation === "pause");
      setConfirmation(undefined);
      onAgentChanged();
    } catch {
      const error = action === "suspend" ? m.agent_settings_pause_failed() : m.agent_settings_resume_failed();
      if (confirmation === "pause") setConfirmationError(error);
      else setMessage({ kind: "error", text: error });
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
      await queryClient.cancelQueries({ queryKey: queryKeys.agents.listRoot() });
      await queryClient.cancelQueries({ queryKey: queryKeys.agents.all(config.id) });
      queryClient.setQueriesData<ListAgentsResponse>({ queryKey: queryKeys.agents.listRoot() }, (current) =>
        current ? { ...current, agents: current.agents.filter((item) => item.id !== config.id) } : current,
      );
      queryClient.removeQueries({ queryKey: queryKeys.agents.all(config.id) });
      void navigate({ to: "/agents" });
    } catch {
      setConfirmationError(m.agent_settings_delete_failed());
      setBusy(false);
    }
  }

  function closeConfirmation() {
    setConfirmation(undefined);
    setConfirmationError(undefined);
  }

  const active = config.status === "active";
  const working = active && agent.activity.state === "working";
  const statusDescription = working
    ? m.agent_settings_status_working_description()
    : active
      ? m.agent_settings_status_active_description()
      : m.agent_settings_status_paused_description();

  return (
    <section className="grid gap-6">
      <header className="grid gap-2">
        <Text as="h1" size="lg" variant="heading">
          {m.agent_settings_pause_or_delete()}
        </Text>
      </header>

      <SettingsList>
        <SettingsRow
          description={<span id={statusDescriptionId}>{statusDescription}</span>}
          label={m.agent_settings_agent_status()}
        >
          <div className="flex justify-start @min-[44rem]/workspace:justify-end">
            <Button
              aria-describedby={statusDescriptionId}
              className="w-full @min-[44rem]/workspace:w-auto"
              disabled={busy}
              ref={pauseButtonRef}
              variant={active ? "secondary" : "primary"}
              onClick={() => {
                if (working) {
                  setConfirmationError(undefined);
                  setConfirmation("pause");
                  return;
                }
                void changeLifecycle(active ? "suspend" : "reactivate");
              }}
            >
              {busy
                ? active
                  ? m.agent_settings_pausing()
                  : m.agent_settings_resuming()
                : active
                  ? m.agent_settings_pause_button()
                  : m.agent_settings_resume_button()}
            </Button>
          </div>
        </SettingsRow>
      </SettingsList>

      <SettingsList>
        <SettingsRow
          description={
            <span id={deleteDescriptionId}>
              {active ? m.agent_settings_delete_active_description() : m.agent_settings_delete_paused_description()}
            </span>
          }
          label={m.agent_settings_delete_button()}
        >
          <div className="flex justify-start @min-[44rem]/workspace:justify-end">
            <Button
              aria-describedby={deleteDescriptionId}
              className="w-full @min-[44rem]/workspace:w-auto"
              disabled={active}
              ref={deleteButtonRef}
              variant="danger"
              onClick={() => {
                setConfirmationText("");
                setConfirmationError(undefined);
                setConfirmation("delete");
              }}
            >
              {m.agent_settings_delete_button()}
            </Button>
          </div>
        </SettingsRow>
      </SettingsList>

      {message ? (
        <Banner
          description={message.text}
          role={message.kind === "error" ? "alert" : "status"}
          variant={message.kind === "error" ? "error" : "secondary"}
        />
      ) : null}

      {confirmation === "pause" ? (
        <Dialog
          busy={busy}
          description={m.agent_settings_pause_confirm_description()}
          returnFocusRef={pauseButtonRef}
          title={m.agent_settings_pause_confirm_title({ agentName: config.displayName })}
          onClose={closeConfirmation}
        >
          {confirmationError ? <Banner variant="error" role="alert" description={confirmationError} /> : null}
          <div className="flex flex-wrap justify-end gap-3">
            <Button disabled={busy} variant="ghost" onClick={closeConfirmation}>
              {m.agent_settings_keep_active()}
            </Button>
            <Button disabled={busy} variant="secondary" onClick={() => void changeLifecycle("suspend")}>
              {busy ? m.agent_settings_pausing() : m.agent_settings_pause_button()}
            </Button>
          </div>
        </Dialog>
      ) : null}

      {confirmation === "delete" ? (
        <Dialog
          busy={busy}
          description={m.agent_settings_delete_confirm_description()}
          returnFocusRef={deleteButtonRef}
          title={m.agent_settings_delete_confirm_title({ agentName: config.displayName })}
          onClose={closeConfirmation}
        >
          <div className="grid gap-4">
            <Field
              htmlFor="agent-delete-confirmation"
              label={m.agent_settings_delete_confirm_label({ agentName: config.displayName })}
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
                {m.common_cancel()}
              </Button>
              <Button
                disabled={busy || confirmationText !== config.displayName}
                variant="danger"
                onClick={() => void deleteAgent()}
              >
                {busy ? m.agent_settings_deleting() : m.agent_settings_delete_final_button()}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
