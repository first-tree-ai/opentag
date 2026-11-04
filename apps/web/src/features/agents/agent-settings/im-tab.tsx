import type { AgentSetupSnapshot, AgentSummary, ImBindingSummary } from "@opentag/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type RefObject, useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import { spaceScriptBoundary } from "../../../i18n/format.js";
import { FeishuSetup } from "../../../im/feishu-setup.js";
import { messagingProviderLabel } from "../../../im/provider-label.js";
import { SlackConfiguration } from "../../../im/slack-configuration.js";
import { SlackCustomApp } from "../../../im/slack-custom-app.js";
import * as m from "../../../paraglide/messages.js";
import { Banner, Button, buttonClassName, Dialog, StatusIndicator, Text } from "../../../ui/design-system.js";
import { ProviderIcon } from "../../../ui/provider-icon.js";
import { AsyncState, toResourceState } from "../../resource/resource-state.js";
import type { AgentDetailView } from "../agent-model.js";
import { messagingConnectionLabel, messagingConnectionTone } from "../agent-presentation.js";
import { useImBindingQuery } from "../agent-queries.js";
import { agentCreateLink, agentSetupLink } from "../agent-routes.js";

type Confirmation = { bindingId: string; provider: ImBindingSummary["provider"]; configured: boolean };

export function ImTab({ agent, onAgentChanged }: { agent: AgentDetailView; onAgentChanged: () => void }) {
  const readOnly = agent.status === "suspended";
  const [error, setError] = useState<string>();
  const [successMessage, setSuccessMessage] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [confirmationError, setConfirmationError] = useState<string>();
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [restoreFocusTarget, setRestoreFocusTarget] = useState<"messaging" | "trigger_rules">();
  const [receiveModePending, setReceiveModePending] = useState(false);
  const disableBindingButtonRef = useRef<HTMLButtonElement>(null);
  const activeFeishuTriggerRef = useRef<HTMLElement | null>(null);
  const messagingHeadingRef = useRef<HTMLHeadingElement>(null);
  const triggerRulesHeadingRef = useRef<HTMLHeadingElement>(null);
  const state = toResourceState(useImBindingQuery(agent.id));

  useEffect(() => {
    if (confirmation || !restoreFocusTarget) return;
    const target = restoreFocusTarget === "messaging" ? messagingHeadingRef.current : triggerRulesHeadingRef.current;
    target?.focus();
    setRestoreFocusTarget(undefined);
  }, [confirmation, restoreFocusTarget]);

  async function changeReceiveMode(receiveMode: "mention_only" | "all_message") {
    if (readOnly || receiveModePending) return;
    try {
      setReceiveModePending(true);
      setError(undefined);
      setSuccessMessage(undefined);
      const config = await browserApi.agentConfig(agent.id);
      await browserApi.updateAgent(agent.id, { expectedRevision: config.revision, receiveMode });
      setRestoreFocusTarget("trigger_rules");
      onAgentChanged();
    } catch {
      setError(m.im_receive_mode_failed());
    } finally {
      setReceiveModePending(false);
    }
  }

  async function disableBinding(bindingId: string, provider: ImBindingSummary["provider"]) {
    if (readOnly) return;
    try {
      setConfirmationBusy(true);
      setError(undefined);
      setSuccessMessage(undefined);
      setConfirmationError(undefined);
      await browserApi.disableImBinding(bindingId);
      setRestoreFocusTarget("messaging");
      setConfirmation(undefined);
      onAgentChanged();
    } catch {
      setConfirmationError(
        spaceScriptBoundary(m.im_disconnect_failed({ providerName: messagingProviderLabel(provider) })),
      );
    } finally {
      setConfirmationBusy(false);
    }
  }

  function closeConfirmation() {
    setConfirmation(undefined);
    setConfirmationError(undefined);
  }

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Text as="h1" ref={messagingHeadingRef} size="lg" tabIndex={-1} variant="heading">
          {m.im_messaging_page_title()}
        </Text>
      </header>
      {readOnly ? <Banner variant="secondary" role="status" description={m.im_paused_read_only()} /> : null}
      <FeishuSetup
        readOnly={readOnly}
        agentId={agent.id}
        presentation="dialog"
        restoreSavedAttempt
        returnFocusRef={activeFeishuTriggerRef}
        onSuccess={() => {
          setSuccessMessage(m.im_feishu_connected({ provider: messagingProviderLabel("feishu") }));
          onAgentChanged();
        }}
      >
        {(feishuSetup) => (
          <SlackConfiguration
            agentId={agent.id}
            onSuccess={() => {
              onAgentChanged();
            }}
          >
            {(slackConfiguration) => {
              const connectFeishu = async (intent: "create" | "reauthorize" = "create") => {
                setError(undefined);
                setSuccessMessage(undefined);
                await feishuSetup.start(intent);
              };
              const connectSlack = async (intent: "create" | "reauthorize" = "create") => {
                if (readOnly) return;
                setError(undefined);
                setSuccessMessage(undefined);
                await slackConfiguration.startOAuth(intent);
              };
              return (
                <AsyncState state={state}>
                  {(binding) => (
                    <div className="grid gap-6">
                      {/*
                       * With nothing connected the page holds one thing to do and its own title and
                       * sentence already name it, so a heading here would say it a third time. Once
                       * a channel is connected the page carries two sections, and this one needs a
                       * label of its own to stay distinct from the receive mode below it.
                       */}
                      <section aria-label={m.im_messaging_app()} className="grid gap-4">
                        {binding ? (
                          <Text as="h2" variant="heading">
                            {m.im_messaging_app()}
                          </Text>
                        ) : null}
                        {/* The same surface as other settings pages, so the page reads as one family. */}
                        <div className={MESSAGING_SURFACE}>
                          {binding ? <MessagingAppIdentity binding={binding} /> : null}
                          <MessagingConnectionActions
                            agent={agent}
                            binding={binding}
                            onAgentChanged={onAgentChanged}
                            readOnly={readOnly}
                            busy={feishuSetup.loading || slackConfiguration.loading}
                            feishuBusy={feishuSetup.loading}
                            disconnectRef={disableBindingButtonRef}
                            onSlack={
                              agent.slackOAuthAvailable !== false ? () => void connectSlack("reauthorize") : undefined
                            }
                            onDisconnect={(current) => {
                              setConfirmationError(undefined);
                              setConfirmation({
                                bindingId: current.id,
                                provider: current.provider,
                                configured: current.bindingState !== "provisioning",
                              });
                            }}
                            onFeishu={(intent, target) => {
                              activeFeishuTriggerRef.current = target;
                              void connectFeishu(intent);
                            }}
                          />
                        </div>
                      </section>
                      {feishuSetup.feedback}

                      {binding ? (
                        <section className="grid gap-4" aria-labelledby="trigger-rules-heading">
                          <div className="grid gap-2">
                            <Text
                              as="h2"
                              id="trigger-rules-heading"
                              ref={triggerRulesHeadingRef}
                              tabIndex={-1}
                              variant="heading"
                            >
                              {m.im_receive_mode()}
                            </Text>
                            <p className="text-sm text-kumo-subtle">{triggerModeExplanation(binding.provider)}</p>
                          </div>
                          <div className={MESSAGING_SURFACE}>
                            <fieldset
                              aria-label={m.im_receive_mode()}
                              className="flex w-fit flex-wrap items-center gap-1 rounded-md bg-kumo-recessed p-1"
                            >
                              <TriggerModeOption
                                busy={readOnly || receiveModePending}
                                label={m.im_mentions_only()}
                                selected={binding.receiveMode === "mention_only"}
                                onSelect={() => void changeReceiveMode("mention_only")}
                              />
                              <TriggerModeOption
                                busy={readOnly || receiveModePending}
                                label={m.im_every_message()}
                                selected={binding.receiveMode === "all_message"}
                                onSelect={() => void changeReceiveMode("all_message")}
                              />
                            </fieldset>
                            <p className="text-sm text-kumo-subtle">{triggerModeDescription(binding.receiveMode)}</p>
                          </div>
                        </section>
                      ) : null}

                      {slackConfiguration.feedback}
                      {successMessage ? (
                        <Banner variant="secondary" role="status" description={successMessage} />
                      ) : null}
                      {error ? <Banner variant="error" role="alert" description={error} /> : null}
                    </div>
                  )}
                </AsyncState>
              );
            }}
          </SlackConfiguration>
        )}
      </FeishuSetup>

      {confirmation ? (
        <Dialog
          busy={confirmationBusy}
          description={spaceScriptBoundary(
            confirmation.configured
              ? m.im_disconnect_description({ providerName: messagingProviderLabel(confirmation.provider) })
              : m.im_cancel_initial_setup_description(),
          )}
          returnFocusRef={confirmation?.provider === "slack" ? messagingHeadingRef : disableBindingButtonRef}
          title={spaceScriptBoundary(
            m.im_disconnect_title({ providerName: messagingProviderLabel(confirmation.provider) }),
          )}
          onClose={closeConfirmation}
        >
          {confirmationError ? <Banner variant="error" role="alert" description={confirmationError} /> : null}
          <div className="flex flex-wrap justify-end gap-3">
            <Button disabled={readOnly || confirmationBusy} variant="ghost" onClick={closeConfirmation}>
              {m.im_disconnect_cancel()}
            </Button>
            <Button
              loading={confirmationBusy}
              disabled={readOnly || confirmationBusy}
              variant="danger"
              onClick={() => void disableBinding(confirmation.bindingId, confirmation.provider)}
            >
              {spaceScriptBoundary(m.im_disconnect({ providerName: messagingProviderLabel(confirmation.provider) }))}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

const MESSAGING_SURFACE = "ui-surface grid gap-3 bg-kumo-base p-4";

/** The Slack dialog stays mounted across the unbound-to-bound refresh. */
function MessagingConnectionActions({
  agent,
  binding,
  onAgentChanged,
  busy,
  feishuBusy,
  readOnly,
  disconnectRef,
  onSlack,
  onDisconnect,
  onFeishu,
}: {
  agent: AgentDetailView;
  binding: ImBindingSummary | null | undefined;
  onAgentChanged: () => void;
  busy: boolean;
  feishuBusy: boolean;
  readOnly: boolean;
  disconnectRef: RefObject<HTMLButtonElement | null>;
  onSlack?: () => void;
  onDisconnect: (binding: ImBindingSummary) => void;
  onFeishu: (intent: "create" | "reauthorize", target: HTMLButtonElement) => void;
}) {
  const creation = useQuery({
    queryKey: ["agent-messaging-creation", agent.id],
    queryFn: () => browserApi.agentSetup(agent.id),
    gcTime: 0,
    enabled: !binding,
  });
  const canCreate = creation.isSuccess && allowsMessagingCreation(creation.data, readOnly);
  const needsCreationRecovery = !binding && !canCreate;
  return (
    <div className="flex flex-wrap items-center gap-3">
      {binding?.provider !== "feishu" ? (
        <SlackCustomApp
          agentId={agent.id}
          readOnly={readOnly}
          bindingId={binding?.id}
          onSaved={onAgentChanged}
          cloud={agent.computerKind === "cloud"}
          renderTrigger={needsCreationRecovery ? () => null : undefined}
          onOAuth={binding ? onSlack : undefined}
          onDisconnect={binding ? () => onDisconnect(binding) : undefined}
        />
      ) : null}
      {binding?.provider === "feishu" ? (
        <>
          <MessagingAppActions binding={binding} busy={busy} readOnly={readOnly} onFeishu={onFeishu} />
          <Button
            disabled={readOnly}
            ref={disconnectRef}
            variant="secondary-destructive"
            onClick={() => onDisconnect(binding)}
          >
            {spaceScriptBoundary(m.im_disconnect({ providerName: messagingProviderLabel(binding.provider) }))}
          </Button>
        </>
      ) : !binding && canCreate ? (
        <Button
          icon={<ProviderIcon className="size-4" provider="feishu" />}
          loading={feishuBusy}
          disabled={readOnly || feishuBusy}
          variant="secondary"
          onClick={(event) => onFeishu("create", event.currentTarget)}
        >
          {m.im_connect_feishu({ provider: messagingProviderLabel("feishu") })}
        </Button>
      ) : null}
      {needsCreationRecovery ? (
        <AsyncState state={toResourceState(creation)}>
          {(snapshot) =>
            snapshot.messaging.kind === "blocked" &&
            snapshot.messaging.errorCode === "IM_BINDING_IDENTITY_DISCONNECTED" ? (
              <div className="grid justify-items-start gap-3">
                <p>{m.im_identity_disconnected()}</p>
                <Link {...agentCreateLink()} className={buttonClassName({ variant: "primary" })}>
                  {m.agents_new_agent()}
                </Link>
              </div>
            ) : (
              <Link {...agentSetupLink(agent.id)} className={buttonClassName({ variant: "secondary" })}>
                {m.agents_continue_setup()}
              </Link>
            )
          }
        </AsyncState>
      ) : null}
    </div>
  );
}

function allowsMessagingCreation(snapshot: AgentSetupSnapshot, readOnly: boolean): boolean {
  return (
    snapshot.actions.some((action) => action.kind === "start-messaging") ||
    (readOnly && snapshot.messaging.kind === "not-configured")
  );
}

function MessagingAppActions({
  binding,
  busy,
  readOnly,
  onFeishu,
}: {
  binding: ImBindingSummary;
  busy: boolean;
  readOnly: boolean;
  onFeishu: (intent: "reauthorize", target: HTMLButtonElement) => void;
}) {
  return (
    <>
      {messagingRecoveryLabel(binding) ? (
        <Button
          disabled={readOnly || busy}
          loading={busy}
          onClick={(event) => onFeishu("reauthorize", event.currentTarget)}
        >
          {messagingRecoveryLabel(binding)}
        </Button>
      ) : null}
    </>
  );
}

function TriggerModeOption({
  busy = false,
  label,
  onSelect,
  selected,
}: {
  busy?: boolean;
  label: string;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <Button
      aria-pressed={selected}
      disabled={busy}
      size="compact"
      type="button"
      variant={selected ? "secondary" : "inline"}
      onClick={selected ? undefined : onSelect}
    >
      {label}
    </Button>
  );
}

/** Why openTag stopped connecting this binding, and what fixes it; nothing for any other state. */
function connectionFailureMessage(binding: ImBindingSummary): string | undefined {
  if (binding.bindingState !== "error" || !binding.connectionFailure) return undefined;
  const provider = messagingProviderLabel(binding.provider);
  const message = {
    credentials_rejected: m.im_connection_failure_credentials_rejected(),
    app_unavailable: m.im_connection_failure_app_unavailable({ provider }),
    connection_rejected: m.im_connection_failure_connection_rejected({ provider }),
    bot_mismatch: m.im_connection_failure_bot_mismatch(),
  }[binding.connectionFailure];
  return spaceScriptBoundary(message);
}

function messagingRecoveryLabel(binding: ImBindingSummary): string | undefined {
  if (binding.bindingState === "reauthorization_required") return m.im_update_permissions();
  if (binding.bindingState === "error" || binding.bindingState === "disabled") return m.im_reconnect();
  return undefined;
}

function triggerModeExplanation(provider: ImBindingSummary["provider"]): string {
  return provider === "feishu" ? m.im_group_chat_messages_description() : m.im_channel_messages_description();
}

function triggerModeDescription(receiveMode: AgentSummary["receiveMode"]): string {
  return receiveMode === "all_message" ? m.im_every_message_description() : m.im_mentions_only_description();
}

/** The connected app's identity, its connection state, and why a failed connection failed. */
function MessagingAppIdentity({ binding }: { binding: ImBindingSummary }) {
  const failure = connectionFailureMessage(binding);
  return (
    <>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3" data-ui="messaging-app-identity">
        <ProviderIcon className="size-6" provider={binding.provider} />
        <span className="grid min-w-0 justify-items-start gap-1">
          <strong className="text-base font-semibold text-kumo-strong">
            {binding.bot.displayName ?? messagingProviderLabel(binding.provider)}
          </strong>
          <StatusIndicator label={messagingConnectionLabel(binding)} tone={messagingConnectionTone(binding)} />
        </span>
      </div>
      {failure ? (
        <p className="text-sm text-kumo-default" data-ui="messaging-connection-failure">
          {failure}
        </p>
      ) : null}
    </>
  );
}
