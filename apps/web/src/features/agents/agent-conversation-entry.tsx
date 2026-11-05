import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { browserApi } from "../../api.js";
import { spaceScriptBoundary } from "../../i18n/format.js";
import { botConversationUrl, matchesBotConversationBinding } from "../../im/bot-conversation.js";
import { botConversationProviderLabel } from "../../im/provider-label.js";
import * as m from "../../paraglide/messages.js";
import { queryKeys } from "../../query/keys.js";
import { Button, Collapsible, Icon } from "../../ui/design-system.js";
import type { AgentDetailView } from "./agent-model.js";
import { agentSettingsSectionLink } from "./agent-routes.js";

/** A use action for a healthy binding, separate from its status and single recovery action. */
export function AgentConversationEntry({ agent }: { agent: AgentDetailView }) {
  const current = agent.messaging.kind === "ready" ? agent.messaging.value : undefined;
  const enabled =
    agent.status === "active" && agent.availability.state === "ready" && current?.bindingState === "active";
  const query = useQuery({
    queryKey: queryKeys.agents.conversationEntry(agent.id, current, agent.updatedAt),
    queryFn: async ({ signal }) => {
      if (!current || current.agentId !== agent.id) return null;
      const snapshot = await browserApi.agentSetup(agent.id);
      if (signal.aborted) return null;
      const binding = await browserApi.imBindingConfig(agent.id);
      return !signal.aborted && matchesBotConversationBinding(current, snapshot, binding) ? binding : null;
    },
    enabled,
    // Identity only: no setup polling or preparation; the overview's status read remains authoritative.
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    staleTime: 0,
    gcTime: 0,
  });
  if (!enabled) return null;
  const binding = query.isSuccess ? query.data : undefined;
  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1 text-sm" data-ui="agent-bot-entry">
      {query.isPending ? <p role="status">{m.im_bot_entry_loading()}</p> : null}
      {!query.isPending && !binding ? (
        <p className="text-kumo-subtle">
          {m.im_bot_entry_unavailable()} <MessagingSettings agentId={agent.id} />
        </p>
      ) : null}
      {binding ? (
        <BotEntry
          key={`${binding.id}:${binding.credentialGeneration}:${binding.bot.displayName}`}
          agentId={agent.id}
          href={botConversationUrl(binding.identity)}
          name={binding.bot.displayName?.trim()}
          provider={botConversationProviderLabel(binding.identity)}
        />
      ) : null}
    </div>
  );
}

function BotEntry({
  agentId,
  href,
  name,
  provider,
}: {
  agentId: string;
  href?: string;
  name?: string;
  provider: string;
}) {
  const [copyResult, setCopyResult] = useState<"copied" | "failed">();
  async function copyName() {
    if (!name) return;
    try {
      await navigator.clipboard.writeText(name);
      setCopyResult("copied");
    } catch {
      setCopyResult("failed");
    }
  }
  return (
    <>
      {href ? (
        <a
          className="inline-flex min-h-11 items-center gap-1 text-kumo-link"
          href={href}
          target="_blank"
          rel="noreferrer"
        >
          {spaceScriptBoundary(m.im_bot_entry_open({ provider }))}
          <Icon name="external-link" />
        </a>
      ) : null}
      <Collapsible.Root className="min-w-0 max-w-full">
        <Collapsible.Trigger render={<Button variant="inline" className="min-h-11" />}>
          {href ? m.im_bot_entry_open_help() : m.im_bot_entry_find()}
          <Icon name="chevron-down" />
        </Collapsible.Trigger>
        <Collapsible.Panel>
          <div className="grid min-w-0 justify-items-start gap-2 py-2 text-kumo-subtle">
            {name ? (
              <>
                <p className="wrap-anywhere">{spaceScriptBoundary(m.im_bot_entry_search({ name, provider }))}</p>
                <Button variant="secondary" className="min-h-11" onClick={() => void copyName()}>
                  {m.im_bot_entry_copy()}
                </Button>
                {copyResult ? (
                  <p role="status">
                    {copyResult === "copied" ? m.im_bot_entry_copied() : m.im_bot_entry_copy_failed()}
                  </p>
                ) : null}
              </>
            ) : (
              <p>
                {m.im_bot_entry_name_unavailable()} <MessagingSettings agentId={agentId} />
              </p>
            )}
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </>
  );
}

function MessagingSettings({ agentId }: { agentId: string }) {
  return (
    <Link className="text-kumo-link" {...agentSettingsSectionLink(agentId, "messaging")}>
      {m.im_bot_entry_settings()}
    </Link>
  );
}
