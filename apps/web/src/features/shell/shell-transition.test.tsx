/**
 * The content-track transition: which element takes focus after a route change, how a remembered
 * visit is restored once its page has rendered, and immediate page changes without visual overlap.
 * A minimal route tree stands in for the application's so each page can shape its own DOM.
 */

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { type ReactElement, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellMain } from "./shell-main.js";
import { ShellMemoryProvider } from "./shell-memory.js";
import { useShellTransition } from "./shell-transition.js";

function Layout() {
  // As the application shell does: the pathname follows the committed matches, not the pending URL.
  const pathname = useRouterState({ select: (state) => state.resolvedLocation?.pathname ?? state.location.pathname });
  return (
    <ShellMemoryProvider>
      <ShellMain pathname={pathname}>
        <Outlet />
      </ShellMain>
    </ShellMemoryProvider>
  );
}

/** The hook without a mounted track: nothing to capture or restore. */
function BareLayout() {
  const pathname = useRouterState({ select: (state) => state.resolvedLocation?.pathname ?? state.location.pathname });
  useShellTransition({ main: useRef(null), pathname });
  return <Outlet />;
}

function HomePage() {
  return (
    <>
      <h1>Home</h1>
      <Link to={"/agents/a1" as never}>Agent</Link>
      <Link to={"/" as never}>Home</Link>
      <Link to={"/late" as never}>Late</Link>
      <Link to={"/other" as never}>Other</Link>
    </>
  );
}

function AgentPage() {
  return (
    <>
      <h1>Agent</h1>
      <Link to={"/" as never}>Back home</Link>
    </>
  );
}

/** Its link appears only on request, like a list that fills in after its data arrives. */
function LatePage() {
  const [revealed, setRevealed] = useState(false);
  return (
    <>
      <h1>Late</h1>
      <button onClick={() => setRevealed(true)} type="button">
        Reveal
      </button>
      {revealed ? <Link to={"/" as never}>Late link</Link> : null}
    </>
  );
}

function OtherPage() {
  return <p>No heading here</p>;
}

async function renderShell(
  root: () => ReactElement = Layout,
  path = "/",
  options: { beforeAgentLoad?: () => Promise<void> } = {},
) {
  const rootRoute = createRootRoute({ component: root });
  const routeTree = rootRoute.addChildren([
    createRoute({ component: HomePage, getParentRoute: () => rootRoute, path: "/" }),
    createRoute({
      ...(options.beforeAgentLoad ? { beforeLoad: options.beforeAgentLoad } : {}),
      component: AgentPage,
      getParentRoute: () => rootRoute,
      path: "/agents/$agentId",
    }),
    createRoute({ component: LatePage, getParentRoute: () => rootRoute, path: "/late" }),
    createRoute({ component: OtherPage, getParentRoute: () => rootRoute, path: "/other" }),
  ]);
  const router = createRouter({ history: createMemoryHistory({ initialEntries: [path] }), routeTree });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<RouterProvider router={router as never} />);
  });
  return { router, view };
}

async function navigate(router: Awaited<ReturnType<typeof renderShell>>["router"], to: string): Promise<void> {
  await act(async () => {
    await router.navigate({ to: to as never });
  });
  await act(async () => undefined);
}

async function flush(): Promise<void> {
  await act(async () => undefined);
}

function pressTab(): void {
  fireEvent.keyDown(document, { key: "Tab" });
}

function content(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-ui="content"]');
  if (!node) throw new Error("Missing content track");
  return node;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useShellTransition focus restoration", () => {
  it("moves keyboard focus to the new heading, then back to the link that led away", async () => {
    const { router } = await renderShell();
    pressTab();
    const agentLink = screen.getByRole("link", { name: "Agent" });
    agentLink.focus();
    expect(document.activeElement).toBe(agentLink);

    fireEvent.click(agentLink);
    const heading = await screen.findByRole("heading", { name: "Agent" });
    await flush();

    // A page without a remembered visit lands on its heading, made focusable for the occasion.
    expect(heading.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(heading);

    await navigate(router, "/");
    const restored = await screen.findByRole("link", { name: "Agent" });
    await flush();

    // Coming back restores the link the reader left through, without touching its tab order.
    expect(document.activeElement).toBe(restored);
    expect(restored.hasAttribute("tabindex")).toBe(false);
  });

  it("leaves focus alone after pointer navigation and ignores unrelated keys", async () => {
    const { router } = await renderShell();
    pressTab();
    fireEvent.pointerDown(document);
    fireEvent.keyDown(document, { key: "a" });

    await navigate(router, "/agents/a1");
    const heading = await screen.findByRole("heading", { name: "Agent" });

    expect(heading.hasAttribute("tabindex")).toBe(false);
    expect(document.activeElement).toBe(document.body);
    expect(content().scrollTop).toBe(0);
  });

  it("waits for a remembered link to render before focusing it", async () => {
    const { router } = await renderShell();
    pressTab();
    await navigate(router, "/late");
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    const lateLink = screen.getByRole("link", { name: "Late link" });
    lateLink.focus();
    fireEvent.click(lateLink);
    await screen.findByRole("heading", { name: "Home" });

    await navigate(router, "/late");
    await screen.findByRole("heading", { name: "Late" });
    await flush();
    // The remembered link is not on the page yet, so nothing is focused prematurely.
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: "Late" }));

    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await flush();

    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Late link" }));
  });

  it("restores focus when a pending route is canceled by returning to the current path", async () => {
    let releaseAgentLoad!: () => void;
    const beforeAgentLoad = new Promise<void>((resolve) => {
      releaseAgentLoad = resolve;
    });
    const { router } = await renderShell(Layout, "/", { beforeAgentLoad: () => beforeAgentLoad });
    pressTab();
    const agentLink = screen.getByRole("link", { name: "Agent" });
    agentLink.focus();

    const pendingNavigation = router.navigate({ to: "/agents/$agentId" as never, params: { agentId: "a1" } as never });
    await flush();

    const homeLink = screen.getByRole("link", { name: "Home" });
    homeLink.focus();
    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.click(homeLink);
    await flush();

    expect(document.activeElement).toBe(agentLink);
    releaseAgentLoad();
    await pendingNavigation.catch(() => undefined);
  });

  it("gives up on a remembered link after the grace period and focuses the heading instead", async () => {
    const { router } = await renderShell();
    pressTab();
    await navigate(router, "/late");
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    const lateLink = screen.getByRole("link", { name: "Late link" });
    lateLink.focus();
    fireEvent.click(lateLink);
    await screen.findByRole("heading", { name: "Home" });

    await navigate(router, "/late");
    const heading = await screen.findByRole("heading", { name: "Late" });
    await flush();
    expect(document.activeElement).not.toBe(heading);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_600));
    });

    expect(heading.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(heading);
  }, 10_000);

  it("stops waiting for a remembered link once the reader moves on again", async () => {
    const { router } = await renderShell();
    pressTab();
    await navigate(router, "/late");
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    const lateLink = screen.getByRole("link", { name: "Late link" });
    lateLink.focus();
    fireEvent.click(lateLink);
    await screen.findByRole("heading", { name: "Home" });

    await navigate(router, "/late");
    await screen.findByRole("heading", { name: "Late" });
    await navigate(router, "/other");
    await screen.findByText("No heading here");
    await flush();

    // A page with neither the remembered link nor a heading has nothing to focus.
    expect(document.activeElement).toBe(document.body);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_600));
    });
    expect(document.activeElement).toBe(document.body);
  }, 10_000);

  it("does nothing without a mounted content track", async () => {
    const { router } = await renderShell(BareLayout);

    await navigate(router, "/agents/a1");

    expect(await screen.findByRole("heading", { name: "Agent" })).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("useShellTransition navigation", () => {
  it.each([false, true])("switches pages without fades or snapshots (reduced motion: %s)", async (reduced) => {
    const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }));
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) => ({ matches: reduced, media: query }) as MediaQueryList,
    );
    try {
      const { router } = await renderShell();
      content().scrollTop = 240;

      await navigate(router, "/agents/a1");
      expect(screen.getByRole("heading", { name: "Agent" })).toBeTruthy();
      expect(document.querySelector("main")?.parentElement?.textContent).not.toContain("Home");
      expect(content().scrollTop).toBe(0);

      await navigate(router, "/");
      expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
      expect(content().scrollTop).toBe(240);

      await navigate(router, "/other");
      expect(screen.getByText("No heading here")).toBeTruthy();
      expect(document.querySelector("main")?.parentElement?.textContent).not.toContain("Home");
      expect(content().scrollTop).toBe(0);
      expect(animate).not.toHaveBeenCalled();
    } finally {
      // @ts-expect-error jsdom has no Web Animations API; remove the test stub.
      delete Element.prototype.animate;
    }
  });
});
