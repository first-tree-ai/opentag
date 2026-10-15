import type { AgentSummary, ImBindingSummary } from "@opentag/shared/browser";
import { type RefObject, useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import { spaceScriptBoundary } from "../../../i18n/format.js";
import { FeishuSetup } from "../../../im/feishu-setup.js";
import { messagingProviderLabel } from "../../../im/provider-label.js";
import { SlackConfiguration } from "../../../im/slack-configuration.js";
import { SlackCustomApp } from "../../../im/slack-custom-app.js";
import * as m from "../../../paraglide/messages.js";
import { Banner, Button, Dialog, StatusIndicator, Text } from "../../../ui/design-system.js";
import { ProviderIcon } from "../../../ui/provider-icon.js";
import { AsyncState, toResourceState } from "../../resource/resource-state.js";
import type { AgentDetailView } from "../agent-model.js";
import { messagingConnectionLabel, messagingConnectionTone } from "../agent-presentation.js";
import { useImBindingQuery } from "../agent-queries.js";

type Confirmation = { bindingId: string; provider: ImBindingSummary["provider"] };

export function ImTab({ agent, onAgentChanged }: { agent: AgentDetailView; onAgentChanged: () => void }) {
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
    if (receiveModePending) return;
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
        <p className="text-sm text-kumo-subtle">{m.im_messaging_page_description()}</p>
      </header>
      <FeishuSetup
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
              const connectFeishu = async (intent: "create" | "reauthorize" | "replace" = "create") => {
                setError(undefined);
                setSuccessMessage(undefined);
                await feishuSetup.start(intent);
              };
              const connectSlack = async (intent: "create" | "reauthorize" = "create") => {
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
                          <>
                            <Text as="h2" variant="heading">
                              {m.im_messaging_app()}
                            </Text>
                            <div
                              className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3"
                              data-ui="messaging-app-identity"
                            >
                              <ProviderIcon className="size-6" provider={binding.provider} />
                              <span className="grid min-w-0 justify-items-start gap-1">
                                <strong className="text-base font-semibold text-kumo-strong">
                                  {binding.bot.displayName ?? messagingProviderLabel(binding.provider)}
                                </strong>
                                <StatusIndicator
                                  label={messagingConnectionLabel(binding)}
                                  tone={messagingConnectionTone(binding)}
                                />
                              </span>
                            </div>
                          </>
                        ) : null}
                        <MessagingConnectionActions
                          agent={agent}
                          binding={binding}
                          onAgentChanged={onAgentChanged}
                          busy={feishuSetup.loading || slackConfiguration.loading}
                          feishuBusy={feishuSetup.loading}
                          disconnectRef={disableBindingButtonRef}
                          onSlack={
                            agent.slackOAuthAvailable !== false ? () => void connectSlack("reauthorize") : undefined
                          }
                          onDisconnect={(current) => {
                            setConfirmationError(undefined);
                            setConfirmation({ bindingId: current.id, provider: current.provider });
                          }}
                          onFeishu={(intent, target) => {
                            activeFeishuTriggerRef.current = target;
                            void connectFeishu(intent);
                          }}
                        />
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
                          <div className="grid gap-3">
                            <fieldset
                              aria-label={m.im_receive_mode()}
                              className="flex w-fit flex-wrap items-center gap-1 rounded-md bg-kumo-recessed p-1"
                            >
                              <TriggerModeOption
                                busy={receiveModePending}
                                label={m.im_mentions_only()}
                                selected={binding.receiveMode === "mention_only"}
                                onSelect={() => void changeReceiveMode("mention_only")}
                              />
                              <TriggerModeOption
                                busy={receiveModePending}
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
            m.im_disconnect_description({ providerName: messagingProviderLabel(confirmation.provider) }),
          )}
          returnFocusRef={confirmation?.provider === "slack" ? messagingHeadingRef : disableBindingButtonRef}
          title={spaceScriptBoundary(
            m.im_disconnect_title({ providerName: messagingProviderLabel(confirmation.provider) }),
          )}
          onClose={closeConfirmation}
        >
          {confirmationError ? <Banner variant="error" role="alert" description={confirmationError} /> : null}
          <div className="flex flex-wrap justify-end gap-3">
            <Button disabled={confirmationBusy} variant="ghost" onClick={closeConfirmation}>
              {m.im_disconnect_cancel()}
            </Button>
            <Button
              loading={confirmationBusy}
              disabled={confirmationBusy}
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

/** The Slack dialog stays mounted across the unbound-to-bound refresh. */
function MessagingConnectionActions({
  agent,
  binding,
  onAgentChanged,
  busy,
  feishuBusy,
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
  disconnectRef: RefObject<HTMLButtonElement | null>;
  onSlack?: () => void;
  onDisconnect: (binding: ImBindingSummary) => void;
  onFeishu: (intent: "create" | "reauthorize" | "replace", target: HTMLButtonElement) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {binding?.provider !== "feishu" ? (
        <SlackCustomApp
          agentId={agent.id}
          bindingId={binding?.id}
          onSaved={onAgentChanged}
          manualOnly={agent.computerKind === "cloud"}
          onOAuth={binding ? onSlack : undefined}
          onDisconnect={binding ? () => onDisconnect(binding) : undefined}
        />
      ) : null}
      {binding?.provider === "feishu" ? (
        <>
          <MessagingAppActions binding={binding} busy={busy} feishuBusy={feishuBusy} onFeishu={onFeishu} />
          <Button ref={disconnectRef} variant="secondary-destructive" onClick={() => onDisconnect(binding)}>
            {spaceScriptBoundary(m.im_disconnect({ providerName: messagingProviderLabel(binding.provider) }))}
          </Button>
        </>
      ) : !binding ? (
        <Button
          icon={<ProviderIcon className="size-4" provider="feishu" />}
          loading={feishuBusy}
          disabled={feishuBusy}
          variant="secondary"
          onClick={(event) => onFeishu("create", event.currentTarget)}
        >
          {m.im_connect_feishu({ provider: messagingProviderLabel("feishu") })}
        </Button>
      ) : null}
    </div>
  );
}

function MessagingAppActions({
  binding,
  busy,
  feishuBusy,
  onFeishu,
}: {
  binding: ImBindingSummary;
  busy: boolean;
  feishuBusy: boolean;
  onFeishu: (intent: "reauthorize" | "replace", target: HTMLButtonElement) => void;
}) {
  return (
    <>
      {messagingRecoveryLabel(binding) ? (
        <Button disabled={busy} loading={busy} onClick={(event) => onFeishu("reauthorize", event.currentTarget)}>
          {messagingRecoveryLabel(binding)}
        </Button>
      ) : null}
      <Button
        loading={feishuBusy}
        disabled={feishuBusy}
        variant="secondary"
        onClick={(event) => onFeishu("replace", event.currentTarget)}
      >
        {m.im_change_bot()}
      </Button>
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
