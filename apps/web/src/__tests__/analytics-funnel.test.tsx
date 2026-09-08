import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analytics } from "../analytics/analytics.js";
import type { AnalyticsParams, GtagCommand } from "../analytics/gtag.js";
import { rememberSignInIntent } from "../analytics/sign-in-intent.js";
import { ApiError, browserApi } from "../api.js";
import { App } from "../app.js";
import { LoginProviderLink } from "../features/auth/login-provider-link.js";
import { PasswordSignInForm } from "../features/auth/password-sign-in-form.js";
import { AgentSetupSurface } from "../onboarding-v2/page.js";
import { agentId, agentListItem, installApi, resetWebAppState, userId } from "./support/app-fixtures.js";
import { renderInRouter } from "./support/router.js";

const sent: GtagCommand[] = [];

/** Only the product milestones; page views are asserted where page views are the subject. */
function events(name?: string): { name: string; params: AnalyticsParams }[] {
  return sent
    .filter((command): command is readonly ["event", string, AnalyticsParams] => command[0] === "event")
    .filter((command) => command[1] !== "page_view" && (name === undefined || command[1] === name))
    .map((command) => ({ name: command[1], params: command[2] }));
}

function identities(): (string | number | boolean | null | undefined)[] {
  return sent
    .filter((command): command is readonly ["set", AnalyticsParams] => command[0] === "set")
    .filter((command) => "user_id" in command[1])
    .map((command) => command[1].user_id);
}

async function createAnAgent(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /Local computer/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
}

describe("activation funnel reporting", () => {
  beforeEach(() => {
    resetWebAppState();
    sent.length = 0;
    analytics.arm((command) => sent.push(command));
  });

  afterEach(() => {
    analytics.disarm();
    vi.restoreAllMocks();
  });

  it("reports the sign-in on the page it lands on, and attaches the Account to what follows", async () => {
    // What the sign-in path left behind on its way out of the previous document.
    rememberSignInIntent({ method: "password", registering: false });
    installApi();
    window.history.replaceState({}, "", "/agents");

    render(<App />);
    await screen.findByRole("heading", { name: "Agents" });

    expect(events("login")).toEqual([
      { name: "login", params: { method: "password", funnel: "activation", funnel_step: 1 } },
    ]);
    expect(identities()).toEqual([userId]);
  });

  it("reports a registration as a registration", async () => {
    rememberSignInIntent({ method: "password", registering: true });
    installApi();
    window.history.replaceState({}, "", "/agents");

    render(<App />);
    await screen.findByRole("heading", { name: "Agents" });

    expect(events("sign_up")).toHaveLength(1);
    expect(events("login")).toHaveLength(0);
  });

  it("says nothing about a sign-in for an Account that arrived with a session it already had", async () => {
    installApi();
    window.history.replaceState({}, "", "/agents");

    render(<App />);
    await screen.findByRole("heading", { name: "Agents" });

    expect(events("login")).toHaveLength(0);
    expect(events("sign_up")).toHaveLength(0);
    // Identified regardless: who is reading is not the same question as how they got here.
    expect(identities()).toEqual([userId]);
  });

  it("records the method both sign-in paths know before they leave the document", async () => {
    const navigate = vi.fn();
    installApi({ authProviders: [{ id: "password", enabled: true, startUrl: null }], unauthenticated: true });
    render(<PasswordSignInForm navigate={navigate} next="/agents" />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());

    expect(window.sessionStorage.getItem("opentag:analytics:sign-in-intent")).toContain("password");
  });

  it("records the provider a redirect sign-in is about to leave for", async () => {
    render(
      <LoginProviderLink
        next="/agents"
        provider={{ id: "google", enabled: true, startUrl: "/api/v1/auth/google/start" }}
      />,
    );

    const link = screen.getByRole("link");
    // The press is a document navigation, which jsdom refuses to perform and reports; the handler
    // under test runs either way.
    link.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(link);

    expect(window.sessionStorage.getItem("opentag:analytics:sign-in-intent")).toContain("google");
  });

  it("reports a created Agent with the runtime it was created for, and never its name", async () => {
    const createAgent = vi.spyOn(browserApi, "createAgent").mockResolvedValue({ id: agentId } as never);

    await renderInRouter(<AgentSetupSurface onAgentAvailable={() => undefined} />);
    await createAnAgent();
    await waitFor(() => expect(createAgent).toHaveBeenCalled());

    expect(events("agent_created")).toEqual([
      { name: "agent_created", params: { runtime_provider: "codex", funnel: "activation", funnel_step: 2 } },
    ]);
    expect(JSON.stringify(sent)).not.toContain("opentag");
  });

  it("reports a refused name apart from any other refusal", async () => {
    vi.spyOn(browserApi, "createAgent").mockRejectedValue(
      new ApiError(409, "That name is taken", "AGENT_NAME_CONFLICT"),
    );
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] } as never);

    await renderInRouter(<AgentSetupSurface onAgentAvailable={() => undefined} />);
    await createAnAgent();
    await screen.findByRole("alert");

    expect(events("agent_create_failed")).toEqual([
      { name: "agent_create_failed", params: { reason: "name_conflict" } },
    ]);
    expect(events("agent_created")).toHaveLength(0);
  });

  it("reports nothing for a preview creation, which creates no Agent", async () => {
    const createAgent = vi.spyOn(browserApi, "createAgent");

    await renderInRouter(
      <AgentSetupSurface creationPreview={async () => ({ id: agentId })} onAgentAvailable={() => undefined} />,
    );
    await createAnAgent();
    await waitFor(() => expect(events("agent_created")).toHaveLength(0));

    expect(createAgent).not.toHaveBeenCalled();
  });

  it("reports a first conversation once the Agent list shows one, and only once", async () => {
    installApi({ agentList: [{ ...agentListItem, usage: { ...agentListItem.usage, tasks: 1 } }] });
    window.history.replaceState({}, "", "/agents");

    const view = render(<App />);
    await screen.findByRole("heading", { name: "Agents" });
    // The list re-reads on focus; a second answer saying the same thing is not a second conversation.
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(events("first_conversation_observed").length).toBeGreaterThan(0));
    view.rerender(<App />);

    expect(events("first_conversation_observed")).toEqual([
      { name: "first_conversation_observed", params: { funnel: "activation", funnel_step: 4 } },
    ]);
  });

  it("says nothing about a conversation for an Agent that has held none", async () => {
    installApi({ agentList: [{ ...agentListItem, usage: { ...agentListItem.usage, tasks: 0 } }] });
    window.history.replaceState({}, "", "/agents");

    render(<App />);
    await screen.findByRole("heading", { name: "Agents" });

    expect(events("first_conversation_observed")).toHaveLength(0);
  });
});
