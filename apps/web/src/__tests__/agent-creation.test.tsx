import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import {
  agentCreationPosts,
  agentId,
  computerId,
  installApi,
  resetWebAppState,
  secondComputerId,
  storeCreationIntent,
  twoReadyComputers,
} from "./support/app-fixtures.js";

describe("OpenTag Web App Shell", () => {
  beforeEach(resetWebAppState);

  it("keeps New Agent under the page title as the Account owner's sole empty-state action", async () => {
    installApi({ emptyAgents: true });
    render(<App />);

    expect(await screen.findByRole("heading", { name: "No Agents yet" })).toBeTruthy();
    expect(screen.getByText("Create your first shared AI teammate with New Agent.")).toBeTruthy();
    const createAgent = screen.getByRole("button", { name: "New Agent" });
    expect(createAgent.closest('[data-ui="page-header"]')).toBeTruthy();
    expect(createAgent.closest('[data-ui="agents-page-action"]')).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
  });

  it("opens the complete New Agent form in a dialog and returns focus when cancelled", async () => {
    installApi();
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "New Agent" });

    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    expect(within(dialog).queryByText("Create")).toBeNull();
    expect(window.location.pathname).toBe("/agents");
    await waitFor(() => expect(within(dialog).getByLabelText("Display name")).toBe(document.activeElement));
    expect(within(dialog).queryByLabelText("Agent name")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Edit Agent name" })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Where it runs" })).toBeTruthy();
    expect(within(dialog).getByText("Ready to run")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Create Agent" })).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Assistant" } });
    expect(within(dialog).getByText("@research-assistant")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit Agent name" }));
    const name = within(dialog).getByLabelText("Agent name") as HTMLInputElement;
    expect(name.value).toBe("research-assistant");
    await waitFor(() => expect(name).toBe(document.activeElement));
    fireEvent.change(name, { target: { value: "custom-researcher" } });
    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Partner" } });
    expect(name.value).toBe("custom-researcher");

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New Agent" })).toBeNull());
    expect(trigger).toBe(document.activeElement);
  });

  it("lets the Account owner connect another Computer from New Agent", async () => {
    installApi();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));

    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Change Computer" }));
    const trigger = within(dialog).getByRole("button", { name: "Connect another Computer" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);

    expect(within(dialog).getByRole("heading", { name: "Connect another Computer" })).toBeTruthy();
    expect(await within(dialog).findByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Cancel Computer connection" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(within(dialog).getByRole("heading", { name: "Where it runs" })).toBeTruthy();
    expect(within(dialog).getByText("Ready to run")).toBeTruthy();
  });

  it("binds the Agent to the Computer the reader selected, not the default one", async () => {
    installApi({ computers: twoReadyComputers });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });

    // The Account has both; the form defaults to one and the reader picks the other. What the
    // request binds to has to be the choice, not the default.
    expect(within(dialog).getByText("Ada's Mac")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Change Computer" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Zulu Tower/ }));
    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Assistant" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Agent" }));

    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.filter(([path, init]) => path === "/api/v1/agents" && init?.method === "POST"),
      ).toHaveLength(1),
    );
    const created = vi
      .mocked(fetch)
      .mock.calls.find(([path, init]) => path === "/api/v1/agents" && init?.method === "POST");
    expect(JSON.parse(String(created?.[1]?.body))).toMatchObject({ computerId: secondComputerId });
  });

  it("lists every Computer the Account has and still offers another", async () => {
    installApi({
      computers: [
        ...twoReadyComputers,
        {
          id: "a5fe9af3-d1c6-472b-b78c-8a7ccf512750",
          displayName: "Ada's Retired Mac",
          platform: "darwin",
          connectionStatus: "offline",
          connectedAt: "2026-08-20T00:00:00.000Z",
          lastSeenAt: "2026-08-20T00:00:00.000Z",
        },
      ],
    });
    window.history.replaceState({}, "", "/agents/computers");
    render(<App />);

    const listed = await screen.findByRole("region", { name: "Your computers" });
    // An Account may hold several, so the page shows all of them and adding one stays available
    // rather than disappearing once the first exists.
    expect(within(listed).getAllByRole("listitem")).toHaveLength(3);
    for (const name of ["Ada's Mac", "Zulu Tower", "Ada's Retired Mac"]) {
      expect(within(listed).getByText(name)).toBeTruthy();
    }
    expect(screen.getByRole("heading", { name: "Connect a Computer" })).toBeTruthy();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([path, init]) => path === "/api/v1/computer-connect-codes" && init?.method === "POST"),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Connect a Computer" }));
    expect(await screen.findByRole("button", { name: "Copy command" })).toBeTruthy();
  });

  it("removes a Computer after explaining the Agent impact", async () => {
    installApi();
    const fixtureFetch = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input) === `/api/v1/computers/${computerId}` && init?.method === "DELETE"
        ? Promise.resolve(new Response(null, { status: 204 }))
        : (fixtureFetch?.(input, init) ?? Promise.reject(new Error("The fixture fetch implementation is missing"))),
    );
    window.history.replaceState({}, "", "/agents/computers");
    render(<App />);

    const trigger = await screen.findByRole("button", { name: "Remove Ada's Mac" });
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("alertdialog", { name: "Remove Ada's Mac?" });
    expect(within(dialog).getByText(/disconnects 1 Agent/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Computer" }));

    await waitFor(() => expect(screen.queryByText("Ada's Mac")).toBeNull());
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([path, init]) => path === `/api/v1/computers/${computerId}` && init?.method === "DELETE"),
    ).toBe(true);
  });

  it("keeps the Computer visible when unresolved Agent work blocks removal", async () => {
    installApi();
    const fixtureFetch = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input) === `/api/v1/computers/${computerId}` && init?.method === "DELETE"
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: "COMPUTER_REMOVAL_BLOCKED",
                  category: "deterministic",
                  message: "Computer removal is blocked",
                },
              }),
              { status: 409 },
            ),
          )
        : (fixtureFetch?.(input, init) ?? Promise.reject(new Error("The fixture fetch implementation is missing"))),
    );
    window.history.replaceState({}, "", "/agents/computers");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove Ada's Mac" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove Ada's Mac?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Computer" }));

    expect(
      await within(dialog).findByText("This Computer is still finishing Agent work. Try again after it completes."),
    ).toBeTruthy();
    expect(screen.getByText("Ada's Mac")).toBeTruthy();
  });

  it("does not resume a stored creation intent onto a Computer the reader moved away from", async () => {
    // The reader's own selection is the divergence: the intent names a machine that cannot run an
    // Agent, so nothing is sent, the reader picks another — and then the abandoned machine comes
    // back. "Is that route ready anywhere" is true again at that moment, and it is the wrong
    // question, because the reader is looking at a different Computer.
    let abandonedIsReady = false;
    storeCreationIntent({
      creationIntentId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e77",
      request: { name: "abandoned-agent", displayName: "Abandoned Agent", runtimeProvider: "codex", computerId },
    });
    installApi({
      computers: () => [
        {
          ...(twoReadyComputers[0] as Record<string, unknown>),
          connectionStatus: abandonedIsReady ? "online" : "offline",
        },
        twoReadyComputers[1] as Record<string, unknown>,
      ],
    });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);

    expect(await screen.findByText("Ada's Mac")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(agentCreationPosts()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Change Computer" }));
    fireEvent.click(screen.getByRole("button", { name: /Zulu Tower/ }));
    expect(screen.getByText("Zulu Tower")).toBeTruthy();

    abandonedIsReady = true;
    fireEvent(window, new Event("focus"));
    // Wait for the refetch to actually land, so the assertion below is about the gate and not about
    // a Computer list that never changed. The picker is where the machine's own state is legible.
    fireEvent.click(screen.getByRole("button", { name: "Change Computer" }));
    await waitFor(() => {
      const option = screen.getByRole("button", { name: /Ada's Mac/ });
      expect(option.textContent).toContain("Online");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(agentCreationPosts()).toHaveLength(0);
    const selectedComputer = screen.getByRole("button", { name: /Zulu Tower/ });
    expect(selectedComputer.getAttribute("aria-pressed")).toBe("true");
    expect(selectedComputer.className).toContain("data-[selected=true]:!bg-(--brand-soft)");
  });

  it("does not resume a stored creation intent onto a Runtime the form is not offering", async () => {
    storeCreationIntent({
      creationIntentId: "0a2f7d19-8b44-4d2e-8c31-5f6a7b8c9d01",
      request: { name: "claude-agent", displayName: "Claude Agent", runtimeProvider: "claude-code", computerId },
    });
    // The Computer matches; only the Runtime makes this a different route from the one on screen.
    installApi({ computerProviderReadiness: [{ provider: "codex", status: "ready", observedAt: null }] });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);

    expect(await screen.findByText("Ada's Mac")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(agentCreationPosts()).toHaveLength(0);
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Claude Agent");
  });

  it("resumes a stored creation intent that names the selected route", async () => {
    // The control: the gate has to refuse an unselected route without disabling resume, which is
    // the whole reason a creation intent is persisted.
    const record = storeCreationIntent({
      creationIntentId: "4d3c2b1a-9e8f-4a7b-8c6d-5e4f3a2b1c00",
      request: { name: "resumed-agent", displayName: "Resumed Agent", runtimeProvider: "codex", computerId },
    });
    installApi();
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);

    await waitFor(() => expect(agentCreationPosts()).toHaveLength(1));
    expect(JSON.parse(String(agentCreationPosts()[0]?.[1]?.body))).toMatchObject({
      computerId,
      creationIntentId: record.creationIntentId,
      runtimeProvider: "codex",
    });
  });

  it("refreshes and selects a newly connected Computer in New Agent", async () => {
    const connectedComputerId = "95fe9af3-d1c6-472b-b78c-8a7ccf512750";
    const existingComputer = {
      id: computerId,
      displayName: "Ada's Mac",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "0.0.1",
      connectionStatus: "online",
      providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" }],
      connectedAt: "2026-08-20T00:00:00.000Z",
      lastSeenAt: "2026-08-20T00:00:01.000Z",
    };
    const connectedComputer = {
      ...existingComputer,
      id: connectedComputerId,
      displayName: "Ada's Linux Computer",
      platform: "linux",
      connectedAt: "2026-08-20T00:00:02.000Z",
    };
    let finishRefresh: (() => void) | undefined;
    const refreshPending = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    installApi({
      computers: async (connected) => {
        if (connected) await refreshPending;
        return connected ? [existingComputer, connectedComputer] : [existingComputer];
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    fireEvent.change(within(dialog).getByLabelText("Display name"), {
      target: { value: "Research Assistant" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit Agent name" }));
    fireEvent.change(within(dialog).getByLabelText("Agent name"), {
      target: { value: "research-assistant" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Change Computer" }));
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T00:00:00.000Z");
    try {
      const connectAnother = within(dialog).getByRole("button", { name: "Connect another Computer" });
      connectAnother.focus();
      fireEvent.click(connectAnother);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(dialog.contains(document.activeElement)).toBe(true);
      await act(async () => {
        finishRefresh?.();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(within(dialog).getByText("Ada's Linux Computer")).toBeTruthy();
      expect(within(dialog).getByText("Codex")).toBeTruthy();
      expect((within(dialog).getByLabelText("Display name") as HTMLInputElement).value).toBe("Research Assistant");
      expect((within(dialog).getByLabelText("Agent name") as HTMLInputElement).value).toBe("research-assistant");
      expect(within(dialog).queryByRole("heading", { name: "Connect another Computer" })).toBeNull();
      expect(within(dialog).getByRole("button", { name: "Change Computer" })).toBe(document.activeElement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a connection attempt visible when a Computer refresh fails", async () => {
    const connectedComputer = {
      id: "95fe9af3-d1c6-472b-b78c-8a7ccf512750",
      displayName: "Ada's Linux Computer",
      platform: "linux",
      arch: "arm64",
      clientVersion: "0.0.1",
      connectionStatus: "online",
      providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:02.000Z" }],
      connectedAt: "2026-08-20T00:00:02.000Z",
      lastSeenAt: "2026-08-20T00:00:02.000Z",
    };
    installApi({
      computers: (connected) => (connected ? [connectedComputer] : []),
      computerReadStatus: (connected) => (connected ? 404 : undefined),
    });
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "New Agent" });
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T00:00:00.000Z");
    try {
      fireEvent.click(trigger);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const dialog = screen.getByRole("dialog", { name: "New Agent" });

      expect(within(dialog).getByRole("alert").textContent).toContain("Request failed");
      const refreshStatus = within(dialog).getByRole("status");
      expect(refreshStatus.textContent).toContain("Waiting for the Computer to connect");
      expect(dialog.contains(document.activeElement)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("completes an existing Computer reconnection in New Agent", async () => {
    const disconnectedAt = "2026-08-20T00:00:00.000Z";
    const reconnectedAt = "2026-08-20T00:00:02.000Z";
    const existingComputer = {
      id: computerId,
      displayName: "Ada's Mac",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "0.0.1",
      connectionStatus: "online",
      providerReadiness: [{ provider: "codex", status: "ready", observedAt: disconnectedAt }],
      connectedAt: disconnectedAt,
      lastSeenAt: "2026-08-20T00:00:01.000Z",
    };
    installApi({
      computers: (connected) =>
        connected ? [{ ...existingComputer, connectedAt: reconnectedAt }] : [existingComputer],
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    fireEvent.change(within(dialog).getByLabelText("Display name"), {
      target: { value: "Research Assistant" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit Agent name" }));
    fireEvent.change(within(dialog).getByLabelText("Agent name"), {
      target: { value: "research-assistant" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Change Computer" }));
    vi.useFakeTimers();
    vi.setSystemTime(disconnectedAt);
    try {
      const connectAnother = within(dialog).getByRole("button", { name: "Connect another Computer" });
      connectAnother.focus();
      fireEvent.click(connectAnother);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(within(dialog).getByText("Ada's Mac")).toBeTruthy();
      expect(within(dialog).getByText("Codex")).toBeTruthy();
      expect((within(dialog).getByLabelText("Display name") as HTMLInputElement).value).toBe("Research Assistant");
      expect((within(dialog).getByLabelText("Agent name") as HTMLInputElement).value).toBe("research-assistant");
      expect(within(dialog).queryByRole("heading", { name: "Connect another Computer" })).toBeNull();
      expect(within(dialog).getByRole("button", { name: "Change Computer" })).toBe(document.activeElement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Computer connection inside the New Agent dialog when no runtime is available", async () => {
    const connectedComputer = {
      id: computerId,
      displayName: "Ada's Mac",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "0.0.1",
      connectionStatus: "online",
      providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:02.000Z" }],
      connectedAt: "2026-08-20T00:00:02.000Z",
      lastSeenAt: "2026-08-20T00:00:02.000Z",
    };
    let finishRefresh: (() => void) | undefined;
    const refreshPending = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    installApi({
      computers: async (connected) => {
        if (connected) await refreshPending;
        return connected ? [connectedComputer] : [];
      },
    });
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "New Agent" });
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T00:00:00.000Z");
    try {
      fireEvent.click(trigger);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const dialog = screen.getByRole("dialog", { name: "New Agent" });
      expect(within(dialog).getByRole("heading", { name: "Connect a Computer" })).toBeTruthy();
      expect(within(dialog).queryByRole("link", { name: "Agent runtime" })).toBeNull();
      expect(dialog.contains(document.activeElement)).toBe(true);
      await act(async () => {
        finishRefresh?.();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(within(dialog).getByText("Ada's Mac")).toBeTruthy();
      expect(within(dialog).getByText("Codex")).toBeTruthy();
      expect(within(dialog).getByRole("button", { name: "Change Computer" })).toBe(document.activeElement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates an Agent from the dialog without a second creation screen", async () => {
    installApi();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });

    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Assistant" } });
    expect(within(dialog).queryByLabelText("Agent name")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Agent" }));

    expect(await within(dialog).findByRole("heading", { name: "Connect messaging" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Set up later" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agentId}`));
    const createCall = vi
      .mocked(fetch)
      .mock.calls.find(([input, init]) => String(input) === "/api/v1/agents" && init?.method === "POST");
    expect(createCall).toBeTruthy();
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      creationIntentId: expect.any(String),
      name: "research-assistant",
      displayName: "Research Assistant",
      runtimeProvider: "codex",
      computerId,
    });
  });

  it("blocks duplicate Agent submissions synchronously and repairs focus while creation is pending", async () => {
    let resolveCreate: () => void = () => undefined;
    const pendingCreate = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });
    installApi({ agentCreate: () => pendingCreate });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Assistant" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit Agent name" }));
    fireEvent.change(within(dialog).getByLabelText("Agent name"), { target: { value: "research-assistant" } });
    const form = within(dialog).getByRole("button", { name: "Create Agent" }).closest("form");
    const submitButton = within(dialog).getByRole("button", { name: "Create Agent" });
    submitButton.focus();

    if (!form) throw new Error("Expected the New Agent form");
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(([input, init]) => String(input) === "/api/v1/agents" && init?.method === "POST"),
      ).toHaveLength(1),
    );
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect((within(dialog).getByLabelText("Display name") as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText("Agent name") as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).getByRole("status").textContent).toContain("Ready to run");
    expect(within(dialog).getByRole("button", { name: "Creating…" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Close new Agent dialog" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "New Agent" })).toBe(dialog);

    resolveCreate();
    expect(await within(dialog).findByRole("heading", { name: "Connect messaging" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Set up later" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agentId}`));
  });

  it("reuses one creation intent when an unchanged Agent request is retried", async () => {
    const attempts: Record<string, unknown>[] = [];
    installApi({
      agentCreate: (input) => {
        attempts.push(input);
        if (attempts.length === 1) throw new Error("Connection lost after creation");
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Assistant" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit Agent name" }));
    fireEvent.change(within(dialog).getByLabelText("Agent name"), { target: { value: "research-assistant" } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Create Agent" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Connection lost after creation");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Agent" }));

    expect(await within(dialog).findByRole("heading", { name: "Connect messaging" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Set up later" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agentId}`));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.creationIntentId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(attempts[1]?.creationIntentId).toBe(attempts[0]?.creationIntentId);
  });

  it("creates a Computer connection command when New Agent has no Computer", async () => {
    installApi({ computers: [] });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Connect a Computer" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents/new");
    expect(await screen.findByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([path, init]) => path === "/api/v1/computer-connect-codes" && init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("guides Agent creation to Computer setup when none is connected", async () => {
    installApi({ computers: [] });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Connect a Computer" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Copy command" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Agent runtime" })).toBeNull();
  });

  it("validates Agent name locally with an accessible field error before sending a request", async () => {
    installApi();
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    await screen.findByLabelText("Display name");
    fireEvent.click(screen.getByRole("button", { name: "Edit Agent name" }));
    const name = screen.getByLabelText("Agent name");
    fireEvent.change(name, { target: { value: "Bestony" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Bestony" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Agent name must start with a lowercase letter or number and contain only lowercase letters, numbers, and hyphens",
    );
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input, init]) => String(input) === "/api/v1/agents" && init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("asks for an explicit Agent name when the display name cannot produce an ASCII name", async () => {
    installApi();
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "研究助手" } });
    expect(screen.getByRole("button", { name: "Edit Agent name" }).textContent).toBe("Set Agent name");
    expect(screen.queryByLabelText("Agent name")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    const alert = await screen.findByRole("alert");
    const name = screen.getByLabelText("Agent name");
    expect(alert.textContent).toBe("Agent name is required");
    await waitFor(() => expect(name).toBe(document.activeElement));
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input, init]) => String(input) === "/api/v1/agents" && init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("creates an Agent with a valid canonical name and keeps the existing payload", async () => {
    installApi();
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "Bestony" } });
    expect(screen.queryByLabelText("Agent name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    expect(await screen.findByRole("heading", { name: "Connect messaging" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up later" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agentId}`));
    const createCall = vi
      .mocked(fetch)
      .mock.calls.find(([input, init]) => String(input) === "/api/v1/agents" && init?.method === "POST");
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      creationIntentId: expect.any(String),
      name: "bestony",
      displayName: "Bestony",
      runtimeProvider: "codex",
      computerId,
    });
  });

  it("maps a Server name issue back to the Agent name field", async () => {
    installApi({ agentCreateError: "name" });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "Bestony" } });
    expect(screen.queryByLabelText("Agent name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    const alert = await screen.findByRole("alert");
    const name = screen.getByLabelText("Agent name");
    expect(alert.textContent).toBe("Use a lowercase Agent name");
    expect(name.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    await waitFor(() => expect(name).toBe(document.activeElement));
    expect(window.location.pathname).toBe("/agents/new");
  });

  it("reveals the Agent name editor when the Server reports a Workspace name conflict", async () => {
    installApi({ agentCreateError: "conflict" });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "Bestony" } });
    expect(screen.queryByLabelText("Agent name")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    const alert = await screen.findByRole("alert");
    const name = screen.getByLabelText("Agent name");
    expect(alert.textContent).toBe("An active Agent with this name already exists in the Workspace");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(name).toBe(document.activeElement));
  });

  it("keeps an unmapped Server validation error at form level", async () => {
    installApi({ agentCreateError: "generic" });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "Bestony" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The request payload is invalid");
    expect(screen.queryByLabelText("Agent name")).toBeNull();
  });

  it("uses only a confirmed ready Computer and Provider route", async () => {
    installApi({
      computers: [
        {
          id: computerId,
          displayName: "Ada's Mac",
          platform: "darwin",
          arch: "arm64",
          clientVersion: "0.0.1",
          connectionStatus: "online",
          providerReadiness: [
            { provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" },
            { provider: "claude-code", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" },
          ],
          connectedAt: "2026-08-20T00:00:00.000Z",
          lastSeenAt: "2026-08-20T00:00:00.000Z",
        },
      ],
    });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    expect(await screen.findByText("Ada's Mac")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change Runtime" }));
    // jsdom 30 drops inter-element whitespace from accessible names; \s? tolerates both engines.
    const claudeCode = screen.getByRole("button", { name: /Claude Code\s?Sign-in required/ });
    expect(claudeCode.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Create Agent" }).hasAttribute("disabled")).toBe(false);
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Codex Reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() => {
      const request = vi
        .mocked(fetch)
        .mock.calls.find(([path, init]) => path === "/api/v1/agents" && init?.method === "POST");
      expect(JSON.parse(String(request?.[1]?.body))).toEqual({
        creationIntentId: expect.any(String),
        name: "codex-reviewer",
        displayName: "Codex Reviewer",
        runtimeProvider: "codex",
        computerId,
      });
    });
  });

  it("revalidates ready routes and disables creation when readiness becomes unavailable", async () => {
    const claudeReadiness: {
      observedAt: string;
      provider: "claude-code";
      status: "ready" | "unavailable";
    } = {
      provider: "claude-code",
      status: "unavailable",
      observedAt: "2026-08-20T00:00:00.000Z",
    };
    let computerReadStatus: number | undefined;
    installApi({
      computers: [
        {
          id: computerId,
          displayName: "Ada's Mac",
          platform: "darwin",
          arch: "arm64",
          clientVersion: "0.0.1",
          connectionStatus: "online",
          providerReadiness: [
            { provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" },
            claudeReadiness,
          ],
          connectedAt: "2026-08-20T00:00:00.000Z",
          lastSeenAt: "2026-08-20T00:00:00.000Z",
        },
      ],
      computerReadStatus: () => computerReadStatus,
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    await within(dialog).findByText("Ada's Mac");
    expect(within(dialog).getByText("Codex")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Change Runtime" }));
    expect(
      within(dialog)
        .getByRole("button", { name: /Claude Code\s?Unavailable/ })
        .hasAttribute("disabled"),
    ).toBe(true);

    claudeReadiness.status = "ready";
    window.dispatchEvent(new Event("focus"));
    fireEvent.click(await within(dialog).findByRole("button", { name: /Claude Code\s?Ready/ }));
    expect(await within(dialog).findByText("Claude Code")).toBeTruthy();

    claudeReadiness.status = "unavailable";
    window.dispatchEvent(new Event("focus"));
    expect(await within(dialog).findByText("Codex")).toBeTruthy();

    computerReadStatus = 503;
    window.dispatchEvent(new Event("focus"));
    expect(await within(dialog).findByText("Readiness unconfirmed")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Create Agent" }).hasAttribute("disabled")).toBe(true);
  });

  it("reports a failed Check again instead of announcing a Computer update", async () => {
    let computerReadStatus: number | undefined;
    installApi({
      computerProviderReadiness: [{ provider: "codex", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" }],
      computerReadStatus: () => computerReadStatus,
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    expect(await within(dialog).findByText("Sign in to Codex")).toBeTruthy();

    // The Account asked a question by pressing the button. A 503 is the answer "I could not check",
    // and the cached Computer is not a substitute for it.
    computerReadStatus = 503;
    fireEvent.click(within(dialog).getByRole("button", { name: "Check again" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("Request failed");
    // Not the degraded state a background re-read would have left: that reads as an answer about
    // the Computer, when what happened is that the check did not complete.
    expect(within(dialog).queryByText("Readiness unconfirmed")).toBeNull();
    expect(within(dialog).queryByText("Computer connection updated")).toBeNull();
  });

  it("keeps a background Computer refresh failure on the retained Computers", async () => {
    let computerReadStatus: number | undefined;
    installApi({
      computerProviderReadiness: [{ provider: "codex", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" }],
      computerReadStatus: () => computerReadStatus,
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    expect(await within(dialog).findByText("Sign in to Codex")).toBeTruthy();

    // The control: revalidation nobody asked for still degrades rather than replacing the dialog.
    computerReadStatus = 503;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await within(dialog).findByText("Readiness unconfirmed")).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("removes a retained creation route after a terminal Computer refresh error", async () => {
    let computerReadStatus: number | undefined;
    installApi({ computerReadStatus: () => computerReadStatus });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    expect(await within(dialog).findByText("Ready to run")).toBeTruthy();

    computerReadStatus = 404;
    window.dispatchEvent(new Event("focus"));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("Request failed");
    expect(within(dialog).queryByRole("button", { name: "Create Agent" })).toBeNull();
  });
});
