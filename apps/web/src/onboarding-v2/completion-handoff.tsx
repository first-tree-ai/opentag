import type { AgentSetupMessagingState, ImBindingAdminDetail, ImProvider } from "@opentag/shared/browser";
import { type ReactNode, useEffect, useState } from "react";
import { spaceScriptBoundary } from "../i18n/format.js";
import { messagingProviderLabel } from "../im/provider-label.js";
import { slackBotConversationUrl } from "../im/slack-app-manifest.js";
import * as m from "../paraglide/messages.js";
import { Button, buttonClassName, Collapsible, Icon, StatusIndicator } from "../ui/design-system.js";
import { ProviderIcon } from "../ui/provider-icon.js";
import type { AgentSetupAdapter } from "./setup-adapter.js";

type ReadyMessaging = Extract<AgentSetupMessagingState, { kind: "ready" }>;
type BindingRead = {
  target: string;
  status: "loading" | "unavailable" | "ready";
  binding?: ImBindingAdminDetail;
};

export function completionHandoff(
  agentId: string,
  messaging: AgentSetupMessagingState,
  readBinding: AgentSetupAdapter["readMessagingBinding"],
  reviewing: boolean,
) {
  if (messaging.kind !== "ready" || reviewing) return undefined;
  return (managementAction: ReactNode) => (
    <CompletionHandoff
      agentId={agentId}
      messaging={messaging}
      readBinding={readBinding}
      managementAction={managementAction}
    />
  );
}

function useCompletionBinding(
  agentId: string,
  messaging: ReadyMessaging,
  readBinding: AgentSetupAdapter["readMessagingBinding"],
): BindingRead {
  const { bindingId, credentialGeneration, provider } = messaging;
  const target = `${agentId}:${provider}:${bindingId}:${credentialGeneration}`;
  const [result, setResult] = useState<BindingRead>({ target, status: "loading" });
  useEffect(() => {
    let live = true;
    setResult({ target, status: "loading" });
    void Promise.resolve()
      .then(() => readBinding?.(agentId))
      .then(
        (binding) => {
          if (!live) return;
          const matches =
            binding &&
            binding.agentId === agentId &&
            binding.id === bindingId &&
            binding.provider === provider &&
            binding.identity.provider === provider &&
            binding.credentialGeneration === credentialGeneration &&
            binding.bindingState === "active" &&
            !binding.reauthorizationRequired;
          setResult(matches ? { target, status: "ready", binding } : { target, status: "unavailable" });
        },
        () => {
          if (live) setResult({ target, status: "unavailable" });
        },
      );
    return () => {
      live = false;
    };
  }, [agentId, bindingId, credentialGeneration, provider, readBinding, target]);
  return result.target === target ? result : { target, status: "loading" };
}

function conversationUrl(binding: ImBindingAdminDetail | undefined): string | undefined {
  const identity = binding?.identity;
  if (!identity) return undefined;
  if (identity.provider === "slack") return slackBotConversationUrl(identity.appId, identity.teamId);
  // The documented Feishu route is not evidence of the equivalent Lark Bot route.
  if (identity.teamBrand !== "feishu") return undefined;
  const url = new URL("https://applink.feishu.cn/client/bot/open");
  url.searchParams.set("appId", identity.appId);
  return url.toString();
}

export function CompletionHandoff({
  agentId,
  messaging,
  readBinding,
  managementAction,
}: {
  agentId: string;
  messaging: ReadyMessaging;
  readBinding: AgentSetupAdapter["readMessagingBinding"];
  managementAction?: ReactNode;
}) {
  const read = useCompletionBinding(agentId, messaging, readBinding);
  const { binding } = read;
  const provider = messagingProviderLabel(messaging.provider);
  const botName = binding?.bot.displayName?.trim();
  const href = conversationUrl(binding);
  return (
    <div className="otv2-completion__body" data-ui="setup-completion-handoff">
      <CompletionBotIdentity provider={messaging.provider} read={read} />
      {!href && botName ? <p className="otv2-completion__notice">{searchCopy(botName, provider)}</p> : null}
      {binding && !href && !botName ? (
        <p className="otv2-completion__notice">{m.onboarding_v2_handoff_name_unavailable()}</p>
      ) : null}
      {href || botName || managementAction ? (
        <fieldset className="otv2-completion__actions" aria-label={m.onboarding_v2_completion_actions()}>
          {href ? (
            <a className={buttonClassName()} href={href} target="_blank" rel="noreferrer">
              {spaceScriptBoundary(m.onboarding_v2_handoff_open({ provider }))}
              <Icon name="external-link" />
            </a>
          ) : botName ? (
            <CopyText key={botName} value={botName} label={m.onboarding_v2_handoff_copy_name()} primary />
          ) : null}
          {managementAction}
        </fieldset>
      ) : null}
      {href && botName ? <BotSearch key={botName} name={botName} provider={provider} /> : null}
    </div>
  );
}

function CompletionBotIdentity({ provider, read }: { provider: ImProvider; read: BindingRead }) {
  const { binding, status } = read;
  return (
    <div className="otv2-completion__identity">
      <span className="otv2-completion__mark" aria-hidden="true">
        <ProviderIcon className="size-6" provider={provider} />
      </span>
      <div className="otv2-completion__details">
        {binding ? (
          <strong className="otv2-completion__name">
            {binding.bot.displayName?.trim() || m.onboarding_v2_handoff_bot()}
          </strong>
        ) : (
          <p className="otv2-completion__notice" role="status">
            {status === "loading" ? m.onboarding_v2_handoff_loading() : m.onboarding_v2_handoff_unavailable()}
          </p>
        )}
        <span className="otv2-completion__provider">{messagingProviderLabel(provider)}</span>
      </div>
      {binding ? <StatusIndicator label={m.im_connected()} tone="success" /> : null}
    </div>
  );
}

function searchCopy(name: string, provider: string) {
  return spaceScriptBoundary(m.onboarding_v2_handoff_search({ name, provider }));
}

function BotSearch({ name, provider }: { name: string; provider: string }) {
  return (
    <Collapsible.Root className="otv2-completion__help">
      <Collapsible.Trigger render={<Button variant="ghost" className="otv2-completion__help-trigger" />}>
        {m.onboarding_v2_handoff_open_help()}
        <Icon name="chevron-down" />
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <div className="otv2-completion__help-content">
          <p className="otv2-completion__notice">{searchCopy(name, provider)}</p>
          <CopyText value={name} label={m.onboarding_v2_handoff_copy_name()} />
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function CopyText({ value, label, primary = false }: { value: string; label: string; primary?: boolean }) {
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
    <div className="otv2-completion__copy">
      <Button variant={primary ? "primary" : "secondary"} onClick={() => void copy()}>
        {label}
      </Button>
      {result ? (
        <p className="text-sm text-kumo-subtle" role="status">
          {result === "copied" ? m.onboarding_v2_handoff_copied() : m.onboarding_v2_handoff_copy_failed()}
        </p>
      ) : null}
    </div>
  );
}
