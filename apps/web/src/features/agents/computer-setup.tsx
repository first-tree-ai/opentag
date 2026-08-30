import type { WorkspaceComputerSummary } from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "../../api.js";
import { Banner, Button, ClipboardText, Loader, Text } from "../../ui/design-system.js";

const COMPUTER_POLL_INTERVAL_MS = 1_500;
const CONNECT_CODE_EXPIRED_MESSAGE = "This Computer connection command expired. Generate a new one to continue.";
/**
 * The command and validity Preview shows in place of an issued one. Review needs the shape of this
 * step — a long install-and-connect line, its copy affordance and a running validity — and none of
 * it is a fact about a Computer, so it is stated here rather than read from the Server.
 */
const PREVIEW_BOOTSTRAP_COMMAND =
  "npm i -g @opentag/cli && opentag computer connect --server https://opentag.example.com -- preview-connect-code";
const PREVIEW_CONNECT_CODE_REMAINING_MS = 900_000;

export interface ComputerSetupProps {
  onConnected?: (computer: WorkspaceComputerSummary) => void;
  /**
   * Renders the panel for review only: it issues no connect code, starts no Computer polling and
   * never resolves a connection. The panel still answers the primary action, from a fixed command,
   * so review sees the same hierarchy production shows after the code is issued.
   */
  preview?: boolean;
  /** Scopes the panel to one enrollment so a recovery flow names the Computer it came from. */
  target?: { computerId: string; displayName: string };
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** Renders the remaining connect-code validity as m:ss without rounding a live second up. */
function formatRemaining(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ComputerSetup({ onConnected, preview, target }: ComputerSetupProps) {
  return (
    <ComputerSetupLifecycle
      key={target?.computerId ?? ""}
      onConnected={onConnected}
      preview={preview}
      target={target}
    />
  );
}

function ComputerSetupLifecycle({ onConnected, preview = false, target }: ComputerSetupProps) {
  const targetComputerId = target?.computerId;
  const targetName = target?.displayName;
  const [bootstrapCommand, setBootstrapCommand] = useState<string>();
  const [error, setError] = useState<string>();
  const [waitingForComputer, setWaitingForComputer] = useState(false);
  const [computerConnected, setComputerConnected] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [pollCycle, setPollCycle] = useState(0);
  const [remainingMs, setRemainingMs] = useState<number>();
  const baselineConnections = useRef<Map<string, string | null>>(new Map());
  const connectCodeExpiresAt = useRef(0);
  const connectAttempt = useRef(0);
  const activePollCycle = useRef(0);
  const mounted = useRef(false);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      connectAttempt.current += 1;
      activePollCycle.current += 1;
    };
  }, []);

  async function connectComputer() {
    // Preview must never issue a connect code: that is durable Server state, not a rendered state.
    // It renders the state that follows one instead. `pollCycle` stays at 0, which is what keeps the
    // poll and expiry effect below inert, so no Computer is ever read and the validity never counts
    // down to a failure Preview cannot recover from.
    if (preview) {
      setError(undefined);
      setBootstrapCommand(PREVIEW_BOOTSTRAP_COMMAND);
      setComputerConnected(false);
      setRemainingMs(PREVIEW_CONNECT_CODE_REMAINING_MS);
      setWaitingForComputer(true);
      return;
    }
    const attempt = connectAttempt.current + 1;
    connectAttempt.current = attempt;
    setGenerating(true);
    setError(undefined);
    try {
      const baseline = new Map(
        (await browserApi.computers()).computers.map((computer) => [computer.computerId, computer.connectedAt]),
      );
      if (!mounted.current || connectAttempt.current !== attempt) return;
      const issued = await browserApi.issueComputerConnectCode();
      if (!mounted.current || connectAttempt.current !== attempt) return;
      const cycle = activePollCycle.current + 1;
      activePollCycle.current = cycle;
      baselineConnections.current = baseline;
      connectCodeExpiresAt.current = Date.parse(issued.issuedAt) + issued.expiresIn * 1_000;
      setError(undefined);
      setBootstrapCommand(issued.bootstrapCommand);
      setComputerConnected(false);
      setRemainingMs(Math.max(0, connectCodeExpiresAt.current - Date.now()));
      setPollCycle(cycle);
      setWaitingForComputer(true);
      setGenerating(false);
    } catch (cause) {
      if (!mounted.current || connectAttempt.current !== attempt) return;
      setError(errorMessage(cause, "Unable to create a Computer connection command"));
      setGenerating(false);
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
      void browserApi.computers().then(
        (value) => {
          if (!active || completed || activePollCycle.current !== pollCycle) return;
          const reconnected = value.computers.filter(
            (computer) =>
              computer.connectionStatus === "online" &&
              ((!baseline.has(computer.computerId) && computer.connectedAt !== null) ||
                (baseline.has(computer.computerId) &&
                  computer.connectedAt !== null &&
                  baseline.get(computer.computerId) !== computer.connectedAt)),
          );
          // The Computers response carries no link back to the issued code, so another Computer
          // registering says nothing about this command. A targeted recovery waits for its own
          // Computer and lets the code expire rather than reading a foreign reconnection as proof.
          const connected = targetComputerId
            ? reconnected.find((computer) => computer.computerId === targetComputerId)
            : reconnected[0];
          if (!connected) return;
          completed = true;
          window.clearInterval(pollTimer);
          window.clearTimeout(expiryTimer);
          setWaitingForComputer(false);
          setComputerConnected(true);
          setRemainingMs(undefined);
          onConnectedRef.current?.(connected);
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
  }, [pollCycle, targetComputerId, waitingForComputer]);

  return (
    <section className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line">
      <Text as="h2" variant="heading">
        {targetName ? `Reconnect ${targetName}` : "Connect a Local Computer"}
      </Text>
      {/*
        Connecting a new Computer needs no machine named: whichever terminal runs the command is the
        Computer that gets enrolled, so saying "on this computer" would only be wrong for anyone who
        runs it over SSH. Reconnecting is the opposite — one enrollment is being restored, and it has
        to happen on that machine.
      */}
      <Text as="p" variant="secondary">
        Generate a command, then run it in the terminal{targetName ? ` on ${targetName}` : ""}.
      </Text>
      <Button loading={generating} disabled={generating} onClick={() => void connectComputer()}>
        Generate connection command
      </Button>
      {bootstrapCommand ? (
        <>
          <ClipboardText
            className="max-w-full"
            labels={{ copyAction: "Copy command" }}
            size="sm"
            text={bootstrapCommand}
            tooltip={{ copiedText: "Copied!", side: "top", text: "Copy command" }}
          />
          <div className="flex flex-wrap items-center gap-3">
            {waitingForComputer && remainingMs !== undefined ? (
              <p className="text-sm text-kumo-subtle">Expires in {formatRemaining(remainingMs)}</p>
            ) : null}
          </div>
          {waitingForComputer || computerConnected ? (
            <p className="flex items-center gap-2" role="status">
              {waitingForComputer ? (
                <span aria-hidden="true">
                  <Loader aria-label="Waiting for Computer connection" size="sm" />
                </span>
              ) : null}
              {waitingForComputer
                ? `Waiting for ${targetName ?? "the Computer"} to connect…`
                : targetName
                  ? `${targetName} is connected.`
                  : "Computer connected."}
            </p>
          ) : null}
        </>
      ) : null}
      {error ? <Banner variant="error" role="alert" description={error} /> : null}
    </section>
  );
}
