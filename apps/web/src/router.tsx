import type {
  AgentAdminConfig,
  AgentDetail,
  AgentListItem as AgentListApiItem,
  AgentSummary,
  AuthProvidersResponse,
  ImBindingHandoffStatus,
  ImBindingSummary,
  MeResponse,
  MeWorkspace,
  ProviderReadinessStatus,
  WorkspaceComputerSummary,
} from "@opentag/shared/browser";
import { DEFAULT_SIGN_IN_DESTINATION, PASSWORD_MIN_LENGTH, resolveSignInDestination } from "@opentag/shared/browser";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { type AgentCreationFacts, AgentCreationFlow } from "./agent-creation/agent-creation-flow.js";
import { ApiError, browserApi } from "./api.js";
// Google-provided, pre-approved button asset: https://developers.google.com/identity/branding-guidelines
import googleSignInButton from "./assets/google-sign-in-light@2x.png";
import { PageHeader } from "./components/kumo/page-header/page-header.js";
import { ComputerSetup } from "./computer-setup.js";
import { orderAgentIds } from "./features/agent-list-order.js";
import { AgentUsageOverview, AgentUsageTab } from "./features/agent-usage.js";
import { IntegrationsPage } from "./features/integrations-page.js";
import { SkillsPage } from "./features/skills-page.js";
import { AgentTasksSection, TaskDetailPage, TasksPage } from "./features/tasks-page.js";
import { FeishuSetup } from "./im/feishu-setup.js";
import { SlackConfiguration } from "./im/slack-configuration.js";
import { OnboardingLabPage } from "./internal/onboarding-lab-page.js";
import { OnboardingPage } from "./onboarding/page.js";
import { RuntimeConfigurationForm } from "./runtime-configuration.js";
import {
  Banner,
  Button,
  buttonClassName,
  Dialog,
  DropdownMenu,
  Field,
  Icon,
  type IconName,
  Input,
  KumoInputControl,
  Loader,
  SettingsList,
  SettingsRow,
  Sidebar,
  SidebarProvider,
  SidebarTrigger,
  StatusIndicator,
  type StatusTone,
  Text,
  useSidebar,
} from "./ui/design-system.js";
import { ProviderIcon } from "./ui/provider-icon.js";

type LoadState<T> = { kind: "loading" } | { kind: "error"; error: Error } | { kind: "ready"; value: T };
type AuthProvider = AuthProvidersResponse["providers"][number];

type AgentAvailability = {
  state: "ready" | "action_required" | "setting_up" | "not_connected" | "suspended" | "unconfirmed";
  reason:
    | "agent_suspended"
    | "agent_unconfirmed"
    | "computer_offline"
    | "runtime_unavailable"
    | "runtime_unconfirmed"
    | "im_not_connected"
    | "im_provisioning"
    | "im_reauthorization_required"
    | "im_error"
    | "im_disabled"
    | "handoff_unavailable"
    | "computer_unconfirmed"
    | "handoff_unconfirmed"
    | null;
  lastConfirmedAt: string | null;
  dependencies: {
    computer: { state: "ready" | "action_required" | "unconfirmed"; lastConfirmedAt: string | null };
    /** Readiness of the Agent's Provider on its Computer. `runtime_unavailable` is diagnosed from this. */
    runtime: { provider: AgentSummary["runtimeProvider"]; status: ProviderReadinessStatus | null };
    handoff: {
      state: "ready" | "action_required" | "setting_up" | "not_connected" | "unconfirmed";
      lastConfirmedAt: string | null;
    };
    channel: {
      state: "connected" | "not_connected" | "unconfirmed";
      provider: "feishu" | "slack" | null;
      botDisplayName: string | null;
    };
  };
};

type AgentListItem = AgentListApiItem & {
  availability: AgentAvailability;
  evidenceConfirmed: boolean;
};
type DetailEvidence<T> = { kind: "ready"; value: T | undefined } | { kind: "unconfirmed" };
type AgentDetailView = AgentDetail & {
  availability: AgentAvailability;
  messaging: DetailEvidence<ImBindingSummary>;
};

function projectAgentAvailability(
  agent: AgentSummary,
  computer: WorkspaceComputerSummary | undefined,
  binding: ImBindingSummary | undefined,
  handoff: ImBindingHandoffStatus | undefined,
  bindingEvidenceConfirmed: boolean,
  handoffEvidenceConfirmed: boolean,
): AgentAvailability {
  const computerReady = computer?.connectionStatus === "online";
  const providerReadiness = computer?.providerReadiness?.find(
    (observation) => observation.provider === agent.runtimeProvider,
  );
  const handoffState =
    !bindingEvidenceConfirmed || !handoffEvidenceConfirmed
      ? ("unconfirmed" as const)
      : !binding
        ? ("not_connected" as const)
        : binding.bindingState === "provisioning"
          ? ("setting_up" as const)
          : binding.bindingState === "active" && handoff?.handoffReady
            ? ("ready" as const)
            : ("action_required" as const);
  const dependencies: AgentAvailability["dependencies"] = {
    computer: {
      state: computer ? (computerReady ? "ready" : "action_required") : "unconfirmed",
      lastConfirmedAt: computer?.lastSeenAt ?? null,
    },
    runtime: { provider: agent.runtimeProvider, status: providerReadiness?.status ?? null },
    handoff: {
      state: handoffState,
      lastConfirmedAt: binding?.lastRuntimeObservationAt ?? binding?.lastValidatedAt ?? null,
    },
    channel: {
      state: !bindingEvidenceConfirmed ? "unconfirmed" : binding ? "connected" : "not_connected",
      provider: binding?.provider ?? null,
      botDisplayName: binding?.bot.displayName ?? null,
    },
  };
  if (agent.status === "suspended") {
    return { state: "suspended", reason: "agent_suspended", lastConfirmedAt: agent.updatedAt, dependencies };
  }
  if (!computer) {
    return { state: "unconfirmed", reason: "computer_unconfirmed", lastConfirmedAt: null, dependencies };
  }
  if (!computerReady) {
    return {
      state: "action_required",
      reason: "computer_offline",
      lastConfirmedAt: computer?.lastSeenAt ?? null,
      dependencies,
    };
  }
  const runtimeReadiness = providerReadiness;
  if (!runtimeReadiness) {
    return { state: "unconfirmed", reason: "runtime_unconfirmed", lastConfirmedAt: null, dependencies };
  }
  if (runtimeReadiness.status !== "ready") {
    return { state: "action_required", reason: "runtime_unavailable", lastConfirmedAt: null, dependencies };
  }
  if (!bindingEvidenceConfirmed || !handoffEvidenceConfirmed) {
    return { state: "unconfirmed", reason: "handoff_unconfirmed", lastConfirmedAt: null, dependencies };
  }
  if (!binding) return { state: "not_connected", reason: "im_not_connected", lastConfirmedAt: null, dependencies };
  if (binding.bindingState === "provisioning") {
    return {
      state: "setting_up",
      reason: "im_provisioning",
      lastConfirmedAt: binding.lastRuntimeObservationAt ?? binding.lastValidatedAt,
      dependencies,
    };
  }
  if (binding.bindingState === "reauthorization_required") {
    return {
      state: "action_required",
      reason: "im_reauthorization_required",
      lastConfirmedAt: binding.lastRuntimeObservationAt ?? binding.lastValidatedAt,
      dependencies,
    };
  }
  if (binding.bindingState === "error" || binding.bindingState === "disabled") {
    return {
      state: "action_required",
      reason: binding.bindingState === "disabled" ? "im_disabled" : "im_error",
      lastConfirmedAt: binding.lastRuntimeObservationAt ?? binding.lastValidatedAt,
      dependencies,
    };
  }
  if (!handoff?.handoffReady) {
    return {
      state: "action_required",
      reason: "handoff_unavailable",
      lastConfirmedAt: binding.lastRuntimeObservationAt ?? binding.lastValidatedAt,
      dependencies,
    };
  }
  return {
    state: "ready",
    reason: null,
    lastConfirmedAt: binding.lastRuntimeObservationAt ?? binding.lastValidatedAt,
    dependencies,
  };
}

async function loadAgentList(): Promise<{ agents: AgentListItem[] }> {
  const [{ agents }, computersResult] = await Promise.all([
    browserApi.agents(),
    browserApi.computers().then(
      (value) => ({ kind: "ready" as const, value }),
      () => ({ kind: "unconfirmed" as const }),
    ),
  ]);
  const computers = computersResult.kind === "ready" ? computersResult.value.computers : [];
  if (computersResult.kind === "unconfirmed") {
    return {
      agents: agents.map((agent) => ({
        ...agent,
        availability: projectAgentAvailability(agent, undefined, undefined, undefined, false, false),
        evidenceConfirmed: true,
      })),
    };
  }
  const availability = await Promise.all(
    agents.map(async (agent) => {
      const [bindingResult, handoffResult] = await Promise.allSettled([
        browserApi.imBinding(agent.id),
        browserApi.imBindingHandoff(agent.id),
      ]);
      return projectAgentAvailability(
        agent,
        computers.find((computer) => computer.computerId === agent.computer.computerId),
        bindingResult.status === "fulfilled" ? bindingResult.value : undefined,
        handoffResult.status === "fulfilled" ? handoffResult.value : undefined,
        bindingResult.status === "fulfilled",
        handoffResult.status === "fulfilled",
      );
    }),
  );
  return {
    agents: agents.map((agent, index) => ({
      ...agent,
      availability:
        availability[index] ?? projectAgentAvailability(agent, undefined, undefined, undefined, false, false),
      evidenceConfirmed: true,
    })),
  };
}

async function loadAgentDetail(agentId: string): Promise<AgentDetailView> {
  const agent = await browserApi.agent(agentId);
  const [computersResult, bindingResult, handoffResult] = await Promise.allSettled([
    browserApi.computers(),
    browserApi.imBinding(agent.id),
    browserApi.imBindingHandoff(agent.id),
  ]);
  const computers = computersResult.status === "fulfilled" ? computersResult.value.computers : [];
  const binding = bindingResult.status === "fulfilled" ? bindingResult.value : undefined;
  const handoff = handoffResult.status === "fulfilled" ? handoffResult.value : undefined;
  return {
    ...agent,
    messaging:
      bindingResult.status === "fulfilled" ? { kind: "ready", value: bindingResult.value } : { kind: "unconfirmed" },
    availability: projectAgentAvailability(
      agent,
      computers.find((computer) => computer.computerId === agent.computer.computerId),
      binding,
      handoff,
      bindingResult.status === "fulfilled",
      handoffResult.status === "fulfilled",
    ),
  };
}

function markAgentListUnconfirmed(value: { agents: AgentListItem[] }): { agents: AgentListItem[] } {
  return {
    agents: value.agents.map((agent) => ({
      ...agent,
      availability: {
        ...agent.availability,
        state: "unconfirmed",
        reason: "agent_unconfirmed",
        lastConfirmedAt: null,
      },
      evidenceConfirmed: false,
    })),
  };
}

function markAgentDetailUnconfirmed(agent: AgentDetailView): AgentDetailView {
  return {
    ...agent,
    messaging: { kind: "unconfirmed" },
    availability: {
      ...agent.availability,
      state: "unconfirmed",
      reason: "agent_unconfirmed",
      lastConfirmedAt: null,
      dependencies: {
        ...agent.availability.dependencies,
        computer: { state: "unconfirmed", lastConfirmedAt: null },
        handoff: { state: "unconfirmed", lastConfirmedAt: null },
        channel: { ...agent.availability.dependencies.channel, state: "unconfirmed" },
      },
    },
  };
}

function useResource<T>(
  loader: () => Promise<T>,
  key: string,
  options: {
    initialValue?: T;
    keepPreviousData?: boolean;
    onBackgroundError?: (value: T, error: Error) => T;
    revalidateMs?: number;
    refreshOnFocus?: boolean;
  } = {},
): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>(() =>
    options.initialValue === undefined ? { kind: "loading" } : { kind: "ready", value: options.initialValue },
  );
  const loaderRef = useRef(loader);
  const keyRef = useRef(key);
  const optionsRef = useRef(options);
  loaderRef.current = loader;
  keyRef.current = key;
  optionsRef.current = options;
  useEffect(() => {
    let active = true;
    let request = 0;
    let inFlight = false;
    const activeKey = key;
    const load = (showLoading: boolean) => {
      if (inFlight) return;
      inFlight = true;
      const currentRequest = ++request;
      if (showLoading) setState({ kind: "loading" });
      void loaderRef
        .current()
        .then(
          (value) =>
            active && keyRef.current === activeKey && request === currentRequest && setState({ kind: "ready", value }),
          (error: unknown) => {
            if (!active || keyRef.current !== activeKey || request !== currentRequest) return;
            const resolvedError = error instanceof Error ? error : new Error(String(error));
            if (showLoading || isTerminalResourceError(resolvedError)) {
              setState({ kind: "error", error: resolvedError });
              return;
            }
            setState((current) => {
              if (current.kind !== "ready" || !optionsRef.current.onBackgroundError) {
                return { kind: "error", error: resolvedError };
              }
              return {
                kind: "ready",
                value: optionsRef.current.onBackgroundError(current.value, resolvedError),
              };
            });
          },
        )
        .finally(() => {
          if (active && keyRef.current === activeKey && request === currentRequest) inFlight = false;
        });
    };
    const revalidate = () => load(false);
    load(!options.keepPreviousData && options.initialValue === undefined);
    const interval = options.revalidateMs ? window.setInterval(revalidate, options.revalidateMs) : undefined;
    const refreshVisible = () => {
      if (document.visibilityState === "visible") revalidate();
    };
    if (options.refreshOnFocus) {
      window.addEventListener("focus", revalidate);
      document.addEventListener("visibilitychange", refreshVisible);
    }
    return () => {
      active = false;
      if (interval !== undefined) window.clearInterval(interval);
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [key, options.initialValue, options.keepPreviousData, options.refreshOnFocus, options.revalidateMs]);
  return state;
}

function isTerminalResourceError(error: Error): boolean {
  return error instanceof ApiError && [401, 403, 404, 410].includes(error.status);
}

function AsyncState<T>({
  state,
  children,
  loading,
}: {
  state: LoadState<T>;
  children: (value: T) => ReactNode;
  loading?: ReactNode;
}) {
  if (state.kind === "loading")
    return (
      loading ?? (
        <div
          aria-label="Loading current server state"
          className="flex items-center gap-2 text-sm text-kumo-subtle"
          role="status"
        >
          <span aria-hidden="true">
            <Loader size="sm" />
          </span>
          <span>Loading current Server state…</span>
        </div>
      )
    );
  if (state.kind === "error")
    return (
      <div className="rounded-md bg-kumo-danger-tint p-3 text-sm text-kumo-danger" role="alert">
        {state.error.message}
      </div>
    );
  return children(state.value);
}

/**
 * Authentication proves the Account identity and nothing more. The Server says the same: an Account
 * may hold no active resource grant and still be signed in, so a page that needs only the Account
 * reads this rather than the Workspace session below.
 */
interface AccountSession {
  me: MeResponse;
  /** Re-reads `/me` from scratch, showing the loading state again; a failure surfaces as the load error. */
  reloadMe: () => void;
  /** Resolves only once the authoritative `/me` response has been installed as current state. */
  refreshMe: () => Promise<MeResponse>;
}

interface WorkspaceSession extends AccountSession {
  membership: MeWorkspace;
}

const accountContext = createContext<AccountSession | undefined>(undefined);
const AccountContext = accountContext.Provider;
const workspaceContext = createContext<WorkspaceSession | undefined>(undefined);
const WorkspaceContext = workspaceContext.Provider;

function useAccount(): AccountSession {
  const value = useContext(accountContext);
  if (!value) throw new Error("Account context is missing");
  return value;
}

function useWorkspace(): WorkspaceSession {
  const value = useContext(workspaceContext);
  if (!value) throw new Error("Workspace context is missing");
  return value;
}

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AuthenticatedAccountGate />}>
        {/*
          Outside AppShell because the Lab renders the onboarding surface verbatim, and onboarding
          has no primary navigation. Outside the setup-completion gate so a stuck run can always
          reopen the Lab, and outside the Workspace-authority gate because Scenario Preview needs
          the Account and nothing else.
        */}
        <Route path="/internal/onboarding-lab" element={<OnboardingLabRoute />} />
        <Route element={<WorkspaceAuthorityGate />}>
          {/*
            Onboarding runs before the Account has entered the application, so it carries no
            AppShell: the primary navigation would offer destinations this gate sends straight
            back here, and a second brand mark beside the one onboarding renders itself.
          */}
          <Route element={<WorkspaceSetupGate />}>
            <Route path="/onboarding" element={<OnboardingRoute />} />
          </Route>
          <Route element={<AppShell />}>
            <Route element={<WorkspaceSetupGate />}>
              <Route index element={<Navigate replace to="/agents" />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/agents/new" element={<NewAgentPage />} />
              <Route path="/agents/:agentId" element={<AgentDetailPage />} />
              <Route path="/agents/:agentId/usage" element={<AgentUsagePage />} />
              <Route path="/agents/:agentId/settings" element={<AgentSettingsPage />} />
              <Route path="/agents/:agentId/settings/:section" element={<AgentSettingsPage />} />
              <Route path="/agents/:agentId/:legacySection" element={<LegacyAgentSectionRedirect />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
              <Route path="/skills" element={<SkillsPage />} />
              <Route path="/integrations" element={<IntegrationsPage />} />
              <Route path="/agents/computers" element={<Navigate replace to="/agents" />} />
              <Route path="/resources" element={<Navigate replace to="/skills" />} />
              <Route path="/usage" element={<Navigate replace to="/agents" />} />
              <Route path="/account" element={<AccountPage />} />
            </Route>
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<StandaloneNotFoundPage />} />
    </Routes>
  );
}

function LoginPage() {
  const providers = useResource(() => browserApi.authProviders(), "auth-providers");
  const next = new URLSearchParams(useLocation().search).get("next") ?? DEFAULT_SIGN_IN_DESTINATION;
  return (
    <main className="grid min-h-screen place-items-center bg-kumo-canvas p-6" data-ui="login-page">
      <section
        aria-labelledby="login-title"
        className="grid w-full max-w-md gap-6 rounded-lg bg-kumo-base p-6 ring ring-kumo-line"
        data-ui="login-card"
      >
        <OpenTagBrandLockup />
        <header className="grid gap-1" data-ui="login-copy">
          <Text as="h1" id="login-title" size="lg" variant="heading">
            Welcome back
          </Text>
          <Text as="p" variant="secondary">
            Sign in to continue to OpenTag.
          </Text>
        </header>
        <AsyncState state={providers}>
          {(value) => {
            /*
             * `password` is deliberately excluded here rather than filtered out by the missing `startUrl`: it is a
             * form, so it renders as one instead of as a link to somewhere.
             */
            const linkProviders = value.providers.filter(
              (provider: AuthProvider) => provider.id !== "password" && provider.enabled && provider.startUrl,
            );
            const password = value.providers.some(
              (provider: AuthProvider) => provider.id === "password" && provider.enabled,
            );
            if (linkProviders.length === 0 && !password) {
              return (
                <p className="text-sm text-kumo-subtle" data-ui="login-unavailable" role="status">
                  No sign-in methods are currently available.
                </p>
              );
            }
            return (
              <>
                {password ? <PasswordSignInForm next={next} /> : null}
                {password && linkProviders.length > 0 ? (
                  <p
                    className="flex items-center justify-center gap-2 text-sm text-kumo-subtle"
                    data-ui="login-divider"
                  >
                    <span>or</span>
                  </p>
                ) : null}
                {linkProviders.length > 0 ? (
                  <div className="grid gap-3" data-ui="login-actions">
                    {linkProviders.map((provider: AuthProvider) => (
                      <LoginProviderLink key={provider.id} next={next} provider={provider} />
                    ))}
                  </div>
                ) : null}
              </>
            );
          }}
        </AsyncState>
        <p className="text-sm text-kumo-subtle" data-ui="login-access-note">
          Sign in to manage your Agents.
        </p>
      </section>
    </main>
  );
}

function OpenTagBrandLockup() {
  return (
    <div className="flex items-center gap-2 text-lg font-semibold text-kumo-strong" data-ui="login-brand-lockup">
      <span
        className="grid size-8 place-items-center rounded-md bg-kumo-brand text-kumo-inverse"
        data-ui="login-brand-mark"
      >
        <Icon name="shield" />
      </span>
      <span>OpenTag</span>
    </div>
  );
}

/**
 * The email and password form, which both registers and signs in.
 *
 * One form with a mode rather than two routes: the two differ by a single field and a single endpoint, and a separate
 * page would have to re-resolve which providers are available in order to render at all.
 *
 * On success it navigates with a full load rather than a client-side route change. The session and double-submit
 * cookies arrive on that response, and every later request reads the token out of `document.cookie`; re-entering the
 * app through a fresh load is what guarantees it is there before anything tries to use it.
 */
export function PasswordSignInForm({
  navigate = (to: string) => window.location.assign(to),
  next,
}: {
  /** The navigation itself, so a test can observe where a sign-in decided to land rather than following it. */
  navigate?: (to: string) => void;
  next: string;
}) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const registering = mode === "sign-up";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      if (registering) {
        await browserApi.signUpWithPassword({ email, password, displayName });
      } else {
        await browserApi.signInWithPassword({ email, password });
      }
      /*
       * Re-checked here rather than trusted from the query string. This is the one sign-in method that navigates the
       * browser itself instead of handing its destination to a server route, so without this the same `next` the
       * redirect providers have validated since they existed would be an open redirect on this path alone.
       */
      navigate(resolveSignInDestination(next) ?? DEFAULT_SIGN_IN_DESTINATION);
    } catch (cause) {
      /*
       * The server's message is shown as it is. It is written to be shown — a rejected sign-in says only that the
       * address or password was wrong, so restating it here could only make it less accurate.
       */
      setError(cause instanceof ApiError ? cause.message : "Sign-in failed. Try again.");
      setSubmitting(false);
    }
  };

  return (
    <form className="grid gap-4" data-ui="login-password-form" onSubmit={submit}>
      <Input
        label="Email"
        autoComplete="email"
        id="login-email"
        name="email"
        onChange={(event) => setEmail(event.target.value)}
        required
        type="email"
        value={email}
      />
      {registering ? (
        <Input
          label="Name"
          autoComplete="name"
          id="login-display-name"
          name="displayName"
          onChange={(event) => setDisplayName(event.target.value)}
          required
          type="text"
          value={displayName}
        />
      ) : null}
      <Input
        label="Password"
        // Tells a password manager to offer a new secret rather than an existing one, and the reverse on sign-in.
        autoComplete={registering ? "new-password" : "current-password"}
        id="login-password"
        minLength={registering ? PASSWORD_MIN_LENGTH : undefined}
        name="password"
        onChange={(event) => setPassword(event.target.value)}
        required
        type="password"
        value={password}
      />
      {registering ? (
        <p className="text-sm text-kumo-subtle" data-ui="login-password-hint">
          At least {PASSWORD_MIN_LENGTH} characters.
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-kumo-danger" data-ui="login-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button disabled={submitting} type="submit">
        {registering ? "Create account" : "Sign in"}
      </Button>
      <p className="text-sm text-kumo-subtle" data-ui="login-mode-switch">
        {registering ? "Already have an account?" : "No account yet?"}{" "}
        <Button
          variant="inline"
          onClick={() => {
            setMode(registering ? "sign-in" : "sign-up");
            setError(undefined);
          }}
          type="button"
        >
          {registering ? "Sign in" : "Create one"}
        </Button>
      </p>
    </form>
  );
}

function LoginProviderLink({ next, provider }: { next: string; provider: AuthProvider }) {
  if (!provider.startUrl) return null;
  const google = provider.id === "google";
  const href = `${provider.startUrl}?next=${encodeURIComponent(next)}`;
  if (google) {
    return (
      <a className="block overflow-hidden rounded-md ring ring-kumo-line" data-ui="login-provider-google" href={href}>
        <img alt="Sign in with Google" className="block w-full" src={googleSignInButton} />
      </a>
    );
  }

  return (
    <a
      className="flex min-h-10 items-center justify-center rounded-md bg-kumo-base px-4 py-2 text-sm font-medium text-kumo-default ring ring-kumo-line"
      data-ui="login-provider"
      href={href}
    >
      <span>Continue with {provider.id}</span>
    </a>
  );
}

/**
 * Resolves the authenticated Account and publishes it. Workspace authority is a separate question,
 * asked below only by the routes that act on stored resources.
 */
function AuthenticatedAccountGate() {
  const location = useLocation();
  const [meRevision, setMeRevision] = useState(0);
  const [refreshed, setRefreshed] = useState<{ revision: number; me: MeResponse }>();
  const state = useResource(() => browserApi.me(), `me:${meRevision}`);
  /**
   * Installs the authoritative response before resolving, so a caller that navigates on the result
   * cannot have a gate re-evaluate the state this refresh was meant to replace.
   */
  const refreshMe = useCallback(async () => {
    const next = await browserApi.me();
    setRefreshed({ revision: meRevision, me: next });
    return next;
  }, [meRevision]);
  if (state.kind === "error" && state.error instanceof ApiError && state.error.status === 401) {
    const requested = location.pathname === "/" ? "/agents" : `${location.pathname}${location.search}`;
    return <Navigate replace to={`/login?next=${encodeURIComponent(requested)}`} />;
  }
  return (
    <AsyncState state={state}>
      {(loaded) => (
        <AccountContext
          value={{
            me: refreshed?.revision === meRevision ? refreshed.me : loaded,
            refreshMe,
            reloadMe: () => setMeRevision((value) => value + 1),
          }}
        >
          <Outlet />
        </AccountContext>
      )}
    </AsyncState>
  );
}

/** Refuses the Account-shaped dead end to the routes that act on stored resources. */
function WorkspaceAuthorityGate() {
  const { me, refreshMe, reloadMe } = useAccount();
  const membership = me.workspaces[0];
  if (!membership) return <NoWorkspaceAccess onRetry={reloadMe} />;
  return (
    <WorkspaceContext value={{ me, membership, refreshMe, reloadMe }}>
      <Outlet />
    </WorkspaceContext>
  );
}

function NoWorkspaceAccess({ onRetry }: { onRetry: () => void }) {
  return (
    <main
      className="mx-auto grid max-w-xl gap-4 rounded-lg bg-kumo-base p-6 ring ring-kumo-line"
      data-ui="account-access"
    >
      <span className="text-xs font-medium uppercase text-kumo-subtle">Account access</span>
      <Text as="h1" size="lg" variant="heading">
        OpenTag is not ready for this account
      </Text>
      <Text as="p" variant="secondary">
        The server has not assigned the internal access needed to use OpenTag.
      </Text>
      <div className="rounded-md bg-kumo-info-tint p-3 text-sm" role="status">
        Retry after provisioning finishes, or contact an operator if this continues.
      </div>
      <Button onClick={onRetry}>Check again</Button>
    </main>
  );
}

function OnboardingRoute() {
  const { me, refreshMe } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const targetAgentId = searchParams.get("agentId") ?? undefined;
  return (
    <OnboardingPage
      targetAgentId={targetAgentId}
      user={me.user}
      onSetupReady={async (agentId) => {
        await browserApi.completeSetup(agentId);
        await refreshMe();
      }}
      onTargetAgentChange={(agentId) => {
        const next = new URLSearchParams(searchParams);
        next.set("agentId", agentId);
        setSearchParams(next, { replace: true });
      }}
    />
  );
}

/**
 * The staging-only Onboarding Lab. A deployment outside staging is answered exactly like a page that
 * does not exist; on staging every signed-in Account may read the Scenario Preview and reset its own
 * onboarding, so reachability is the only question the Server answers here.
 */
function OnboardingLabRoute() {
  const { me, refreshMe } = useAccount();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const offered = useResource(() => browserApi.onboardingLabOffered(), "onboarding-lab");
  return (
    <AsyncState state={offered}>
      {(value) =>
        value ? (
          <OnboardingLabPage
            scenarioId={searchParams.get("scenario")}
            user={me.user}
            onScenarioChange={(scenarioId) => {
              const next = new URLSearchParams(searchParams);
              next.set("scenario", scenarioId);
              setSearchParams(next, { replace: true });
            }}
            onResetSucceeded={async () => {
              // The Lab never infers success from client state: it enters onboarding only once the
              // refreshed Account actually reports incomplete setup.
              const account = await refreshMe();
              if (account.workspaces[0]?.setupCompletedAt) {
                throw new Error("The Account still reports completed setup; retry the reset.");
              }
              navigate("/onboarding", { replace: true });
            }}
          />
        ) : (
          // The Lab renders outside AppShell, so its not-found answer must carry its own page frame.
          <StandaloneNotFoundPage />
        )
      }
    </AsyncState>
  );
}

function WorkspaceSetupGate() {
  const { membership } = useWorkspace();
  const location = useLocation();
  const onboarding = location.pathname === "/onboarding";
  if (membership.setupCompletedAt) return onboarding ? <Navigate replace to="/agents" /> : <Outlet />;
  return onboarding ? <Outlet /> : <Navigate replace to="/onboarding" />;
}

function AppShell() {
  return (
    <SidebarProvider className="h-full min-h-0 overflow-hidden" collapsible="icon" defaultOpen>
      <AppShellContent />
    </SidebarProvider>
  );
}

function AppShellContent() {
  const { me } = useAccount();
  const location = useLocation();
  const navigate = useNavigate();
  const { setOpenMobile } = useSidebar();
  const [openMenu, setOpenMenu] = useState<"account">();
  const [loggingOut, setLoggingOut] = useState(false);
  const [accountError, setAccountError] = useState<string>();
  const accountMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (openMenu !== "account") return;
    accountMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')?.focus();
  }, [openMenu]);
  async function logout() {
    setLoggingOut(true);
    setAccountError(undefined);
    try {
      await browserApi.logout();
      navigate("/login", { replace: true });
    } catch (cause) {
      setAccountError(cause instanceof Error ? cause.message : "Unable to sign out");
      setLoggingOut(false);
    }
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 bg-kumo-canvas" data-ui="shell">
      <Sidebar aria-label="Primary navigation" fullScreenOnMobile>
        <Sidebar.Header>
          <Link className="text-lg font-semibold text-kumo-strong" to="/agents" onClick={() => setOpenMobile(false)}>
            OpenTag
          </Link>
        </Sidebar.Header>
        <Sidebar.Content>
          <nav aria-label="Product">
            <Sidebar.Group>
              <Sidebar.Menu>
                <Sidebar.MenuButton
                  active={isSidebarNavActive(location.pathname, "/agents")}
                  aria-current={isSidebarNavActive(location.pathname, "/agents") ? "page" : undefined}
                  href="/agents"
                  icon={<WorkspaceNavIcon name="agents" />}
                  onClick={() => setOpenMobile(false)}
                >
                  Agents
                </Sidebar.MenuButton>
                <Sidebar.MenuButton
                  active={isSidebarNavActive(location.pathname, "/tasks")}
                  aria-current={isSidebarNavActive(location.pathname, "/tasks") ? "page" : undefined}
                  href="/tasks"
                  icon={<WorkspaceNavIcon name="tasks" />}
                  onClick={() => setOpenMobile(false)}
                >
                  Tasks
                </Sidebar.MenuButton>
                <Sidebar.MenuButton
                  active={isSidebarNavActive(location.pathname, "/skills")}
                  aria-current={isSidebarNavActive(location.pathname, "/skills") ? "page" : undefined}
                  href="/skills"
                  icon={<WorkspaceNavIcon name="skills" />}
                  onClick={() => setOpenMobile(false)}
                >
                  Skills
                </Sidebar.MenuButton>
                <Sidebar.MenuButton
                  active={isSidebarNavActive(location.pathname, "/integrations")}
                  aria-current={isSidebarNavActive(location.pathname, "/integrations") ? "page" : undefined}
                  href="/integrations"
                  icon={<WorkspaceNavIcon name="integrations" />}
                  onClick={() => setOpenMobile(false)}
                >
                  Integrations
                </Sidebar.MenuButton>
              </Sidebar.Menu>
            </Sidebar.Group>
          </nav>
        </Sidebar.Content>
        <Sidebar.Footer>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Sidebar.Menu className="min-w-0 flex-1 group-data-[state=collapsed]/sidebar:hidden">
              <Sidebar.MenuItem>
                <DropdownMenu
                  open={openMenu === "account"}
                  onOpenChange={(open) => setOpenMenu(open ? "account" : undefined)}
                >
                  <DropdownMenu.Trigger
                    render={
                      <Sidebar.MenuButton
                        aria-label="Account menu"
                        className="justify-start"
                        icon={
                          <span
                            className="grid size-8 place-items-center rounded-full bg-kumo-tint text-sm font-semibold"
                            aria-hidden="true"
                          >
                            {initials(me.user.displayName)}
                          </span>
                        }
                      >
                        <span className="min-w-0 flex-1 truncate text-left">
                          <strong>{me.user.displayName}</strong>
                        </span>
                        <span aria-hidden="true">
                          <Icon name="more-vertical" />
                        </span>
                      </Sidebar.MenuButton>
                    }
                  />
                  <DropdownMenu.Content aria-label="Account" ref={accountMenuRef}>
                    <DropdownMenu.Item
                      onClick={() => {
                        setOpenMobile(false);
                        navigate("/account");
                      }}
                    >
                      Account
                    </DropdownMenu.Item>
                    <DropdownMenu.Item disabled={loggingOut} onClick={() => void logout()}>
                      {loggingOut ? (
                        <span className="flex items-center gap-2">
                          <span aria-hidden="true">
                            <Loader aria-label="Signing out" size="sm" />
                          </span>
                          Signing out…
                        </span>
                      ) : (
                        "Sign out"
                      )}
                    </DropdownMenu.Item>
                    {accountError ? (
                      <span className="text-sm text-kumo-danger" role="alert">
                        {accountError}
                      </span>
                    ) : null}
                  </DropdownMenu.Content>
                </DropdownMenu>
              </Sidebar.MenuItem>
            </Sidebar.Menu>
            <Sidebar.Trigger title="Toggle sidebar" />
          </div>
        </Sidebar.Footer>
      </Sidebar>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-ui="app-main">
        <header className="app-mobile-header shrink-0 items-center justify-between border-b border-kumo-line bg-kumo-base px-4 py-3">
          <Link className="font-semibold text-kumo-strong" to="/agents" onClick={() => setOpenMobile(false)}>
            OpenTag
          </Link>
          <SidebarTrigger aria-label="Open navigation" title="Open navigation" />
        </header>
        <main
          className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto px-4 py-5 md:px-8 md:py-8"
          data-ui="content"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function WorkspaceNavIcon({ name }: { name: "agents" | "integrations" | "skills" | "tasks" }) {
  const icon: IconName =
    name === "agents" ? "user" : name === "tasks" ? "instructions" : name === "skills" ? "shield" : "settings";
  return <Icon name={icon} />;
}

function isSidebarNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function AgentsPage() {
  const { me } = useWorkspace();
  const [createOpen, setCreateOpen] = useState(false);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const state = useResource(() => loadAgentList(), me.user.id, {
    onBackgroundError: markAgentListUnconfirmed,
    revalidateMs: 30_000,
    refreshOnFocus: true,
  });
  return (
    <>
      <Page
        title="Agents"
        action={
          <Button ref={createTriggerRef} size="compact" variant="outline" onClick={() => setCreateOpen(true)}>
            New Agent <Icon name="plus" />
          </Button>
        }
      >
        <AsyncState state={state}>{(value) => <AgentsContent agents={value.agents} />}</AsyncState>
      </Page>
      <NewAgentDialog open={createOpen} returnFocusRef={createTriggerRef} onClose={() => setCreateOpen(false)} />
    </>
  );
}

function AgentsContent({ agents }: { agents: AgentListItem[] }) {
  if (agents.length > 0) return <AgentList agents={agents} />;
  return <EmptyState title="No Agents yet">Create your first shared AI teammate with New Agent.</EmptyState>;
}

function AgentList({ agents }: { agents: AgentListItem[] }) {
  const shownOrder = useRef<readonly string[]>([]);
  const byPriority = [...agents].sort(
    (left, right) => agentCardStatus(left).priority - agentCardStatus(right).priority,
  );
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  /*
   * Written during render on purpose. `orderAgentIds` is stable under reapplication, so a
   * repeated render of the same list produces the same order; deferring it to an effect would
   * show one frame of the resorted list before restoring the order the viewer is pointing at.
   */
  const order = orderAgentIds(
    byPriority.map((agent) => agent.id),
    shownOrder.current,
  );
  shownOrder.current = order;
  return (
    <section className="grid gap-4" aria-label="Agents" data-ui="agent-list">
      <p className="justify-self-end text-sm text-kumo-subtle">Usage · last 30 days</p>
      <div className="grid gap-4 sm:grid-cols-2" data-ui="agent-card-grid">
        {order.map((id) => {
          const agent = byId.get(id);
          return agent ? <AgentCard agent={agent} key={agent.id} /> : null;
        })}
      </div>
    </section>
  );
}

function AgentCard({ agent }: { agent: AgentListItem }) {
  const status = agentCardStatus(agent);
  const action = status.action;
  const channel = agent.availability.dependencies.channel.provider;
  const statusDetail: ReactNode =
    agent.activity.state === "working" && status.label === "Working" ? (
      <>Started {formatElapsedCompact(agent.activity.startedAt)} ago</>
    ) : status.detail ? (
      action ? (
        <>
          <span className="text-kumo-subtle">{status.detail}</span>
          <span className="text-kumo-subtle" aria-hidden="true">
            {" · "}
          </span>
          <Link
            className={buttonClassName({ variant: "inline" })}
            to={`/agents/${agent.id}/settings/${action.section}`}
          >
            {action.label}
          </Link>
        </>
      ) : (
        status.detail
      )
    ) : undefined;
  return (
    <article
      className="relative grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      data-avatar-tone={agentAvatarTone(agent.id)}
      data-tone={status.tone}
      data-ui="agent-card"
    >
      <div className="flex items-center gap-3" data-ui="agent-card-identity">
        <span
          className="grid size-10 shrink-0 place-items-center rounded-full bg-kumo-tint text-sm font-semibold text-kumo-strong"
          aria-hidden="true"
        >
          {initials(agent.displayName)}
        </span>
        <div className="grid min-w-0 gap-1" data-ui="agent-card-identity-copy">
          <strong className="flex min-w-0 items-center gap-2">
            <Link aria-label={`Open ${agent.displayName}`} to={`/agents/${agent.id}`}>
              {agent.displayName}
            </Link>
            {channel ? (
              <span className="inline-flex shrink-0 items-center" data-ui="agent-card-channel">
                <ProviderIcon className="size-4" provider={channel} />
                <span className="sr-only">{titleCase(channel)}</span>
              </span>
            ) : null}
          </strong>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-4 border-t border-kumo-line pt-3" data-ui="agent-card-usage">
        <div>
          <dt>Tasks</dt>
          <dd>{formatUsageNumber(agent.usage.tasks)}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{formatUsageNumber(agent.usage.tokens)}</dd>
        </div>
      </dl>
      <div data-ui="agent-card-state">
        <StatusIndicator detail={statusDetail} label={status.label} tone={status.tone} />
      </div>
    </article>
  );
}

const agentAvatarTones = ["brand", "amber", "blue", "neutral"] as const;

function agentAvatarTone(agentId: string): (typeof agentAvatarTones)[number] {
  let hash = 0;
  for (let index = 0; index < agentId.length; index += 1) {
    hash = (hash * 31 + agentId.charCodeAt(index)) >>> 0;
  }
  return agentAvatarTones[hash % agentAvatarTones.length] ?? "brand";
}

/**
 * Every state a viewer can act on carries the Settings section that explains it. A state without an
 * exit reads as a dead end: the card reports a failure the viewer cannot follow anywhere.
 */
function agentCardStatus(agent: AgentListItem): {
  action?: { label: string; section: AgentSettingsSection };
  detail?: string;
  label: string;
  priority: number;
  tone: StatusTone;
} {
  const status = agentStatusPresentation(agent);
  if (agent.status === "suspended") return { label: status.label, priority: 4, tone: status.tone };
  if (!agent.evidenceConfirmed) {
    return { detail: "Unable to refresh", label: "Unconfirmed", priority: 1, tone: "neutral" };
  }
  if (agent.availability.state === "unconfirmed") {
    return { detail: "Unable to confirm readiness", label: status.label, priority: 1, tone: status.tone };
  }
  if (agent.availability.state === "action_required") {
    const action =
      agent.availability.reason === "computer_offline"
        ? { label: "View Computer", section: "computer" as const }
        : agent.availability.reason === "runtime_unavailable"
          ? // Provider readiness is observed per Computer, so the Computer page is where it is explained.
            { label: "View Computer", section: "computer" as const }
          : { label: "View messaging", section: "messaging" as const };
    return {
      action,
      detail: "Cannot receive new work",
      label: status.label,
      priority: 0,
      tone: status.tone,
    };
  }
  if (agent.availability.state === "setting_up") {
    return { detail: "Messaging setup in progress", label: status.label, priority: 2, tone: status.tone };
  }
  if (agent.availability.state === "not_connected") {
    return {
      action: { label: "Connect messaging", section: "messaging" },
      detail: "Cannot receive new work",
      label: status.label,
      priority: 2,
      tone: status.tone,
    };
  }
  if (agent.activity.state === "working") {
    return {
      label: status.label,
      priority: 2,
      tone: status.tone,
    };
  }
  return { label: status.label, priority: 3, tone: status.tone };
}

function formatElapsedCompact(value: string): string {
  const elapsedMinutes = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  return `${Math.floor(elapsedHours / 24)}d`;
}

function formatUsageNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 1_000 ? 1 : 0,
    notation: value >= 1_000 ? "compact" : "standard",
  }).format(value);
}

function useOwnComputersResource(accountId: string, refreshVersion = 0) {
  return useResource(() => browserApi.computers(), `${accountId}:${refreshVersion}`, {
    onBackgroundError: markOwnComputersUnconfirmed,
    revalidateMs: 30_000,
    refreshOnFocus: true,
  });
}

function NewAgentPage() {
  const { me } = useWorkspace();
  const navigate = useNavigate();
  const [computerRefreshVersion, setComputerRefreshVersion] = useState(0);
  const [created, setCreated] = useState<AgentAdminConfig>();
  const computers = useOwnComputersResource(me.user.id, computerRefreshVersion);
  return (
    <Page
      title={created ? "Agent created" : "Create Agent"}
      description={
        created
          ? "Connect messaging now or continue from the Agent overview."
          : "Name the Agent and prepare where it runs."
      }
    >
      {created ? (
        <NewAgentMessagingStep agent={created} onFinish={() => navigate(`/agents/${created.id}`)} />
      ) : (
        <AgentCreationContent
          computers={computers}
          accountId={me.user.id}
          onCreated={setCreated}
          onRefresh={() => setComputerRefreshVersion((current) => current + 1)}
        />
      )}
    </Page>
  );
}

function NewAgentDialog({
  open,
  onClose,
  returnFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  returnFocusRef: { current: HTMLButtonElement | null };
}) {
  const { me } = useWorkspace();
  const navigate = useNavigate();
  const [computerRefreshVersion, setComputerRefreshVersion] = useState(0);
  const computers = useOwnComputersResource(me.user.id, computerRefreshVersion);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<AgentAdminConfig>();
  const finish = () => {
    if (created) navigate(`/agents/${created.id}`);
  };
  const close = () => {
    if (created) finish();
    else onClose();
  };

  return (
    <Dialog
      busy={submitting}
      className="w-[min(42rem,calc(100vw-2rem))]"
      closeLabel="Close new Agent dialog"
      returnFocusRef={returnFocusRef}
      open={open}
      title="New Agent"
      onClose={close}
    >
      {created ? (
        <NewAgentMessagingStep agent={created} onFinish={finish} />
      ) : (
        <AgentCreationContent
          computers={computers}
          accountId={me.user.id}
          onCancel={onClose}
          onCreated={setCreated}
          onRefresh={() => setComputerRefreshVersion((current) => current + 1)}
          onSubmittingChange={setSubmitting}
        />
      )}
    </Dialog>
  );
}

function AgentCreationContent({
  computers,
  onCancel,
  onCreated,
  onRefresh,
  onSubmittingChange,
  accountId,
}: {
  computers: LoadState<{ computers: WorkspaceComputerSummary[] }>;
  onCancel?: () => void;
  onCreated: (agent: AgentAdminConfig) => void;
  onRefresh: () => void;
  onSubmittingChange?: (submitting: boolean) => void;
  accountId: string;
}) {
  const current = computers.kind === "ready" ? computers.value : undefined;
  const [retained, setRetained] = useState(current);
  const [computerRefreshFocusActive, setComputerRefreshFocusActive] = useState(false);
  const computerRefreshFocusRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (computers.kind === "ready") setRetained(computers.value);
  }, [computers]);

  const refreshFocusTarget = onCancel ? (
    <span
      className="sr-only"
      ref={computerRefreshFocusRef}
      role={computerRefreshFocusActive ? "status" : undefined}
      tabIndex={-1}
    >
      {computerRefreshFocusActive
        ? computers.kind === "loading"
          ? "Refreshing Computers"
          : computers.kind === "error"
            ? "Computer refresh failed"
            : "Computer connection updated"
        : null}
    </span>
  ) : null;

  if (computers.kind === "error") {
    return (
      <>
        {refreshFocusTarget}
        <AsyncState state={computers}>{() => null}</AsyncState>
      </>
    );
  }
  const value = current ?? retained;
  if (!value) {
    return (
      <>
        {refreshFocusTarget}
        <AsyncState state={computers}>{() => null}</AsyncState>
      </>
    );
  }
  return (
    <>
      {refreshFocusTarget}
      <AgentCreationFlow
        facts={agentCreationFactsFromOwnComputers(value.computers)}
        refreshing={computers.kind === "loading"}
        accountId={accountId}
        onCancel={onCancel}
        onComputerRefreshFocus={() => {
          setComputerRefreshFocusActive(true);
          computerRefreshFocusRef.current?.focus();
        }}
        onCreated={onCreated}
        onRefresh={onRefresh}
        onSubmittingChange={onSubmittingChange}
      />
    </>
  );
}

function NewAgentMessagingStep({ agent, onFinish }: { agent: AgentAdminConfig; onFinish: () => void }) {
  return (
    <FeishuSetup agentId={agent.id} onSuccess={onFinish}>
      {(setup) => (
        <section className="grid gap-4" aria-labelledby="agent-created-heading" data-ui="agent-create-complete">
          <div>
            <span className="text-xs font-medium uppercase text-kumo-subtle">Agent created</span>
            <Text as="h2" id="agent-created-heading" variant="heading">
              Connect messaging
            </Text>
            <Text as="p" variant="secondary">
              Connect a Feishu Bot so teammates can mention {agent.displayName}.
            </Text>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void setup.start()}>Connect Feishu</Button>
            <Button variant="secondary" onClick={onFinish}>
              Set up later
            </Button>
          </div>
          {setup.feedback}
        </section>
      )}
    </FeishuSetup>
  );
}

function agentCreationFactsFromOwnComputers(computers: readonly WorkspaceComputerSummary[]): AgentCreationFacts {
  return {
    computers: computers.map((computer) => ({
      id: computer.computerId,
      displayName: computer.displayName,
      connectionStatus: computer.connectionStatus,
    })),
    providers: computers.flatMap((computer) =>
      (computer.providerReadiness ?? []).map((readiness) => ({
        computerId: computer.computerId,
        provider: readiness.provider,
        runtimeReady: readiness.status === "ready",
        status: readiness.status,
      })),
    ),
    runtimeEvidenceAvailable:
      computers.length === 0 || computers.some((computer) => computer.providerReadiness !== undefined),
  };
}

function markOwnComputersUnconfirmed(value: { computers: WorkspaceComputerSummary[] }): {
  computers: WorkspaceComputerSummary[];
} {
  return {
    computers: value.computers.map(({ providerReadiness: _providerReadiness, ...computer }) => computer),
  };
}

type AgentSettingsSection = "instructions" | "execution" | "messaging" | "identity" | "computer" | "manage";
type AgentSettingsGroup = "setup" | "danger";

const agentSettingsSections: ReadonlyArray<{
  key: AgentSettingsSection;
  label: string;
  group: AgentSettingsGroup;
  icon: IconName;
}> = [
  {
    key: "identity",
    label: "Name",
    group: "setup",
    icon: "user",
  },
  {
    key: "messaging",
    label: "Messaging",
    group: "setup",
    icon: "message",
  },
  {
    key: "computer",
    label: "Computer",
    group: "setup",
    icon: "laptop",
  },
  {
    key: "instructions",
    label: "Instructions",
    group: "setup",
    icon: "instructions",
  },
  {
    key: "execution",
    label: "Model & reasoning",
    group: "setup",
    icon: "model",
  },
  {
    key: "manage",
    label: "Pause or delete",
    group: "danger",
    icon: "shield",
  },
];
/*
 * One list in the order a viewer thinks about an Agent -- who it is, how it is reached, where it
 * runs, how it works -- with the irreversible actions held apart rather than sorted among them.
 */
const agentSettingsGroups = [
  { key: "setup", label: null },
  { key: "danger", label: "Danger zone" },
] as const;

function LegacyAgentSectionRedirect() {
  const { agentId = "", legacySection = "" } = useParams();
  const destinations: Record<string, string> = {
    general: `/agents/${agentId}`,
    runtime: `/agents/${agentId}/settings/execution`,
    im: `/agents/${agentId}/settings/messaging`,
  };
  const destination = destinations[legacySection];
  if (destination) return <Navigate replace to={destination} />;
  if (legacySection === "integrations" || legacySection === "skills") {
    return <LegacyAgentCapabilityPage capability={legacySection} />;
  }
  return <NotFoundPage />;
}

function LegacyAgentCapabilityPage({ capability }: { capability: "integrations" | "skills" }) {
  const { agentId = "" } = useParams();
  const state = useResource(() => loadAgentDetail(agentId), agentId, {
    onBackgroundError: markAgentDetailUnconfirmed,
  });
  const label = capability === "integrations" ? "integrations" : "skills";
  return (
    <AsyncState state={state}>
      {(agent) => (
        <section className="grid gap-6">
          <AgentObjectHeader agent={agent} />
          <div className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line">
            <header className="grid gap-2">
              <Text as="h2" variant="heading">
                Agent {label} are not available here
              </Text>
              <Text as="p" variant="secondary">
                OpenTag does not currently show {label} assigned to {agent.displayName}. The shared catalog is separate
                from this Agent.
              </Text>
            </header>
            <div className="flex flex-wrap gap-3">
              <Link className={buttonClassName()} to={`/agents/${agent.id}`}>
                Back to {agent.displayName}
              </Link>
              <Link className={buttonClassName({ variant: "secondary" })} to={`/${capability}`}>
                Browse {label}
              </Link>
            </div>
          </div>
        </section>
      )}
    </AsyncState>
  );
}

function AgentDetailPage() {
  const { agentId = "" } = useParams();
  const state = useResource(() => loadAgentDetail(agentId), agentId, {
    onBackgroundError: markAgentDetailUnconfirmed,
    revalidateMs: 30_000,
    refreshOnFocus: true,
  });
  return (
    <AsyncState state={state}>
      {(agent) => (
        <section className="grid gap-6">
          <AgentObjectHeader agent={agent} />
          <div className="grid gap-6">
            {agent.availability.state !== "ready" ? <AgentRecoveryBanner agent={agent} /> : null}
            <AgentUsageOverview agentId={agent.id} detailsLinkState={{ agent }} />
            <AgentTasksSection agentId={agent.id} />
          </div>
        </section>
      )}
    </AsyncState>
  );
}

function AgentObjectHeader({ agent, backToSettings }: { agent: AgentDetailView; backToSettings?: boolean }) {
  const { me } = useWorkspace();
  const showCreator = agent.createdBy.userId !== me.user.id;
  return (
    <header className="grid gap-4">
      <Link
        className="inline-flex w-fit items-center gap-2 text-sm text-kumo-link"
        to={backToSettings ? `/agents/${agent.id}` : "/agents"}
      >
        <Icon name="arrow-left" />
        {backToSettings ? agent.displayName : "Agents"}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="grid size-10 shrink-0 place-items-center rounded-full bg-kumo-tint font-semibold"
            aria-hidden="true"
          >
            {initials(agent.displayName)}
          </span>
          <div className="grid min-w-0 gap-1">
            <div className="flex flex-wrap items-center gap-3">
              <Text as="h1" size="lg" variant="heading">
                {agent.displayName}
              </Text>
              <AgentAvailabilityAction agent={agent} />
            </div>
            <p>
              <span>@{agent.name}</span>
              {showCreator ? <span>Created by {agent.createdBy.displayName}</span> : null}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {!backToSettings ? <AgentMessagingLink agent={agent} /> : null}
          {true && !backToSettings ? (
            <Link
              className={buttonClassName({ variant: "secondary" })}
              state={{ agent }}
              to={`/agents/${agent.id}/settings`}
            >
              <Icon name="settings" /> Settings
            </Link>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function AgentRecoveryBanner({ agent }: { agent: AgentDetailView }) {
  const recovery = agentAvailabilityRecovery(agent);
  const status = agentStatusPresentation(agent);
  return (
    <section
      className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-kumo-danger-tint p-4"
      aria-label={`Agent status: ${status.label}`}
    >
      <div>
        <strong>{status.label}</strong>
        <p>{agentRecoveryMessage(agent)}</p>
      </div>
      {recovery ? (
        <Link className={buttonClassName({ size: "compact", variant: "secondary" })} state={{ agent }} to={recovery.to}>
          {recovery.label}
        </Link>
      ) : null}
    </section>
  );
}

/**
 * The Agent's messaging channel as a single header affordance. It always opens messaging settings, so
 * a missing binding or unreadable evidence keeps an entry point instead of disappearing.
 */
function AgentMessagingLink({ agent }: { agent: AgentDetailView }) {
  const binding = agent.messaging.kind === "ready" ? agent.messaging.value : undefined;
  const label = binding
    ? messagingChannelLabel(agent, binding)
    : agent.messaging.kind === "unconfirmed"
      ? "Messaging status unavailable"
      : "Connect messaging";
  return (
    <Link
      aria-label={label}
      className="grid size-9 place-items-center rounded-md text-kumo-subtle ring ring-kumo-line hover:text-kumo-link"
      state={{ agent, returnLabel: agent.displayName, returnTo: `/agents/${agent.id}` }}
      title={label}
      to={`/agents/${agent.id}/settings/messaging`}
    >
      {binding ? <ProviderIcon className="size-5" provider={binding.provider} /> : <Icon name="message" />}
    </Link>
  );
}

function AgentUsagePage() {
  const { agentId = "" } = useParams();
  const location = useLocation();
  const routeState = location.state as { agent?: AgentDetailView } | null;
  const initialAgent = routeState?.agent?.id === agentId ? routeState.agent : undefined;
  const state = useResource(() => loadAgentDetail(agentId), agentId, {
    initialValue: initialAgent,
    onBackgroundError: markAgentDetailUnconfirmed,
  });
  return (
    <AsyncState state={state}>
      {(agent) => (
        <section className="grid gap-6">
          <AgentObjectHeader agent={agent} backToSettings />
          <div className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line">
            <header className="grid gap-2">
              <Text as="h2" variant="heading">
                Usage
              </Text>
            </header>
            <AgentUsageTab agentId={agent.id} />
          </div>
        </section>
      )}
    </AsyncState>
  );
}

function AgentSettingsPage() {
  const { agentId = "", section } = useParams();
  const location = useLocation();
  const routeState = location.state as {
    agent?: AgentDetailView;
    returnLabel?: string;
    returnTo?: string;
  } | null;
  const initialAgent = routeState?.agent?.id === agentId ? routeState.agent : undefined;
  const [refreshVersion, setRefreshVersion] = useState(0);
  const state = useResource(() => loadAgentDetail(agentId), `${agentId}:${refreshVersion}`, {
    initialValue: initialAgent,
    keepPreviousData: true,
    onBackgroundError: markAgentDetailUnconfirmed,
    // Failure exits land here, so the page has to observe recovery on its own; it is where an
    // operator waits while a Computer reconnects or a Provider finishes installing.
    revalidateMs: 30_000,
    refreshOnFocus: true,
  });
  const selected = section as AgentSettingsSection | undefined;
  if (selected && !agentSettingsSections.some((item) => item.key === selected)) return <NotFoundPage />;
  return (
    <AsyncState state={state}>
      {(agent) => {
        const backTo = selected ? (routeState?.returnTo ?? `/agents/${agent.id}/settings`) : `/agents/${agent.id}`;
        const backLabel = selected ? (routeState?.returnLabel ?? "Agent settings") : agent.displayName;
        return (
          <section className="grid gap-6">
            <div className="grid gap-4">
              <Link className="inline-flex w-fit items-center gap-2 text-sm text-kumo-link" to={backTo}>
                <Icon name="arrow-left" />
                Back to {backLabel}
              </Link>
              <div className="min-w-0">
                <AgentSettingsContent
                  agent={agent}
                  section={selected}
                  onAgentChanged={() => setRefreshVersion((value) => value + 1)}
                />
              </div>
            </div>
          </section>
        );
      }}
    </AsyncState>
  );
}

function AccountPage() {
  const { me, refreshMe } = useWorkspace();
  return (
    <Page title="Account" description="Manage your personal account details.">
      <AccountSettings refreshMe={refreshMe} user={me.user} />
    </Page>
  );
}

/**
 * Only the healthy states are shown beside the name. Every other state is already stated, with its
 * recovery, by the banner at the top of the Agent home, and repeating it read as two problems.
 */
function AgentAvailabilityAction({ agent }: { agent: AgentDetailView }) {
  if (agent.availability.state !== "ready") return null;
  const status = agentStatusPresentation(agent);
  return <StatusIndicator label={status.label} tone={status.tone} />;
}

function AgentSettingsContent({
  agent,
  section,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  section: AgentSettingsSection | undefined;
  onAgentChanged: () => void;
}) {
  if (!section) return <AgentSettingsOverview agent={agent} />;
  if (section === "messaging") return <ImTab agent={agent} onAgentChanged={onAgentChanged} />;
  if (section === "computer") return <AgentComputerSettings agent={agent} onAgentChanged={onAgentChanged} />;
  return <AgentConfigSettingsContent agent={agent} section={section} onAgentChanged={onAgentChanged} />;
}

function AgentConfigSettingsContent({
  agent,
  section,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  section: Exclude<AgentSettingsSection, "computer" | "messaging">;
  onAgentChanged: () => void;
}) {
  const configState = useResource(() => browserApi.agentConfig(agent.id), `${agent.id}:${section}`);
  return (
    <AsyncState state={configState}>
      {(config) => {
        if (section === "identity") {
          return <GeneralConfigForm initialConfig={config} onAgentChanged={onAgentChanged} />;
        }
        if (section === "instructions" || section === "execution") {
          return (
            <RuntimeConfigurationForm
              initialConfig={config}
              save={(input) => browserApi.updateAgent(config.id, input)}
              section={section}
            />
          );
        }
        return <AgentManageSettings agent={agent} initialConfig={config} onAgentChanged={onAgentChanged} />;
      }}
    </AsyncState>
  );
}

function AgentSettingsOverview({ agent }: { agent: AgentDetailView }) {
  const configState = useResource(() => browserApi.agentConfig(agent.id), `${agent.id}:settings-overview`);
  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Text as="h1" size="lg" variant="heading">
          Agent settings
        </Text>
      </header>
      <AsyncState loading={<AgentSettingsDirectoryLoading />} state={configState}>
        {(config) => (
          <div className="grid gap-6">
            {agentSettingsGroups.map((group) => (
              <section
                className={group.label ? "grid gap-3 border-t border-kumo-line pt-6" : "grid gap-3"}
                key={group.key}
                aria-label={group.label ?? "Agent setup"}
                aria-labelledby={group.label ? `agent-settings-${group.key}` : undefined}
              >
                {group.label ? (
                  <Text as="h2" id={`agent-settings-${group.key}`} variant="heading">
                    {group.label}
                  </Text>
                ) : null}
                <div className="grid overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line">
                  {agentSettingsSections
                    .filter((item) => item.group === group.key)
                    .map((item) => {
                      const content = (
                        <>
                          <span
                            className="grid size-8 shrink-0 place-items-center rounded-md bg-kumo-tint"
                            aria-hidden="true"
                            data-ui="agent-settings-entry-icon"
                          >
                            <Icon name={item.icon} />
                          </span>
                          <span className="grid min-w-0 flex-1 gap-1">
                            <strong>{item.label}</strong>
                            <small>{agentSettingsSummary(agent, config, item.key)}</small>
                          </span>
                        </>
                      );
                      const computerReady =
                        item.key === "computer" && agent.availability.dependencies.computer.state === "ready";
                      if (computerReady) {
                        return (
                          <div
                            className="flex items-center gap-3 border-b border-kumo-line p-4 last:border-b-0"
                            key={item.key}
                            data-ui="agent-settings-entry"
                          >
                            {content}
                          </div>
                        );
                      }
                      return (
                        <Link
                          className="flex items-center gap-3 border-b border-kumo-line p-4 last:border-b-0"
                          key={item.key}
                          data-ui="agent-settings-entry"
                          to={`/agents/${agent.id}/settings/${item.key}`}
                        >
                          {content}
                          <span
                            className="ml-auto flex shrink-0 items-center gap-2 text-kumo-subtle"
                            aria-hidden="true"
                          >
                            {item.key === "computer" ? <small>Review</small> : null}
                            <Icon name="chevron-right" />
                          </span>
                        </Link>
                      );
                    })}
                </div>
              </section>
            ))}
          </div>
        )}
      </AsyncState>
    </div>
  );
}

function AgentSettingsDirectoryLoading() {
  return (
    <div aria-label="Loading Agent settings" className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
      <span aria-hidden="true">
        <Loader />
      </span>
      <span>Loading Agent settings…</span>
    </div>
  );
}

function agentSettingsSummary(agent: AgentDetailView, config: AgentAdminConfig, section: AgentSettingsSection): string {
  if (section === "instructions") {
    return config.runtimeConfig.instructions.trim() ? "Custom instructions" : "Not configured";
  }
  if (section === "execution") {
    const provider = config.runtimeProvider === "codex" ? "Codex" : "Claude Code";
    if (!config.runtimeConfig.model && !config.runtimeConfig.reasoningEffort) return `${provider} · Provider defaults`;
    const model = config.runtimeConfig.model ?? "Default model";
    const reasoning = config.runtimeConfig.reasoningEffort
      ? titleCase(config.runtimeConfig.reasoningEffort)
      : "Default reasoning";
    return `${provider} · ${model} · ${reasoning}`;
  }
  if (section === "messaging") {
    if (agent.messaging.kind === "unconfirmed") return "Messaging status is temporarily unavailable";
    const binding = agent.messaging.value;
    if (!binding) return "No messaging channel connected";
    const status = messagingConnectionLabel(binding);
    return `${messagingChannelLabel(agent, binding)} · ${status}`;
  }
  if (section === "identity") return config.displayName;
  if (section === "computer") {
    const state = agent.availability.dependencies.computer.state;
    const status = state === "ready" ? "Online" : state === "action_required" ? "Offline" : "Unconfirmed";
    return `${agent.computer.displayName} · ${platformLabel(agent.computer.platform)} · ${status}`;
  }
  return config.status === "active" ? "Active" : "Paused";
}

function GeneralConfigForm({
  initialConfig,
  onAgentChanged,
}: {
  initialConfig: AgentAdminConfig;
  onAgentChanged: () => void;
}) {
  const [config, setConfig] = useState(initialConfig);
  const [displayName, setDisplayName] = useState(initialConfig.displayName);
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);
  const dirty = displayName !== config.displayName;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || saving) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const updated = await browserApi.updateAgent(config.id, { expectedRevision: config.revision, displayName });
      setConfig(updated);
      setDisplayName(updated.displayName);
      setMessage("Name saved.");
      onAgentChanged();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to save name");
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line" onSubmit={submit}>
      <header className="grid gap-2">
        <Text as="h1" size="lg" variant="heading">
          Name
        </Text>
      </header>
      <Field htmlFor="agent-display-name" label="Display name">
        <KumoInputControl
          id="agent-display-name"
          name="displayName"
          required
          value={displayName}
          onChange={(event) => {
            setDisplayName(event.currentTarget.value);
            setMessage(undefined);
          }}
        />
      </Field>
      {dirty ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3">
          <span className="text-sm text-kumo-subtle">Unsaved changes</span>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={saving}
              variant="ghost"
              onClick={() => {
                setDisplayName(config.displayName);
                setMessage(undefined);
              }}
            >
              Discard
            </Button>
            <Button disabled={saving} type="submit">
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}

/**
 * Names the machine-level action that resolves the failure. Recovery is stated against the Computer
 * rather than a person: the Workspace has no authoritative operator field, and issue #125 makes the
 * Agent creator audit-only while stating that enrollment implies no control of the physical host.
 */
function computerRecoveryMessage(agent: AgentDetailView): string {
  const computerName = agent.computer.displayName;
  if (agent.availability.reason === "runtime_unavailable") {
    const { provider, status } = agent.availability.dependencies.runtime;
    const providerName = provider === "codex" ? "Codex" : "Claude Code";
    if (status === "install") return `${providerName} is not installed on ${computerName}.`;
    if (status === "sign-in") return `${providerName} is not signed in on ${computerName}.`;
    if (status === "checking") return `OpenTag is still checking ${providerName} on ${computerName}.`;
    return `${providerName} is unavailable on ${computerName}.`;
  }
  if (agent.availability.dependencies.computer.state !== "action_required") {
    return "OpenTag could not confirm this Computer's current connection.";
  }
  return `OpenTag is not running on ${computerName}. Start it there to bring this Computer back online.`;
}

function AgentComputerSettings({ agent, onAgentChanged }: { agent: AgentDetailView; onAgentChanged: () => void }) {
  const [reconnecting, setReconnecting] = useState(false);
  const computerState = agent.availability.dependencies.computer;
  const runtimeUnavailable = agent.availability.reason === "runtime_unavailable";
  // A reachable Computer that cannot run this Agent's Provider is not "Online" for this Agent.
  const ready = computerState.state === "ready" && !runtimeUnavailable;
  const blocked = computerState.state === "action_required" || runtimeUnavailable;
  const computerStatus = ready
    ? "Online"
    : blocked
      ? runtimeUnavailable
        ? "Not ready"
        : "Offline"
      : "Unable to confirm";
  const computerTone: StatusTone = ready ? "success" : blocked ? "warning" : "neutral";
  return (
    <div className="grid gap-6">
      <section
        aria-labelledby="computer-heading"
        className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      >
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Text as="h1" id="computer-heading" size="lg" variant="heading">
              {agent.computer.displayName} · {platformLabel(agent.computer.platform)}
            </Text>
          </div>
          <StatusIndicator label={computerStatus} tone={computerTone} />
        </header>
        {ready ? null : (
          <div className="rounded-md bg-kumo-recessed p-4">
            <div className="grid gap-3">
              {computerState.lastConfirmedAt ? (
                <p>
                  Last seen {formatRelativeTime(computerState.lastConfirmedAt)} ·{" "}
                  {formatDate(computerState.lastConfirmedAt)}
                </p>
              ) : null}
              <p>{computerRecoveryMessage(agent)}</p>
              {/* Re-enrolment only answers an unreachable Computer; a missing Provider needs the
                  Provider installed, so offering it there would send an operator down a dead path. */}
              {computerState.state === "action_required" ? (
                <>
                  <Button
                    aria-controls="agent-computer-reconnect"
                    aria-expanded={reconnecting}
                    size="compact"
                    variant={reconnecting ? "inline" : "secondary"}
                    onClick={() => setReconnecting((value) => !value)}
                  >
                    {reconnecting ? "Cancel Computer connection" : "Reconnect this Computer"}
                  </Button>
                  {reconnecting ? (
                    <div className="grid gap-3" id="agent-computer-reconnect">
                      <ComputerSetup
                        target={{
                          computerId: agent.computer.computerId,
                          displayName: agent.computer.displayName,
                        }}
                        onConnected={() => onAgentChanged()}
                      />
                      <p className="text-sm text-kumo-subtle">
                        Reconnecting restores this Computer for every Agent that runs on it.
                      </p>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function AgentManageSettings({
  agent,
  initialConfig,
  onAgentChanged,
}: {
  agent: AgentDetailView;
  initialConfig: AgentAdminConfig;
  onAgentChanged: () => void;
}) {
  const navigate = useNavigate();
  const [config, setConfig] = useState(initialConfig);
  const [message, setMessage] = useState<string>();
  const [confirmation, setConfirmation] = useState<"delete" | "pause">();
  const [confirmationError, setConfirmationError] = useState<string>();
  const [confirmationText, setConfirmationText] = useState("");
  const [busy, setBusy] = useState(false);
  const [restorePauseFocus, setRestorePauseFocus] = useState(false);
  const pauseButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmation || !restorePauseFocus) return;
    pauseButtonRef.current?.focus();
    setRestorePauseFocus(false);
  }, [confirmation, restorePauseFocus]);
  async function changeLifecycle(action: "suspend" | "reactivate") {
    try {
      setBusy(true);
      setMessage(undefined);
      setConfirmationError(undefined);
      setConfig(
        action === "suspend" ? await browserApi.suspendAgent(config.id) : await browserApi.reactivateAgent(config.id),
      );
      setMessage(action === "suspend" ? "Agent paused." : "Agent reactivated.");
      setRestorePauseFocus(confirmation === "pause");
      setConfirmation(undefined);
      onAgentChanged();
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "Unable to change Agent status";
      if (confirmation === "pause") setConfirmationError(error);
      else setMessage(error);
    } finally {
      setBusy(false);
    }
  }
  async function deleteAgent() {
    try {
      setBusy(true);
      setMessage(undefined);
      setConfirmationError(undefined);
      await browserApi.deleteAgent(config.id);
      navigate("/agents");
    } catch (cause) {
      setConfirmationError(cause instanceof Error ? cause.message : "Unable to delete Agent");
      setBusy(false);
    }
  }
  function closeConfirmation() {
    setConfirmation(undefined);
    setConfirmationError(undefined);
  }
  return (
    <section className="grid gap-4">
      <header className="grid gap-2">
        <Text as="h1" size="lg" variant="heading">
          Manage Agent
        </Text>
      </header>
      <SettingsList>
        <SettingsRow
          description={
            config.status === "active" ? "Stop accepting new requests until reactivated." : "Allow new requests again."
          }
          label={config.status === "active" ? "Pause Agent" : "Reactivate Agent"}
        >
          <Button
            ref={pauseButtonRef}
            variant="secondary"
            onClick={() => {
              if (config.status === "active" && agent.activity.state === "working") {
                setConfirmationError(undefined);
                setConfirmation("pause");
                return;
              }
              void changeLifecycle(config.status === "active" ? "suspend" : "reactivate");
            }}
          >
            {config.status === "active" ? "Pause" : "Reactivate"}
          </Button>
        </SettingsRow>
        <SettingsRow
          description={
            config.status === "active"
              ? "Pause this Agent before deleting it permanently."
              : "Permanently remove this Agent. This cannot be undone."
          }
          label="Delete Agent"
        >
          <Button
            disabled={config.status === "active"}
            ref={deleteButtonRef}
            variant="danger"
            onClick={() => {
              setConfirmationText("");
              setConfirmationError(undefined);
              setConfirmation("delete");
            }}
          >
            Delete permanently
          </Button>
        </SettingsRow>
      </SettingsList>
      {message ? <p role="status">{message}</p> : null}
      {confirmation === "pause" ? (
        <Dialog
          busy={busy}
          description="This Agent is handling a request. Pausing it stops new requests, but the current request may continue until it reaches a safe stopping point."
          returnFocusRef={pauseButtonRef}
          title={`Pause ${config.displayName}?`}
          onClose={closeConfirmation}
        >
          {confirmationError ? <Banner variant="error" role="alert" description={confirmationError} /> : null}
          <div className="flex flex-wrap justify-end gap-3">
            <Button disabled={busy} variant="ghost" onClick={closeConfirmation}>
              Keep active
            </Button>
            <Button disabled={busy} variant="primary" onClick={() => void changeLifecycle("suspend")}>
              {busy ? "Pausing…" : "Pause Agent"}
            </Button>
          </div>
        </Dialog>
      ) : null}
      {confirmation === "delete" ? (
        <Dialog
          busy={busy}
          description="This permanently removes the Agent and its messaging connection. The Agent cannot be restored."
          returnFocusRef={deleteButtonRef}
          title={`Delete ${config.displayName}?`}
          onClose={closeConfirmation}
        >
          <div className="grid gap-4">
            <Field
              htmlFor="agent-delete-confirmation"
              label={
                <>
                  Type <strong>{config.displayName}</strong> to confirm
                </>
              }
            >
              <KumoInputControl
                autoComplete="off"
                id="agent-delete-confirmation"
                value={confirmationText}
                onChange={(event) => setConfirmationText(event.currentTarget.value)}
              />
            </Field>
            {confirmationError ? <Banner variant="error" role="alert" description={confirmationError} /> : null}
            <div className="flex flex-wrap justify-end gap-3">
              <Button disabled={busy} variant="ghost" onClick={closeConfirmation}>
                Cancel
              </Button>
              <Button
                disabled={busy || confirmationText !== config.displayName}
                variant="danger"
                onClick={() => void deleteAgent()}
              >
                {busy ? "Deleting…" : "Delete permanently"}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

function ImTab({ agent, onAgentChanged }: { agent: AgentDetailView; onAgentChanged: () => void }) {
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string>();
  const [confirmation, setConfirmation] = useState<{ bindingId: string; kind: "disable_binding" }>();
  const [confirmationError, setConfirmationError] = useState<string>();
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [restoreFocusTarget, setRestoreFocusTarget] = useState<"messaging" | "trigger_rules">();
  const allMessagesButtonRef = useRef<HTMLButtonElement>(null);
  const disableBindingButtonRef = useRef<HTMLButtonElement>(null);
  const messagingHeadingRef = useRef<HTMLHeadingElement>(null);
  const triggerRulesHeadingRef = useRef<HTMLHeadingElement>(null);
  const state = useResource(() => browserApi.imBinding(agent.id), `${agent.id}:${reload}`, {
    keepPreviousData: true,
  });
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
      setReload((value) => value + 1);
      setRestoreFocusTarget("trigger_rules");
      onAgentChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to change receive mode");
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
      setReload((value) => value + 1);
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
          setReload((value) => value + 1);
          onAgentChanged();
        }}
      >
        {(feishuSetup) => (
          <SlackConfiguration
            agentId={agent.id}
            onSuccess={() => {
              setReload((value) => value + 1);
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
                              <ProviderIcon className="size-7" provider={binding.provider} />
                              <span className="grid min-w-0 flex-1 gap-1">
                                <strong>{binding.bot.displayName ?? titleCase(binding.provider)}</strong>
                                <small className="text-kumo-subtle">{messagingChannelLabel(agent, binding)}</small>
                              </span>
                              <StatusIndicator
                                detail={
                                  binding.lastRuntimeObservationAt
                                    ? `Last observed ${formatDate(binding.lastRuntimeObservationAt)}`
                                    : binding.lastValidatedAt
                                      ? `Validated ${formatDate(binding.lastValidatedAt)}`
                                      : "Not yet observed"
                                }
                                label={messagingConnectionLabel(binding)}
                                tone={messagingConnectionTone(binding)}
                              />
                            </div>
                            <MessagingChannelRecovery
                              agent={agent}
                              binding={binding}
                              busy={feishuSetup.loading || slackConfiguration.loading}
                              onReconnect={() =>
                                void (binding.provider === "feishu"
                                  ? connectFeishu("reauthorize")
                                  : connectSlack("reauthorize"))
                              }
                            />
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
                                {triggerModeHeading(binding.provider)}
                              </Text>
                              <p className="text-sm text-kumo-subtle">{triggerModeExplanation(binding.provider)}</p>
                            </div>
                            <div className="grid gap-3">
                              <fieldset
                                aria-label={triggerModeHeading(binding.provider)}
                                className="flex flex-wrap items-center gap-2"
                              >
                                {binding.receiveMode === "mention_only" ? (
                                  <>
                                    <span className="rounded-md bg-kumo-tint px-4 py-2 text-sm font-medium">
                                      On mention
                                    </span>
                                    <Button
                                      variant="inline"
                                      ref={allMessagesButtonRef}
                                      type="button"
                                      onClick={() => void changeReceiveMode("all_message")}
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
                                      On mention
                                    </Button>
                                    <span className="rounded-md bg-kumo-tint px-4 py-2 text-sm font-medium">
                                      Every message
                                    </span>
                                  </>
                                )}
                              </fieldset>
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

function imBindingStateLabel(binding: ImBindingSummary): string {
  if (binding.bindingState === "reauthorization_required" && binding.provider === "feishu") {
    return "Permissions update required";
  }
  return {
    active: "Connected",
    provisioning: "Setting up",
    reauthorization_required: "Permissions update required",
    error: "Connection error",
    disabled: "Disabled",
  }[binding.bindingState];
}

function imBindingTone(binding: ImBindingSummary): StatusTone {
  const tones: Record<ImBindingSummary["bindingState"], StatusTone> = {
    active: "success",
    provisioning: "info",
    reauthorization_required: "warning",
    error: "danger",
    disabled: "neutral",
  };
  return tones[binding.bindingState];
}

function messagingConnectionLabel(binding: ImBindingSummary): string {
  return imBindingStateLabel(binding);
}

function messagingConnectionTone(binding: ImBindingSummary): StatusTone {
  return imBindingTone(binding);
}

function AccountSettings({ refreshMe, user }: { refreshMe: () => Promise<MeResponse>; user: MeResponse["user"] }) {
  const saveInFlight = useRef(false);
  const confirmedDisplayNameRef = useRef(user.displayName);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [saving, setSaving] = useState(false);
  const syncInFlight = useRef(false);
  const [syncing, setSyncing] = useState(false);
  /**
   * A Server-confirmed display name whose Account refresh has not succeeded yet. It is saved, not
   * unsaved, so it — and never the stale projection — is what the form treats as confirmed.
   */
  const [unsyncedDisplayName, setUnsyncedDisplayName] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const confirmedDisplayName = unsyncedDisplayName ?? user.displayName;
  const dirty = displayName !== confirmedDisplayName;

  useEffect(() => {
    if (confirmedDisplayNameRef.current === user.displayName) return;
    confirmedDisplayNameRef.current = user.displayName;
    setDisplayName(user.displayName);
  }, [user.displayName]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Enter in the text field submits this form too, so the boundary lives here rather than in
    // which controls are rendered: a committed save must not be repeated, and a save must never
    // run against an Account refresh that is still in flight.
    if (saveInFlight.current || syncInFlight.current || !dirty) return;
    saveInFlight.current = true;
    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      const updated = await browserApi.updateProfile({ displayName });
      setDisplayName(updated.displayName);
      await syncAccount(updated.displayName);
    } catch (cause) {
      // Only the write can fail here; syncAccount reports its own failure. Fall back to the last
      // confirmed value, which is the saved one when an earlier save is still unsynchronized.
      setDisplayName(confirmedDisplayName);
      setError(cause instanceof Error ? cause.message : "Unable to save the account profile");
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  /**
   * Refreshes the shared Account after a committed write; it never repeats the write itself. One
   * refresh at a time, so a slower earlier response can never overwrite a newer projection.
   */
  async function syncAccount(savedDisplayName: string): Promise<void> {
    if (syncInFlight.current) return;
    syncInFlight.current = true;
    setSyncing(true);
    try {
      await refreshMe();
      setUnsyncedDisplayName(undefined);
      setError(undefined);
      setMessage("Account profile saved.");
    } catch {
      setUnsyncedDisplayName(savedDisplayName);
      setMessage(undefined);
      setError(
        "Your display name was saved. OpenTag could not refresh the account, so the rest of the page still shows the previous name.",
      );
    } finally {
      syncInFlight.current = false;
      setSyncing(false);
    }
  }

  async function retrySync() {
    if (unsyncedDisplayName === undefined) return;
    await syncAccount(unsyncedDisplayName);
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <Text as="h2" variant="heading">
        Account profile
      </Text>
      <SettingsList>
        <SettingsRow label="Email" description="Your sign-in email cannot be changed here.">
          <Field hint="Read only" hintId="account-email-hint" htmlFor="account-email" label="Email">
            <KumoInputControl
              aria-describedby="account-email-hint"
              id="account-email"
              name="email"
              readOnly
              type="email"
              value={user.email}
            />
          </Field>
        </SettingsRow>
        <SettingsRow label="Display name" description="This identity is used throughout OpenTag.">
          <Field htmlFor="account-display-name" label="Display name">
            <KumoInputControl
              autoComplete="name"
              // Editing during a refresh-only retry could open a save that races it.
              disabled={syncing}
              id="account-display-name"
              maxLength={255}
              name="displayName"
              onChange={(event) => {
                setDisplayName(event.currentTarget.value);
                setMessage(undefined);
                setError(undefined);
              }}
              required
              value={displayName}
            />
          </Field>
        </SettingsRow>
      </SettingsList>
      {dirty ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3">
          <span className="text-sm text-kumo-subtle">Unsaved changes</span>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={saving}
              variant="ghost"
              onClick={() => {
                setDisplayName(confirmedDisplayName);
                setMessage(undefined);
                setError(undefined);
              }}
            >
              Discard
            </Button>
            <Button disabled={saving} type="submit">
              {saving ? "Saving…" : "Save account profile"}
            </Button>
          </div>
        </div>
      ) : null}
      {!dirty && unsyncedDisplayName !== undefined ? (
        // The value is saved, so this offers only the step that failed: no Save that would repeat
        // the write, and no Discard that would replace the saved name with the stale projection.
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3">
          <span className="text-sm text-kumo-subtle">Account not refreshed</span>
          <div className="flex flex-wrap justify-end gap-2">
            <Button disabled={syncing} onClick={() => void retrySync()}>
              {syncing ? "Refreshing…" : "Retry refresh"}
            </Button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p className="text-sm text-kumo-success" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-kumo-danger" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function Page({
  title,
  eyebrow,
  description,
  action,
  children,
}: {
  title: string;
  eyebrow?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid w-full gap-6" data-ui="page">
      <PageHeader description={description} eyebrow={eyebrow} title={title} titleId="page-title">
        {action}
      </PageHeader>
      {children}
    </section>
  );
}

function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2 rounded-lg bg-kumo-base p-8 text-center ring ring-kumo-line" data-ui="empty">
      <Text as="h2" variant="heading">
        {title}
      </Text>
      <Text as="p" variant="secondary">
        {children}
      </Text>
    </section>
  );
}

function NotFoundPage() {
  return (
    <section
      className="mx-auto grid max-w-xl gap-3 rounded-lg bg-kumo-base p-6 ring ring-kumo-line"
      data-ui="not-found"
    >
      <Text as="h1" size="lg" variant="heading">
        Page not found
      </Text>
      <Text as="p" variant="secondary">
        The requested OpenTag page is not available.
      </Text>
      <Link to="/agents">Back to Agents</Link>
    </section>
  );
}

function StandaloneNotFoundPage() {
  return (
    <main className="mx-auto grid max-w-xl gap-3 rounded-lg bg-kumo-base p-6 ring ring-kumo-line" data-ui="not-found">
      <Text as="h1" size="lg" variant="heading">
        Page not found
      </Text>
      <Text as="p" variant="secondary">
        The requested OpenTag page is not available.
      </Text>
      <Link to="/agents">Back to Agents</Link>
    </main>
  );
}

function titleCase(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function platformLabel(platform: AgentSummary["computer"]["platform"]): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  return "Linux";
}

type AgentStatusSource = Pick<AgentListItem, "activity" | "availability">;

function runtimeProviderName(provider: AgentSummary["runtimeProvider"]): string {
  return provider === "codex" ? "Codex" : "Claude Code";
}

/**
 * Presents the exact Agent-level state the viewer can act on. Channel authorization is deliberately
 * excluded: a connected Slack or Feishu App can coexist with an offline Computer or unavailable
 * runtime, and collapsing those facts into one warning made the old status impossible to interpret.
 */
/**
 * Feishu gives each Agent its own bot, so its handle addresses the Agent. Slack routes one workspace
 * Bot, so an Agent handle would name a Slack identity that does not exist.
 */
function messagingChannelLabel(agent: AgentDetailView, binding: ImBindingSummary): string {
  const provider = titleCase(binding.provider);
  if (binding.provider === "feishu") return `${provider} · @${agent.name}`;
  return binding.bot.displayName ? `${provider} · ${binding.bot.displayName}` : provider;
}

/**
 * The mode never changes what the Agent receives -- every message in a shared conversation reaches it
 * either way. It changes when the Agent wakes up to act, which is what costs Tokens.
 */
function triggerModeHeading(provider: ImBindingSummary["provider"]): string {
  return provider === "feishu" ? "Group chat trigger mode" : "Channel trigger mode";
}

function triggerModeExplanation(provider: ImBindingSummary["provider"]): string {
  const destination = provider === "feishu" ? "group chats" : "channels";
  return `This Agent receives every message in connected ${destination}. This setting only decides when it wakes up to act on them.`;
}

function triggerModeDescription(
  receiveMode: AgentSummary["receiveMode"],
  provider: ImBindingSummary["provider"],
): string {
  const destination = provider === "feishu" ? "group chat" : "channel";
  if (receiveMode === "all_message") {
    return `Wakes up on each new ${destination} message and decides for itself whether to reply. Fastest to react, and uses the most Tokens.`;
  }
  return "Waits until someone @mentions it, then reads everything said since its last reply in one go. Slower to react, and much cheaper.";
}

/**
 * One exit per channel state. Where the connection cannot be repaired from here, the row says what it
 * is waiting on -- and only when the evidence names it -- instead of offering an action that does nothing.
 */
function MessagingChannelRecovery({
  agent,
  binding,
  busy = false,
  onReconnect,
}: {
  agent: AgentDetailView;
  binding: ImBindingSummary;
  busy?: boolean;
  onReconnect: () => void;
}) {
  const provider = titleCase(binding.provider);
  if (binding.bindingState === "reauthorization_required") {
    return (
      <div className="flex flex-wrap gap-3">
        <Button disabled={busy} loading={busy} onClick={onReconnect}>
          Reauthorize {provider}
        </Button>
      </div>
    );
  }
  if (binding.bindingState === "error" || binding.bindingState === "disabled") {
    return (
      <div className="flex flex-wrap gap-3">
        <Button disabled={busy} loading={busy} onClick={onReconnect}>
          Reconnect {provider}
        </Button>
      </div>
    );
  }
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
        The channel itself is connected. Messages wait until this Agent's Computer is online.{" "}
        <Link className="text-kumo-link" to={`/agents/${agent.id}/settings/computer`}>
          View Computer
        </Link>
      </p>
    );
  }
  if (computerState === "ready" && runtimeStatus && runtimeStatus !== "ready") {
    return (
      <p className="text-sm text-kumo-subtle">
        The channel itself is connected. Messages wait until {runtimeProviderName(agent.runtimeProvider)} is ready on
        this Agent's Computer.{" "}
        <Link className="text-kumo-link" to={`/agents/${agent.id}/settings/computer`}>
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

function agentStatusPresentation(agent: AgentStatusSource): { label: string; tone: StatusTone } {
  const { availability } = agent;
  if (availability.state === "ready") {
    return agent.activity.state === "working"
      ? { label: "Working", tone: "info" }
      : { label: "Ready", tone: "success" };
  }
  if (availability.state === "suspended") return { label: "Suspended", tone: "neutral" };

  /*
   * Unreadable evidence is one situation to a viewer -- nothing to act on, retried automatically --
   * so it is named for the dependency it covers rather than for which read failed.
   */
  if (availability.state === "unconfirmed") {
    if (availability.reason === "computer_unconfirmed" || availability.reason === "runtime_unconfirmed") {
      return { label: "Computer unknown", tone: "neutral" };
    }
    return { label: "Status unknown", tone: "neutral" };
  }

  if (availability.reason === "computer_offline") return { label: "Computer offline", tone: "warning" };
  if (availability.reason === "runtime_unavailable") {
    // The Provider-specific wording tells a viewer what to do; a single "runtime not available" does not.
    const { provider, status } = availability.dependencies.runtime;
    const providerName = runtimeProviderName(provider);
    if (status === "checking") return { label: `Checking ${providerName}`, tone: "info" };
    if (status === "install") return { label: `${providerName} not installed`, tone: "warning" };
    if (status === "sign-in") return { label: `${providerName} sign-in required`, tone: "warning" };
    return { label: `${providerName} unavailable`, tone: "warning" };
  }
  /*
   * Every messaging failure blocks the same thing, and separating "not connected" from "error" from
   * "handoff" made one outcome read as four unrelated events.
   */
  if (availability.state === "not_connected" || availability.state === "setting_up") {
    return { label: "Messaging disconnected", tone: availability.state === "setting_up" ? "info" : "neutral" };
  }
  return { label: "Messaging disconnected", tone: "warning" };
}

function agentAvailabilitySummary(agent: AgentDetailView): string {
  if (agent.availability.state === "ready") {
    const provider = agent.availability.dependencies.channel.provider;
    return provider ? `Available in ${titleCase(provider)}` : "Ready for new work";
  }
  return {
    action_required: "Cannot receive new work",
    setting_up: "Messaging setup in progress",
    not_connected: "Messaging is not connected",
    suspended: "Not receiving new work",
    unconfirmed: "Status temporarily unavailable",
  }[agent.availability.state];
}

function agentAvailabilityRecovery(agent: AgentDetailView): { label: string; to: string } | undefined {
  if (!true || agent.availability.state === "ready") return undefined;
  if (agent.availability.reason === "agent_suspended") {
    return { label: "Manage Agent", to: `/agents/${agent.id}/settings/manage` };
  }
  if (
    agent.availability.reason === "im_not_connected" ||
    agent.availability.reason === "im_provisioning" ||
    agent.availability.reason === "im_reauthorization_required" ||
    agent.availability.reason === "im_error" ||
    agent.availability.reason === "im_disabled"
  ) {
    return { label: "View messaging", to: `/agents/${agent.id}/settings/messaging` };
  }
  if (agent.availability.reason === "handoff_unavailable") {
    return { label: "View messaging", to: `/agents/${agent.id}/settings/messaging` };
  }
  if (agent.availability.state === "unconfirmed") return undefined;
  return { label: "View Computer", to: `/agents/${agent.id}/settings/computer` };
}

function agentRecoveryMessage(agent: AgentDetailView): string {
  const messages: Record<NonNullable<AgentAvailability["reason"]>, string> = {
    agent_suspended: "This Agent is paused. Resume it to start receiving messages again.",
    agent_unconfirmed: "Could not refresh this Agent's status. Retrying automatically.",
    handoff_unconfirmed: "Could not refresh this Agent's status. Retrying automatically.",
    computer_unconfirmed: "Could not confirm the assigned Computer. Retrying automatically.",
    runtime_unconfirmed: "Could not confirm the assigned Computer. Retrying automatically.",
    computer_offline: "This Agent's Computer is offline. Retrying automatically.",
    runtime_unavailable: "The Agent runtime is not available. Set up the runtime on this Agent's Computer.",
    im_not_connected: "Connect Feishu or Slack so teammates can send this Agent work.",
    im_provisioning: "The messaging connection is still being set up.",
    im_reauthorization_required: "The messaging connection needs to be re-authorized before it can receive messages.",
    im_error: "The messaging connection failed. Reconnect Feishu or Slack to receive messages.",
    im_disabled: "Messaging is turned off for this Agent. Reconnect Feishu or Slack to receive messages.",
    handoff_unavailable: "Messages cannot be sent to this Agent.",
  };
  return agent.availability.reason ? messages[agent.availability.reason] : agentAvailabilitySummary(agent);
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "OT";
  return parts
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatRelativeTime(value: string): string {
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1_000));
  if (elapsedSeconds < 60) return "just now";
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes} ${elapsedMinutes === 1 ? "minute" : "minutes"} ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} ${elapsedHours === 1 ? "hour" : "hours"} ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays} ${elapsedDays === 1 ? "day" : "days"} ago`;
}
