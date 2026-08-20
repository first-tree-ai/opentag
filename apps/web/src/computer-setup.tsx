import type { Computer } from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "./api.js";

const COMPUTER_POLL_INTERVAL_MS = 1_500;
const CONNECT_CODE_EXPIRED_MESSAGE = "This Computer connection command expired. Generate a new one to continue.";

export interface ComputerSetupProps {
  teamId: string;
  onConnected?: () => void;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
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
  const baselineConnections = useRef<Map<string, string | null>>(new Map());
  const connectCodeExpiresAt = useRef(0);
  const connectAttempt = useRef(0);
  const mounted = useRef(false);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      connectAttempt.current += 1;
    };
  }, []);

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
      baselineConnections.current = baseline;
      connectCodeExpiresAt.current = Date.parse(issued.issuedAt) + issued.expiresIn * 1_000;
      setBootstrapCommand(issued.bootstrapCommand);
      setComputerConnected(false);
      setPollCycle(attempt);
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
        if (!active || completed) return;
        completed = true;
        window.clearInterval(pollTimer);
        setWaitingForComputer(false);
        setComputerConnected(false);
        setError(CONNECT_CODE_EXPIRED_MESSAGE);
      },
      Math.max(0, expiresAt - Date.now()),
    );
    pollTimer = window.setInterval(() => {
      void browserApi.ownComputers().then(
        (value) => {
          if (!active || completed) return;
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
          onConnectedRef.current?.();
        },
        (cause: unknown) => {
          if (active && !completed) setError(errorMessage(cause, "Unable to refresh Computers"));
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
      <button className="button" type="button" onClick={() => void connectComputer()}>
        Generate connection command
      </button>
      {bootstrapCommand ? (
        <>
          <pre>
            <code>{bootstrapCommand}</code>
          </pre>
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
