import { type RefObject, useLayoutEffect, useRef } from "react";

export function useSoulEditorHeight(
  value: string,
  editorRef: RefObject<HTMLTextAreaElement | null>,
  exampleRef: RefObject<HTMLDivElement | null>,
  footerRef: RefObject<HTMLDivElement | null>,
) {
  const sizing = useRef({
    width: 0,
    height: 0,
    exampleHeight: 0,
    footerHeight: 0,
    viewportHeight: 0,
    manualHeight: undefined as number | undefined,
  });

  useLayoutEffect(() => {
    const element = editorRef.current;
    if (!element) return;
    const editor = element;
    const state = sizing.current;
    state.viewportHeight ||= window.innerHeight;
    const example = exampleRef.current;
    let observedFooter = footerRef.current;
    const main = editor.closest("main");

    function measureLayout() {
      const width = editor.getBoundingClientRect().width;
      const widthChanged = width !== state.width;
      if (widthChanged) state.exampleHeight = 0;
      state.width = width;
      // Keep the layout stable when a mobile keyboard reduces the viewport during editing.
      const keyboardMayBeOpen = window.matchMedia("(pointer: coarse)").matches && document.activeElement === editor;
      if (!keyboardMayBeOpen || widthChanged) state.viewportHeight = window.innerHeight;
      if (value.length === 0 && example) state.exampleHeight = example.getBoundingClientRect().height + 2;
      // Reserve the measured action area after it closes so successful updates do not enlarge the editor.
      state.footerHeight = Math.max(state.footerHeight, footerRef.current?.getBoundingClientRect().height ?? 0);
    }

    function resizeEditor() {
      measureLayout();
      const { minimum, rowMaximum, borders } = editorHeights(editor, state.exampleHeight);
      const maximum = Math.max(minimum, Math.min(rowMaximum, availableHeight()));
      editor.style.minHeight = `${minimum}px`;
      editor.style.height = "auto";
      const contentHeight = editor.scrollHeight + borders;
      const height = state.manualHeight ?? Math.min(maximum, contentHeight);
      editor.style.height = `${Math.max(minimum, height)}px`;
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

    resizeEditor();
    const observer = new ResizeObserver((entries) => {
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
      if (entries.some((entry) => entry.target === example || entry.target === observedFooter)) resizeEditor();
    });
    observer.observe(editor);
    if (example) observer.observe(example);
    if (observedFooter) observer.observe(observedFooter);
    window.addEventListener("resize", resizeEditor);
    document.fonts?.addEventListener("loadingdone", resizeEditor);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resizeEditor);
      document.fonts?.removeEventListener("loadingdone", resizeEditor);
    };
  }, [value, editorRef, exampleRef, footerRef]);
}

function editorHeights(editor: HTMLTextAreaElement, exampleHeight: number) {
  const style = getComputedStyle(editor);
  const lineHeight = pixels(style.lineHeight, pixels(style.fontSize, 14) * 1.625);
  const borders = pixels(style.borderTopWidth) + pixels(style.borderBottomWidth);
  const padding = pixels(style.paddingTop) + pixels(style.paddingBottom);
  return {
    minimum: Math.max(12 * lineHeight + padding + borders, exampleHeight),
    rowMaximum: 24 * lineHeight + padding + borders,
    borders,
  };
}

function pixels(value: string, fallback = 0) {
  return Number.parseFloat(value) || fallback;
}
