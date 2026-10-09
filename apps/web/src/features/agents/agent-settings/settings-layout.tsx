import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
    <header className="grid gap-2">
      <Text as="h1" id={id} size="lg" variant="heading">
        {title}
      </Text>
      {description ? <p className="text-sm text-kumo-subtle">{description}</p> : null}
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
}: {
  busy: boolean;
  onDiscard: () => void;
  saveDisabled?: boolean;
  saveLabel?: string;
  savingLabel?: string;
  statusLabel?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3">
      <span className="text-sm text-kumo-subtle">{statusLabel}</span>
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={busy} type="button" variant="ghost" onClick={onDiscard}>
          {m.agent_settings_discard_action()}
        </Button>
        <Button disabled={busy || saveDisabled} type="submit">
          {busy ? savingLabel : saveLabel}
        </Button>
      </div>
    </div>
  );
}

export function UnsavedChangesGuard({ when }: { when: boolean }) {
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
      description={m.agent_settings_unsaved_confirm_description()}
      title={m.agent_settings_unsaved_confirm_title()}
      onClose={() => settle(true)}
    >
      <div className="flex flex-wrap justify-end gap-3">
        <Button variant="ghost" onClick={() => settle(true)}>
          {m.agent_settings_keep_editing()}
        </Button>
        <Button variant="secondary" onClick={() => settle(false)}>
          {m.agent_settings_discard_action()}
        </Button>
      </div>
    </Dialog>
  ) : null;
}
