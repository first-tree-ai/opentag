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
}: {
  busy: boolean;
  onDiscard: () => void;
  saveDisabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3">
      <span className="text-sm text-kumo-subtle">{m.agent_settings_unsaved_changes()}</span>
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={busy} type="button" variant="ghost" onClick={onDiscard}>
          {m.agent_settings_discard_action()}
        </Button>
        <Button disabled={busy || saveDisabled} type="submit">
          {busy ? m.agent_settings_saving_action() : m.agent_settings_save_changes_action()}
        </Button>
      </div>
    </div>
  );
}

export function UnsavedChangesGuard({ when }: { when: boolean }) {
  const router = useRouter({ warn: false });
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
    return () => {
      unblock();
      resolverRef.current?.(true);
      resolverRef.current = undefined;
    };
  }, [router, when]);

  function settle(blocked: boolean) {
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
