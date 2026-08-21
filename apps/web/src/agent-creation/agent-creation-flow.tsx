import type {
  AgentAdminConfig,
  AgentRuntimeProvider,
  CreateAgentRequest,
  ProviderReadinessStatus,
} from "@opentag/shared/browser";
import { AgentNameSchema } from "@opentag/shared/browser";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import { ComputerSetup } from "../computer-setup.js";
import { Button, Field, StatusIndicator, type StatusTone } from "../ui/design-system.js";

const CREATE_INTENT_VERSION = 2;

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

export interface AgentCreationFlowProps {
  readonly facts: AgentCreationFacts;
  readonly initialDisplayName?: string;
  readonly onCancel?: () => void;
  readonly onComputerRefreshFocus?: () => void;
  readonly onCreated: (agent: AgentAdminConfig) => void;
  readonly onRefresh: () => void;
  readonly onSubmittingChange?: (submitting: boolean) => void;
  readonly refreshing?: boolean;
  readonly teamId: string;
}

interface ReadyRoute {
  readonly computer: AgentCreationComputer;
  readonly provider: AgentRuntimeProvider;
}

interface CreationIntentRecord {
  readonly version: typeof CREATE_INTENT_VERSION;
  readonly teamId: string;
  readonly creationIntentId: string;
  readonly request: Omit<CreateAgentRequest, "creationIntentId">;
}

interface CreationIntentStore {
  readonly version: typeof CREATE_INTENT_VERSION;
  readonly teamId: string;
  readonly records: readonly CreationIntentRecord[];
}

const memoryIntentRecords = new Map<string, readonly CreationIntentRecord[]>();
const memoryIntentFallbackTeams = new Set<string>();
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
  facts,
  initialDisplayName = "",
  onCancel,
  onComputerRefreshFocus,
  onCreated,
  onRefresh,
  onSubmittingChange,
  refreshing = false,
  teamId,
}: AgentCreationFlowProps) {
  const pendingIntent = useMemo(() => readCreationIntent(teamId), [teamId]);
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
  const [changingRoute, setChangingRoute] = useState(false);
  const [connectingComputer, setConnectingComputer] = useState(false);
  const [selectedRouteKey, setSelectedRouteKey] = useState(() =>
    pendingIntent ? routeKey(pendingIntent.request.computerId, pendingIntent.request.runtimeProvider) : undefined,
  );
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const nameFieldRef = useRef<HTMLInputElement>(null);
  const computerSetupToggleRef = useRef<HTMLButtonElement>(null);
  const inFlightRef = useRef(false);
  const resumeAttemptedRef = useRef(false);
  const connectedComputerIdRef = useRef<string | undefined>(undefined);
  const restoreComputerSetupFocusRef = useRef(false);
  const computerRefreshStartedRef = useRef(false);

  const readyRoutes = useMemo(() => resolveReadyRoutes(facts), [facts]);
  const selectedRoute =
    readyRoutes.find((route) => routeKey(route.computer.id, route.provider) === selectedRouteKey) ?? readyRoutes[0];
  const alternatives = readyRoutes.filter((route) => route !== selectedRoute);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  useEffect(() => {
    if (editingName) nameFieldRef.current?.focus();
  }, [editingName]);

  useEffect(() => {
    if (nameError) nameFieldRef.current?.focus();
  }, [nameError]);

  useEffect(() => {
    const connectedComputerId = connectedComputerIdRef.current;
    if (!connectedComputerId) return;
    const connectedRoute = readyRoutes.find((route) => route.computer.id === connectedComputerId);
    if (!connectedRoute) return;
    setSelectedRouteKey(routeKey(connectedRoute.computer.id, connectedRoute.provider));
    connectedComputerIdRef.current = undefined;
  }, [readyRoutes]);

  useEffect(() => {
    if (!restoreComputerSetupFocusRef.current) return;
    if (refreshing) {
      computerRefreshStartedRef.current = true;
      return;
    }
    if (!computerRefreshStartedRef.current) return;
    restoreComputerSetupFocusRef.current = false;
    computerRefreshStartedRef.current = false;
    (computerSetupToggleRef.current ?? firstFieldRef.current)?.focus();
  }, [refreshing]);

  const create = useCallback(
    async (request: Omit<CreateAgentRequest, "creationIntentId">, intent?: CreationIntentRecord) => {
      if (inFlightRef.current) return;
      let record = intent;
      inFlightRef.current = true;
      setError(undefined);
      setNameError(undefined);
      setSubmitting(true);
      onSubmittingChange?.(true);
      try {
        record ??= await getOrCreateCreationIntent(teamId, request);
        const created = await createAgentOnce(record);
        await clearCreationIntent(teamId, record.creationIntentId);
        onCreated(created);
      } catch (cause) {
        if (cause instanceof ApiError) {
          const issue = cause.issues?.find(({ path }) => path[0] === "name");
          if (issue || cause.code === "AGENT_NAME_CONFLICT") {
            if (record) await clearCreationIntent(teamId, record.creationIntentId);
            setEditingName(true);
            setNameError(issue?.message ?? cause.message);
            return;
          }
          if (record && (cause.category === "validation" || cause.category === "deterministic")) {
            await clearCreationIntent(teamId, record.creationIntentId);
          }
        }
        setError(cause instanceof Error ? cause.message : "Agent creation failed");
      } finally {
        inFlightRef.current = false;
        setSubmitting(false);
        onSubmittingChange?.(false);
      }
    },
    [onCreated, onSubmittingChange, teamId],
  );

  useEffect(() => {
    if (!pendingIntent || resumeAttemptedRef.current) return;
    const routeStillReady = readyRoutes.some(
      (route) =>
        route.computer.id === pendingIntent.request.computerId &&
        route.provider === pendingIntent.request.runtimeProvider,
    );
    if (!routeStillReady) return;
    resumeAttemptedRef.current = true;
    void create(pendingIntent.request, pendingIntent);
  }, [create, pendingIntent, readyRoutes]);

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
    <form className="form-card agent-create-form" onSubmit={submit}>
      <div className="agent-create-identity">
        <Field className="agent-create-field" htmlFor="new-agent-display-name" label="Display name">
          <input
            className="ds-control"
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
        {!editingName ? (
          <div className="agent-name-summary">
            <Button
              aria-label="Edit Agent name"
              aria-controls="agent-name-editor"
              aria-expanded="false"
              className="agent-name-handle"
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
              className="agent-create-field"
              error={nameError}
              errorId="agent-name-error"
              hint="Used for mentions. Lowercase letters, numbers, and hyphens only."
              hintId="new-agent-name-hint"
              htmlFor="new-agent-name"
              label="Agent name"
            >
              <span className="agent-name-input">
                <span aria-hidden="true">@</span>
                <input
                  aria-describedby={nameError ? "new-agent-name-hint agent-name-error" : "new-agent-name-hint"}
                  aria-invalid={nameError ? true : undefined}
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
        alternatives={alternatives}
        changingRoute={changingRoute}
        connectingComputer={connectingComputer}
        computerSetupToggleRef={computerSetupToggleRef}
        facts={facts}
        refreshing={refreshing}
        selectedRoute={selectedRoute}
        submitting={submitting}
        teamId={teamId}
        onChangeRoute={(route) => {
          setSelectedRouteKey(routeKey(route.computer.id, route.provider));
          setChangingRoute(false);
        }}
        onConnected={(computer) => {
          connectedComputerIdRef.current = computer.id;
          restoreComputerSetupFocusRef.current = true;
          computerRefreshStartedRef.current = false;
          if (onCancel) onComputerRefreshFocus?.();
          setConnectingComputer(false);
          onRefresh();
        }}
        onRefresh={onRefresh}
        onToggleComputerSetup={() => {
          restoreComputerSetupFocusRef.current = false;
          computerRefreshStartedRef.current = false;
          setConnectingComputer((current) => !current);
        }}
        onToggleRoutes={() => setChangingRoute((value) => !value)}
      />

      {error ? (
        <div className="notice error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="agent-create-actions">
        {onCancel ? (
          <Button disabled={submitting} variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button disabled={submitting || refreshing || !selectedRoute} type="submit">
          {submitting ? "Creating…" : "Create Agent"}
        </Button>
      </div>
    </form>
  );
}

function RuntimeRouteSection({
  alternatives,
  changingRoute,
  connectingComputer,
  computerSetupToggleRef,
  facts,
  onChangeRoute,
  onConnected,
  onRefresh,
  onToggleComputerSetup,
  onToggleRoutes,
  refreshing,
  selectedRoute,
  submitting,
  teamId,
}: {
  alternatives: readonly ReadyRoute[];
  changingRoute: boolean;
  connectingComputer: boolean;
  computerSetupToggleRef: { current: HTMLButtonElement | null };
  facts: AgentCreationFacts;
  onChangeRoute: (route: ReadyRoute) => void;
  onConnected: (computer: AgentCreationComputer) => void;
  onRefresh: () => void;
  onToggleComputerSetup: () => void;
  onToggleRoutes: () => void;
  refreshing: boolean;
  selectedRoute: ReadyRoute | undefined;
  submitting: boolean;
  teamId: string;
}) {
  const onlineComputers = facts.computers.filter((computer) => computer.connectionStatus === "online");
  const attention = providerAttention(facts, onlineComputers[0]);
  return (
    <section aria-labelledby="agent-runtime-heading" className="agent-create-runtime">
      <header className="agent-create-runtime-header">
        <div>
          <h3 id="agent-runtime-heading">Where it runs</h3>
          {selectedRoute ? (
            <p>
              {providerLabel(selectedRoute.provider)} · {selectedRoute.computer.displayName}
            </p>
          ) : null}
        </div>
        {selectedRoute && alternatives.length > 0 ? (
          <Button
            aria-expanded={changingRoute}
            disabled={submitting || refreshing}
            size="compact"
            variant="ghost"
            onClick={onToggleRoutes}
          >
            Change
          </Button>
        ) : null}
      </header>

      {facts.computers.length === 0 ? (
        <div className="agent-create-runtime-setup">
          <ComputerSetup teamId={teamId} onConnected={onConnected} />
        </div>
      ) : selectedRoute ? (
        <>
          <div aria-live="polite" className="agent-create-runtime-status" role="status">
            <StatusIndicator label="Ready to run" tone="success" />
          </div>
          {changingRoute ? (
            <div className="agent-create-route-list">
              {[selectedRoute, ...alternatives].map((route) => (
                <button
                  className="agent-create-route-option"
                  data-selected={route === selectedRoute ? "true" : undefined}
                  disabled={submitting || refreshing}
                  key={routeKey(route.computer.id, route.provider)}
                  type="button"
                  onClick={() => onChangeRoute(route)}
                >
                  <strong>{providerLabel(route.provider)}</strong>
                  <span>{route.computer.displayName}</span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : onlineComputers.length === 0 ? (
        <RuntimeAttention
          detail="Reconnect one of your Computers to continue."
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
      {facts.computers.length > 0 ? (
        <>
          <div className="agent-create-computer-action">
            <Button
              aria-controls="new-agent-computer-setup"
              aria-expanded={connectingComputer}
              disabled={submitting}
              ref={computerSetupToggleRef}
              size="compact"
              variant="inline"
              onClick={onToggleComputerSetup}
            >
              {connectingComputer ? "Cancel Computer connection" : "Connect another Computer"}
            </Button>
          </div>
          {connectingComputer ? (
            <div className="agent-create-runtime-setup" id="new-agent-computer-setup">
              <ComputerSetup teamId={teamId} onConnected={onConnected} />
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
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
    <div className="agent-create-runtime-attention">
      <StatusIndicator detail={detail} label={label} tone={tone} />
      <Button disabled={refreshing} size="compact" variant="secondary" onClick={onRefresh}>
        {refreshing ? "Checking…" : "Check again"}
      </Button>
    </div>
  );
}

function providerAttention(
  facts: AgentCreationFacts,
  computer: AgentCreationComputer | undefined,
): { detail: string; label: string; tone: StatusTone } {
  if (!facts.runtimeEvidenceAvailable) {
    return {
      label: "Readiness unconfirmed",
      detail: "OpenTag cannot confirm a ready Provider on this Computer yet.",
      tone: "neutral",
    };
  }
  const provider = facts.providers.find((candidate) => candidate.computerId === computer?.id);
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
      const computerOrder = left.computer.displayName.localeCompare(right.computer.displayName);
      return computerOrder !== 0 ? computerOrder : providerRank(left.provider) - providerRank(right.provider);
    });
}

function providerRank(provider: AgentRuntimeProvider): number {
  return provider === "codex" ? 0 : 1;
}

function providerLabel(provider: AgentRuntimeProvider): string {
  return provider === "claude-code" ? "Claude Code" : "Codex";
}

function routeKey(computerId: string, provider: AgentRuntimeProvider): string {
  return `${computerId}:${provider}`;
}

function createAgentOnce(record: CreationIntentRecord): Promise<AgentAdminConfig> {
  const existing = creationRequests.get(record.creationIntentId);
  if (existing) return existing;
  const request = browserApi.createAgent(record.teamId, {
    ...record.request,
    creationIntentId: record.creationIntentId,
  });
  creationRequests.set(record.creationIntentId, request);
  void request.catch(() => creationRequests.delete(record.creationIntentId));
  return request;
}

async function withCreationLock<T>(teamId: string, task: () => Promise<T> | T): Promise<T> {
  const lockName = `opentag:create-agent:${teamId}`;
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
  teamId: string,
  request: Omit<CreateAgentRequest, "creationIntentId">,
): Promise<CreationIntentRecord> {
  return withCreationLock(teamId, () => {
    const records = readCreationIntents(teamId);
    const fingerprint = JSON.stringify(request);
    const existing = records.find((record) => JSON.stringify(record.request) === fingerprint);
    if (existing) return existing;
    const next: CreationIntentRecord = {
      version: CREATE_INTENT_VERSION,
      teamId,
      creationIntentId: crypto.randomUUID(),
      request,
    };
    writeCreationIntents(teamId, [...records, next]);
    return next;
  });
}

function readCreationIntent(teamId: string): CreationIntentRecord | undefined {
  return readCreationIntents(teamId).at(-1);
}

function readCreationIntents(teamId: string): readonly CreationIntentRecord[] {
  try {
    const raw = window.localStorage.getItem(creationIntentKey(teamId));
    if (!raw) {
      if (memoryIntentFallbackTeams.has(teamId)) return memoryIntentRecords.get(teamId) ?? [];
      memoryIntentRecords.delete(teamId);
      return [];
    }
    const value = JSON.parse(raw) as Partial<CreationIntentStore>;
    if (
      value.version !== CREATE_INTENT_VERSION ||
      value.teamId !== teamId ||
      !Array.isArray(value.records) ||
      !value.records.every((record) => validCreationIntentRecord(record, teamId))
    ) {
      return [];
    }
    const records = value.records as readonly CreationIntentRecord[];
    memoryIntentRecords.set(teamId, records);
    return records;
  } catch {
    return memoryIntentRecords.get(teamId) ?? [];
  }
}

function writeCreationIntents(teamId: string, records: readonly CreationIntentRecord[]): void {
  memoryIntentRecords.set(teamId, records);
  try {
    window.localStorage.setItem(
      creationIntentKey(teamId),
      JSON.stringify({ version: CREATE_INTENT_VERSION, teamId, records } satisfies CreationIntentStore),
    );
    memoryIntentFallbackTeams.delete(teamId);
  } catch {
    memoryIntentFallbackTeams.add(teamId);
  }
}

async function clearCreationIntent(teamId: string, creationIntentId: string): Promise<void> {
  await withCreationLock(teamId, () => {
    const records = readCreationIntents(teamId).filter((record) => record.creationIntentId !== creationIntentId);
    if (records.length > 0) {
      writeCreationIntents(teamId, records);
      return;
    }
    memoryIntentRecords.delete(teamId);
    memoryIntentFallbackTeams.delete(teamId);
    try {
      window.localStorage.removeItem(creationIntentKey(teamId));
    } catch {
      // No durable record is available to clear.
    }
  });
}

function validCreationIntentRecord(value: unknown, teamId: string): value is CreationIntentRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CreationIntentRecord>;
  return (
    record.version === CREATE_INTENT_VERSION &&
    record.teamId === teamId &&
    typeof record.creationIntentId === "string" &&
    record.request !== undefined &&
    typeof record.request.name === "string" &&
    typeof record.request.displayName === "string" &&
    typeof record.request.computerId === "string" &&
    (record.request.runtimeProvider === "codex" || record.request.runtimeProvider === "claude-code")
  );
}

function creationIntentKey(teamId: string): string {
  return `opentag.agent-creation.intent:${teamId}`;
}
