/**
 * The content-track transition: which element takes focus after a route change, how a remembered
 * visit is restored once its page has rendered, and how the outgoing snapshot is animated away.
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

function scopeFor(pathname: string): "agent" | "workspace" {
  return pathname.startsWith("/agents/") ? "agent" : "workspace";
}

function Layout() {
  // As the application shell does: the pathname follows the committed matches, not the pending URL.
  const pathname = useRouterState({ select: (state) => state.resolvedLocation?.pathname ?? state.location.pathname });
  return (
    <ShellMemoryProvider>
      <ShellMain pathname={pathname} scope={scopeFor(pathname)}>
        <Outlet />
      </ShellMain>
    </ShellMemoryProvider>
  );
}

/** The hook without a mounted track: nothing to capture, restore, or animate. */
function BareLayout() {
  const pathname = useRouterState({ select: (state) => state.resolvedLocation?.pathname ?? state.location.pathname });
  useShellTransition({ main: useRef(null), outgoing: useRef(null), pathname, scope: scopeFor(pathname) });
  return <Outlet />;
}

function HomePage() {
  return (
    <>
      <h1>Home</h1>
      <Link to={"/agents/a1" as never}>Agent</Link>
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

async function renderShell(root: () => ReactElement = Layout, path = "/") {
  const rootRoute = createRootRoute({ component: root });
  const routeTree = rootRoute.addChildren([
    createRoute({ component: HomePage, getParentRoute: () => rootRoute, path: "/" }),
    createRoute({ component: AgentPage, getParentRoute: () => rootRoute, path: "/agents/$agentId" }),
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

function outgoing(): HTMLElement {
  const node = document.querySelector<HTMLElement>('main[data-ui="content"] + div');
  if (!node) throw new Error("Missing outgoing snapshot host");
  return node;
}

interface FakeAnimation {
  cancel: ReturnType<typeof vi.fn>;
  onfinish: (() => void) | null;
}

function installAnimate() {
  const animations: FakeAnimation[] = [];
  const animate = vi.fn<(keyframes: Keyframe[], options?: KeyframeAnimationOptions) => Animation>(() => {
    const animation: FakeAnimation = { cancel: vi.fn(), onfinish: null };
    animations.push(animation);
    return animation as unknown as Animation;
  });
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
  return {
    animate,
    animations,
    restore: () => {
      // @ts-expect-error jsdom has no Web Animations API; the polyfill above is the only definition.
      delete Element.prototype.animate;
    },
  };
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

describe("useShellTransition animation", () => {
  it("fades the incoming frame and the outgoing snapshot, with cross-scope timing", async () => {
    const { animate, animations, restore } = installAnimate();
    try {
      const { router, view } = await renderShell();
      const homeHeading = screen.getByRole("heading", { name: "Home" });
      expect(homeHeading.closest('[data-ui="content-page-frame"]')).toBeTruthy();

      await navigate(router, "/agents/a1");
      await screen.findByRole("heading", { name: "Agent" });

      // The outgoing page is a short-lived clone that keeps no IDs or test landmarks.
      const snapshot = outgoing().firstElementChild as HTMLElement | null;
      expect(snapshot).not.toBeNull();
      expect(snapshot?.textContent).toContain("Home");
      expect(snapshot?.hasAttribute("data-ui")).toBe(false);
      expect(snapshot?.querySelector("[data-ui], [id]")).toBeNull();
      expect(snapshot?.style.overflow).toBe("hidden");

      expect(animate).toHaveBeenCalledTimes(2);
      expect(animate.mock.calls[0]?.[1]).toEqual({
        duration: 150,
        delay: 90,
        fill: "backwards",
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      });
      expect(animate.mock.calls[1]?.[1]).toEqual({ duration: 80, fill: "forwards" });
      const exit = animations[1];
      expect(exit?.onfinish).toEqual(expect.any(Function));
      exit?.onfinish?.();
      expect(outgoing().childElementCount).toBe(0);

      await navigate(router, "/");
      await screen.findByRole("heading", { name: "Home" });
      // Leaving the Agent scope: the earlier animations are cancelled before the next pair starts.
      expect(animations[0]?.cancel).toHaveBeenCalled();
      expect(animate.mock.calls[2]?.[1]).toMatchObject({ duration: 150, delay: 60 });

      await navigate(router, "/other");
      await screen.findByText("No heading here");
      // Same scope: shorter and immediate.
      expect(animate.mock.calls[4]?.[1]).toMatchObject({ duration: 120, delay: 0 });

      view.unmount();
      for (const animation of animations.slice(4)) expect(animation.cancel).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("skips the snapshot and shortens the fade under reduced motion", async () => {
    const { animate, restore } = installAnimate();
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query === "(prefers-reduced-motion: reduce)",
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
    try {
      const { router } = await renderShell();

      await navigate(router, "/agents/a1");
      await screen.findByRole("heading", { name: "Agent" });

      expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
      expect(outgoing().childElementCount).toBe(0);
      expect(animate).toHaveBeenCalledTimes(1);
      expect(animate.mock.calls[0]?.[1]).toEqual({ duration: 70 });
    } finally {
      restore();
    }
  });
});
