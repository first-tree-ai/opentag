import { useRouter } from "@tanstack/react-router";
import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { useShellMemory } from "./shell-memory.js";

type Scope = "agent" | "workspace";

export function useShellTransition({
  main,
  outgoing,
  pathname,
  scope,
}: {
  main: RefObject<HTMLElement | null>;
  outgoing: RefObject<HTMLDivElement | null>;
  pathname: string;
  scope: Scope;
}) {
  const router = useRouter();
  const memory = useShellMemory();
  const previous = useRef({ pathname, scope });
  const keyboard = useRef(false);
  const animations = useRef<Animation[]>([]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (["Tab", "Enter", " "].includes(event.key)) keyboard.current = true;
    };
    const onPointer = () => {
      keyboard.current = false;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, []);

  useEffect(
    () =>
      router.subscribe("onBeforeLoad", (event) => {
        const node = main.current;
        if (!node || !event.pathChanged) return;
        memory?.pages.set(previous.current.pathname, captureVisit(node));
        captureSnapshot(node, outgoing.current);
      }),
    [router, main, outgoing, memory],
  );

  useLayoutEffect(() => {
    if (previous.current.pathname === pathname) return;
    const crossScope = previous.current.scope !== scope;
    previous.current = { pathname, scope };
    for (const animation of animations.current) animation.cancel();
    animations.current = [];
    const node = main.current;
    if (!node) return;
    animations.current = animateContent(node, outgoing.current, crossScope, scope);
    return restorePage(node, memory?.pages.get(pathname), keyboard.current);
  }, [pathname, scope, main, outgoing, memory]);

  useEffect(
    () => () => {
      for (const animation of animations.current) animation.cancel();
    },
    [],
  );
}

function restorePage(
  node: HTMLElement,
  visit: { scrollTop: number; focusHref?: string } | undefined,
  keyboard: boolean,
) {
  node.scrollTop = visit?.scrollTop ?? 0;
  const restore = () => {
    const anchor = visit?.focusHref
      ? [...node.querySelectorAll<HTMLAnchorElement>("a[href]")].find(
          (link) => link.getAttribute("href") === visit.focusHref,
        )
      : undefined;
    if (visit?.focusHref && !anchor) return false;
    node.scrollTop = visit?.scrollTop ?? 0;
    const target = anchor ?? node.querySelector<HTMLElement>("h1");
    if (!target) return false;
    if (keyboard) {
      if (!anchor) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
    return true;
  };
  if (restore()) return;
  const observer = new MutationObserver(() => {
    if (restore()) {
      observer.disconnect();
      clearTimeout(timeout);
    }
  });
  observer.observe(node, { childList: true, subtree: true });
  const timeout = setTimeout(() => {
    observer.disconnect();
    if (keyboard) {
      const heading = node.querySelector<HTMLElement>("h1");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    }
  }, 1500);
  return () => {
    observer.disconnect();
    clearTimeout(timeout);
  };
}

function captureVisit(node: HTMLElement) {
  const active = document.activeElement;
  const focusHref =
    active instanceof HTMLAnchorElement && node.contains(active)
      ? (active.getAttribute("href") ?? undefined)
      : undefined;
  return { scrollTop: node.scrollTop, focusHref };
}

function captureSnapshot(node: HTMLElement, outgoing: HTMLDivElement | null) {
  if (!node.animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // A short-lived visual snapshot avoids mounting a second route and duplicating its queries.
  // Its parent is inert and hidden from assistive technology; no IDs or test landmarks survive.
  const clone = node.cloneNode(true) as HTMLElement;
  for (const element of [clone, ...clone.querySelectorAll("*")]) {
    element.removeAttribute("id");
    element.removeAttribute("data-ui");
  }
  clone.style.height = "100%";
  clone.style.overflow = "hidden";
  outgoing?.replaceChildren(clone);
  clone.scrollTop = node.scrollTop;
}

function animateContent(node: HTMLElement, outgoing: HTMLDivElement | null, crossScope: boolean, scope: Scope) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const frame = node.firstElementChild as HTMLElement | null;
  const animations: Animation[] = [];
  if (frame?.animate)
    animations.push(frame.animate([{ opacity: 0 }, { opacity: 1 }], contentTiming(reduced, crossScope, scope)));
  const snapshot = outgoing?.firstElementChild as HTMLElement | null;
  if (snapshot?.animate) {
    const exit = snapshot.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduced ? 0 : 80, fill: "forwards" });
    exit.onfinish = () => snapshot.remove();
    animations.push(exit);
  } else outgoing?.replaceChildren();
  return animations;
}

function contentTiming(reduced: boolean, crossScope: boolean, scope: Scope): KeyframeAnimationOptions {
  if (reduced) return { duration: 70 };
  return {
    duration: crossScope ? 150 : 120,
    delay: crossScope ? (scope === "agent" ? 90 : 60) : 0,
    fill: "backwards",
    easing: "cubic-bezier(0.2, 0, 0, 1)",
  };
}
