import type { AccountComputerSummary } from "@opentag/shared/browser";
import { type RefObject, useLayoutEffect, useMemo, useRef } from "react";
import * as m from "../../paraglide/messages.js";
import { type ComputerConnectAdapter, ComputerConnectLifecycleRoot } from "./computer-connect.js";
import { ConnectCommandWindow } from "./connect-command-window.js";

type RecoveryComputer = Pick<AccountComputerSummary, "computerId" | "displayName" | "platform">;

/**
 * Restores an existing Computer through the shared command window: a targeted repair task, its
 * expiry, and the single connection status. The surrounding card shows no status of its own while
 * this window is on screen.
 */
export function ComputerRecovery({
  computer,
  adapter,
  available = true,
  focusOnMount = false,
  returnFocusRef,
  onConnected,
}: {
  readonly computer: RecoveryComputer;
  readonly adapter?: ComputerConnectAdapter;
  /** Hide controls during inventory uncertainty while retaining the exact attempt. */
  readonly available?: boolean;
  /** Opened by the reader's own action: take focus so the button they pressed is not lost. */
  readonly focusOnMount?: boolean;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  readonly onConnected: () => void;
}) {
  const recoveryRef = useRef<HTMLDivElement>(null);
  const focusTarget = returnFocusRef ?? recoveryRef;
  useLayoutEffect(() => {
    // Taken once, when the reader opens the window.
    if (focusOnMount) recoveryRef.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  useLayoutEffect(() => {
    const recovery = recoveryRef.current;
    return () => {
      // A confirmed connection removes the focused control; keep focus on the card.
      if (recovery?.contains(document.activeElement)) focusTarget.current?.focus({ preventScroll: true });
    };
  }, [focusTarget]);
  const intent = useMemo(() => ({ mode: "repair" as const, target: computer }), [computer]);
  return (
    <div
      ref={recoveryRef}
      tabIndex={-1}
      className="min-w-0 outline-none focus-visible:outline-2 focus-visible:outline-kumo-focus"
      data-ui="computer-recovery"
    >
      <ComputerConnectLifecycleRoot adapter={adapter} autoIssue={available} intent={intent} onConnected={onConnected}>
        {(lifecycle) =>
          available ? (
            <ConnectCommandWindow
              intent={intent}
              intro={m.computer_connect_recovery_intro({ computerName: computer.displayName })}
              lifecycle={lifecycle}
              returnFocusRef={focusTarget}
            />
          ) : null
        }
      </ComputerConnectLifecycleRoot>
    </div>
  );
}
