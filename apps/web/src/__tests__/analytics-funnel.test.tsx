import { onlineManager } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analytics } from "../analytics/analytics.js";
import type { AnalyticsParams, GtagCommand } from "../analytics/gtag.js";
import { rememberSignInIntent } from "../analytics/sign-in-intent.js";
import { ApiError, browserApi } from "../api.js";
import { App } from "../app.js";
import { LoginProviderLink } from "../features/auth/login-provider-link.js";
import { PasswordSignInForm } from "../features/auth/password-sign-in-form.js";
import { AgentSetupSurface } from "../onboarding-v2/page.js";
import {
  agentId,
  agentListItem,
  installApi,
  json,
  openAccountMenu,
  resetWebAppState,
  userId,
} from "./support/app-fixtures.js";
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

/** The identity values recorded before the page view for `path`, so ordering can be asserted. */
function sentUpTo(path: string): (string | number | boolean | null | undefined)[] {
  const index = sent.findIndex(
    (command) => command[0] === "event" && command[1] === "page_view" && command[2].page_path === path,
  );
  return (index === -1 ? sent : sent.slice(0, index))
    .filter((command): command is readonly ["set", AnalyticsParams] => command[0] === "set")
    .filter((command) => "user_id" in command[1])
    .map((command) => command[1].user_id);
}

function pageViewParams(): AnalyticsParams[] {
  return sent
    .filter((command): command is readonly ["event", string, AnalyticsParams] => command[0] === "event")
    .filter((command) => command[1] === "page_view")
    .map((command) => command[2]);
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
    // Restored, because a stubbed MODE changes how the query cache behaves for every later test.
    vi.unstubAllEnvs();
    onlineManager.setOnline(true);
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

  it("names a real dynamic route by its template, against the generated route tree", async () => {
    installApi({ bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);

    render(<App />);
    await screen.findByRole("heading", { name: "Reviewer" });

    // The generated tree declares this leaf as `/agents/$agentId/`; the report groups by its shape.
    expect(pageViewParams()[0]).toMatchObject({ page_path: "/agents/:agentId" });
    expect(JSON.stringify(pageViewParams())).not.toContain(agentId);
  });

  it("gives an unrouted URL one constant path, carrying none of the address", async () => {
    // `/invites/<token>` renders the standalone not-found page rather than failing to match, and the
    // token grants access to an Account. This is the assumption the whole sanitizer rests on.
    const token = "A".repeat(43);
    installApi();
    window.history.replaceState({}, "", `/invites/${token}`);

    render(<App />);
    await screen.findByRole("heading", { name: "Page not found" });

    expect(pageViewParams()[0]).toMatchObject({ page_path: "/(not-found)" });
    expect(JSON.stringify(pageViewParams())).not.toContain(token);
  });

  it("stops attributing anything to the Account once it signs out", async () => {
    installApi();
    window.history.replaceState({}, "", "/agents");

    render(<App />);
    await screen.findByRole("heading", { name: "Agents" });
    const { menu } = await openAccountMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Sign out" }));
    await screen.findByRole("heading", { name: "Sign in to OpenTag" });

    // Signing out is a client-side navigation, so without an explicit clear the login page — and
    // every page after it — would still be reported as the Account that just left.
    expect(identities()).toEqual([userId, null]);
  });

  it("stops attributing anything to the Account when its session lapses, not only when it signs out", async () => {
    /*
     * The commoner of the two exits, and the one a sign-out test cannot reach. `createQueryClient`
     * only sets `refetchOnReconnect` outside tests, so production behaviour is restored here — a
     * probe that skips this sees nothing and wrongly passes.
     */
    vi.stubEnv("MODE", "production");
    installApi();
    const fallback = vi.mocked(fetch).getMockImplementation();
    if (!fallback) throw new Error("installApi did not install fetch");
    let sessionValid = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/me" && init?.method === undefined && !sessionValid) {
        return json({ error: { code: "UNAUTHENTICATED", message: "The session has expired" } }, 401);
      }
      return fallback(input, init);
    });
    window.history.replaceState({}, "", "/agents");

    render(<App />);
    await screen.findByRole("heading", { name: "Agents" });
    expect(identities()).toEqual([userId]);

    sessionValid = false;
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await screen.findByRole("heading", { name: "Sign in to OpenTag" });

    expect(identities()).toEqual([userId, null]);
    // And the identity is released before the page it redirects to is reported, so the login page
    // view does not carry the Account that just lost its session.
    const loginView = pageViewParams().findIndex((params) => params.page_path === "/login");
    expect(loginView).toBeGreaterThanOrEqual(0);
    expect(sentUpTo("/login")).toContain(null);
  });

  it("keeps the identity through a read that has not answered, and through one that failed to reach the Server", async () => {
    vi.stubEnv("MODE", "production");
    installApi();
    const fallback = vi.mocked(fetch).getMockImplementation();
    if (!fallback) throw new Error("installApi did not install fetch");
    let reachable = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/me" && init?.method === undefined && !reachable) {
        throw new TypeError("Failed to fetch");
      }
      return fallback(input, init);
    });
    window.history.replaceState({}, "", "/agents");

    render(<App />);
    await screen.findByRole("heading", { name: "Agents" });

    reachable = false;
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(0));

    // A dropped connection is also "no Account", and it is not a sign-out. Clearing here would drop
    // the identity of a session that is still perfectly alive.
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

  it("does not turn a created Agent into a failed one when what follows the creation fails", async () => {
    vi.spyOn(browserApi, "createAgent").mockResolvedValue({ id: agentId } as never);
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] } as never);

    await renderInRouter(
      <AgentSetupSurface
        onAgentAvailable={() => {
          throw new Error("navigation failed");
        }}
      />,
    );
    await createAnAgent();
    await screen.findByRole("alert");

    // The Server made the Agent. A route that could not be reached afterwards is not a refusal.
    expect(events("agent_created")).toHaveLength(1);
    expect(events("agent_create_failed")).toHaveLength(0);
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
