import type { Computer } from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "./api.js";

const COMPUTER_POLL_INTERVAL_MS = 1_500;

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
  const baselineComputers = useRef<Map<string, string>>(new Map());
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
        (await browserApi.ownComputers()).computers.map((computer: Computer) => [computer.id, computer.lastSeenAt]),
      );
      if (!mounted.current || connectAttempt.current !== attempt) return;
      baselineComputers.current = baseline;
      const issued = await browserApi.issueConnectCode(teamId);
      if (!mounted.current || connectAttempt.current !== attempt) return;
      setBootstrapCommand(issued.bootstrapCommand);
      setWaitingForComputer(true);
    } catch (cause) {
      if (!mounted.current || connectAttempt.current !== attempt) return;
      setError(errorMessage(cause, "Unable to create a Computer connection command"));
    }
  }

  useEffect(() => {
    if (!waitingForComputer) return;
    let active = true;
    let completed = false;
    const timer = window.setInterval(() => {
      void browserApi.ownComputers().then(
        (value) => {
          if (!active || completed) return;
          const connected = value.computers.some(
            (computer: Computer) => baselineComputers.current.get(computer.id) !== computer.lastSeenAt,
          );
          if (!connected) return;
          completed = true;
          window.clearInterval(timer);
          setWaitingForComputer(false);
          onConnectedRef.current?.();
        },
        (cause: unknown) => {
          if (active && !completed) setError(errorMessage(cause, "Unable to refresh Computers"));
        },
      );
    }, COMPUTER_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [waitingForComputer]);

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
          <p role="status">{waitingForComputer ? "Waiting for the Computer to connect…" : "Computer connected."}</p>
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
