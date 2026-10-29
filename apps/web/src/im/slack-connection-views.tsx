import { SLACK_SUBSCRIBED_BOT_EVENTS, type SlackConfigurationView } from "@opentag/shared/browser";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { isHandoffChecking } from "../features/agents/agent-model.js";
import { agentDetailLink } from "../features/agents/agent-routes.js";
import * as m from "../paraglide/messages.js";
import { Button, buttonClassName, Collapsible, Icon, InputArea, Text } from "../ui/design-system.js";
import { ProviderIcon } from "../ui/provider-icon.js";
import { messagingProviderLabel } from "./provider-label.js";
import { slackBotConversationUrl } from "./slack-app-manifest.js";

export type SlackConnectionPanel = "test" | "help" | "details";

function canRetrySlackSetup(view: SlackConfigurationView, manualOnly: boolean): boolean {
  return (
    !manualOnly &&
    !view.blockedReason &&
    view.allowedIntent === "reauthorize" &&
    view.binding?.identity.provider === "slack" &&
    !view.binding.reauthorizationRequired &&
    view.preferredRecovery !== "oauth" &&
    view.identityClosure?.status !== "verified"
  );
}

export function slackConnectionTitle(view: SlackConfigurationView, panel: SlackConnectionPanel): string {
  if (panel === "help") return m.im_slack_help_title({ provider: messagingProviderLabel("slack") });
  if (panel === "details") return m.im_slack_details_title();
  if (view.identityClosure?.status !== "verified")
    return m.im_slack_test_title({ provider: messagingProviderLabel("slack") });
  if (view.handoff?.handoffReady) return m.im_slack_ready_title({ provider: messagingProviderLabel("slack") });
  return isHandoffChecking(view.handoff) ? m.im_slack_preparing_agent() : m.im_slack_attention_title();
}

export function slackConnectionDescription(view: SlackConfigurationView, panel: SlackConnectionPanel): string {
  if (panel === "help") return m.im_slack_help_description();
  if (panel === "details") return m.im_slack_details_description({ provider: messagingProviderLabel("slack") });
  if (view.identityClosure?.status !== "verified") return m.im_slack_test_description();
  if (view.handoff?.handoffReady) return m.im_slack_ready_description({ provider: messagingProviderLabel("slack") });
  return isHandoffChecking(view.handoff)
    ? m.im_slack_received_description({ provider: messagingProviderLabel("slack") })
    : m.im_slack_attention_description();
}

export function SlackAppIdentity({ view }: { view: SlackConfigurationView }) {
  const bot = view.binding?.bot;
  return (
    <div className="flex min-w-0 items-center gap-3">
      {bot?.avatarUrl ? (
        <img alt="" className="size-12 shrink-0 rounded-xl object-cover" src={bot.avatarUrl} />
      ) : (
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-kumo-tint">
          <ProviderIcon className="size-7" provider="slack" />
        </span>
      )}
      <div className="grid min-w-0 gap-1">
        <strong className="break-words text-sm">{bot?.displayName ?? m.im_slack_current_app()}</strong>
        <span className="text-sm text-kumo-subtle">
          {m.im_slack_app_context({ provider: messagingProviderLabel("slack") })}
        </span>
      </div>
    </div>
  );
}

export function SlackSavedApp({
  agentId,
  view,
  panel,
  onPanel,
  onUpdate,
  onOAuth,
  onRetrySetup,
  manualOnly,
  savedMethod,
  onClose,
}: {
  agentId: string;
  view: SlackConfigurationView;
  panel: SlackConnectionPanel;
  onPanel: (panel: SlackConnectionPanel) => void;
  onUpdate: () => void;
  onOAuth?: () => void;
  onRetrySetup?: () => void;
  savedMethod?: "auto" | "manual";
  manualOnly: boolean;
  onClose: () => void;
}) {
  const identity = view.binding?.identity;
  if (identity?.provider !== "slack") return null;
  const appSettings = `https://api.slack.com/apps/${encodeURIComponent(identity.appId)}/event-subscriptions`;
  if (panel === "details") return <SlackConnectionDetails view={view} appSettings={appSettings} />;
  if (panel === "help")
    return (
      <SlackAppHelp
        appSettings={appSettings}
        onDetails={() => onPanel("details")}
        onUpdate={onUpdate}
        onOAuth={onOAuth}
        onRetrySetup={canRetrySlackSetup(view, manualOnly) ? onRetrySetup : undefined}
      />
    );
  return (
    <SlackConnectionTest
      agentId={agentId}
      view={view}
      savedMethod={savedMethod}
      appSettings={appSettings}
      onHelp={() => onPanel("help")}
      onClose={onClose}
    />
  );
}

function slackConnectionStatus(view: SlackConfigurationView): string {
  if (view.identityClosure?.status !== "verified") return m.im_slack_pending_verification();
  if (view.handoff?.handoffReady) return m.im_slack_connected({ provider: messagingProviderLabel("slack") });
  return isHandoffChecking(view.handoff) ? m.im_slack_preparing_agent() : m.im_slack_check_agent();
}

function SlackConnectionTest({
  agentId,
  view,
  savedMethod,
  appSettings,
  onHelp,
  onClose,
}: {
  agentId: string;
  view: SlackConfigurationView;
  savedMethod?: "auto" | "manual";
  appSettings: string;
  onHelp: () => void;
  onClose: () => void;
}) {
  const identity = view.binding?.identity;
  if (identity?.provider !== "slack") return null;
  const verified = view.identityClosure?.status === "verified";
  const verifyUrl =
    !verified && savedMethod === "manual" && !view.binding?.lastRuntimeObservationAt && !view.binding?.lastInboundAt;
  const preparing = verified && !view.handoff?.handoffReady;
  return (
    <>
      {!verified ? (
        <ol className="grid gap-4 border-t border-kumo-line pt-5 text-sm">
          {(verifyUrl
            ? [m.im_slack_verify_instructions({ provider: messagingProviderLabel("slack") })]
            : [m.im_slack_test_open({ provider: messagingProviderLabel("slack") }), m.im_slack_test_send()]
          ).map((step, index) => (
            <li className="flex items-start gap-3" key={step}>
              <span
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-kumo-tint text-kumo-subtle"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <span className="pt-1.5">{step}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {preparing ? (
        <Link className={buttonClassName({ className: "w-full" })} {...agentDetailLink(agentId)}>
          {m.im_slack_agent_status()}
        </Link>
      ) : (
        <a
          className={buttonClassName({ className: "w-full gap-3" })}
          href={verifyUrl ? appSettings : slackBotConversationUrl(identity.appId, identity.teamId)}
          target="_blank"
          rel="noreferrer"
        >
          {verifyUrl
            ? m.im_slack_open_settings({ provider: messagingProviderLabel("slack") })
            : m.im_slack_open_dm({ provider: messagingProviderLabel("slack") })}
          <Icon name="external-link" />
        </a>
      )}
      {!verified ? <p className="-mt-3 text-sm text-kumo-subtle">{m.im_slack_test_return()}</p> : null}
      <p className="flex items-start gap-3 border-t border-kumo-line pt-5 text-sm text-kumo-subtle" role="status">
        <Icon name={verified ? "check" : "message"} className="mt-0.5 shrink-0" />
        {slackConnectionStatus(view)}
      </p>
      <div className="flex items-center justify-between gap-3 border-t border-kumo-line pt-3">
        <Button className="justify-between!" variant="ghost" onClick={onHelp}>
          {m.im_slack_existing_app_help()}
          <Icon name="chevron-right" />
        </Button>
        {verified && view.handoff?.handoffReady ? (
          <Button variant="secondary" onClick={onClose}>
            {m.common_done()}
          </Button>
        ) : null}
      </div>
    </>
  );
}

function SlackAppHelp({
  appSettings,
  onDetails,
  onUpdate,
  onOAuth,
  onRetrySetup,
}: {
  appSettings: string;
  onDetails: () => void;
  onUpdate: () => void;
  onOAuth?: () => void;
  onRetrySetup?: () => void;
}) {
  return (
    <div className="divide-y divide-kumo-line border-t border-kumo-line">
      <Collapsible.Root defaultOpen>
        <Collapsible.Trigger
          render={<Button className="h-auto! w-full justify-between! py-4! text-left" variant="ghost" />}
        >
          {m.im_slack_help_missing_message()}
          <Icon name="chevron-down" />
        </Collapsible.Trigger>
        <Collapsible.Panel className="grid gap-4 pb-5 text-sm">
          <p className="text-kumo-subtle">
            {m.im_slack_help_check_events({ provider: messagingProviderLabel("slack") })}
          </p>
          <ol className="grid list-decimal gap-3 pl-5">
            <li>{m.im_slack_help_verify_url()}</li>
            <li>{m.im_slack_preserve_events()}</li>
          </ol>
          {onRetrySetup ? (
            <Button variant="secondary" className="w-full gap-3" onClick={onRetrySetup}>
              <Icon name="settings" />
              {m.im_slack_retry_setup()}
            </Button>
          ) : null}
          <a
            className={buttonClassName({ className: "w-full gap-3" })}
            href={appSettings}
            target="_blank"
            rel="noreferrer"
          >
            {m.im_slack_open_settings({ provider: messagingProviderLabel("slack") })}
            <Icon name="external-link" />
          </a>
          <Button className="justify-start! text-kumo-link" variant="ghost" onClick={onDetails}>
            {m.im_slack_view_required_settings()}
            <Icon name="chevron-right" />
          </Button>
        </Collapsible.Panel>
      </Collapsible.Root>
      <div className="py-4">
        <Button
          className="h-auto! w-full justify-between! text-left"
          variant="ghost"
          aria-label={m.im_slack_update_credentials()}
          onClick={onUpdate}
        >
          <span className="grid gap-1">
            <span>{m.im_slack_update_credentials()}</span>
            <span className="text-sm font-normal text-kumo-subtle">
              {m.im_slack_help_changed_credentials({ provider: messagingProviderLabel("slack") })}
            </span>
          </span>
          <Icon name="chevron-right" />
        </Button>
      </div>
      {onOAuth ? (
        <div className="py-4">
          <Button variant="secondary" onClick={onOAuth}>
            {m.im_slack_explicit_oauth()}
          </Button>
        </div>
      ) : null}
      <div className="pt-4">
        <Button
          className="h-auto! w-full justify-between! text-left"
          variant="ghost"
          aria-label={m.im_slack_details_title()}
          onClick={onDetails}
        >
          <span className="grid gap-1">
            <span>{m.im_slack_details_title()}</span>
            <span className="text-sm font-normal text-kumo-subtle">{m.im_slack_details_summary()}</span>
          </span>
          <Icon name="chevron-right" />
        </Button>
      </div>
    </div>
  );
}

function SlackConnectionDetails({ view, appSettings }: { view: SlackConfigurationView; appSettings: string }) {
  const identity = view.binding?.identity;
  if (identity?.provider !== "slack") return null;
  return (
    <div className="grid min-w-0 gap-6 border-t border-kumo-line pt-5 text-sm">
      <section className="grid min-w-0 gap-3" aria-label={m.im_slack_app_workspace()}>
        <Text as="h3" variant="heading" headingSize="body">
          {m.im_slack_app_workspace()}
        </Text>
        <SlackCopyValue label={m.im_slack_app_id()} value={identity.appId} />
        <SlackCopyValue label={m.im_slack_workspace_id()} value={identity.teamId} />
      </section>
      <section
        className="grid min-w-0 gap-4 border-t border-kumo-line pt-5"
        aria-label={m.im_slack_event_subscriptions()}
      >
        <Text as="h3" variant="heading" headingSize="body">
          {m.im_slack_event_subscriptions()}
        </Text>
        <SlackCopyValue label={m.im_slack_request_url()} value={view.eventsUrl} multiline />
        <p className="text-kumo-subtle">{m.im_slack_request_url_help()}</p>
        <a className="text-kumo-link underline underline-offset-4" href={appSettings} target="_blank" rel="noreferrer">
          {m.im_slack_open_settings({ provider: messagingProviderLabel("slack") })}
        </a>
        <div className="grid gap-3">
          <Text as="h4" variant="heading" headingSize="body">
            {m.im_slack_required_events({ count: SLACK_SUBSCRIBED_BOT_EVENTS.length })}
          </Text>
          <ul className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {SLACK_SUBSCRIBED_BOT_EVENTS.map((event) => (
              <li key={event}>
                <code className="block rounded bg-kumo-tint px-3 py-1 text-xs">{event}</code>
              </li>
            ))}
          </ul>
          <p className="text-kumo-subtle">{m.im_slack_preserve_events()}</p>
        </div>
      </section>
    </div>
  );
}

function SlackCopyValue({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  const [result, setResult] = useState<"copied" | "failed">();
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setResult("copied");
    } catch {
      setResult("failed");
    }
  }
  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex items-center justify-between gap-3">
        <span>{label}</span>
        <Button
          variant="secondary"
          size="compact"
          aria-label={m.im_slack_copy_value({ label })}
          onClick={() => void copy()}
        >
          <Icon name="copy" />
          {m.common_copy()}
        </Button>
      </div>
      <code className="min-w-0 select-all break-all rounded-lg bg-kumo-tint px-3 py-2 font-mono text-xs leading-relaxed">
        {value}
      </code>
      {result ? (
        <p role="status" className="text-xs text-kumo-subtle">
          {result === "copied" ? m.im_slack_copied() : m.im_slack_copy_failed()}
        </p>
      ) : null}
      {result === "failed" ? (
        <InputArea
          readOnly
          aria-label={m.im_slack_manual_copy({ label })}
          value={value}
          rows={multiline ? 3 : 1}
          className="w-full font-mono text-xs"
        />
      ) : null}
    </div>
  );
}
