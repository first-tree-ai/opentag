import type { AgentSummary, ImBindingSummary } from "@opentag/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type Ref, useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import { formatDateTime } from "../../../i18n/format.js";
import { FeishuSetup } from "../../../im/feishu-setup.js";
import { SlackConfiguration } from "../../../im/slack-configuration.js";
import * as m from "../../../paraglide/messages.js";
import { queryKeys } from "../../../query/keys.js";
import { Banner, Button, Dialog, StatusIndicator, Text } from "../../../ui/design-system.js";
import { ProviderIcon } from "../../../ui/provider-icon.js";
import { AsyncState, toResourceState } from "../../resource/resource-state.js";
import type { AgentDetailView } from "../agent-model.js";
import {
  messagingConnectionLabel,
  messagingConnectionTone,
  runtimeProviderName,
  titleCase,
} from "../agent-presentation.js";
import { agentSettingsSectionLink } from "../agent-routes.js";

export function ImTab({ agent, onAgentChanged }: { agent: AgentDetailView; onAgentChanged: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const [confirmation, setConfirmation] = useState<{ bindingId: string; kind: "disable_binding" }>();
  const [confirmationError, setConfirmationError] = useState<string>();
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [restoreFocusTarget, setRestoreFocusTarget] = useState<"messaging" | "trigger_rules">();
  const [confirmingEveryMessage, setConfirmingEveryMessage] = useState(false);
  const [receiveModePending, setReceiveModePending] = useState(false);
  const allMessagesButtonRef = useRef<HTMLButtonElement>(null);
  const disableBindingButtonRef = useRef<HTMLButtonElement>(null);
  const messagingHeadingRef = useRef<HTMLHeadingElement>(null);
  const triggerRulesHeadingRef = useRef<HTMLHeadingElement>(null);
  // Re-reading the same key keeps the binding on screen while the write settles, so there is no
  // need for the placeholder the composite key used to require.
  const reload = () => void queryClient.invalidateQueries({ queryKey: queryKeys.agents.imBinding(agent.id) });
  const state = toResourceState(
    useQuery({
      queryKey: queryKeys.agents.imBinding(agent.id),
      queryFn: () => browserApi.imBinding(agent.id).then((binding) => binding ?? null),
    }),
  );
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
      setConfirmationBusy(true);
      setError(undefined);
      setConfirmationError(undefined);
      const config = await browserApi.agentConfig(agent.id);
      await browserApi.updateAgent(agent.id, { expectedRevision: config.revision, receiveMode });
      reload();
      setRestoreFocusTarget("trigger_rules");
      onAgentChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.agent_settings_change_receive_mode_failed());
    } finally {
      setReceiveModePending(false);
      setConfirmationBusy(false);
    }
  }
  async function disableBinding(bindingId: string) {
    try {
      setConfirmationBusy(true);
      setError(undefined);
      setConfirmationError(undefined);
      await browserApi.disableImBinding(bindingId);
      reload();
      setRestoreFocusTarget("messaging");
      setConfirmation(undefined);
      onAgentChanged();
    } catch (cause) {
      setConfirmationError(cause instanceof Error ? cause.message : m.agent_settings_disconnect_messaging_failed());
    } finally {
      setConfirmationBusy(false);
    }
  }
  function closeMessagingConfirmation() {
    setConfirmation(undefined);
    setConfirmationError(undefined);
  }
  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Text as="h1" ref={messagingHeadingRef} size="lg" tabIndex={-1} variant="heading">
          {m.agent_settings_messaging_title()}
        </Text>
      </header>
      <FeishuSetup
        agentId={agent.id}
        onSuccess={() => {
          reload();
          onAgentChanged();
        }}
      >
        {(feishuSetup) => (
          <SlackConfiguration
            agentId={agent.id}
            onSuccess={() => {
              reload();
              onAgentChanged();
            }}
          >
            {(slackConfiguration) => {
              const connectFeishu = async (intent: "create" | "reauthorize" | "replace" = "create") => {
                setError(undefined);
                await feishuSetup.start(intent);
              };
              const connectSlack = async (intent: "create" | "reauthorize" = "create") => {
                setError(undefined);
                await slackConfiguration.startOAuth(intent);
              };
              return (
                <AsyncState state={state}>
                  {(binding) => (
                    <div className="grid gap-6">
                      {binding ? (
                        <>
                          <section
                            className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
                            aria-labelledby="contact-channel-heading"
                          >
                            <div className="grid gap-2">
                              <Text as="h3" id="contact-channel-heading" variant="heading">
                                {m.agent_settings_connected_channel_title()}
                              </Text>
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                              <ProviderIcon className="size-6" provider={binding.provider} />
                              <span className="grid min-w-0 gap-1">
                                <strong>{binding.bot.displayName ?? titleCase(binding.provider)}</strong>
                                <small className="text-kumo-subtle">{messagingChannelDetail(agent, binding)}</small>
                              </span>
                              <StatusIndicator
                                detail={
                                  binding.lastRuntimeObservationAt
                                    ? m.agent_settings_last_observed({
                                        date: formatDateTime(binding.lastRuntimeObservationAt),
                                      })
                                    : binding.lastValidatedAt
                                      ? m.agent_settings_validated({ date: formatDateTime(binding.lastValidatedAt) })
                                      : m.agent_settings_not_yet_observed()
                                }
                                label={messagingConnectionLabel(binding)}
                                tone={messagingConnectionTone(binding)}
                              />
                            </div>
                            <MessagingChannelNote agent={agent} binding={binding} />
                            <div className="flex flex-wrap items-center gap-3">
                              {messagingRecoveryLabel(binding) ? (
                                <Button
                                  disabled={feishuSetup.loading || slackConfiguration.loading}
                                  loading={feishuSetup.loading || slackConfiguration.loading}
                                  size="compact"
                                  onClick={() =>
                                    void (binding.provider === "feishu"
                                      ? connectFeishu("reauthorize")
                                      : connectSlack("reauthorize"))
                                  }
                                >
                                  {messagingRecoveryLabel(binding)}
                                </Button>
                              ) : null}
                              {binding.provider === "feishu" ? (
                                <Button
                                  loading={feishuSetup.loading}
                                  disabled={feishuSetup.loading}
                                  size="compact"
                                  variant="outline"
                                  onClick={() => void connectFeishu("replace")}
                                >
                                  {m.agent_settings_change_feishu_bot()}
                                </Button>
                              ) : null}
                              <Button
                                ref={disableBindingButtonRef}
                                size="compact"
                                variant="danger"
                                onClick={() => {
                                  setConfirmationError(undefined);
                                  setConfirmation({ bindingId: binding.id, kind: "disable_binding" });
                                }}
                              >
                                {m.agent_settings_disconnect_provider({ provider: titleCase(binding.provider) })}
                              </Button>
                            </div>
                          </section>
                          <section
                            className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
                            aria-labelledby="trigger-rules-heading"
                          >
                            <div className="grid gap-2">
                              <Text
                                as="h3"
                                id="trigger-rules-heading"
                                ref={triggerRulesHeadingRef}
                                tabIndex={-1}
                                variant="heading"
                              >
                                {triggerModeHeading(binding.provider)}
                              </Text>
                              <p className="text-sm text-kumo-subtle">{triggerModeExplanation(binding.provider)}</p>
                            </div>
                            <div className="grid gap-3">
                              <fieldset
                                aria-label={triggerModeHeading(binding.provider)}
                                className="flex w-fit flex-wrap items-center gap-1 rounded-md bg-kumo-recessed p-1"
                              >
                                <TriggerModeOption
                                  busy={receiveModePending}
                                  label={m.agent_settings_on_mention()}
                                  selected={binding.receiveMode === "mention_only"}
                                  onSelect={() => {
                                    setConfirmingEveryMessage(false);
                                    void changeReceiveMode("mention_only");
                                  }}
                                />
                                <TriggerModeOption
                                  busy={receiveModePending}
                                  label={
                                    confirmingEveryMessage
                                      ? m.agent_settings_confirm_every_message()
                                      : m.agent_settings_every_message()
                                  }
                                  ref={allMessagesButtonRef}
                                  selected={binding.receiveMode === "all_message"}
                                  onSelect={() => {
                                    if (!confirmingEveryMessage) {
                                      setConfirmingEveryMessage(true);
                                      return;
                                    }
                                    setConfirmingEveryMessage(false);
                                    void changeReceiveMode("all_message");
                                  }}
                                />
                              </fieldset>
                              {confirmingEveryMessage ? (
                                <p className="text-sm text-kumo-subtle" role="status">
                                  {m.agent_settings_confirm_every_message_warning()}
                                </p>
                              ) : null}
                              <p className="text-sm text-kumo-subtle">
                                {triggerModeDescription(binding.receiveMode, binding.provider)}
                              </p>
                            </div>
                          </section>
                        </>
                      ) : (
                        <section
                          className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
                          aria-labelledby="contact-channel-heading"
                        >
                          <div className="grid gap-2">
                            <Text as="h3" id="contact-channel-heading" variant="heading">
                              {m.agent_settings_no_channel_connected()}
                            </Text>
                          </div>
                          <p className="text-sm text-kumo-subtle">{m.agent_settings_no_channel_description()}</p>
                          <div className="flex flex-wrap gap-3">
                            <Button
                              loading={feishuSetup.loading}
                              disabled={feishuSetup.loading}
                              onClick={() => void connectFeishu()}
                            >
                              {m.agent_settings_connect_feishu_bot()}
                            </Button>
                            <Button
                              loading={slackConfiguration.loading}
                              disabled={slackConfiguration.loading}
                              variant="secondary"
                              onClick={() => void connectSlack()}
                            >
                              {m.agent_settings_add_opentag_to_slack()}
                            </Button>
                          </div>
                        </section>
                      )}
                      {feishuSetup.feedback}
                      {slackConfiguration.feedback}
                      {error ? <Banner variant="error" role="alert" description={error} /> : null}
                    </div>
                  )}
                </AsyncState>
              );
            }}
          </SlackConfiguration>
        )}
      </FeishuSetup>
      {confirmation?.kind === "disable_binding" ? (
        <Dialog
          busy={confirmationBusy}
          description={m.agent_settings_disconnect_confirmation_description()}
          returnFocusRef={disableBindingButtonRef}
          title={m.agent_settings_disconnect_confirmation_title()}
          onClose={closeMessagingConfirmation}
        >
          {confirmationError ? <Banner variant="error" role="alert" description={confirmationError} /> : null}
          <div className="flex flex-wrap justify-end gap-3">
            <Button disabled={confirmationBusy} variant="ghost" onClick={closeMessagingConfirmation}>
              {m.agent_settings_keep_connected_action()}
            </Button>
            <Button
              loading={confirmationBusy}
              disabled={confirmationBusy}
              variant="danger"
              onClick={() => void disableBinding(confirmation.bindingId)}
            >
              {m.agent_settings_disconnect_action()}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * Both modes are always selectable, so both are always a button: a selected option rendered as static
 * text and an unselected one rendered as a ghost control read as a label next to a link.
 */
function TriggerModeOption({
  busy = false,
  label,
  onSelect,
  ref,
  selected,
}: {
  busy?: boolean;
  label: string;
  onSelect: () => void;
  ref?: Ref<HTMLButtonElement>;
  selected: boolean;
}) {
  return (
    <Button
      aria-pressed={selected}
      disabled={busy}
      ref={ref}
      size="compact"
      type="button"
      variant={selected ? "secondary" : "inline"}
      onClick={selected ? undefined : onSelect}
    >
      {label}
    </Button>
  );
}

/** The row already shows the Bot name above, so the line beneath it does not repeat it. */
function messagingChannelDetail(agent: AgentDetailView, binding: ImBindingSummary): string {
  return binding.provider === "feishu"
    ? m.agent_settings_channel_detail_with_name({ provider: titleCase(binding.provider), name: agent.name })
    : m.agent_settings_channel_detail({ provider: titleCase(binding.provider) });
}

/** The one repair a channel state offers, or nothing when the state cannot be repaired from here. */
function messagingRecoveryLabel(binding: ImBindingSummary): string | undefined {
  const provider = titleCase(binding.provider);
  if (binding.bindingState === "reauthorization_required") return m.agent_settings_reauthorize_provider({ provider });
  if (binding.bindingState === "error" || binding.bindingState === "disabled") {
    return m.agent_settings_reconnect_provider({ provider });
  }
  return undefined;
}

/**
 * What the channel is waiting on, when no button on this page can move it. The blocker is named only
 * where the evidence names it: a Computer that is offline, a Provider that is not ready, or neither,
 * in which case the note says only that delivery is not working yet.
 */
function MessagingChannelNote({ agent, binding }: { agent: AgentDetailView; binding: ImBindingSummary }) {
  if (messagingRecoveryLabel(binding)) return null;
  if (binding.bindingState === "provisioning") {
    return <p className="text-sm text-kumo-subtle">{m.agent_settings_channel_setting_up()}</p>;
  }
  const handoffState = agent.availability.dependencies.handoff.state;
  if (handoffState === "ready") return null;
  if (handoffState === "unconfirmed") {
    return <p className="text-sm text-kumo-subtle">{m.agent_settings_delivery_unconfirmed()}</p>;
  }
  const computerState = agent.availability.dependencies.computer.state;
  const runtimeStatus = agent.availability.dependencies.runtime.status;
  if (computerState === "action_required") {
    return (
      <p className="text-sm text-kumo-subtle">
        {m.agent_settings_messages_wait_for_computer()}{" "}
        <Link className="text-kumo-link" {...agentSettingsSectionLink(agent.id, "computer")}>
          {m.agent_settings_view_computer()}
        </Link>
      </p>
    );
  }
  if (computerState === "ready" && runtimeStatus && runtimeStatus !== "ready") {
    return (
      <p className="text-sm text-kumo-subtle">
        {m.agent_settings_messages_wait_for_runtime({ provider: runtimeProviderName(agent.runtimeProvider) })}{" "}
        <Link className="text-kumo-link" {...agentSettingsSectionLink(agent.id, "computer")}>
          {m.agent_settings_view_computer()}
        </Link>
      </p>
    );
  }
  return <p className="text-sm text-kumo-subtle">{m.agent_settings_messages_delivery_pending()}</p>;
}

/**
 * The mode decides which messages are delivered to the Agent at all. In `mention_only` an ordinary
 * shared-conversation message is durable history and creates no delivery; a direct mention creates one
 * and carries the intervening history as context. `all_message` adds an ambient delivery per message,
 * so it can wake the runtime far more often -- which is what changes execution and Token spend.
 */
function triggerModeHeading(provider: ImBindingSummary["provider"]): string {
  return provider === "feishu" ? m.agent_settings_group_chat_trigger_mode() : m.agent_settings_channel_trigger_mode();
}

function triggerModeExplanation(provider: ImBindingSummary["provider"]): string {
  const destination = provider === "feishu" ? m.agent_settings_group_chats() : m.agent_settings_channels();
  return m.agent_settings_trigger_mode_explanation({ destination });
}

function triggerModeDescription(
  receiveMode: AgentSummary["receiveMode"],
  provider: ImBindingSummary["provider"],
): string {
  const destination = provider === "feishu" ? m.agent_settings_group_chat() : m.agent_settings_channel();
  if (receiveMode === "all_message") {
    return m.agent_settings_trigger_mode_all_messages({ destination });
  }
  return m.agent_settings_trigger_mode_mentions({ destination });
}
