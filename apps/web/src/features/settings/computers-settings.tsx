import type { Computer, TeamComputerSummary } from "@opentag/shared/browser";
import { useEffect, useRef, useState } from "react";
import { browserApi } from "../../api.js";
import { formatDate } from "../../lib/format.js";
import { useResource } from "../../lib/resource.js";
import { AsyncState } from "../../ui/async-state.js";
import { RowList } from "../../ui/data-display.js";
import { Notice, Status } from "../../ui/feedback.js";

export function ComputersSettings({ canManage, teamId }: { canManage: boolean; teamId: string }) {
  const [reload, setReload] = useState(0);
  const state = useResource(() => browserApi.computers.listForTeam(teamId), `${teamId}:${reload}`);
  const [bootstrapCommand, setBootstrapCommand] = useState<string>();
  const [error, setError] = useState<string>();
  const [waitingForComputer, setWaitingForComputer] = useState(false);
  const baselineComputers = useRef<Map<string, string>>(new Map());
  async function connectComputer() {
    try {
      setError(undefined);
      baselineComputers.current = new Map(
        (await browserApi.computers.listMine()).computers.map((computer: Computer) => [
          computer.id,
          computer.lastSeenAt,
        ]),
      );
      const issued = await browserApi.computers.issueConnectCode(teamId);
      setBootstrapCommand(issued.bootstrapCommand);
      setWaitingForComputer(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create a Computer connection command");
    }
  }
  useEffect(() => {
    if (!waitingForComputer) return;
    const timer = window.setInterval(() => {
      void browserApi.computers.listMine().then(
        (value) => {
          if (
            value.computers.some(
              (computer: Computer) => baselineComputers.current.get(computer.id) !== computer.lastSeenAt,
            )
          ) {
            setWaitingForComputer(false);
            setReload((current) => current + 1);
          }
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : "Unable to refresh Computers"),
      );
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [waitingForComputer]);
  return (
    <>
      {canManage ? (
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
              <Status>{waitingForComputer ? "Waiting for the Computer to connect…" : "Computer connected."}</Status>
            </>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
        </section>
      ) : null}
      <AsyncState state={state}>
        {(value) => (
          <RowList items={value.computers} itemKey={(computer: TeamComputerSummary) => computer.id}>
            {(computer: TeamComputerSummary) => (
              <>
                <span>
                  <strong>{computer.displayName}</strong>
                  <small>
                    {computer.ownerDisplayName} · {computer.platform}
                  </small>
                </span>
                <span>
                  {computer.connectionStatus} · observed {formatDate(computer.observedAt)}
                </span>
              </>
            )}
          </RowList>
        )}
      </AsyncState>
    </>
  );
}
