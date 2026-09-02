import type { AgentAdminConfig, AgentRuntimeProvider, ProviderReadinessStatus } from "@opentag/shared/browser";
import { AgentNameSchema } from "@opentag/shared/browser";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api.js";
import { ComputerConnect } from "../features/computer-connect/computer-connect.js";
import { compareText, formatNumber } from "../i18n/format.js";
import * as m from "../paraglide/messages.js";
import {
  Banner,
  Button,
  Field,
  KumoInputControl,
  Loader,
  StatusIndicator,
  type StatusTone,
  Text,
} from "../ui/design-system.js";
import {
  type CreationIntentRecord,
  type CreationIntentRequest,
  clearCreationIntent,
  createAgentOnce,
  getOrCreateCreationIntent,
  pruneSupersededCreationIntents,
  readCreationIntent,
} from "./creation-intent-store.js";
import { CreationRecoverySection, useCreationRecovery } from "./creation-recovery.js";

export interface AgentCreationComputer {
  readonly id: string;
  readonly displayName: string;
  readonly connectionStatus: "online" | "offline";
}

export interface AgentCreationProvider {
  readonly computerId: string;
  readonly provider: AgentRuntimeProvider;
  readonly runtimeReady: boolean;
  readonly status?: ProviderReadinessStatus;
}

export interface AgentCreationFacts {
  readonly computers: readonly AgentCreationComputer[];
  readonly providers: readonly AgentCreationProvider[];
  readonly runtimeEvidenceAvailable: boolean;
}

/**
 * When the derived Agent name is put in front of the Account. `always` keeps it visible, which is
 * what an Account that already owns Agents needs: the name carries a uniqueness constraint, so
 * seeing the derivation is how a collision gets avoided before it is submitted. `when-required`
 * shows it only once a display name derives to nothing and the Account has to choose one — the
 * onboarding case, where this is the Account's first Agent and no collision is possible.
 */
export type AgentNameDisclosure = "always" | "when-required";

export interface AgentCreationFlowProps {
  readonly agentNameDisclosure?: AgentNameDisclosure;
  readonly facts: AgentCreationFacts;
  readonly initialDisplayName?: string;
  readonly onCancel?: () => void;
  readonly onComputerRefreshFocus?: () => void;
  readonly onCreated: (agent: AgentAdminConfig) => void;
  readonly onRefresh: () => void;
  readonly onSubmittingChange?: (submitting: boolean) => void;
  /** Renders the flow for review only: no creation intent is read or recovered and no Agent is created. */
  readonly preview?: boolean;
  readonly refreshing?: boolean;
  readonly accountId: string;
}

interface ReadyRoute {
  readonly computer: AgentCreationComputer;
  readonly provider: AgentRuntimeProvider;
}

export function deriveAgentName(displayName: string): string {
  return displayName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

export function AgentCreationFlow({
  agentNameDisclosure = "always",
  facts,
  initialDisplayName = "",
  onCancel,
  onComputerRefreshFocus,
  onCreated,
  onRefresh,
  onSubmittingChange,
  preview = false,
  refreshing = false,
  accountId,
}: AgentCreationFlowProps) {
  useEffect(() => {
    if (!preview) pruneSupersededCreationIntents();
  }, [preview]);
  const pendingIntent = useMemo(() => (preview ? undefined : readCreationIntent(accountId)), [preview, accountId]);
  const [displayName, setDisplayName] = useState(() => pendingIntent?.request.displayName ?? initialDisplayName);
  const [name, setName] = useState(() => pendingIntent?.request.name ?? deriveAgentName(initialDisplayName));
  const [nameDirty, setNameDirty] = useState(
    () =>
      pendingIntent !== undefined && pendingIntent.request.name !== deriveAgentName(pendingIntent.request.displayName),
  );
  const [editingName, setEditingName] = useState(false);
  const [nameError, setNameError] = useState<string>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [dismissedIntentId, setDismissedIntentId] = useState<string>();
  const [changingComputer, setChangingComputer] = useState(false);
  const [changingRuntime, setChangingRuntime] = useState(false);
  const [connectingComputer, setConnectingComputer] = useState(false);
  const [selectedComputerId, setSelectedComputerId] = useState(() => pendingIntent?.request.computerId);
  const [selectedProvider, setSelectedProvider] = useState<AgentRuntimeProvider | undefined>(
    () => pendingIntent?.request.runtimeProvider,
  );
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const nameFieldRef = useRef<HTMLInputElement>(null);
  const computerChangeButtonRef = useRef<HTMLButtonElement>(null);
  const inFlightRef = useRef(false);
  const connectedComputerIdRef = useRef<string | undefined>(undefined);
  const restoreComputerSetupFocusRef = useRef(false);
  const computerRefreshStartedRef = useRef(false);

  /**
   * A display name carrying no Latin letters or digits — a Chinese one, most often — derives to an
   * empty Agent name, which submit refuses. That is the one case where the Account has to act on
   * the name, so it is the one case `when-required` reveals it: hiding it here would let the first
   * mention of the field be the error that rejects the form.
   */
  const nameUnderivable = name.trim() === "";
  const agentNameVisible = agentNameDisclosure === "always" || nameUnderivable;
  const readyRoutes = useMemo(() => resolveReadyRoutes(facts), [facts]);
  const defaultReadyRoute = readyRoutes[0];
  const displayedComputer =
    facts.computers.find((computer) => computer.id === selectedComputerId) ??
    defaultReadyRoute?.computer ??
    facts.computers.find((computer) => computer.connectionStatus === "online") ??
    facts.computers[0];
  const displayedProvider =
    facts.providers.find(
      (provider) => provider.computerId === displayedComputer?.id && provider.provider === selectedProvider,
    ) ??
    facts.providers.find(
      (provider) =>
        provider.computerId === displayedComputer?.id &&
        displayedComputer.id === defaultReadyRoute?.computer.id &&
        provider.provider === defaultReadyRoute.provider,
    ) ??
    [...facts.providers]
      .filter((provider) => provider.computerId === displayedComputer?.id)
      .sort((left, right) => providerRank(left.provider) - providerRank(right.provider))[0];
  const selectedRoute = readyRoutes.find(
    (route) => route.computer.id === displayedComputer?.id && route.provider === displayedProvider?.provider,
  );

  useEffect(() => {
    if (!displayedComputer || !displayedProvider || selectedRoute) return;
    const fallbackRoute = readyRoutes.find((route) => route.computer.id === displayedComputer.id);
    if (fallbackRoute) setSelectedProvider(fallbackRoute.provider);
  }, [displayedComputer, displayedProvider, readyRoutes, selectedRoute]);

  useEffect(() => {
    // Preview is a review surface: it must not pull focus, or scroll, away from the page around it.
    if (preview) return;
    firstFieldRef.current?.focus();
  }, [preview]);

  useEffect(() => {
    if (editingName) nameFieldRef.current?.focus();
  }, [editingName]);

  useEffect(() => {
    if (nameError) nameFieldRef.current?.focus();
  }, [nameError]);

  useEffect(() => {
    const connectedComputerId = connectedComputerIdRef.current;
    if (!connectedComputerId) return;
    const connectedComputer = facts.computers.find((computer) => computer.id === connectedComputerId);
    if (!connectedComputer) return;
    const connectedRoute = readyRoutes.find((route) => route.computer.id === connectedComputerId);
    const connectedProvider =
      connectedRoute?.provider ??
      [...facts.providers]
        .filter((provider) => provider.computerId === connectedComputerId)
        .sort((left, right) => providerRank(left.provider) - providerRank(right.provider))[0]?.provider;
    setSelectedComputerId(connectedComputer.id);
    setSelectedProvider(connectedProvider);
    connectedComputerIdRef.current = undefined;
  }, [facts.computers, facts.providers, readyRoutes]);

  useEffect(() => {
    if (!restoreComputerSetupFocusRef.current) return;
    if (refreshing) {
      computerRefreshStartedRef.current = true;
      return;
    }
    if (!computerRefreshStartedRef.current) return;
    restoreComputerSetupFocusRef.current = false;
    computerRefreshStartedRef.current = false;
    (computerChangeButtonRef.current ?? firstFieldRef.current)?.focus();
  }, [refreshing]);

  const create = useCallback(
    async (request: CreationIntentRequest, intent?: CreationIntentRecord) => {
      if (preview || inFlightRef.current) return;
      let record = intent;
      inFlightRef.current = true;
      setError(undefined);
      setNameError(undefined);
      setSubmitting(true);
      onSubmittingChange?.(true);
      try {
        record ??= await getOrCreateCreationIntent(accountId, request);
        const created = await createAgentOnce(record);
        await clearCreationIntent(accountId, record.creationIntentId);
        setDismissedIntentId(record.creationIntentId);
        onCreated(created);
      } catch (cause) {
        if (cause instanceof ApiError) {
          const issue = cause.issues?.find(({ path }) => path[0] === "name");
          if (issue || cause.code === "AGENT_NAME_CONFLICT") {
            if (record) {
              await clearCreationIntent(accountId, record.creationIntentId);
              setDismissedIntentId(record.creationIntentId);
            }
            setEditingName(true);
            setNameError(issue?.message ?? cause.message);
            return;
          }
          if (record && (cause.category === "validation" || cause.category === "deterministic")) {
            await clearCreationIntent(accountId, record.creationIntentId);
            setDismissedIntentId(record.creationIntentId);
          }
        }
        setError(cause instanceof Error ? cause.message : m.agent_create_failed());
      } finally {
        inFlightRef.current = false;
        setSubmitting(false);
        onSubmittingChange?.(false);
      }
    },
    [onCreated, onSubmittingChange, preview, accountId],
  );

  const recovery = useCreationRecovery({
    accountId,
    create,
    createInFlightRef: inFlightRef,
    dismissedIntentId,
    onSubmittingChange,
    pendingIntent,
    preview,
    selectedRoute,
    setDismissedIntentId,
    submitting,
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A saved attempt is an explicit Check / Retry / Discard decision. A normal form submit must
    // never reach getOrCreateCreationIntent while that identity is pending, because an unchanged
    // request would silently reuse it and make the ordinary Create button behave like Retry.
    if (inFlightRef.current || recovery.checkInFlightRef.current || recovery.intent || !selectedRoute) return;
    setError(undefined);
    setNameError(undefined);
    const parsedName = AgentNameSchema.safeParse(name);
    if (!parsedName.success) {
      setEditingName(true);
      setNameError(parsedName.error.issues[0]?.message ?? m.agent_create_name_invalid());
      return;
    }
    void create({
      name: parsedName.data,
      displayName: displayName.trim(),
      runtimeProvider: selectedRoute.provider,
      computerId: selectedRoute.computer.id,
    });
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <CreationRecoverySection recovery={recovery} />
      <div className="grid gap-4">
        <Field htmlFor="new-agent-display-name" label={m.agent_create_display_name_label()}>
          <KumoInputControl
            id="new-agent-display-name"
            ref={firstFieldRef}
            name="displayName"
            placeholder={m.agent_create_display_name_placeholder()}
            disabled={submitting}
            required
            value={displayName}
            onChange={(event) => {
              const nextDisplayName = event.currentTarget.value;
              setDisplayName(nextDisplayName);
              if (!nameDirty) {
                setName(deriveAgentName(nextDisplayName));
                setNameError(undefined);
              }
            }}
          />
        </Field>
        {!editingName && agentNameVisible ? (
          <div className="grid gap-1">
            {nameUnderivable ? (
              <p className="text-sm text-kumo-danger">{m.agent_create_name_required_message()}</p>
            ) : null}
            <Button
              aria-label={m.agent_create_edit_name_label()}
              aria-controls="agent-name-editor"
              aria-expanded="false"
              className="w-fit"
              disabled={submitting}
              variant="inline"
              onClick={() => setEditingName(true)}
            >
              {name ? m.agent_create_at_name({ name }) : m.agent_create_set_name_action()}
            </Button>
          </div>
        ) : null}
        {editingName ? (
          <div id="agent-name-editor">
            <Field
              error={nameError}
              errorId="agent-name-error"
              hint={m.agent_create_name_hint()}
              hintId="new-agent-name-hint"
              htmlFor="new-agent-name"
              label={m.agent_create_agent_name_label()}
            >
              <span className="grid grid-cols-[auto_1fr] items-center gap-2">
                <span aria-hidden="true">@</span>
                <KumoInputControl
                  aria-describedby={nameError ? "new-agent-name-hint agent-name-error" : "new-agent-name-hint"}
                  aria-invalid={nameError ? true : undefined}
                  aria-labelledby="new-agent-name-label"
                  id="new-agent-name"
                  ref={nameFieldRef}
                  placeholder={m.agent_create_name_placeholder()}
                  disabled={submitting}
                  aria-required="true"
                  value={name}
                  onChange={(event) => {
                    setName(event.currentTarget.value);
                    setNameDirty(true);
                    setNameError(undefined);
                  }}
                />
              </span>
            </Field>
          </div>
        ) : null}
      </div>

      <RuntimeRouteSection
        changingComputer={changingComputer}
        changingRuntime={changingRuntime}
        connectingComputer={connectingComputer}
        computerChangeButtonRef={computerChangeButtonRef}
        displayedComputer={displayedComputer}
        displayedProvider={displayedProvider}
        facts={facts}
        preview={preview}
        readyRoutes={readyRoutes}
        refreshing={refreshing}
        selectedRoute={selectedRoute}
        submitting={submitting}
        onChangeComputer={(computer) => {
          const providers = [...facts.providers]
            .filter((provider) => provider.computerId === computer.id)
            .sort((left, right) => providerRank(left.provider) - providerRank(right.provider));
          const nextProvider =
            providers.find((provider) => provider.provider === displayedProvider?.provider)?.provider ??
            readyRoutes.find((route) => route.computer.id === computer.id)?.provider ??
            providers[0]?.provider;
          setSelectedComputerId(computer.id);
          setSelectedProvider(nextProvider);
          setChangingComputer(false);
          setChangingRuntime(false);
        }}
        onChangeRuntime={(provider) => {
          if (displayedComputer) setSelectedComputerId(displayedComputer.id);
          setSelectedProvider(provider.provider);
          setChangingComputer(false);
          setChangingRuntime(false);
        }}
        onConnected={(computer) => {
          connectedComputerIdRef.current = computer.id;
          restoreComputerSetupFocusRef.current = true;
          computerRefreshStartedRef.current = false;
          if (onCancel) onComputerRefreshFocus?.();
          setConnectingComputer(false);
          setChangingComputer(false);
          onRefresh();
        }}
        onRefresh={onRefresh}
        onToggleComputerSetup={() => {
          restoreComputerSetupFocusRef.current = false;
          computerRefreshStartedRef.current = false;
          setConnectingComputer((current) => !current);
        }}
        onToggleComputer={() => {
          setChangingRuntime(false);
          setConnectingComputer(false);
          setChangingComputer((current) => !current);
        }}
        onToggleRuntime={() => {
          setChangingComputer(false);
          setConnectingComputer(false);
          setChangingRuntime((current) => !current);
        }}
      />

      {error ? <Banner variant="error" role="alert" description={error} /> : null}
      <div className="flex flex-wrap justify-end gap-3">
        {onCancel ? (
          <Button disabled={submitting} variant="secondary" onClick={onCancel}>
            {m.agent_create_cancel_action()}
          </Button>
        ) : null}
        <Button
          disabled={submitting || recovery.checking || recovery.intent !== undefined || refreshing || !selectedRoute}
          type="submit"
        >
          {submitting ? (
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true">
                <Loader aria-label={m.agent_create_creating_agent_label()} size="sm" />
              </span>
              {m.agent_create_creating_action()}
            </span>
          ) : (
            m.agent_create_create_agent_action()
          )}
        </Button>
      </div>
    </form>
  );
}

function RuntimeRouteSection({
  changingComputer,
  changingRuntime,
  connectingComputer,
  computerChangeButtonRef,
  displayedComputer,
  displayedProvider,
  facts,
  onChangeComputer,
  onChangeRuntime,
  onConnected,
  onRefresh,
  onToggleComputerSetup,
  onToggleComputer,
  onToggleRuntime,
  preview,
  readyRoutes,
  refreshing,
  selectedRoute,
  submitting,
}: {
  changingComputer: boolean;
  changingRuntime: boolean;
  connectingComputer: boolean;
  computerChangeButtonRef: { current: HTMLButtonElement | null };
  displayedComputer: AgentCreationComputer | undefined;
  displayedProvider: AgentCreationProvider | undefined;
  facts: AgentCreationFacts;
  onChangeComputer: (computer: AgentCreationComputer) => void;
  onChangeRuntime: (provider: AgentCreationProvider) => void;
  onConnected: (computer: AgentCreationComputer) => void;
  onRefresh: () => void;
  onToggleComputerSetup: () => void;
  onToggleComputer: () => void;
  onToggleRuntime: () => void;
  preview: boolean;
  readyRoutes: readonly ReadyRoute[];
  refreshing: boolean;
  selectedRoute: ReadyRoute | undefined;
  submitting: boolean;
}) {
  const onlineComputers = facts.computers.filter((computer) => computer.connectionStatus === "online");
  const attention = providerAttention(facts, displayedComputer, displayedProvider);
  const providerOptions = [...facts.providers]
    .filter((provider) => provider.computerId === displayedComputer?.id)
    .sort((left, right) => providerRank(left.provider) - providerRank(right.provider));
  const computerOptions = [...facts.computers].sort((left, right) => compareText(left.displayName, right.displayName));
  // The heading names the section and everything under it answers it: the route rows label
  // themselves Computer and Runtime, and where there is no Computer yet the setup panel names the
  // task. A sentence here would only say those labels again, which is one more line between the
  // Account and the single action this step asks for.
  return (
    <section aria-labelledby="agent-runtime-heading" className="grid gap-4 border-t border-kumo-line pt-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <Text as="h3" id="agent-runtime-heading" variant="heading">
            {m.agent_create_where_it_runs_title()}
          </Text>
        </div>
      </header>

      {facts.computers.length === 0 ? (
        <div className="grid gap-4">
          <div className="grid gap-1">
            <Text as="h4" variant="heading">
              {m.computer_connect_agent_title()}
            </Text>
            <Text as="p" variant="secondary">
              {m.computer_connect_agent_description()}
            </Text>
          </div>
          {preview ? null : (
            <ComputerConnect
              intent={{ mode: "create" }}
              onConnected={(computer) =>
                onConnected({
                  id: computer.computerId,
                  displayName: computer.displayName,
                  connectionStatus: computer.connectionStatus,
                })
              }
            />
          )}
        </div>
      ) : displayedComputer ? (
        <>
          <div className="grid divide-y divide-kumo-line rounded-md bg-kumo-base ring ring-kumo-line">
            <div className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="grid gap-1">
                <span className="text-xs text-kumo-subtle">{m.agent_create_computer_label()}</span>
                <strong>{displayedComputer.displayName}</strong>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <RouteState
                  label={
                    displayedComputer.connectionStatus === "online"
                      ? m.agent_create_online_status()
                      : m.agent_create_offline_status()
                  }
                  tone={displayedComputer.connectionStatus === "online" ? "success" : "warning"}
                />
                <Button
                  aria-controls="new-agent-computer-picker"
                  aria-expanded={changingComputer}
                  aria-label={m.agent_create_change_computer_label()}
                  disabled={submitting || refreshing}
                  ref={computerChangeButtonRef}
                  size="compact"
                  variant="inline"
                  onClick={onToggleComputer}
                >
                  {m.agent_create_change_action()}
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="grid gap-1">
                <span className="text-xs text-kumo-subtle">{m.agent_create_runtime_label()}</span>
                <strong>
                  {displayedProvider ? providerLabel(displayedProvider.provider) : m.agent_create_no_runtime_detected()}
                </strong>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <RouteState
                  label={selectedRoute ? m.agent_create_ready_status() : providerStatusLabel(displayedProvider)}
                  tone={selectedRoute ? "success" : providerStatusTone(displayedProvider)}
                />
                {providerOptions.length > 0 ? (
                  <Button
                    aria-controls="new-agent-runtime-picker"
                    aria-expanded={changingRuntime}
                    aria-label={m.agent_create_change_runtime_label()}
                    disabled={submitting || refreshing}
                    size="compact"
                    variant="inline"
                    onClick={onToggleRuntime}
                  >
                    {m.agent_create_change_action()}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>

          {changingComputer ? (
            <div className="grid gap-3 rounded-md bg-kumo-base p-3 ring ring-kumo-line" id="new-agent-computer-picker">
              <strong className="text-sm font-medium text-kumo-strong">{m.agent_create_choose_computer_title()}</strong>
              <div className="grid gap-2">
                {computerOptions.map((computer) => {
                  const routes = readyRoutes.filter((route) => route.computer.id === computer.id);
                  return (
                    <Button
                      aria-pressed={computer.id === displayedComputer.id}
                      className="h-auto w-full justify-between text-left data-[selected=true]:!bg-(--brand-soft) data-[selected=true]:ring-kumo-brand"
                      data-selected={computer.id === displayedComputer.id ? "true" : undefined}
                      disabled={submitting || refreshing}
                      key={computer.id}
                      type="button"
                      variant="secondary"
                      onClick={() => onChangeComputer(computer)}
                    >
                      <span className="grid gap-1">
                        <strong>{computer.displayName}</strong>
                        <small>{computerRouteSummary(computer, routes.length)}</small>
                      </span>
                      <span>
                        {computer.connectionStatus === "online"
                          ? m.agent_create_online_status()
                          : m.agent_create_offline_status()}
                      </span>
                    </Button>
                  );
                })}
              </div>
              <div className="flex justify-start">
                <Button
                  aria-controls="new-agent-computer-setup"
                  aria-expanded={connectingComputer}
                  disabled={submitting}
                  size="compact"
                  variant="inline"
                  onClick={onToggleComputerSetup}
                >
                  {connectingComputer
                    ? m.agent_create_cancel_computer_connection()
                    : m.agent_create_connect_another_computer()}
                </Button>
              </div>
              {connectingComputer ? (
                <div className="grid gap-4" id="new-agent-computer-setup">
                  <div className="grid gap-1">
                    <Text as="h4" variant="heading">
                      {m.computer_connect_another_title()}
                    </Text>
                    <Text as="p" variant="secondary">
                      {m.computer_connect_another_description()}
                    </Text>
                  </div>
                  {preview ? null : (
                    <ComputerConnect
                      intent={{ mode: "create" }}
                      onConnected={(computer) =>
                        onConnected({
                          id: computer.computerId,
                          displayName: computer.displayName,
                          connectionStatus: computer.connectionStatus,
                        })
                      }
                    />
                  )}
                </div>
              ) : null}
            </div>
          ) : null}

          {changingRuntime ? (
            <div className="grid gap-3 rounded-md bg-kumo-base p-3 ring ring-kumo-line" id="new-agent-runtime-picker">
              <strong className="text-sm font-medium text-kumo-strong">{m.agent_create_choose_runtime_title()}</strong>
              <div className="grid gap-2">
                {providerOptions.map((provider) => {
                  const route = readyRoutes.find(
                    (candidate) =>
                      candidate.computer.id === provider.computerId && candidate.provider === provider.provider,
                  );
                  return (
                    <Button
                      aria-pressed={provider.provider === displayedProvider?.provider}
                      className="h-auto w-full justify-between text-left data-[selected=true]:!bg-(--brand-soft) data-[selected=true]:ring-kumo-brand"
                      data-selected={provider.provider === displayedProvider?.provider ? "true" : undefined}
                      disabled={submitting || refreshing || route === undefined}
                      key={provider.provider}
                      type="button"
                      variant="secondary"
                      onClick={() => onChangeRuntime(provider)}
                    >
                      <strong>{providerLabel(provider.provider)}</strong>
                      <span>{providerStatusLabel(provider)}</span>
                    </Button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {selectedRoute ? (
            <div aria-live="polite" className="px-1" role="status">
              <StatusIndicator label={m.agent_create_ready_to_run_status()} tone="success" />
            </div>
          ) : displayedComputer.connectionStatus === "offline" ? (
            <RuntimeAttention
              detail={
                onlineComputers.length === 0
                  ? m.agent_create_reconnect_computer_to_continue()
                  : m.agent_create_reconnect_named_computer_to_continue({ displayName: displayedComputer.displayName })
              }
              label={m.agent_create_computer_offline_status()}
              refreshing={refreshing}
              tone="warning"
              onRefresh={onRefresh}
            />
          ) : (
            <RuntimeAttention
              detail={attention.detail}
              label={attention.label}
              refreshing={refreshing}
              tone={attention.tone}
              onRefresh={onRefresh}
            />
          )}
        </>
      ) : null}
    </section>
  );
}

function RouteState({ label, tone }: { label: string; tone: "success" | "warning" | "neutral" }) {
  return <StatusIndicator label={label} tone={tone} />;
}

function computerRouteSummary(computer: AgentCreationComputer, readyRuntimeCount: number): string {
  if (computer.connectionStatus === "offline") return m.agent_create_computer_offline_status();
  if (readyRuntimeCount === 0) return m.agent_create_no_runtime_ready();
  return readyRuntimeCount === 1
    ? m.agent_create_runtime_ready({ count: formatNumber(readyRuntimeCount) })
    : m.agent_create_runtimes_ready({ count: formatNumber(readyRuntimeCount) });
}

function providerStatusLabel(provider: AgentCreationProvider | undefined): string {
  if (provider?.runtimeReady || provider?.status === "ready") return m.agent_create_ready_status();
  if (provider?.status === "checking") return m.agent_create_checking_status();
  if (provider?.status === "install") return m.agent_create_not_installed_status();
  if (provider?.status === "sign-in") return m.agent_create_sign_in_required_status();
  if (provider?.status === "unavailable") return m.agent_create_unavailable_status();
  return m.agent_create_unconfirmed_status();
}

function providerStatusTone(provider: AgentCreationProvider | undefined): "success" | "warning" | "neutral" {
  if (provider?.runtimeReady || provider?.status === "ready") return "success";
  return provider?.status === "checking" || provider === undefined ? "neutral" : "warning";
}

function RuntimeAttention({
  detail,
  label,
  onRefresh,
  refreshing,
  tone,
}: {
  detail: string;
  label: string;
  onRefresh: () => void;
  refreshing: boolean;
  tone: StatusTone;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-kumo-base p-3">
      <StatusIndicator detail={detail} label={label} tone={tone} />
      <Button disabled={refreshing} size="compact" variant="secondary" onClick={onRefresh}>
        {refreshing ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true">
              <Loader aria-label={m.agent_create_checking_server_facts_label()} size="sm" />
            </span>
            {m.agent_create_checking_action()}
          </span>
        ) : (
          m.agent_create_check_again_action()
        )}
      </Button>
    </div>
  );
}

function providerAttention(
  facts: AgentCreationFacts,
  computer: AgentCreationComputer | undefined,
  selectedProvider: AgentCreationProvider | undefined,
): { detail: string; label: string; tone: StatusTone } {
  if (!facts.runtimeEvidenceAvailable) {
    return {
      label: m.agent_create_readiness_unconfirmed_label(),
      detail: m.agent_create_readiness_unconfirmed_detail(),
      tone: "neutral",
    };
  }
  const provider = selectedProvider;
  const providerName = providerLabel(provider?.provider ?? "codex");
  if (provider?.status === "install") {
    return {
      label: m.agent_create_install_provider({ provider: providerName }),
      detail: m.agent_create_install_provider_on_computer({
        provider: providerName,
        computer: computer?.displayName ?? m.agent_create_this_computer(),
      }),
      tone: "warning",
    };
  }
  if (provider?.status === "sign-in") {
    return {
      label: m.agent_create_sign_in_provider({ provider: providerName }),
      detail: m.agent_create_finish_sign_in_on_computer({
        computer: computer?.displayName ?? m.agent_create_this_computer(),
      }),
      tone: "warning",
    };
  }
  if (provider?.status === "checking") {
    return {
      label: m.agent_create_checking_setup_label(),
      detail: m.agent_create_provider_readiness_checking({ provider: providerName }),
      tone: "neutral",
    };
  }
  return {
    label: m.agent_create_provider_unavailable_label(),
    detail: m.agent_create_prepare_provider_on_computer({
      computer: computer?.displayName ?? m.agent_create_this_computer(),
    }),
    tone: "warning",
  };
}

function resolveReadyRoutes(facts: AgentCreationFacts): ReadyRoute[] {
  const computers = new Map(
    facts.computers
      .filter((computer) => computer.connectionStatus === "online")
      .map((computer) => [computer.id, computer]),
  );
  return facts.providers
    .filter((provider) => provider.runtimeReady)
    .map((provider) => ({ computer: computers.get(provider.computerId), provider: provider.provider }))
    .filter((route): route is ReadyRoute => route.computer !== undefined)
    .sort((left, right) => {
      const computerOrder = compareText(left.computer.displayName, right.computer.displayName);
      return computerOrder !== 0 ? computerOrder : providerRank(left.provider) - providerRank(right.provider);
    });
}

function providerRank(provider: AgentRuntimeProvider): number {
  return provider === "codex" ? 0 : 1;
}

function providerLabel(provider: AgentRuntimeProvider): string {
  return provider === "claude-code" ? m.agent_create_claude_code() : m.agent_create_codex();
}
