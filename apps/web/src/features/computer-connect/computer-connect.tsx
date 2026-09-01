import type { AccountComputerSummary, ComputerConnectCodeStatus } from "@opentag/shared/browser";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { CommandBlock, formatRemaining, readConnectCodeVerdict, useRemaining } from "../../setup/index.js";
import { Banner, Button, Loader, StatusIndicator } from "../../ui/design-system.js";

const COMPUTER_POLL_INTERVAL_MS = 1_500;
/**
 * A non-command placeholder shown while the Server-derived bootstrap command is being issued.
 * Keeping this channel-neutral prevents a loading state from implying a production package or URL.
 */
export const COMPUTER_CONNECT_COMMAND_PLACEHOLDER = "[connection command pending]";

export type ComputerConnectIntent =
  | { readonly mode: "create" }
  | {
      readonly mode: "repair";
      readonly target: { readonly computerId: string; readonly displayName: string };
    };

export interface ComputerConnectProps {
  readonly intent: ComputerConnectIntent;
  readonly onConnected?: (computer: AccountComputerSummary) => void;
}

export interface ComputerConnectAdapter {
  readonly issue: (intent: ComputerConnectIntent) => Promise<{
    readonly bootstrapCommand: string;
    readonly connectCodeId: string;
    readonly expiresIn: number;
    readonly issuedAt: string;
  }>;
  readonly status: (connectCodeId: string) => Promise<ComputerConnectCodeStatus>;
  readonly computers: () => Promise<{ readonly computers: readonly AccountComputerSummary[] }>;
}

export interface IssuedComputerConnectCommand {
  readonly command: string;
  readonly connectCodeId: string;
  readonly expiresAt: number;
}

interface RedeemedComputerConnectCommand {
  readonly computerId: string;
  readonly redeemedAt: string;
}

export type ComputerConnectState =
  | { readonly kind: "issuing" }
  | { readonly kind: "issue-failed" }
  | { readonly kind: "issued"; readonly issued: IssuedComputerConnectCommand }
  | {
      readonly kind: "redeemed";
      readonly issued: IssuedComputerConnectCommand;
      readonly redeemed: RedeemedComputerConnectCommand;
    }
  | { readonly kind: "expired"; readonly issued: IssuedComputerConnectCommand }
  | {
      readonly kind: "connected";
      readonly issued: IssuedComputerConnectCommand;
      readonly computer: AccountComputerSummary;
    };

export interface ComputerConnectLifecycle {
  readonly error: string | undefined;
  readonly reissue: () => void;
  readonly state: ComputerConnectState;
}

export interface ComputerConnectLifecycleProps extends ComputerConnectProps {
  readonly adapter?: ComputerConnectAdapter;
  readonly children: (lifecycle: ComputerConnectLifecycle) => ReactNode;
}

type PollResult =
  | { readonly kind: "wait" }
  | { readonly kind: "expire" }
  | { readonly kind: "redeemed"; readonly redeemed: RedeemedComputerConnectCommand }
  | { readonly kind: "connected"; readonly computer: AccountComputerSummary };

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** The redeemed Computer counts only once the connection bought by that redemption is online. */
function isFreshlyConnected(computer: AccountComputerSummary, redeemedAt: string): boolean {
  return (
    computer.connectionStatus === "online" &&
    computer.connectedAt !== null &&
    Date.parse(computer.connectedAt) >= Date.parse(redeemedAt)
  );
}

async function readPollResult(
  adapter: ComputerConnectAdapter,
  issued: IssuedComputerConnectCommand,
  targetComputerId: string | undefined,
  isCurrent: () => boolean,
): Promise<PollResult> {
  const verdict = readConnectCodeVerdict(await adapter.status(issued.connectCodeId));
  if (!isCurrent() || verdict.kind === "wait") return { kind: "wait" };
  if (verdict.kind === "expire") return { kind: "expire" };
  if (targetComputerId && verdict.computerId !== targetComputerId) return { kind: "wait" };
  const { computers } = await adapter.computers();
  if (!isCurrent()) return { kind: "wait" };
  const connected = computers.find(
    (computer) => computer.computerId === verdict.computerId && isFreshlyConnected(computer, verdict.redeemedAt),
  );
  return connected
    ? { kind: "connected", computer: connected }
    : { kind: "redeemed", redeemed: { computerId: verdict.computerId, redeemedAt: verdict.redeemedAt } };
}

async function pollRedeemedComputer({
  adapter,
  isCurrent,
  onConnected,
  redeemed,
  setError,
}: {
  readonly adapter: ComputerConnectAdapter;
  readonly isCurrent: () => boolean;
  readonly onConnected: (computer: AccountComputerSummary) => void;
  readonly redeemed: RedeemedComputerConnectCommand;
  readonly setError: (message: string | undefined) => void;
}): Promise<void> {
  try {
    const { computers } = await adapter.computers();
    if (!isCurrent()) return;
    setError(undefined);
    const connected = computers.find(
      (computer) => computer.computerId === redeemed.computerId && isFreshlyConnected(computer, redeemed.redeemedAt),
    );
    if (connected) onConnected(connected);
  } catch (cause) {
    if (isCurrent()) setError(errorMessage(cause, m.computer_connect_poll_failed()));
  }
}

async function pollIssuedCommand({
  adapter,
  expire,
  issued,
  isCurrent,
  onConnected,
  onRedeemed,
  setError,
  targetComputerId,
}: {
  readonly adapter: ComputerConnectAdapter;
  readonly expire: () => void;
  readonly issued: IssuedComputerConnectCommand;
  readonly isCurrent: () => boolean;
  readonly onConnected: (computer: AccountComputerSummary) => void;
  readonly onRedeemed: (redeemed: RedeemedComputerConnectCommand) => void;
  readonly setError: (message: string | undefined) => void;
  readonly targetComputerId?: string;
}): Promise<void> {
  if (!isCurrent()) return;
  try {
    const result = await readPollResult(adapter, issued, targetComputerId, isCurrent);
    if (!isCurrent()) return;
    if (result.kind === "expire") {
      expire();
      return;
    }
    setError(undefined);
    if (result.kind === "connected") {
      onConnected(result.computer);
    } else if (result.kind === "redeemed") {
      onRedeemed(result.redeemed);
    } else if (Date.now() >= issued.expiresAt) {
      expire();
    }
  } catch (cause) {
    if (isCurrent()) setError(errorMessage(cause, m.computer_connect_poll_failed()));
  }
}

/**
 * Owns one explicit Computer connection attempt from issuance through its terminal state.
 *
 * Callers choose only create versus a repair target and decide what to do after connection. The
 * module owns every ordering rule inside that seam, including retiring stale issue and poll work.
 */
export function ComputerConnect({ intent, onConnected }: ComputerConnectProps) {
  return (
    <ComputerConnectLifecycleRoot intent={intent} onConnected={onConnected}>
      {(lifecycle) => <ComputerConnectPresentation intent={intent} lifecycle={lifecycle} />}
    </ComputerConnectLifecycleRoot>
  );
}

const browserAdapter: ComputerConnectAdapter = {
  issue: (intent) =>
    browserApi.issueComputerConnectCode(
      intent.mode === "repair" ? { mode: "repair", targetComputerId: intent.target.computerId } : { mode: "create" },
    ),
  status: (connectCodeId) => browserApi.computerConnectCodeStatus(connectCodeId),
  computers: () => browserApi.computers(),
};

/**
 * Render seam for pages that keep their own layout while sharing the complete connection lifecycle.
 * The adapter is intentionally the only varying dependency: production and Review Lab both drive
 * the same state machine, including stale-work retirement and exact repair-target validation.
 */
export function ComputerConnectLifecycleRoot({
  adapter = browserAdapter,
  children,
  intent,
  onConnected,
}: ComputerConnectLifecycleProps) {
  const targetComputerId = intent.mode === "repair" ? intent.target.computerId : undefined;
  const attemptKey = `${intent.mode}:${targetComputerId ?? ""}`;
  return (
    <ComputerConnectAttempt adapter={adapter} key={attemptKey} intent={intent} onConnected={onConnected}>
      {children}
    </ComputerConnectAttempt>
  );
}

function ComputerConnectAttempt({
  adapter,
  children,
  intent,
  onConnected,
}: {
  readonly adapter: ComputerConnectAdapter;
  readonly children: ComputerConnectLifecycleProps["children"];
  readonly intent: ComputerConnectIntent;
  readonly onConnected?: (computer: AccountComputerSummary) => void;
}) {
  const targetComputerId = intent.mode === "repair" ? intent.target.computerId : undefined;
  const [state, setState] = useState<ComputerConnectState>({ kind: "issuing" });
  const [error, setError] = useState<string>();
  const mounted = useRef(false);
  const started = useRef(false);
  const generation = useRef(0);
  const stateRef = useRef(state);
  const onConnectedRef = useRef(onConnected);
  stateRef.current = state;
  onConnectedRef.current = onConnected;

  const issue = useCallback(async () => {
    const mine = generation.current + 1;
    generation.current = mine;
    const previous = stateRef.current;
    setState({ kind: "issuing" });
    setError(undefined);
    try {
      const issued = await adapter.issue(intent);
      if (!mounted.current || generation.current !== mine) return;
      setState({
        kind: "issued",
        issued: {
          command: issued.bootstrapCommand,
          connectCodeId: issued.connectCodeId,
          expiresAt: Date.parse(issued.issuedAt) + issued.expiresIn * 1_000,
        },
      });
    } catch (cause) {
      if (!mounted.current || generation.current !== mine) return;
      setState(previous.kind === "expired" ? previous : { kind: "issue-failed" });
      setError(errorMessage(cause, m.computer_connect_issue_failed()));
    }
  }, [adapter, intent]);

  useEffect(() => {
    mounted.current = true;
    // React Strict Mode replays the effect while preserving this ref. One mount is one Server-side
    // attempt, even in development; the replay only restores the mounted flag after its cleanup.
    if (!started.current) {
      started.current = true;
      void issue();
    }
    return () => {
      mounted.current = false;
    };
  }, [issue]);

  useEffect(() => {
    if (state.kind !== "issued" && state.kind !== "redeemed") return;
    const { expiresAt } = state.issued;
    const redeemed = state.kind === "redeemed" ? state.redeemed : undefined;
    const mine = generation.current;
    let active = true;
    let polling = false;
    let completed = false;

    const current = () => active && !completed && mounted.current && generation.current === mine;
    const expire = () => {
      if (!current()) return;
      completed = true;
      setError(undefined);
      setState({ kind: "expired", issued: state.issued });
    };
    const complete = (computer: AccountComputerSummary) => {
      if (!current()) return;
      completed = true;
      setError(undefined);
      setState({ kind: "connected", issued: state.issued, computer });
      onConnectedRef.current?.(computer);
    };
    const latchRedeemed = (value: RedeemedComputerConnectCommand) => {
      if (!current()) return;
      completed = true;
      setState({ kind: "redeemed", issued: state.issued, redeemed: value });
    };
    const poll = () => {
      if (polling) return;
      polling = true;
      const work = redeemed
        ? pollRedeemedComputer({ adapter, isCurrent: current, onConnected: complete, redeemed, setError })
        : pollIssuedCommand({
            adapter,
            expire,
            issued: state.issued,
            isCurrent: current,
            onConnected: complete,
            onRedeemed: latchRedeemed,
            setError,
            targetComputerId,
          });
      void work.finally(() => {
        polling = false;
      });
    };

    const pollTimer = window.setInterval(poll, COMPUTER_POLL_INTERVAL_MS);
    // At the local deadline, ask the Server once more instead of expiring blindly: redemption is
    // durable and can precede inventory propagation. Once latched, the exact Computer is polled
    // without any code TTL because issuing another command would risk a duplicate connection.
    const expiryTimer = redeemed ? undefined : window.setTimeout(poll, Math.max(0, expiresAt - Date.now()));
    poll();
    return () => {
      active = false;
      window.clearInterval(pollTimer);
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
    };
  }, [adapter, state, targetComputerId]);

  return children({ error, reissue: () => void issue(), state });
}

function ComputerConnectPresentation({
  intent,
  lifecycle,
}: {
  readonly intent: ComputerConnectIntent;
  readonly lifecycle: ComputerConnectLifecycle;
}) {
  const { error, reissue, state } = lifecycle;
  const targetName = intent.mode === "repair" ? intent.target.displayName : undefined;

  if (state.kind === "issue-failed") {
    return (
      <div className="grid gap-3" data-ui="computer-connect" data-state={state.kind}>
        {error ? <Banner variant="error" role="alert" description={error} /> : null}
        <Button className="w-fit" onClick={reissue}>
          {m.computer_connect_retry_issue()}
        </Button>
      </div>
    );
  }

  const comment = targetName
    ? m.computer_connect_repair_command_comment({ computerName: targetName })
    : m.computer_connect_create_command_comment();
  return (
    <div aria-busy={state.kind === "issuing"} className="grid gap-3" data-ui="computer-connect" data-state={state.kind}>
      {state.kind === "issuing" ? (
        <div aria-hidden="true" className="ots-command-pending" data-ui="computer-connect-command-skeleton">
          <CommandBlock
            command={COMPUTER_CONNECT_COMMAND_PLACEHOLDER}
            comment={comment}
            copiedLabel={m.computer_connect_copied()}
            copyLabel={m.computer_connect_copy()}
            fallbackHint={m.computer_connect_copy_fallback()}
            inert
          />
        </div>
      ) : (
        <CommandBlock
          key={state.issued.command}
          command={state.issued.command}
          comment={comment}
          copiedLabel={m.computer_connect_copied()}
          copyLabel={m.computer_connect_copy()}
          expiredNotice={
            state.kind === "expired" ? (
              <>
                <span>{m.computer_connect_expired()}</span>
                <Button size="compact" variant="inline" onClick={reissue}>
                  {m.computer_connect_reissue()}
                </Button>
              </>
            ) : undefined
          }
          fallbackHint={m.computer_connect_copy_fallback()}
          inert={state.kind === "redeemed"}
        />
      )}
      <AttemptStatus state={state} targetName={targetName} />
      {error ? <Banner variant="error" role="alert" description={error} /> : null}
    </div>
  );
}

function AttemptStatus({ state, targetName }: { readonly state: ComputerConnectState; readonly targetName?: string }) {
  let content = null;
  if (state.kind === "issuing") {
    content = (
      <p className="flex items-center gap-2 text-kumo-subtle">
        <span aria-hidden="true">
          <Loader aria-label={m.computer_connect_issuing()} size="sm" />
        </span>
        {m.computer_connect_issuing()}
      </p>
    );
  } else if (state.kind === "issued" || state.kind === "redeemed") {
    content = (
      <p className="flex items-center gap-2 text-kumo-subtle">
        <span aria-hidden="true" className="ots-pulse shrink-0" />
        {targetName
          ? m.computer_connect_waiting_repair({ computerName: targetName })
          : m.computer_connect_waiting_create()}
      </p>
    );
  } else if (state.kind === "connected") {
    content = (
      <StatusIndicator
        label={m.computer_connect_connected({ computerName: state.computer.displayName })}
        tone="success"
      />
    );
  } else if (state.kind === "expired") {
    content = <span className="text-kumo-subtle">{m.computer_connect_expired_status()}</span>;
  }
  return (
    <div className="ots-slot--status flex min-w-0 flex-wrap items-center justify-between gap-2 text-sm">
      <div aria-live="polite" role="status">
        {content}
      </div>
      {state.kind === "issued" ? <Remaining expiresAt={state.issued.expiresAt} /> : null}
    </div>
  );
}

function Remaining({ expiresAt }: { readonly expiresAt: number }) {
  return (
    <span className="text-kumo-subtle">
      {m.computer_connect_expires_in({ time: formatRemaining(useRemaining(expiresAt)) })}
    </span>
  );
}
