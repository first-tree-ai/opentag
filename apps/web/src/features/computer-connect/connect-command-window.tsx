import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import * as m from "../../paraglide/messages.js";
import { CommandBlock, formatRemaining, useRemaining } from "../../setup/index.js";
import { Button, Loader, StatusIndicator } from "../../ui/design-system.js";
import type { ComputerConnectIntent, ComputerConnectLifecycle, ComputerConnectState } from "./computer-connect.js";

/**
 * A non-command placeholder shown while the Server-derived bootstrap command is being issued.
 * Keeping this channel-neutral prevents a loading state from implying a production package or URL.
 */
export const COMPUTER_CONNECT_COMMAND_PLACEHOLDER = "[connection command pending]";

/**
 * The one command window every connect surface shows: new computers and repairs, on the computer
 * list, in Agent settings and in Agent setup. It owns the page's only connection status.
 *
 * - The explanatory line above the command is the caller's (`intro`), because only the caller knows
 *   which computer the task is meant for.
 * - The code-expiry hint sits beside the command. An expired command stays in place, masked, with a
 *   single Refresh action that issues a new one there.
 * - The status speaks about the computer's connection only. Whether the command has been used is
 *   not shown: the page cannot always know it, and it is not something the reader acts on.
 */
export function ConnectCommandWindow({
  intent,
  intro,
  lifecycle,
  returnFocusRef,
}: {
  readonly intent: ComputerConnectIntent;
  readonly intro?: string;
  readonly lifecycle: ComputerConnectLifecycle;
  /** Where focus goes when the command it was on disappears (for example once the computer connects). */
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { error, issue, state } = lifecycle;
  if (state.kind === "idle") {
    return (
      <div className="grid gap-3" data-ui="computer-connect" data-state={state.kind}>
        <Button className="w-fit" size="compact" variant="secondary" onClick={issue}>
          {m.computer_connect_repair_action()}
        </Button>
      </div>
    );
  }
  if (state.kind === "issue-failed") {
    return (
      <div className="grid gap-3 text-sm" data-ui="computer-connect" data-state={state.kind}>
        <p role="alert" className="text-kumo-danger">
          {error ?? m.computer_connect_issue_failed()}
        </p>
        <Button className="w-fit" size="compact" variant="secondary" onClick={issue}>
          {m.computer_connect_retry_issue()}
        </Button>
      </div>
    );
  }
  // Once the command has been used there is nothing left to copy; the window keeps only the
  // connection status (it does not say the command was used).
  const showCommand = state.kind === "issuing" || state.kind === "issued" || state.kind === "expired";
  return (
    <div aria-busy={state.kind === "issuing"} className="grid gap-3" data-ui="computer-connect" data-state={state.kind}>
      {showCommand ? (
        <div
          className="ots-command-lead flex items-center justify-between gap-3"
          data-ui="computer-connect-command-lead"
        >
          {intro ? <p className="text-sm text-kumo-subtle m-0">{intro}</p> : <span />}
          <div className="ots-slot--expiry flex shrink-0 items-center text-sm" data-ui="computer-connect-expiry">
            <Expiry state={state} />
          </div>
        </div>
      ) : null}
      {showCommand ? (
        <CommandSurface intent={intent} issue={issue} returnFocusRef={returnFocusRef} state={state} />
      ) : null}
      <ConnectionStatus error={error} intent={intent} state={state} />
    </div>
  );
}

function Expiry({ state }: { readonly state: ComputerConnectState }) {
  if (state.kind === "issued") return <Remaining expiresAt={state.issued.expiresAt} />;
  if (state.kind === "expired") return <span className="text-kumo-subtle">{m.computer_connect_expired()}</span>;
  return null;
}

function CommandSurface({
  intent,
  issue,
  returnFocusRef,
  state,
}: {
  readonly intent: ComputerConnectIntent;
  readonly issue: () => void;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  readonly state: ComputerConnectState;
}) {
  const labels = {
    copiedLabel: m.computer_connect_copied(),
    copyLabel: m.computer_connect_copy(),
    fallbackHint: m.computer_connect_copy_fallback(),
  };
  const repair = intent.mode === "repair" ? intent.target : undefined;
  if (state.kind === "issuing") {
    const comment = repair
      ? m.computer_connect_repair_command_comment({ computerName: repair.displayName })
      : m.computer_connect_create_command_comment();
    return (
      <div aria-hidden="true" className="ots-command-pending" data-ui="computer-connect-command-skeleton">
        <CommandBlock {...labels} command={COMPUTER_CONNECT_COMMAND_PLACEHOLDER} comment={comment} inert />
      </div>
    );
  }
  if (state.kind !== "issued" && state.kind !== "expired") return null;
  const comment = repair
    ? m.computer_connect_repair_command_comment({ computerName: repair.displayName })
    : m.computer_connect_create_command_comment();
  return (
    <IssuedCommand
      comment={comment}
      label={repair ? m.computer_connect_recovery_title() : m.computer_connect_create_title()}
      command={state.issued.command}
      expired={state.kind === "expired"}
      expiresAt={state.issued.expiresAt}
      issue={issue}
      labels={labels}
      returnFocusRef={returnFocusRef}
    />
  );
}

/**
 * The issued command, shown exactly as it is copied: one inert line for an Agent and the command a
 * person can paste into a terminal. Past its deadline the command is masked at once: until the
 * Server's verdict arrives nothing new is issued (a late redemption must not race a replacement), and
 * once it is expired the single Refresh action replaces it in place.
 */
function IssuedCommand({
  comment,
  command,
  label,
  expired,
  expiresAt,
  issue,
  labels,
  returnFocusRef,
}: {
  readonly comment: string;
  readonly command: string;
  readonly label: string;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  readonly expired: boolean;
  readonly expiresAt: number;
  readonly issue: () => void;
  readonly labels: { copiedLabel: string; copyLabel: string; fallbackHint: string };
}) {
  const remaining = useRemaining(expiresAt);
  const dead = expired || remaining <= 0;
  const blockRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const block = blockRef.current;
    return () => {
      // The command can disappear under the reader (the computer connected): keep focus on the page.
      if (block?.contains(document.activeElement)) returnFocusRef?.current?.focus({ preventScroll: true });
    };
  }, [returnFocusRef]);
  // The copy control the reader may be on is disabled by the mask; hand focus to Refresh instead
  // of dropping it to the page.
  useEffect(() => {
    if (!expired) return;
    const active = document.activeElement;
    if (active === document.body || blockRef.current?.contains(active)) refreshRef.current?.focus();
  }, [expired]);
  // A dead command is masked and never kept in the page: only a placeholder stays under the mask.
  const shown = dead ? COMPUTER_CONNECT_COMMAND_PLACEHOLDER : command;
  return (
    <div ref={blockRef} className="min-w-0">
      <CommandBlock
        {...labels}
        key={shown}
        command={shown}
        comment={comment}
        label={label}
        expiredNotice={
          expired ? (
            <Button ref={refreshRef} size="compact" variant="secondary" onClick={issue}>
              {m.computer_connect_refresh()}
            </Button>
          ) : dead ? (
            <Loader aria-label={m.computer_connect_expired()} size="sm" />
          ) : undefined
        }
      />
    </div>
  );
}

function ConnectionStatus({
  error,
  intent,
  state,
}: {
  readonly error?: string;
  readonly intent: ComputerConnectIntent;
  readonly state: ComputerConnectState;
}) {
  const content = statusContent(error, intent, state);
  return (
    <div className="ots-slot--status flex min-w-0 flex-wrap items-center gap-2 text-sm">
      <div aria-live="polite" role="status">
        {content}
      </div>
    </div>
  );
}

function statusContent(error: string | undefined, intent: ComputerConnectIntent, state: ComputerConnectState) {
  if (error) {
    return (
      <span className="text-kumo-danger" role="alert">
        {error}
      </span>
    );
  }
  if (state.kind === "issuing") {
    return (
      <p className="flex items-center gap-2 text-kumo-subtle">
        <span aria-hidden="true">
          <Loader aria-label={m.computer_connect_issuing()} size="sm" />
        </span>
        {m.computer_connect_issuing()}
      </p>
    );
  }
  // A used command is still a computer that has not come online: the status says only that.
  if (state.kind === "issued" || state.kind === "redeemed") {
    return (
      <p className="flex items-center gap-2 text-kumo-subtle">
        <span aria-hidden="true">
          <Loader size="sm" />
        </span>
        {intent.mode === "repair"
          ? m.computer_connect_waiting_repair({ computerName: intent.target.displayName })
          : m.computer_connect_waiting_create()}
      </p>
    );
  }
  // A dead command leaves the computer where it was: say so plainly, next to the Refresh action.
  if (state.kind === "expired") {
    return (
      <p className="flex items-center gap-2 text-kumo-subtle">
        {intent.mode === "repair"
          ? m.computer_connect_not_connected_repair({ computerName: intent.target.displayName })
          : m.computer_connect_not_connected_create()}
      </p>
    );
  }
  if (state.kind === "connected") {
    return (
      <StatusIndicator
        label={m.computer_connect_connected({ computerName: state.computer.displayName })}
        tone="success"
      />
    );
  }
  return null;
}

function Remaining({ expiresAt }: { readonly expiresAt: number }) {
  const remaining = useRemaining(expiresAt);
  return (
    <span className="text-kumo-subtle">
      {remaining > 0
        ? m.computer_connect_expires_in({ time: formatRemaining(remaining) })
        : m.computer_connect_expired()}
    </span>
  );
}
