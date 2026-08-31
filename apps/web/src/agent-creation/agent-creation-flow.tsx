import type {
  AgentAdminConfig,
  AgentRuntimeProvider,
  CreateAgentRequest,
  ProviderReadinessStatus,
} from "@opentag/shared/browser";
import { AgentNameSchema } from "@opentag/shared/browser";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import { resolveAccountComputer } from "../features/agents/account-computer.js";
import { ComputerSetup } from "../features/agents/computer-setup.js";
import { compareText } from "../i18n/format.js";
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

const CREATE_INTENT_VERSION = 3;
const CREATION_INTENT_KEY_PREFIX = "opentag.agent-creation.intent:";

export interface AgentCreationComputer {
  readonly id: string;
  readonly displayName: string;
  readonly connectionStatus: "online" | "offline";
  /** Agents already bound to this Computer, which is what identifies it when none is reachable. */
  readonly agentCount: number;
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
 * what a Workspace that already holds Agents needs: the name carries a uniqueness constraint, so
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
  /** Renders the flow for review only: no creation intent is read or resumed and no Agent is created. */
  readonly preview?: boolean;
  readonly refreshing?: boolean;
  readonly accountId: string;
}

interface ReadyRoute {
  readonly computer: AgentCreationComputer;
  readonly provider: AgentRuntimeProvider;
}

interface CreationIntentRecord {
  readonly version: typeof CREATE_INTENT_VERSION;
  readonly accountId: string;
  readonly creationIntentId: string;
  readonly request: Omit<CreateAgentRequest, "creationIntentId">;
}

interface CreationIntentStore {
  readonly version: typeof CREATE_INTENT_VERSION;
  readonly accountId: string;
  readonly records: readonly CreationIntentRecord[];
}

const memoryIntentRecords = new Map<string, readonly CreationIntentRecord[]>();
const memoryIntentFallbackAccounts = new Set<string>();
const fallbackCreationLocks = new Map<string, Promise<void>>();
const creationRequests = new Map<string, Promise<AgentAdminConfig>>();

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
  const [changingRuntime, setChangingRuntime] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<AgentRuntimeProvider | undefined>(
    () => pendingIntent?.request.runtimeProvider,
  );
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const nameFieldRef = useRef<HTMLInputElement>(null);
  const inFlightRef = useRef(false);
  const resumeAttemptedRef = useRef(false);
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
  // The Account has one Computer, so this resolves which machine the form is talking about rather
  // than honouring a choice — through the same policy the Computer page uses, so the machine an
  // Agent is created on is the machine the Account manages and repairs.
  const displayedComputer = useMemo(
    () =>
      resolveAccountComputer(facts.computers, (computer) => ({
        connectionStatus: computer.connectionStatus,
        runtimeReady: facts.providers.some((provider) => provider.computerId === computer.id && provider.runtimeReady),
        agentCount: computer.agentCount,
        displayName: computer.displayName,
      })),
    [facts.computers, facts.providers],
  );
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
    firstFieldRef.current?.focus();
  }, [refreshing]);

  const create = useCallback(
    async (request: Omit<CreateAgentRequest, "creationIntentId">, intent?: CreationIntentRecord) => {
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
        await clearCreationIntents(accountId);
        onCreated(created);
      } catch (cause) {
        if (cause instanceof ApiError) {
          const issue = cause.issues?.find(({ path }) => path[0] === "name");
          if (issue || cause.code === "AGENT_NAME_CONFLICT") {
            if (record) await clearCreationIntent(accountId, record.creationIntentId);
            setEditingName(true);
            setNameError(issue?.message ?? cause.message);
            return;
          }
          if (record && (cause.category === "validation" || cause.category === "deterministic")) {
            await clearCreationIntent(accountId, record.creationIntentId);
          }
        }
        setError(cause instanceof Error ? cause.message : "Agent creation failed");
      } finally {
        inFlightRef.current = false;
        setSubmitting(false);
        onSubmittingChange?.(false);
      }
    },
    [onCreated, onSubmittingChange, preview, accountId],
  );

  useEffect(() => {
    if (!pendingIntent || resumeAttemptedRef.current) return;
    /*
     * A resume finishes what the reader started, so it may only send what the reader is looking at.
     * An intent stored by an older build can name a Computer this form no longer displays — one of
     * several enrollments, resolved away — and sending it then creates the Agent on a machine that
     * is nowhere on screen. Requiring the stored route to be the displayed route keeps the target
     * visible; a stored intent that names another machine is simply not resumed, leaving its fields
     * on the form for the reader to submit against the Computer they can see.
     */
    const resumesTheDisplayedRoute =
      selectedRoute !== undefined &&
      selectedRoute.computer.id === pendingIntent.request.computerId &&
      selectedRoute.provider === pendingIntent.request.runtimeProvider;
    if (!resumesTheDisplayedRoute) return;
    resumeAttemptedRef.current = true;
    void create(pendingIntent.request, pendingIntent);
  }, [create, pendingIntent, selectedRoute]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlightRef.current || !selectedRoute) return;
    setError(undefined);
    setNameError(undefined);
    const parsedName = AgentNameSchema.safeParse(name);
    if (!parsedName.success) {
      setEditingName(true);
      setNameError(parsedName.error.issues[0]?.message ?? "Agent name is invalid");
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
      <div className="grid gap-4">
        <Field htmlFor="new-agent-display-name" label="Display name">
          <KumoInputControl
            id="new-agent-display-name"
            ref={firstFieldRef}
            name="displayName"
            placeholder="Research Assistant"
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
              <p className="text-sm text-kumo-danger">
                This display name cannot produce an @ name. Set one to continue.
              </p>
            ) : null}
            <Button
              aria-label="Edit Agent name"
              aria-controls="agent-name-editor"
              aria-expanded="false"
              className="w-fit"
              disabled={submitting}
              variant="inline"
              onClick={() => setEditingName(true)}
            >
              {name ? `@${name}` : "Set Agent name"}
            </Button>
          </div>
        ) : null}
        {editingName ? (
          <div id="agent-name-editor">
            <Field
              error={nameError}
              errorId="agent-name-error"
              hint="Used for mentions. Lowercase letters, numbers, and hyphens only."
              hintId="new-agent-name-hint"
              htmlFor="new-agent-name"
              label="Agent name"
            >
              <span className="grid grid-cols-[auto_1fr] items-center gap-2">
                <span aria-hidden="true">@</span>
                <KumoInputControl
                  aria-describedby={nameError ? "new-agent-name-hint agent-name-error" : "new-agent-name-hint"}
                  aria-invalid={nameError ? true : undefined}
                  aria-labelledby="new-agent-name-label"
                  id="new-agent-name"
                  ref={nameFieldRef}
                  placeholder="research-assistant"
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
        changingRuntime={changingRuntime}
        displayedComputer={displayedComputer}
        displayedProvider={displayedProvider}
        facts={facts}
        preview={preview}
        readyRoutes={readyRoutes}
        refreshing={refreshing}
        selectedRoute={selectedRoute}
        submitting={submitting}
        onChangeRuntime={(provider) => {
          setSelectedProvider(provider.provider);
          setChangingRuntime(false);
        }}
        onConnected={(computer) => {
          connectedComputerIdRef.current = computer.id;
          restoreComputerSetupFocusRef.current = true;
          computerRefreshStartedRef.current = false;
          if (onCancel) onComputerRefreshFocus?.();
          onRefresh();
        }}
        onRefresh={onRefresh}
        onToggleRuntime={() => {
          setChangingRuntime((current) => !current);
        }}
      />

      {error ? <Banner variant="error" role="alert" description={error} /> : null}
      <div className="flex flex-wrap justify-end gap-3">
        {onCancel ? (
          <Button disabled={submitting} variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button disabled={submitting || refreshing || !selectedRoute} type="submit">
          {submitting ? (
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true">
                <Loader aria-label="Creating Agent" size="sm" />
              </span>
              Creating…
            </span>
          ) : (
            "Create Agent"
          )}
        </Button>
      </div>
    </form>
  );
}

function RuntimeRouteSection({
  changingRuntime,
  displayedComputer,
  displayedProvider,
  facts,
  onChangeRuntime,
  onConnected,
  onRefresh,
  onToggleRuntime,
  preview,
  readyRoutes,
  refreshing,
  selectedRoute,
  submitting,
}: {
  changingRuntime: boolean;
  displayedComputer: AgentCreationComputer | undefined;
  displayedProvider: AgentCreationProvider | undefined;
  facts: AgentCreationFacts;
  onChangeRuntime: (provider: AgentCreationProvider) => void;
  onConnected: (computer: AgentCreationComputer) => void;
  onRefresh: () => void;
  onToggleRuntime: () => void;
  preview: boolean;
  readyRoutes: readonly ReadyRoute[];
  refreshing: boolean;
  selectedRoute: ReadyRoute | undefined;
  submitting: boolean;
}) {
  const attention = providerAttention(facts, displayedComputer, displayedProvider);
  const providerOptions = [...facts.providers]
    .filter((provider) => provider.computerId === displayedComputer?.id)
    .sort((left, right) => providerRank(left.provider) - providerRank(right.provider));
  // The heading names the section and everything under it answers it: the route rows label
  // themselves Computer and Runtime, and where there is no Computer yet the setup panel names the
  // task. A sentence here would only say those labels again, which is one more line between the
  // Account and the single action this step asks for.
  return (
    <section
      aria-labelledby="agent-runtime-heading"
      className="grid gap-4 rounded-lg bg-kumo-recessed p-4 ring ring-kumo-line"
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <Text as="h3" id="agent-runtime-heading" variant="heading">
            Where it runs
          </Text>
        </div>
      </header>

      {facts.computers.length === 0 ? (
        <div className="grid gap-4">
          <ComputerSetup
            preview={preview}
            onConnected={(computer) =>
              onConnected({
                id: computer.computerId,
                displayName: computer.displayName,
                connectionStatus: computer.connectionStatus,
                agentCount: computer.agentIds.length,
              })
            }
          />
        </div>
      ) : displayedComputer ? (
        <>
          <div className="grid divide-y divide-kumo-line rounded-md bg-kumo-base ring ring-kumo-line">
            <div className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="grid gap-1">
                <span className="text-xs text-kumo-subtle">Computer</span>
                <strong>{displayedComputer.displayName}</strong>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <RouteState
                  label={displayedComputer.connectionStatus === "online" ? "Online" : "Offline"}
                  tone={displayedComputer.connectionStatus === "online" ? "success" : "warning"}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="grid gap-1">
                <span className="text-xs text-kumo-subtle">Runtime</span>
                <strong>{displayedProvider ? providerLabel(displayedProvider.provider) : "No Runtime detected"}</strong>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <RouteState
                  label={selectedRoute ? "Ready" : providerStatusLabel(displayedProvider)}
                  tone={selectedRoute ? "success" : providerStatusTone(displayedProvider)}
                />
                {providerOptions.length > 0 ? (
                  <Button
                    aria-controls="new-agent-runtime-picker"
                    aria-expanded={changingRuntime}
                    aria-label="Change Runtime"
                    disabled={submitting || refreshing}
                    size="compact"
                    variant="inline"
                    onClick={onToggleRuntime}
                  >
                    Change
                  </Button>
                ) : null}
              </div>
            </div>
          </div>

          {changingRuntime ? (
            <div className="grid gap-3 rounded-md bg-kumo-base p-3 ring ring-kumo-line" id="new-agent-runtime-picker">
              <strong className="text-sm font-medium text-kumo-strong">Choose Runtime</strong>
              <div className="grid gap-2">
                {providerOptions.map((provider) => {
                  const route = readyRoutes.find(
                    (candidate) =>
                      candidate.computer.id === provider.computerId && candidate.provider === provider.provider,
                  );
                  return (
                    <Button
                      aria-pressed={provider.provider === displayedProvider?.provider}
                      className="h-auto w-full justify-between text-left"
                      data-selected={provider.provider === displayedProvider?.provider ? "true" : undefined}
                      disabled={submitting || refreshing || route === undefined}
                      key={provider.provider}
                      type="button"
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
            <div aria-live="polite" className="rounded-md bg-kumo-base p-3" role="status">
              <StatusIndicator label="Ready to run" tone="success" />
            </div>
          ) : displayedComputer.connectionStatus === "offline" ? (
            <RuntimeAttention
              detail={`Reconnect ${displayedComputer.displayName} from the Computer page to continue.`}
              label="Computer offline"
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

function providerStatusLabel(provider: AgentCreationProvider | undefined): string {
  if (provider?.runtimeReady || provider?.status === "ready") return "Ready";
  if (provider?.status === "checking") return "Checking";
  if (provider?.status === "install") return "Not installed";
  if (provider?.status === "sign-in") return "Sign-in required";
  if (provider?.status === "unavailable") return "Unavailable";
  return "Unconfirmed";
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
              <Loader aria-label="Checking Server facts" size="sm" />
            </span>
            Checking…
          </span>
        ) : (
          "Check again"
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
      label: "Readiness unconfirmed",
      detail: "OpenTag cannot confirm a ready Provider on this Computer yet.",
      tone: "neutral",
    };
  }
  const provider = selectedProvider;
  const providerName = providerLabel(provider?.provider ?? "codex");
  if (provider?.status === "install") {
    return {
      label: `Install ${providerName}`,
      detail: `Install ${providerName} on ${computer?.displayName}.`,
      tone: "warning",
    };
  }
  if (provider?.status === "sign-in") {
    return {
      label: `Sign in to ${providerName}`,
      detail: `Finish sign-in on ${computer?.displayName}.`,
      tone: "warning",
    };
  }
  if (provider?.status === "checking") {
    return { label: "Checking setup", detail: `${providerName} readiness is still being checked.`, tone: "neutral" };
  }
  return {
    label: "Provider unavailable",
    detail: `Prepare Codex or Claude Code on ${computer?.displayName ?? "this Computer"}.`,
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
  return provider === "claude-code" ? "Claude Code" : "Codex";
}

function createAgentOnce(record: CreationIntentRecord): Promise<AgentAdminConfig> {
  const existing = creationRequests.get(record.creationIntentId);
  if (existing) return existing;
  const request = browserApi.createAgent({
    ...record.request,
    creationIntentId: record.creationIntentId,
  });
  creationRequests.set(record.creationIntentId, request);
  void request.catch(() => creationRequests.delete(record.creationIntentId));
  return request;
}

async function withCreationLock<T>(accountId: string, task: () => Promise<T> | T): Promise<T> {
  const lockName = `opentag:create-agent:${accountId}`;
  if (navigator.locks) return navigator.locks.request(lockName, task);
  const prior = fallbackCreationLocks.get(lockName) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prior.then(() => current);
  fallbackCreationLocks.set(lockName, queued);
  await prior;
  try {
    return await task();
  } finally {
    release();
    if (fallbackCreationLocks.get(lockName) === queued) fallbackCreationLocks.delete(lockName);
  }
}

async function getOrCreateCreationIntent(
  accountId: string,
  request: Omit<CreateAgentRequest, "creationIntentId">,
): Promise<CreationIntentRecord> {
  return withCreationLock(accountId, () => {
    const records = readCreationIntents(accountId);
    const fingerprint = JSON.stringify(request);
    const existing = records.find((record) => JSON.stringify(record.request) === fingerprint);
    if (existing) return existing;
    const next: CreationIntentRecord = {
      version: CREATE_INTENT_VERSION,
      accountId,
      creationIntentId: crypto.randomUUID(),
      request,
    };
    writeCreationIntents(accountId, [...records, next]);
    return next;
  });
}

function readCreationIntent(accountId: string): CreationIntentRecord | undefined {
  return readCreationIntents(accountId).at(-1);
}

function readCreationIntents(accountId: string): readonly CreationIntentRecord[] {
  try {
    const raw = window.localStorage.getItem(creationIntentKey(accountId));
    if (!raw) {
      if (memoryIntentFallbackAccounts.has(accountId)) return memoryIntentRecords.get(accountId) ?? [];
      memoryIntentRecords.delete(accountId);
      return [];
    }
    const value = JSON.parse(raw) as Partial<CreationIntentStore>;
    if (
      value.version !== CREATE_INTENT_VERSION ||
      value.accountId !== accountId ||
      !Array.isArray(value.records) ||
      !value.records.every((record) => validCreationIntentRecord(record, accountId))
    ) {
      return [];
    }
    const records = value.records as readonly CreationIntentRecord[];
    memoryIntentRecords.set(accountId, records);
    return records;
  } catch {
    return memoryIntentRecords.get(accountId) ?? [];
  }
}

function writeCreationIntents(accountId: string, records: readonly CreationIntentRecord[]): void {
  memoryIntentRecords.set(accountId, records);
  try {
    window.localStorage.setItem(
      creationIntentKey(accountId),
      JSON.stringify({ version: CREATE_INTENT_VERSION, accountId, records } satisfies CreationIntentStore),
    );
    memoryIntentFallbackAccounts.delete(accountId);
  } catch {
    memoryIntentFallbackAccounts.add(accountId);
  }
}

/**
 * Retires every creation intent this Account holds, which is what a successful creation makes of
 * them: they exist to survive one act of creating one Agent, and the reader may have abandoned
 * several along the way by changing the name or the route. A record left behind is not inert — the
 * resume effect will send it the moment its old route is displayed again, creating a second Agent
 * nobody asked for. Refusing to resume a hidden route only defers that; retiring the record ends it.
 */
async function clearCreationIntents(accountId: string): Promise<void> {
  await withCreationLock(accountId, () => {
    memoryIntentRecords.delete(accountId);
    memoryIntentFallbackAccounts.delete(accountId);
    try {
      window.localStorage.removeItem(creationIntentKey(accountId));
    } catch {
      // No durable record is available to clear.
    }
  });
}

async function clearCreationIntent(accountId: string, creationIntentId: string): Promise<void> {
  await withCreationLock(accountId, () => {
    const records = readCreationIntents(accountId).filter((record) => record.creationIntentId !== creationIntentId);
    if (records.length > 0) {
      writeCreationIntents(accountId, records);
      return;
    }
    memoryIntentRecords.delete(accountId);
    memoryIntentFallbackAccounts.delete(accountId);
    try {
      window.localStorage.removeItem(creationIntentKey(accountId));
    } catch {
      // No durable record is available to clear.
    }
  });
}

function validCreationIntentRecord(value: unknown, accountId: string): value is CreationIntentRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CreationIntentRecord>;
  return (
    record.version === CREATE_INTENT_VERSION &&
    record.accountId === accountId &&
    typeof record.creationIntentId === "string" &&
    record.request !== undefined &&
    typeof record.request.name === "string" &&
    typeof record.request.displayName === "string" &&
    typeof record.request.computerId === "string" &&
    (record.request.runtimeProvider === "codex" || record.request.runtimeProvider === "claude-code")
  );
}

function creationIntentKey(accountId: string): string {
  return `${CREATION_INTENT_KEY_PREFIX}${accountId}`;
}

/**
 * Drops creation intents written in a superseded format. Records were previously scoped by the internal
 * Workspace, so after the move to Account scoping their keys are never read again; removing them by stored
 * version leaves other Accounts' current records on a shared browser untouched.
 */
function pruneSupersededCreationIntents(): void {
  try {
    const stale: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(CREATION_INTENT_KEY_PREFIX)) continue;
      const raw = window.localStorage.getItem(key);
      if (raw === null) continue;
      let version: unknown;
      try {
        version = (JSON.parse(raw) as Partial<CreationIntentStore>).version;
      } catch {
        version = undefined;
      }
      if (version !== CREATE_INTENT_VERSION) stale.push(key);
    }
    for (const key of stale) window.localStorage.removeItem(key);
  } catch {
    // Storage is unavailable; the superseded records are unreadable either way.
  }
}
