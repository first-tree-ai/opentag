import type { AgentSummary, ImBindingSummary } from "@opentag/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type Ref, useEffect, useRef, useState } from "react";
import { browserApi } from "../../../api.js";
import { formatDateTime } from "../../../i18n/format.js";
import { FeishuSetup } from "../../../im/feishu-setup.js";
import { SlackConfiguration } from "../../../im/slack-configuration.js";
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

export function AgentMessagingSettings({
  agent,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  onAgentChanged: () => void;
}) {
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
      setError(cause instanceof Error ? cause.message : "Unable to change receive mode");
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
        <Text as="h2" id="agent-messaging-heading" ref={messagingHeadingRef} tabIndex={-1} variant="heading">
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
                                Connected channel
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
                                    ? `Last observed ${formatDateTime(binding.lastRuntimeObservationAt)}`
                                    : binding.lastValidatedAt
                                      ? `Validated ${formatDateTime(binding.lastValidatedAt)}`
                                      : "Not yet observed"
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
                                  label="On mention"
                                  selected={binding.receiveMode === "mention_only"}
                                  onSelect={() => {
                                    setConfirmingEveryMessage(false);
                                    void changeReceiveMode("mention_only");
                                  }}
                                />
                                <TriggerModeOption
                                  busy={receiveModePending}
                                  label={confirmingEveryMessage ? "Confirm every message" : "Every message"}
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
                                  This wakes the Agent on every message in the conversation, which raises Token spend.
                                  Choose <strong>Confirm every message</strong> to apply it.
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
                              No channel connected
                            </Text>
                          </div>
                          <p className="text-sm text-kumo-subtle">
                            Teammates cannot contact this Agent until a supported bot is connected.
                          </p>
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
    ? `${titleCase(binding.provider)} · @${agent.name}`
    : titleCase(binding.provider);
}

/** The one repair a channel state offers, or nothing when the state cannot be repaired from here. */
function messagingRecoveryLabel(binding: ImBindingSummary): string | undefined {
  const provider = titleCase(binding.provider);
  if (binding.bindingState === "reauthorization_required") return `Reauthorize ${provider}`;
  if (binding.bindingState === "error" || binding.bindingState === "disabled") return `Reconnect ${provider}`;
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
    return <p className="text-sm text-kumo-subtle">Setting up. This usually finishes within a minute.</p>;
  }
  const handoffState = agent.availability.dependencies.handoff.state;
  if (handoffState === "ready") return null;
  if (handoffState === "unconfirmed") {
    return <p className="text-sm text-kumo-subtle">Could not confirm delivery. Retrying automatically.</p>;
  }
  const computerState = agent.availability.dependencies.computer.state;
  const runtimeStatus = agent.availability.dependencies.runtime.status;
  if (computerState === "action_required") {
    return (
      <p className="text-sm text-kumo-subtle">
        The channel itself is connected. Messages wait until this agent's computer is online.{" "}
        <Link className="text-kumo-link" {...agentSettingsSectionLink(agent.id, "computer")}>
          View Computer
        </Link>
      </p>
    );
  }
  if (computerState === "ready" && runtimeStatus && runtimeStatus !== "ready") {
    return (
      <p className="text-sm text-kumo-subtle">
        The channel itself is connected. Messages wait until {runtimeProviderName(agent.runtimeProvider)} is ready on
        this agent's computer.{" "}
        <Link className="text-kumo-link" {...agentSettingsSectionLink(agent.id, "computer")}>
          View Computer
        </Link>
      </p>
    );
  }
  return (
    <p className="text-sm text-kumo-subtle">
      The channel itself is connected, but messages cannot be delivered yet. Retrying automatically.
    </p>
  );
}

/**
 * The mode decides which messages are delivered to the Agent at all. In `mention_only` an ordinary
 * shared-conversation message is durable history and creates no delivery; a direct mention creates one
 * and carries the intervening history as context. `all_message` adds an ambient delivery per message,
 * so it can wake the runtime far more often -- which is what changes execution and Token spend.
 */
function triggerModeHeading(provider: ImBindingSummary["provider"]): string {
  return provider === "feishu" ? "Group chat trigger mode" : "Channel trigger mode";
}

function triggerModeExplanation(provider: ImBindingSummary["provider"]): string {
  const destination = provider === "feishu" ? "group chats" : "channels";
  return `Every message in connected ${destination} is kept as conversation history either way. This setting decides which of them wake this Agent up to act.`;
}

function triggerModeDescription(
  receiveMode: AgentSummary["receiveMode"],
  provider: ImBindingSummary["provider"],
): string {
  const destination = provider === "feishu" ? "group chat" : "channel";
  if (receiveMode === "all_message") {
    return `Every ${destination} message is delivered and can wake this Agent, which then decides for itself whether to reply. Fastest to react, and the most Tokens.`;
  }
  return `Only an @mention wakes this Agent. It is then given what was said in the ${destination} since its last reply, so a mention never arrives without its context.`;
}
