import type { WorkspaceComputerSummary } from "@opentag/shared/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { CommandBlock, formatRemaining, readConnectCodeVerdict, useRemaining } from "../../setup/index.js";
import { Banner, Button, Loader, StatusIndicator } from "../../ui/design-system.js";

const COMPUTER_POLL_INTERVAL_MS = 1_500;
const COMMAND_SKELETON = "opentag computer connect --server https://opentag.example.com -- preparing-command";

export type ComputerConnectIntent =
  | { readonly mode: "create" }
  | {
      readonly mode: "repair";
      readonly target: { readonly computerId: string; readonly displayName: string };
    };

export interface ComputerConnectProps {
  readonly intent: ComputerConnectIntent;
  readonly onConnected?: (computer: WorkspaceComputerSummary) => void;
}

interface IssuedCommand {
  readonly command: string;
  readonly connectCodeId: string;
  readonly expiresAt: number;
}

type AttemptState =
  | { readonly kind: "issuing" }
  | { readonly kind: "issue-failed" }
  | { readonly kind: "issued"; readonly issued: IssuedCommand }
  | { readonly kind: "expired"; readonly issued: IssuedCommand }
  | { readonly kind: "connected"; readonly issued: IssuedCommand; readonly computer: WorkspaceComputerSummary };

type PollResult =
  | { readonly kind: "wait" }
  | { readonly kind: "expire" }
  | { readonly kind: "connected"; readonly computer: WorkspaceComputerSummary };

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** The redeemed Computer counts only once the connection bought by that redemption is online. */
function isFreshlyConnected(computer: WorkspaceComputerSummary, redeemedAt: string): boolean {
  return (
    computer.connectionStatus === "online" &&
    computer.connectedAt !== null &&
    Date.parse(computer.connectedAt) >= Date.parse(redeemedAt)
  );
}

async function readPollResult(
  issued: IssuedCommand,
  targetComputerId: string | undefined,
  isCurrent: () => boolean,
): Promise<PollResult> {
  const verdict = readConnectCodeVerdict(await browserApi.computerConnectCodeStatus(issued.connectCodeId));
  if (!isCurrent() || verdict.kind === "wait") return { kind: "wait" };
  if (verdict.kind === "expire") return { kind: "expire" };
  if (targetComputerId && verdict.computerId !== targetComputerId) return { kind: "wait" };
  const { computers } = await browserApi.computers();
  if (!isCurrent()) return { kind: "wait" };
  const connected = computers.find(
    (computer) => computer.computerId === verdict.computerId && isFreshlyConnected(computer, verdict.redeemedAt),
  );
  return connected ? { kind: "connected", computer: connected } : { kind: "wait" };
}

async function pollIssuedCommand({
  expire,
  issued,
  isCurrent,
  onConnected,
  setError,
  targetComputerId,
}: {
  readonly expire: () => void;
  readonly issued: IssuedCommand;
  readonly isCurrent: () => boolean;
  readonly onConnected: (computer: WorkspaceComputerSummary) => void;
  readonly setError: (message: string | undefined) => void;
  readonly targetComputerId?: string;
}): Promise<void> {
  if (!isCurrent()) return;
  if (Date.now() >= issued.expiresAt) {
    expire();
    return;
  }
  try {
    const result = await readPollResult(issued, targetComputerId, isCurrent);
    if (!isCurrent()) return;
    if (result.kind === "expire") {
      expire();
      return;
    }
    setError(undefined);
    if (result.kind === "connected") onConnected(result.computer);
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
  const targetComputerId = intent.mode === "repair" ? intent.target.computerId : undefined;
  const targetName = intent.mode === "repair" ? intent.target.displayName : undefined;
  const attemptKey = `${intent.mode}:${targetComputerId ?? ""}`;
  return (
    <ComputerConnectAttempt
      key={attemptKey}
      mode={intent.mode}
      onConnected={onConnected}
      targetComputerId={targetComputerId}
      targetName={targetName}
    />
  );
}

function ComputerConnectAttempt({
  mode,
  onConnected,
  targetComputerId,
  targetName,
}: {
  readonly mode: ComputerConnectIntent["mode"];
  readonly onConnected?: (computer: WorkspaceComputerSummary) => void;
  readonly targetComputerId?: string;
  readonly targetName?: string;
}) {
  const [state, setState] = useState<AttemptState>({ kind: "issuing" });
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
      const issued = await browserApi.issueComputerConnectCode(
        mode === "repair" && targetComputerId ? { mode: "repair", targetComputerId } : { mode: "create" },
      );
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
  }, [mode, targetComputerId]);

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
    if (state.kind !== "issued") return;
    const { expiresAt } = state.issued;
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
    const complete = (computer: WorkspaceComputerSummary) => {
      if (!current()) return;
      completed = true;
      setError(undefined);
      setState({ kind: "connected", issued: state.issued, computer });
      onConnectedRef.current?.(computer);
    };
    const poll = () => {
      if (polling) return;
      polling = true;
      void pollIssuedCommand({
        expire,
        issued: state.issued,
        isCurrent: current,
        onConnected: complete,
        setError,
        targetComputerId,
      }).finally(() => {
        polling = false;
      });
    };

    const pollTimer = window.setInterval(poll, COMPUTER_POLL_INTERVAL_MS);
    const expiryTimer = window.setTimeout(expire, Math.max(0, expiresAt - Date.now()));
    poll();
    return () => {
      active = false;
      window.clearInterval(pollTimer);
      window.clearTimeout(expiryTimer);
    };
  }, [state, targetComputerId]);

  if (state.kind === "issue-failed") {
    return (
      <div className="grid gap-3" data-ui="computer-connect" data-state={state.kind}>
        {error ? <Banner variant="error" role="alert" description={error} /> : null}
        <Button className="w-fit" onClick={() => void issue()}>
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
            command={COMMAND_SKELETON}
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
                <Button size="compact" variant="inline" onClick={() => void issue()}>
                  {m.computer_connect_reissue()}
                </Button>
              </>
            ) : undefined
          }
          fallbackHint={m.computer_connect_copy_fallback()}
        />
      )}
      <AttemptStatus state={state} targetName={targetName} />
      {error ? <Banner variant="error" role="alert" description={error} /> : null}
    </div>
  );
}

function AttemptStatus({ state, targetName }: { readonly state: AttemptState; readonly targetName?: string }) {
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
  } else if (state.kind === "issued") {
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
