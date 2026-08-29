import type { MeResponse } from "@opentag/shared/browser";
import { useCallback, useState } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { ApiError, browserApi } from "./api.js";
import { AccountPage } from "./features/account/account-page.js";
import { AgentDetailPage } from "./features/agents/agent-detail-page.js";
import { AgentSettingsPage } from "./features/agents/agent-settings/agent-settings-page.js";
import { AgentUsagePage } from "./features/agents/agent-usage-page.js";
import { AgentsPage } from "./features/agents/agents-page.js";
import { LegacyAgentSectionRedirect } from "./features/agents/legacy-redirects.js";
import { NewAgentPage } from "./features/agents/new-agent-page.js";
import { LoginPage } from "./features/auth/login-page.js";
import { IntegrationsPage } from "./features/integrations-page.js";
import { StandaloneNotFoundPage } from "./features/not-found.js";
import { OnboardingLabRoute, OnboardingRoute } from "./features/onboarding/onboarding-routes.js";
import { AsyncState, useResource } from "./features/resource/use-resource.js";
import { AccountContext, useAccount, useWorkspace, WorkspaceContext } from "./features/session/session-context.js";
import { AppShell } from "./features/shell/app-shell.js";
import { SkillsPage } from "./features/skills-page.js";
import { TaskDetailPage, TasksPage } from "./features/tasks-page.js";
import { OnboardingV2Page } from "./onboarding-v2/page.js";
import { Button, Text } from "./ui/design-system.js";

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/*
        The redesigned onboarding flow, built against an in-page mock. It sits outside every gate
        on purpose: it reaches no Server, so requiring an Account to look at it would only slow
        down the page and interaction work it exists for.
      */}
      <Route path="/internal/onboarding-v2" element={<OnboardingV2Page />} />
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

function WorkspaceSetupGate() {
  const { membership } = useWorkspace();
  const location = useLocation();
  const onboarding = location.pathname === "/onboarding";
  if (membership.setupCompletedAt) return onboarding ? <Navigate replace to="/agents" /> : <Outlet />;
  return onboarding ? <Outlet /> : <Navigate replace to="/onboarding" />;
}
