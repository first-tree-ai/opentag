import { useRouter } from "@tanstack/react-router";
import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { useShellMemory } from "./shell-memory.js";

export function useShellTransition({ main, pathname }: { main: RefObject<HTMLElement | null>; pathname: string }) {
  const router = useRouter();
  const memory = useShellMemory();
  const previous = useRef(pathname);
  const keyboard = useRef(false);
  const pendingNavigation = useRef<{ from: string } | undefined>(undefined);

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
        if (!node) return;
        if (!event.pathChanged) {
          const path = previous.current;
          if (keyboard.current && pendingNavigation.current?.from === path && event.toLocation.pathname === path) {
            restorePage(node, memory?.pages.get(path), true);
          }
          pendingNavigation.current = undefined;
          return;
        }
        const visit = captureVisit(node);
        pendingNavigation.current = { from: previous.current };
        memory?.pages.set(previous.current, visit);
      }),
    [router, main, memory],
  );

  useLayoutEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    pendingNavigation.current = undefined;
    const node = main.current;
    if (!node) return;
    return restorePage(node, memory?.pages.get(pathname), keyboard.current);
  }, [pathname, main, memory]);
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
