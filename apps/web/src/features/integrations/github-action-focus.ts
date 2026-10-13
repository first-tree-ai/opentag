import { useEffect, useRef } from "react";

/** Restore only focus lost by an async GitHub action, without overriding a user's later navigation. */
export function useGitHubActionFocus(busy: boolean) {
  const resultRef = useRef<HTMLParagraphElement>(null);
  const trigger = useRef<HTMLElement | null>(null);

  // An immediate action may batch away busy=true, so inspect the trigger after every commit.
  useEffect(() => {
    if (busy) return;
    const previous = trigger.current;
    trigger.current = null;
    if (!previous) return;
    const active = document.activeElement;
    if (active !== document.body && !(active === previous && previous.matches(":disabled"))) return;
    const target = previous.isConnected && !previous.matches(":disabled") ? previous : resultRef.current;
    target?.focus();
  });

  function captureFocus() {
    const active = document.activeElement;
    trigger.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }

  return { resultRef, captureFocus };
}
