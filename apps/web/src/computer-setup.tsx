import type { Computer } from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "./api.js";
import { Button } from "./ui/design-system.js";

const COMPUTER_POLL_INTERVAL_MS = 1_500;
const COPY_FEEDBACK_MS = 2_000;
const CONNECT_CODE_EXPIRED_MESSAGE = "This Computer connection command expired. Generate a new one to continue.";
const COPY_FALLBACK_HINT = "Copying is unavailable here. The command is selected; press Ctrl or Cmd + C.";

export interface ComputerSetupProps {
  teamId: string;
  onConnected?: () => void;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** Selects the command so a browser without clipboard access still allows a manual copy. */
function selectCommand(node: HTMLElement | null): void {
  const selection = window.getSelection?.();
  if (!node || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Renders the remaining connect-code validity as m:ss without rounding a live second up. */
function formatRemaining(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ComputerSetup({ teamId, onConnected }: ComputerSetupProps) {
  return <ComputerSetupLifecycle key={teamId} teamId={teamId} onConnected={onConnected} />;
}

function ComputerSetupLifecycle({ teamId, onConnected }: ComputerSetupProps) {
  const [bootstrapCommand, setBootstrapCommand] = useState<string>();
  const [error, setError] = useState<string>();
  const [waitingForComputer, setWaitingForComputer] = useState(false);
  const [computerConnected, setComputerConnected] = useState(false);
  const [pollCycle, setPollCycle] = useState(0);
  const [remainingMs, setRemainingMs] = useState<number>();
  const [copied, setCopied] = useState(false);
  const [copyHint, setCopyHint] = useState<string>();
  const baselineConnections = useRef<Map<string, string | null>>(new Map());
  const connectCodeExpiresAt = useRef(0);
  const connectAttempt = useRef(0);
  const activePollCycle = useRef(0);
  const copyResetTimer = useRef(0);
  const commandRef = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      connectAttempt.current += 1;
      activePollCycle.current += 1;
      window.clearTimeout(copyResetTimer.current);
    };
  }, []);

  async function copyCommand(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      if (!mounted.current) return;
      setCopyHint(undefined);
      setCopied(true);
      window.clearTimeout(copyResetTimer.current);
      copyResetTimer.current = window.setTimeout(() => {
        if (mounted.current) setCopied(false);
      }, COPY_FEEDBACK_MS);
    } catch {
      if (!mounted.current) return;
      setCopied(false);
      selectCommand(commandRef.current);
      setCopyHint(COPY_FALLBACK_HINT);
    }
  }

  async function connectComputer() {
    const attempt = connectAttempt.current + 1;
    connectAttempt.current = attempt;
    setError(undefined);
    try {
      const baseline = new Map(
        (await browserApi.ownComputers()).computers.map((computer: Computer) => [computer.id, computer.connectedAt]),
      );
      if (!mounted.current || connectAttempt.current !== attempt) return;
      const issued = await browserApi.issueConnectCode(teamId);
      if (!mounted.current || connectAttempt.current !== attempt) return;
      const cycle = activePollCycle.current + 1;
      activePollCycle.current = cycle;
      baselineConnections.current = baseline;
      connectCodeExpiresAt.current = Date.parse(issued.issuedAt) + issued.expiresIn * 1_000;
      setError(undefined);
      setBootstrapCommand(issued.bootstrapCommand);
      setComputerConnected(false);
      setRemainingMs(Math.max(0, connectCodeExpiresAt.current - Date.now()));
      setCopied(false);
      setCopyHint(undefined);
      setPollCycle(cycle);
      setWaitingForComputer(true);
    } catch (cause) {
      if (!mounted.current || connectAttempt.current !== attempt) return;
      setError(errorMessage(cause, "Unable to create a Computer connection command"));
    }
  }

  useEffect(() => {
    if (!waitingForComputer || pollCycle === 0) return;
    const baseline = baselineConnections.current;
    const expiresAt = connectCodeExpiresAt.current;
    let active = true;
    let completed = false;
    let pollTimer = 0;
    const expiryTimer = window.setTimeout(
      () => {
        if (!active || completed || activePollCycle.current !== pollCycle) return;
        completed = true;
        window.clearInterval(pollTimer);
        setWaitingForComputer(false);
        setComputerConnected(false);
        setRemainingMs(undefined);
        setError(CONNECT_CODE_EXPIRED_MESSAGE);
      },
      Math.max(0, expiresAt - Date.now()),
    );
    pollTimer = window.setInterval(() => {
      // The existing poll cycle also drives the countdown, so the command needs no timer of its own.
      setRemainingMs(Math.max(0, expiresAt - Date.now()));
      void browserApi.ownComputers().then(
        (value) => {
          if (!active || completed || activePollCycle.current !== pollCycle) return;
          const connected = value.computers.some(
            (computer: Computer) =>
              computer.connectionStatus === "online" &&
              ((!baseline.has(computer.id) && computer.connectedAt !== null) ||
                (baseline.has(computer.id) &&
                  computer.connectedAt !== null &&
                  baseline.get(computer.id) !== computer.connectedAt)),
          );
          if (!connected) return;
          completed = true;
          window.clearInterval(pollTimer);
          window.clearTimeout(expiryTimer);
          setWaitingForComputer(false);
          setComputerConnected(true);
          setRemainingMs(undefined);
          onConnectedRef.current?.();
        },
        (cause: unknown) => {
          if (active && !completed && activePollCycle.current === pollCycle) {
            setError(errorMessage(cause, "Unable to refresh Computers"));
          }
        },
      );
    }, COMPUTER_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(pollTimer);
      window.clearTimeout(expiryTimer);
    };
  }, [pollCycle, waitingForComputer]);

  return (
    <section className="panel">
      <h2>Connect a Local Computer</h2>
      <p>Generate a short-lived command, then run it in a terminal on the Computer.</p>
      <Button className="connect-command-primary" onClick={() => void connectComputer()}>
        Generate connection command
      </Button>
      {bootstrapCommand ? (
        <>
          <pre>
            <code ref={commandRef}>{bootstrapCommand}</code>
          </pre>
          <div className="connect-command-actions">
            <Button variant="secondary" onClick={() => void copyCommand(bootstrapCommand)}>
              {copied ? "Copied" : "Copy command"}
            </Button>
            {waitingForComputer && remainingMs !== undefined ? (
              <p className="connect-command-meta">Expires in {formatRemaining(remainingMs)}</p>
            ) : null}
          </div>
          {copyHint ? <p className="connect-command-meta">{copyHint}</p> : null}
          {waitingForComputer || computerConnected ? (
            <p role="status">{waitingForComputer ? "Waiting for the Computer to connect…" : "Computer connected."}</p>
          ) : null}
        </>
      ) : null}
      {error ? (
        <div className="notice error" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}
