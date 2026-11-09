import type { ImProvider } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useId, useMemo, useState, useSyncExternalStore } from "react";
import { getLocale, setLocale } from "../i18n/locale.js";
import { messagingProviderLabel } from "../im/provider-label.js";
import {
  failPendingLabEvent,
  LAB_AGENT_ID,
  labSeed,
  pendingLabEvent,
  runPendingLabEvent,
} from "../onboarding-v2/agent-setup-lab-model.js";
import { AgentSetupPage } from "../onboarding-v2/agent-setup-page.js";
import { createMemorySetupAdapter } from "../onboarding-v2/setup-memory-adapter.js";
import * as m from "../paraglide/messages.js";
import { Button, KumoSelectControl } from "../ui/design-system.js";
import { createBotPreviewAdapter, type PreviewFailure } from "./adapter.js";

const SCENARIOS = ["messaging-setup", "messaging-handoff", "messaging-recovery", "everything-ready"] as const;
type Scenario = (typeof SCENARIOS)[number];
const labels = {
  "messaging-setup": () => m.onboarding_v2_bot_preview_initial(),
  "messaging-handoff": () => m.onboarding_v2_bot_preview_handoff(),
  "messaging-recovery": () => m.onboarding_v2_bot_preview_recovery(),
  "everything-ready": () => m.onboarding_v2_bot_preview_complete(),
};

export function BotConnectionPlayground({ initialControlsOpen = false }: { readonly initialControlsOpen?: boolean }) {
  const controlsId = useId();
  const [controlsOpen, setControlsOpen] = useState(initialControlsOpen);
  const [scenario, setScenario] = useState<Scenario>("messaging-setup");
  const [provider, setProvider] = useState<ImProvider>("feishu");
  const [failure, setFailure] = useState<PreviewFailure>("unknown");
  const [revision, setRevision] = useState(0);
  const [dark, setDark] = useState(false);
  return (
    <>
      {controlsOpen ? (
        <aside
          className="sticky top-0 z-0 flex flex-wrap items-center gap-3 border-b border-kumo-line bg-kumo-base px-4 py-3"
          aria-label={m.onboarding_v2_bot_preview_controls()}
        >
          <strong>{m.onboarding_v2_bot_preview_title()}</strong>
          <Button size="compact" variant="ghost" onClick={() => setControlsOpen(false)}>
            {m.common_close()}
          </Button>
          <span className="text-xs text-kumo-subtle">{m.onboarding_v2_bot_preview_notice()}</span>
          <label htmlFor={`${controlsId}-state`} className="flex items-center gap-2 text-sm">
            {m.onboarding_v2_bot_preview_state()}
            <KumoSelectControl
              id={`${controlsId}-state`}
              value={scenario}
              onChange={(event) => setScenario(event.target.value as Scenario)}
            >
              {SCENARIOS.map((value) => (
                <option key={value} value={value}>
                  {labels[value]()}
                </option>
              ))}
            </KumoSelectControl>
          </label>
          <label htmlFor={`${controlsId}-provider`} className="flex items-center gap-2 text-sm">
            {m.onboarding_v2_bot_preview_fixture_provider()}
            <KumoSelectControl
              id={`${controlsId}-provider`}
              value={provider}
              onChange={(event) => {
                const next = event.target.value as ImProvider;
                setProvider(next);
                if (next === "slack" && failure === "expired") setFailure("unknown");
              }}
              disabled={scenario === "messaging-setup"}
            >
              {(["feishu", "slack"] as const).map((value) => (
                <option key={value} value={value}>
                  {messagingProviderLabel(value)}
                </option>
              ))}
            </KumoSelectControl>
          </label>
          {scenario === "messaging-recovery" ? (
            <label htmlFor={`${controlsId}-failure`} className="flex items-center gap-2 text-sm">
              {m.onboarding_v2_bot_preview_failure()}
              <KumoSelectControl
                id={`${controlsId}-failure`}
                value={failure}
                onChange={(event) => setFailure(event.target.value as PreviewFailure)}
              >
                <option value="unknown">{m.onboarding_v2_bot_preview_unknown()}</option>
                <option value="service">{m.onboarding_v2_bot_preview_network()}</option>
                <option value="permissions">{m.onboarding_v2_bot_preview_permissions()}</option>
                {provider === "feishu" ? (
                  <option value="expired">{m.onboarding_v2_bot_preview_expired()}</option>
                ) : null}
              </KumoSelectControl>
            </label>
          ) : null}
          <Button size="compact" variant="secondary" onClick={() => setRevision((value) => value + 1)}>
            {m.onboarding_v2_lab_reset()}
          </Button>
          <Button size="compact" variant="ghost" onClick={() => setLocale(getLocale() === "zh" ? "en" : "zh")}>
            中文 / English
          </Button>
          <Button
            size="compact"
            variant="ghost"
            aria-pressed={dark}
            onClick={() => {
              const next = !dark;
              setDark(next);
              document.documentElement.setAttribute("data-opentag-mode", next ? "dark" : "light");
            }}
          >
            {m.onboarding_v2_bot_preview_dark()}
          </Button>
        </aside>
      ) : null}
      <ConnectionSession
        key={`${scenario}:${provider}:${revision}:${failure}`}
        failure={failure}
        scenario={scenario}
        provider={provider}
        controlsOpen={controlsOpen}
      />
    </>
  );
}

function ConnectionSession({
  failure,
  scenario,
  provider,
  controlsOpen,
}: {
  readonly failure: PreviewFailure;
  readonly scenario: Scenario;
  readonly provider: ImProvider;
  readonly controlsOpen: boolean;
}) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  const [memory] = useState(() => createMemorySetupAdapter(labSeed(scenario, "one-online", "codex", provider)));
  const adapter = useMemo(() => createBotPreviewAdapter(memory, failure), [memory, failure]);
  const version = useSyncExternalStore(memory.subscribe, memory.getVersion, memory.getVersion);
  const pending = pendingLabEvent(memory);
  const messaging = memory.inspect().snapshot.messaging;
  return (
    <>
      {controlsOpen ? (
        <fieldset
          className="m-0 flex flex-wrap items-center justify-center gap-3 border-0 bg-kumo-base p-3"
          aria-label={m.onboarding_v2_bot_preview_simulation()}
        >
          <Button size="compact" variant="secondary" disabled={!pending} onClick={() => runPendingLabEvent(memory)}>
            {m.onboarding_v2_bot_preview_advance()}
          </Button>
          <Button
            size="compact"
            variant="outline"
            disabled={messaging.kind !== "authorizing"}
            onClick={() => failPendingLabEvent(memory)}
          >
            {m.onboarding_v2_lab_fail_authorization()}
          </Button>
          <Button
            size="compact"
            variant="outline"
            disabled={pending !== "scan-feishu"}
            onClick={() => memory.controls.awaitFeishuActivation()}
          >
            {m.onboarding_v2_bot_preview_approval()}
          </Button>
          <Button
            size="compact"
            variant="outline"
            disabled={pending !== "scan-feishu"}
            onClick={() => memory.controls.awaitFeishuActivation("temporary_failure")}
          >
            {m.onboarding_v2_bot_preview_retry()}
          </Button>
          <output className="text-xs text-kumo-subtle" aria-live="polite">
            {m.onboarding_v2_bot_preview_state()}: {messaging.kind}
          </output>
        </fieldset>
      ) : null}
      <QueryClientProvider client={queryClient}>
        <AgentSetupPage
          agentId={LAB_AGENT_ID}
          adapter={adapter}
          computerAdapter={memory.computerAdapter}
          previewInitialView="messaging"
          refreshSignal={version}
          onExternalNavigation={() => undefined}
        />
      </QueryClientProvider>
    </>
  );
}
