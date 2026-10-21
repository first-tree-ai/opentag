import { type RefObject, useLayoutEffect, useRef } from "react";

export function useSoulEditorHeight(
  value: string,
  element: HTMLElement | null,
  footerRef: RefObject<HTMLDivElement | null>,
) {
  const sizing = useRef({
    width: 0,
    height: 0,
    footerHeight: 0,
    viewportHeight: 0,
    manualHeight: undefined as number | undefined,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: Text changes require remeasuring DOM scrollHeight after React commits.
  useLayoutEffect(() => {
    if (!element) return;
    const editor = element;
    const state = sizing.current;
    state.viewportHeight ||= window.innerHeight;
    let observedFooter = footerRef.current;
    const main = editor.closest("main");

    function measureLayout() {
      const width = editor.getBoundingClientRect().width;
      const widthChanged = width !== state.width;
      if (widthChanged) {
        state.footerHeight = 0;
      }
      state.width = width;
      // Keep the layout stable when a mobile keyboard reduces the viewport during editing.
      const keyboardMayBeOpen = window.matchMedia("(pointer: coarse)").matches && document.activeElement === editor;
      if (!keyboardMayBeOpen || widthChanged) state.viewportHeight = window.innerHeight;
      // Reserve the measured action area after it closes so successful updates do not enlarge the editor.
      state.footerHeight = Math.max(state.footerHeight, footerRef.current?.getBoundingClientRect().height ?? 0);
    }

    function resizeEditor() {
      const scrollTop = editor.scrollTop;
      measureLayout();
      const { minimum, rowMaximum, borders } = editorHeights(editor);
      const maximum = Math.max(minimum, Math.min(rowMaximum, availableHeight()));
      editor.style.minHeight = `${minimum}px`;
      editor.style.height = "auto";
      const contentHeight = editor.scrollHeight + borders;
      const height = state.manualHeight ?? Math.min(maximum, contentHeight);
      editor.style.height = `${Math.max(minimum, height)}px`;
      // Intrinsic-height measurement temporarily expands the document and clears its scroll offset.
      editor.scrollTop = scrollTop;
      editor.style.overflowY = contentHeight > editor.getBoundingClientRect().height ? "auto" : "hidden";
      state.height = editor.getBoundingClientRect().height;
    }

    function availableHeight() {
      const top = editor.getBoundingClientRect().top + (main?.scrollTop ?? window.scrollY);
      const bottomInset = main ? Math.max(0, window.innerHeight - main.getBoundingClientRect().bottom) : 0;
      const bottomGap = main ? Number.parseFloat(getComputedStyle(main).paddingBottom) || 32 : 32;
      return state.viewportHeight - bottomInset - top - state.footerHeight - 16 - bottomGap;
    }

    function updateFooterObservation(observer: ResizeObserver) {
      // The action area can attach after this sibling's layout effect.
      const footer = footerRef.current;
      if (footer === observedFooter) return false;
      if (observedFooter) observer.unobserve(observedFooter);
      if (footer) observer.observe(footer);
      observedFooter = footer;
      return true;
    }

    function applyObservedChanges(changes: ResizeObserverEntry[]) {
      if (updateFooterObservation(observer)) {
        resizeEditor();
        return;
      }
      const rect = editor.getBoundingClientRect();
      if (rect.width !== state.width) {
        resizeEditor();
        return;
      }
      if (Math.abs(rect.height - state.height) > 1) {
        state.manualHeight = rect.height;
        state.height = rect.height;
        editor.style.overflowY = "auto";
      }
      if (changes.some((entry) => entry.target === observedFooter)) resizeEditor();
    }

    let resizeFrame = 0;
    let pendingEntries: ResizeObserverEntry[] = [];
    resizeEditor();
    const observer = new ResizeObserver((entries) => {
      pendingEntries.push(...entries);
      if (resizeFrame) return;
      // Finish observer delivery before changing overflow or resizing observed regions.
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        const changes = pendingEntries;
        pendingEntries = [];
        applyObservedChanges(changes);
      });
    });
    observer.observe(editor);
    if (observedFooter) observer.observe(observedFooter);
    window.addEventListener("resize", resizeEditor);
    document.fonts?.addEventListener("loadingdone", resizeEditor);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      window.removeEventListener("resize", resizeEditor);
      document.fonts?.removeEventListener("loadingdone", resizeEditor);
    };
  }, [value, element, footerRef]);
}

function editorHeights(editor: HTMLElement) {
  const style = getComputedStyle(editor);
  const lineHeight = pixels(style.lineHeight, pixels(style.fontSize, 14) * 1.625);
  const borders = pixels(style.borderTopWidth) + pixels(style.borderBottomWidth);
  const padding = pixels(style.paddingTop) + pixels(style.paddingBottom);
  return {
    minimum: 12 * lineHeight + padding + borders,
    rowMaximum: 24 * lineHeight + padding + borders,
    borders,
  };
}

function pixels(value: string, fallback = 0) {
  return Number.parseFloat(value) || fallback;
}
