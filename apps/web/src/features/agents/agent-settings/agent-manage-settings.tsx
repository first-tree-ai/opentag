import type { AgentAdminConfig } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiError, browserApi } from "../../../api.js";
import * as m from "../../../paraglide/messages.js";
import { evictAgentFromLists } from "../../../query/agent-sync.js";
import { queryKeys } from "../../../query/keys.js";
import {
  Banner,
  Button,
  Dialog,
  Field,
  KumoInputControl,
  SettingsList,
  SettingsRow,
} from "../../../ui/design-system.js";
import type { AgentDetailView } from "../agent-model.js";
import { AgentSettingsPageHeader } from "./settings-layout.js";

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

  /*
   * The Server deletes only a paused Agent. The reader has already confirmed the delete, so an
   * active Agent is paused first, in the same action. Each step that fails says what state it left.
   */
  async function deleteAgent() {
    setBusy(true);
    setMessage(undefined);
    setConfirmationError(undefined);
    const pauseFirst = config.status === "active";
    if (pauseFirst) {
      try {
        setConfig(await browserApi.suspendAgent(config.id));
        onAgentChanged();
      } catch (cause) {
        setConfirmationError(deleteFailure(cause, "pause"));
        setBusy(false);
        return;
      }
    }
    try {
      await browserApi.deleteAgent(config.id);
      // A confirmed delete is stronger than a later list revalidation. Evict the Agent from every
      // cached list and remove its detail/config/evidence entries before the navigation can render
      // stale data after a transient list failure.
      await queryClient.cancelQueries({ queryKey: queryKeys.agents.listRoot() });
      await queryClient.cancelQueries({ queryKey: queryKeys.agents.all(config.id) });
      evictAgentFromLists(queryClient, config.id);
      queryClient.removeQueries({ queryKey: queryKeys.agents.all(config.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.computers() });
      void navigate({ to: "/agents" });
    } catch (cause) {
      setConfirmationError(deleteFailure(cause, pauseFirst ? "delete-after-pause" : "delete"));
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
      <AgentSettingsPageHeader title={m.agent_settings_pause_or_delete()} />

      <SettingsList>
        <SettingsRow
          description={<span id={statusDescriptionId}>{statusDescription}</span>}
          label={m.agent_settings_agent_status()}
        >
          <div className="flex justify-start @min-[44rem]/content:justify-end">
            <Button
              aria-busy={busy || undefined}
              aria-describedby={statusDescriptionId}
              className="w-full @min-[44rem]/content:w-auto"
              ref={pauseButtonRef}
              variant={active ? "secondary" : "primary"}
              onClick={() => {
                // Stays enabled while busy so keyboard focus is kept; repeats are ignored instead.
                if (busy) return;
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
          description={<span id={deleteDescriptionId}>{m.agent_settings_delete_paused_description()}</span>}
          label={m.agent_settings_delete_button()}
        >
          <div className="flex justify-start @min-[44rem]/content:justify-end">
            <Button
              aria-describedby={deleteDescriptionId}
              className="w-full @min-[44rem]/content:w-auto"
              disabled={busy}
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

/** A failed step of the delete, in the reader's terms: what happened and what state it left. */
function deleteFailure(cause: unknown, step: "pause" | "delete" | "delete-after-pause"): string {
  if (cause instanceof ApiError && cause.status === 403) return m.agent_settings_delete_forbidden();
  if (step === "pause") return m.agent_settings_delete_pause_failed();
  if (step === "delete-after-pause") return m.agent_settings_delete_failed_after_pause();
  return m.agent_settings_delete_failed();
}
