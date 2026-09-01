import type { AgentSummary, ImBindingSummary } from "@opentag/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type Ref, useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import { FeishuSetup } from "../../../im/feishu-setup.js";
import { messagingProviderLabel } from "../../../im/provider-label.js";
import { SlackConfiguration } from "../../../im/slack-configuration.js";
import * as m from "../../../paraglide/messages.js";
import { queryKeys } from "../../../query/keys.js";
import { Banner, Button, Dialog, StatusIndicator, Text } from "../../../ui/design-system.js";
import { ProviderIcon } from "../../../ui/provider-icon.js";
import { AsyncState, toResourceState } from "../../resource/resource-state.js";
import type { AgentDetailView } from "../agent-model.js";
import { messagingConnectionLabel, messagingConnectionTone } from "../agent-presentation.js";

type Confirmation =
  | { bindingId: string; kind: "disable_binding"; provider: ImBindingSummary["provider"] }
  | { kind: "every_message" };

export function ImTab({ agent, onAgentChanged }: { agent: AgentDetailView; onAgentChanged: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const [successMessage, setSuccessMessage] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [confirmationError, setConfirmationError] = useState<string>();
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [restoreFocusTarget, setRestoreFocusTarget] = useState<"messaging" | "trigger_rules">();
  const [receiveModePending, setReceiveModePending] = useState(false);
  const allMessagesButtonRef = useRef<HTMLButtonElement>(null);
  const disableBindingButtonRef = useRef<HTMLButtonElement>(null);
  const activeFeishuTriggerRef = useRef<HTMLElement | null>(null);
  const messagingHeadingRef = useRef<HTMLHeadingElement>(null);
  const triggerRulesHeadingRef = useRef<HTMLHeadingElement>(null);
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
      setSuccessMessage(undefined);
      setConfirmationError(undefined);
      const config = await browserApi.agentConfig(agent.id);
      await browserApi.updateAgent(agent.id, { expectedRevision: config.revision, receiveMode });
      reload();
      setRestoreFocusTarget("trigger_rules");
      setConfirmation(undefined);
      onAgentChanged();
    } catch {
      const nextError = m.im_receive_mode_failed();
      if (confirmation?.kind === "every_message") setConfirmationError(nextError);
      else setError(nextError);
    } finally {
      setReceiveModePending(false);
      setConfirmationBusy(false);
    }
  }

  async function disableBinding(bindingId: string, provider: ImBindingSummary["provider"]) {
    try {
      setConfirmationBusy(true);
      setError(undefined);
      setSuccessMessage(undefined);
      setConfirmationError(undefined);
      await browserApi.disableImBinding(bindingId);
      reload();
      setRestoreFocusTarget("messaging");
      setConfirmation(undefined);
      onAgentChanged();
    } catch {
      setConfirmationError(m.im_disconnect_failed({ providerName: messagingProviderLabel(provider) }));
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
      <FeishuSetup
        agentId={agent.id}
        presentation="dialog"
        returnFocusRef={activeFeishuTriggerRef}
        onSuccess={() => {
          setSuccessMessage(m.im_feishu_connected({ provider: messagingProviderLabel("feishu") }));
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
                      <section
                        className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
                        aria-labelledby="messaging-app-heading"
                      >
                        <Text as="h2" id="messaging-app-heading" variant="heading">
                          {m.im_messaging_app()}
                        </Text>
                        {binding ? (
                          <>
                            <div
                              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3"
                              data-ui="messaging-app-identity"
                            >
                              <ProviderIcon className="size-6" provider={binding.provider} />
                              <span className="grid min-w-0 gap-1">
                                <strong className="text-base font-semibold text-kumo-strong">
                                  {binding.bot.displayName ?? messagingProviderLabel(binding.provider)}
                                </strong>
                                <span className="text-sm text-kumo-subtle">{messagingAppDetail(agent, binding)}</span>
                              </span>
                              <StatusIndicator
                                className="justify-self-end"
                                label={messagingConnectionLabel(binding)}
                                tone={messagingConnectionTone(binding)}
                              />
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              {messagingRecoveryLabel(binding) ? (
                                <Button
                                  disabled={feishuSetup.loading || slackConfiguration.loading}
                                  loading={feishuSetup.loading || slackConfiguration.loading}
                                  onClick={(event) => {
                                    activeFeishuTriggerRef.current = event.currentTarget;
                                    void (binding.provider === "feishu"
                                      ? connectFeishu("reauthorize")
                                      : connectSlack("reauthorize"));
                                  }}
                                >
                                  {messagingRecoveryLabel(binding)}
                                </Button>
                              ) : null}
                              {binding.provider === "feishu" ? (
                                <Button
                                  loading={feishuSetup.loading}
                                  disabled={feishuSetup.loading}
                                  variant="secondary"
                                  onClick={(event) => {
                                    activeFeishuTriggerRef.current = event.currentTarget;
                                    void connectFeishu("replace");
                                  }}
                                >
                                  {m.im_change_bot()}
                                </Button>
                              ) : null}
                              <Button
                                ref={disableBindingButtonRef}
                                variant="secondary-destructive"
                                onClick={() => {
                                  setConfirmationError(undefined);
                                  setConfirmation({
                                    bindingId: binding.id,
                                    kind: "disable_binding",
                                    provider: binding.provider,
                                  });
                                }}
                              >
                                {m.im_disconnect({ providerName: messagingProviderLabel(binding.provider) })}
                              </Button>
                            </div>
                          </>
                        ) : (
                          <>
                            <p className="text-sm text-kumo-subtle">
                              {m.im_messaging_connect_description({ provider: messagingProviderLabel("feishu") })}
                            </p>
                            <div className="flex flex-wrap gap-3">
                              <Button
                                loading={feishuSetup.loading}
                                disabled={feishuSetup.loading}
                                onClick={(event) => {
                                  activeFeishuTriggerRef.current = event.currentTarget;
                                  void connectFeishu();
                                }}
                              >
                                {m.im_connect_feishu({ provider: messagingProviderLabel("feishu") })}
                              </Button>
                              <Button
                                loading={slackConfiguration.loading}
                                disabled={slackConfiguration.loading}
                                variant="secondary"
                                onClick={() => void connectSlack()}
                              >
                                {m.im_connect_slack()}
                              </Button>
                            </div>
                          </>
                        )}
                      </section>

                      {binding ? (
                        <section
                          className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
                          aria-labelledby="trigger-rules-heading"
                        >
                          <div className="grid gap-2">
                            <Text
                              as="h2"
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
                                label={m.im_mentions_only()}
                                selected={binding.receiveMode === "mention_only"}
                                onSelect={() => void changeReceiveMode("mention_only")}
                              />
                              <TriggerModeOption
                                busy={receiveModePending}
                                label={m.im_every_message()}
                                ref={allMessagesButtonRef}
                                selected={binding.receiveMode === "all_message"}
                                onSelect={() => {
                                  setConfirmationError(undefined);
                                  setConfirmation({ kind: "every_message" });
                                }}
                              />
                            </fieldset>
                            <p className="text-sm text-kumo-subtle">{triggerModeDescription(binding.receiveMode)}</p>
                          </div>
                        </section>
                      ) : null}

                      {feishuSetup.feedback}
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

      {confirmation?.kind === "disable_binding" ? (
        <Dialog
          busy={confirmationBusy}
          description={m.im_disconnect_description({ providerName: messagingProviderLabel(confirmation.provider) })}
          returnFocusRef={disableBindingButtonRef}
          title={m.im_disconnect_title({ providerName: messagingProviderLabel(confirmation.provider) })}
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
              {m.im_disconnect({ providerName: messagingProviderLabel(confirmation.provider) })}
            </Button>
          </div>
        </Dialog>
      ) : null}

      {confirmation?.kind === "every_message" ? (
        <Dialog
          busy={confirmationBusy}
          description={m.im_every_message_confirm_description()}
          returnFocusRef={allMessagesButtonRef}
          title={m.im_every_message_confirm_title()}
          onClose={closeConfirmation}
        >
          {confirmationError ? <Banner variant="error" role="alert" description={confirmationError} /> : null}
          <div className="flex flex-wrap justify-end gap-3">
            <Button disabled={confirmationBusy} variant="ghost" onClick={closeConfirmation}>
              {m.common_cancel()}
            </Button>
            <Button
              disabled={confirmationBusy}
              loading={confirmationBusy}
              onClick={() => void changeReceiveMode("all_message")}
            >
              {m.im_every_message_confirm_button()}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

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

function messagingAppDetail(agent: AgentDetailView, binding: ImBindingSummary): string {
  return binding.provider === "feishu"
    ? m.agent_settings_channel_detail_with_name({
        provider: messagingProviderLabel(binding.provider),
        name: agent.name,
      })
    : m.agent_settings_channel_detail({ provider: messagingProviderLabel(binding.provider) });
}

function messagingRecoveryLabel(binding: ImBindingSummary): string | undefined {
  if (binding.bindingState === "reauthorization_required") return m.im_update_permissions();
  if (binding.bindingState === "error" || binding.bindingState === "disabled") return m.im_reconnect();
  return undefined;
}

function triggerModeHeading(provider: ImBindingSummary["provider"]): string {
  return provider === "feishu" ? m.im_group_chat_messages() : m.im_channel_messages();
}

function triggerModeExplanation(provider: ImBindingSummary["provider"]): string {
  return provider === "feishu" ? m.im_group_chat_messages_description() : m.im_channel_messages_description();
}

function triggerModeDescription(receiveMode: AgentSummary["receiveMode"]): string {
  return receiveMode === "all_message" ? m.im_every_message_description() : m.im_mentions_only_description();
}
