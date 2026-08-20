import { Navigate, Route, Routes } from "react-router-dom";
import { AgentDetailPage } from "./features/agents/agent-detail-page.js";
import { AgentsPage } from "./features/agents/agents-page.js";
import { NewAgentPage } from "./features/agents/new-agent-page.js";
import { AuthenticatedTeamGate } from "./features/auth/authenticated-team-gate.js";
import { InvitePage } from "./features/auth/invite-page.js";
import { LoginPage } from "./features/auth/login-page.js";
import { OnboardingPage } from "./features/onboarding/onboarding-page.js";
import { SettingsPage } from "./features/settings/settings-page.js";
import { AppShell } from "./layout/app-shell.js";
import { NotFoundPage, UnavailablePage } from "./routes/fallback-pages.js";

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invites/:token" element={<InvitePage />} />
      <Route path="/teams/new" element={<UnavailablePage title="Create Team" />} />
      <Route element={<AuthenticatedTeamGate />}>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route element={<AppShell />}>
          <Route index element={<Navigate replace to="/agents" />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/new" element={<NewAgentPage />} />
          <Route path="/agents/:agentId" element={<Navigate replace to="general" />} />
          <Route path="/agents/:agentId/:tab" element={<AgentDetailPage />} />
          <Route path="/settings" element={<Navigate replace to="team" />} />
          <Route path="/settings/:section" element={<SettingsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
