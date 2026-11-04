import type { AgentSetupMessagingState, ImBindingAdminDetail } from "@opentag/shared/browser";
import { useEffect, useState } from "react";
import { spaceScriptBoundary } from "../i18n/format.js";
import { messagingProviderLabel } from "../im/provider-label.js";
import { slackBotConversationUrl } from "../im/slack-app-manifest.js";
import * as m from "../paraglide/messages.js";
import { Button, buttonClassName, Collapsible, Icon } from "../ui/design-system.js";
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
  return <CompletionHandoff agentId={agentId} messaging={messaging} readBinding={readBinding} />;
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
}: {
  agentId: string;
  messaging: ReadyMessaging;
  readBinding: AgentSetupAdapter["readMessagingBinding"];
}) {
  const { binding, status } = useCompletionBinding(agentId, messaging, readBinding);
  const provider = messagingProviderLabel(messaging.provider);
  const botName = binding?.bot.displayName?.trim();
  const href = conversationUrl(binding);
  return (
    <div className="grid min-w-0 gap-5" data-ui="setup-completion-handoff">
      <div className="grid min-w-0 justify-items-start gap-3">
        {botName ? <strong className="max-w-full break-words text-sm">{botName}</strong> : null}
        {href ? (
          <a className={buttonClassName()} href={href} target="_blank" rel="noreferrer">
            {spaceScriptBoundary(m.onboarding_v2_handoff_open({ provider }))}
            <Icon name="external-link" />
          </a>
        ) : !botName ? (
          <p className="text-sm text-kumo-subtle" role="status">
            {status === "loading" ? m.onboarding_v2_handoff_loading() : m.onboarding_v2_handoff_unavailable()}
          </p>
        ) : null}
        {botName ? <BotSearch key={botName} name={botName} provider={provider} collapsed={Boolean(href)} /> : null}
      </div>
    </div>
  );
}

function BotSearch({ name, provider, collapsed }: { name: string; provider: string; collapsed: boolean }) {
  const content = (
    <div className="grid justify-items-start gap-3">
      <p className="text-sm text-kumo-subtle">
        {spaceScriptBoundary(m.onboarding_v2_handoff_search({ name, provider }))}
      </p>
      <CopyText value={name} label={m.onboarding_v2_handoff_copy_name()} primary={!collapsed} />
    </div>
  );
  if (!collapsed) return content;
  return (
    <Collapsible.Root>
      <Collapsible.Trigger render={<Button variant="ghost" />}>
        {m.onboarding_v2_handoff_open_help()}
      </Collapsible.Trigger>
      <Collapsible.Panel className="pt-3">{content}</Collapsible.Panel>
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
    <div className="grid justify-items-start gap-2">
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
