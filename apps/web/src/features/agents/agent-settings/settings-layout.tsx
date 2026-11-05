import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as m from "../../../paraglide/messages.js";
import { Button, Dialog, Text } from "../../../ui/design-system.js";

export function AgentSettingsPageHeader({
  description,
  id,
  title,
}: {
  description?: ReactNode;
  id?: string;
  title: ReactNode;
}) {
  return (
    <header className="grid gap-3">
      <Text as="h1" id={id} size="lg" variant="heading">
        {title}
      </Text>
      {description ? <p className="text-base text-kumo-subtle">{description}</p> : null}
    </header>
  );
}

export function SettingsSaveActions({
  busy,
  onDiscard,
  saveDisabled = false,
  saveLabel = m.agent_settings_save_changes_action(),
  savingLabel = m.agent_settings_saving_action(),
  statusLabel = m.agent_settings_unsaved_changes(),
  showActions = true,
  discardLabel = m.agent_settings_discard_action(),
}: {
  busy: boolean;
  onDiscard: () => void;
  saveDisabled?: boolean;
  saveLabel?: string;
  savingLabel?: string;
  statusLabel?: ReactNode;
  showActions?: boolean;
  discardLabel?: string;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const focusInside = useRef(false);
  // The bar disappears once changes are saved or discarded. Keyboard focus on one of its buttons would
  // otherwise fall back to the page, so it moves to the first control of the form the bar belongs to.
  useLayoutEffect(() => {
    const element = bar.current;
    const form = element?.closest("form");
    const onFocusIn = () => {
      focusInside.current = true;
    };
    const onFocusOut = (event: FocusEvent) => {
      // A browser may report a blur while the bar itself is being removed; that is not the reader leaving.
      if (!element?.isConnected) return;
      focusInside.current = element.contains(event.relatedTarget as Node | null);
    };
    element?.addEventListener("focusin", onFocusIn);
    element?.addEventListener("focusout", onFocusOut);
    return () => {
      element?.removeEventListener("focusin", onFocusIn);
      element?.removeEventListener("focusout", onFocusOut);
      if (element?.contains(document.activeElement)) focusInside.current = true;
      if (!focusInside.current || !form) return;
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        form.querySelector<HTMLElement>(FIRST_FORM_CONTROL)?.focus();
      });
    };
  }, []);
  return (
    <div
      ref={bar}
      className="flex min-h-[57px] flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3 md:min-h-[53px]"
    >
      {statusLabel ? <span className="text-sm text-kumo-subtle">{statusLabel}</span> : null}
      {showActions ? (
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          {/* Busy buttons stay enabled and ignore repeats: disabling the focused button would drop focus. */}
          <Button
            aria-disabled={busy || undefined}
            type="button"
            variant="ghost"
            onClick={() => {
              if (!busy) onDiscard();
            }}
          >
            {discardLabel}
          </Button>
          <Button aria-busy={busy || undefined} disabled={saveDisabled && !busy} type="submit">
            {busy ? savingLabel : saveLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const FIRST_FORM_CONTROL =
  'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"], button:not([disabled])';

export function UnsavedChangesGuard({ when, soul = false }: { when: boolean; soul?: boolean }) {
  const router = useRouter({ warn: false });
  const unblockRef = useRef<(() => void) | undefined>(undefined);
  const resolverRef = useRef<((blocked: boolean) => void) | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!when || !router) return;
    const unblock = router.history.block({
      blockerFn: ({ currentLocation, nextLocation }) => {
        if (currentLocation.href === nextLocation.href) return false;
        return new Promise<boolean>((resolve) => {
          resolverRef.current = resolve;
          setConfirming(true);
        });
      },
      enableBeforeUnload: true,
    });
    unblockRef.current = unblock;
    return () => {
      unblock();
      if (unblockRef.current === unblock) unblockRef.current = undefined;
      resolverRef.current?.(true);
      resolverRef.current = undefined;
    };
  }, [router, when]);

  function settle(blocked: boolean) {
    if (!blocked) {
      // Remove the blocker before retrying the allowed navigation. The settings component can
      // remain mounted until the route commit finishes, so a fast Back could otherwise be blocked
      // by the discarded draft and observe timing-dependent history.
      unblockRef.current?.();
      unblockRef.current = undefined;
    }
    resolverRef.current?.(blocked);
    resolverRef.current = undefined;
    setConfirming(false);
  }

  return confirming ? (
    <Dialog
      description={soul ? m.agent_settings_soul_leave_description() : m.agent_settings_unsaved_confirm_description()}
      title={soul ? m.agent_settings_soul_leave_title() : m.agent_settings_unsaved_confirm_title()}
      onClose={() => settle(true)}
    >
      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="ghost" onClick={() => settle(true)}>
          {m.agent_settings_keep_editing()}
        </Button>
        <Button variant="secondary" onClick={() => settle(false)}>
          {soul ? m.agent_settings_soul_discard_and_leave() : m.agent_settings_discard_action()}
        </Button>
      </div>
    </Dialog>
  ) : null;
}
