import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import { FeishuSetup } from "../../../im/feishu-setup.js";
import { SlackConfiguration } from "../../../im/slack-configuration.js";
import { queryKeys } from "../../../query/keys.js";
import {
  Banner,
  Button,
  buttonClassName,
  Dialog,
  SettingsList,
  SettingsRow,
  StatusIndicator,
  Text,
} from "../../../ui/design-system.js";
import { EmptyState } from "../../layout/page.js";
import { toResourceState } from "../../resource/query-state.js";
import { AsyncState } from "../../resource/use-resource.js";
import type { AgentDetailView } from "../agent-model.js";
import {
  agentAvailabilityRecovery,
  agentStatusPresentation,
  agentUseInstruction,
  formatDate,
  messagingAgentStatusDescription,
  messagingConnectionLabel,
  messagingConnectionTone,
  sharedConversationLabel,
  titleCase,
} from "../agent-presentation.js";

export function ImTab({ agent, onAgentChanged }: { agent: AgentDetailView; onAgentChanged: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const [confirmation, setConfirmation] = useState<
    { kind: "all_messages" } | { bindingId: string; kind: "disable_binding" }
  >();
  const [confirmationError, setConfirmationError] = useState<string>();
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [restoreFocusTarget, setRestoreFocusTarget] = useState<"messaging" | "trigger_rules">();
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
    try {
      setConfirmationBusy(true);
      setError(undefined);
      setConfirmationError(undefined);
      const config = await browserApi.agentConfig(agent.id);
      await browserApi.updateAgent(agent.id, { expectedRevision: config.revision, receiveMode });
      reload();
      if (receiveMode === "all_message") setRestoreFocusTarget("trigger_rules");
      setConfirmation(undefined);
      onAgentChanged();
    } catch (cause) {
      const nextError = cause instanceof Error ? cause.message : "Unable to change receive mode";
      if (confirmation?.kind === "all_messages") setConfirmationError(nextError);
      else setError(nextError);
    } finally {
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
      setConfirmationError(cause instanceof Error ? cause.message : "Unable to disconnect messaging");
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
          Messaging
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
              const agentStatus = agentStatusPresentation(agent);
              const agentRecovery = agentAvailabilityRecovery(agent);
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
                                Contact channel
                              </Text>
                            </div>
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <StatusIndicator
                                detail={`${titleCase(binding.provider)} · ${messagingConnectionLabel(binding)}`}
                                label={binding.bot.displayName}
                                tone={messagingConnectionTone(binding)}
                              />
                              <small>
                                {binding.lastRuntimeObservationAt
                                  ? `Last observed ${formatDate(binding.lastRuntimeObservationAt)}`
                                  : binding.lastValidatedAt
                                    ? `Validated ${formatDate(binding.lastValidatedAt)}`
                                    : "Not yet observed"}
                              </small>
                            </div>
                            <div className="grid gap-2">
                              <StatusIndicator
                                detail="Agent status"
                                label={agentStatus.label}
                                tone={agentStatus.tone}
                              />
                              <p>{messagingAgentStatusDescription(agent, binding.provider)}</p>
                              {agentRecovery && agentRecovery.link.params.section !== "messaging" ? (
                                <Link
                                  className={buttonClassName({ size: "compact", variant: "secondary" })}
                                  state={{ agent }}
                                  {...agentRecovery.link}
                                >
                                  {agentRecovery.label}
                                </Link>
                              ) : null}
                            </div>
                            <dl className="grid gap-3 rounded-md bg-kumo-recessed p-3 sm:grid-cols-2">
                              <div>
                                <dt>Contact</dt>
                                <dd>@{agent.name}</dd>
                              </div>
                              <div>
                                <dt>How to use</dt>
                                <dd>{agentUseInstruction(agent, binding.provider)}</dd>
                              </div>
                            </dl>
                            {binding.bindingState === "reauthorization_required" && binding.provider === "feishu" ? (
                              <div className="flex flex-wrap gap-3">
                                <Button
                                  loading={feishuSetup.loading}
                                  disabled={feishuSetup.loading}
                                  onClick={() => void connectFeishu("reauthorize")}
                                >
                                  Reauthorize Feishu
                                </Button>
                              </div>
                            ) : null}
                            {binding.bindingState === "reauthorization_required" && binding.provider === "slack" ? (
                              <div className="flex flex-wrap gap-3">
                                <Button
                                  loading={slackConfiguration.loading}
                                  disabled={slackConfiguration.loading}
                                  onClick={() => void connectSlack("reauthorize")}
                                >
                                  Reauthorize Slack
                                </Button>
                              </div>
                            ) : null}
                            <div className="flex flex-wrap gap-3">
                              {binding.provider === "feishu" ? (
                                <Button
                                  loading={feishuSetup.loading}
                                  disabled={feishuSetup.loading}
                                  size="compact"
                                  variant="outline"
                                  onClick={() => void connectFeishu("replace")}
                                >
                                  Change Feishu Bot
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
                                Disconnect {titleCase(binding.provider)}
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
                                Trigger rules
                              </Text>
                            </div>
                            <SettingsList>
                              <SettingsRow label="Direct messages">
                                <strong>All messages</strong>
                              </SettingsRow>
                              <SettingsRow label={sharedConversationLabel(binding.provider)}>
                                <fieldset
                                  aria-label="Shared conversation trigger rule"
                                  className="flex flex-wrap items-center gap-2"
                                >
                                  {binding.receiveMode === "mention_only" ? (
                                    <>
                                      <span className="rounded-md bg-kumo-tint px-4 py-2 text-sm font-medium">
                                        Mentions only
                                      </span>
                                      <Button
                                        variant="inline"
                                        ref={allMessagesButtonRef}
                                        type="button"
                                        onClick={() => {
                                          setConfirmationError(undefined);
                                          setConfirmation({ kind: "all_messages" });
                                        }}
                                      >
                                        Every message
                                      </Button>
                                    </>
                                  ) : (
                                    <>
                                      <Button
                                        variant="inline"
                                        type="button"
                                        onClick={() => void changeReceiveMode("mention_only")}
                                      >
                                        Mentions only
                                      </Button>
                                      <span className="rounded-md bg-kumo-tint px-4 py-2 text-sm font-medium">
                                        Every message
                                      </span>
                                    </>
                                  )}
                                </fieldset>
                              </SettingsRow>
                            </SettingsList>
                          </section>
                        </>
                      ) : (
                        <section
                          className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
                          aria-labelledby="contact-channel-heading"
                        >
                          <div className="grid gap-2">
                            <Text as="h3" id="contact-channel-heading" variant="heading">
                              Contact channel
                            </Text>
                          </div>
                          <EmptyState title="No messaging channel">
                            Teammates cannot contact this agent until a supported bot is connected.
                          </EmptyState>
                          <div className="flex flex-wrap gap-3">
                            <Button
                              loading={feishuSetup.loading}
                              disabled={feishuSetup.loading}
                              onClick={() => void connectFeishu()}
                            >
                              Connect a Feishu Bot
                            </Button>
                            <Button
                              loading={slackConfiguration.loading}
                              disabled={slackConfiguration.loading}
                              variant="secondary"
                              onClick={() => void connectSlack()}
                            >
                              Add OpenTag to Slack
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
      {confirmation?.kind === "all_messages" ? (
        <Dialog
          busy={confirmationBusy}
          description="Every new conversation message could start a task. This can share more conversation content and increase token usage."
          returnFocusRef={allMessagesButtonRef}
          title="Allow messages without mentions?"
          onClose={closeMessagingConfirmation}
        >
          {confirmationError ? <Banner variant="error" role="alert" description={confirmationError} /> : null}
          <div className="flex flex-wrap justify-end gap-3">
            <Button disabled={confirmationBusy} variant="ghost" onClick={closeMessagingConfirmation}>
              Keep mentions only
            </Button>
            <Button
              loading={confirmationBusy}
              disabled={confirmationBusy}
              onClick={() => void changeReceiveMode("all_message")}
            >
              Allow every message
            </Button>
          </div>
        </Dialog>
      ) : null}
      {confirmation?.kind === "disable_binding" ? (
        <Dialog
          busy={confirmationBusy}
          description="Teammates will no longer be able to assign new work to this agent until another messaging connection is added."
          returnFocusRef={disableBindingButtonRef}
          title="Disconnect messaging?"
          onClose={closeMessagingConfirmation}
        >
          {confirmationError ? <Banner variant="error" role="alert" description={confirmationError} /> : null}
          <div className="flex flex-wrap justify-end gap-3">
            <Button disabled={confirmationBusy} variant="ghost" onClick={closeMessagingConfirmation}>
              Keep connected
            </Button>
            <Button
              loading={confirmationBusy}
              disabled={confirmationBusy}
              variant="danger"
              onClick={() => void disableBinding(confirmation.bindingId)}
            >
              Disconnect
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
