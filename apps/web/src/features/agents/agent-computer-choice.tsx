import { useState } from "react";
import { browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Text } from "../../ui/design-system.js";
import { platformLabel } from "./agent-presentation.js";
import { useComputersQuery } from "./agent-queries.js";
import { ComputerSetup } from "./computer-setup.js";

/**
 * Choosing which Computer an Agent runs on.
 *
 * It is shared because the two places that need it are the two places an Agent can be found without
 * one — its Settings, and an onboarding run that resumed into it — and a reader who follows either
 * route must arrive at the same controls. Duplicating it once let the two drift; the second copy is
 * how the onboarding recovery ended up pointing at a route the setup gate refuses.
 *
 * Every bind here is an act the reader took against a named machine. Connecting a new Computer only
 * puts it in the list: the connect step can tell that *a* Computer arrived, not that it is the one
 * that ran the command, and that is not evidence enough to hand an Agent a durable home. The reader
 * closes that gap by picking, which is the one thing the Server cannot infer for them.
 */
export function AgentComputerChoice({
  agentId,
  onBound,
}: {
  agentId: string;
  /** Called once the Agent has the chosen Computer, so the surface around this can move on. */
  onBound: () => void;
}) {
  const computersQuery = useComputersQuery();
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState<string>();
  // Only a successful read speaks for the Account. Answering a failed one with "connect a new
  // Computer" would send someone to enrol a machine they already own -- the same conflation the
  // Agent's availability refuses to make one layer up.
  const enrolled = computersQuery.isSuccess ? computersQuery.data.computers : undefined;

  async function bind(computerId: string) {
    try {
      setBinding(true);
      setError(undefined);
      await browserApi.rebindAgentComputer(agentId, computerId);
      onBound();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : m.agents_computer_choice_bind_failed());
    } finally {
      setBinding(false);
    }
  }

  return (
    <div className="grid gap-4">
      {error ? <Banner variant="error" role="alert" description={error} /> : null}
      {/*
       * An Account that genuinely has no Computers is offered nothing to pick from: the section is
       * absent, not empty. A read that failed keeps it, because those are different facts and this
       * is the surface where confusing them sends someone to enrol a machine they already own.
       */}
      {enrolled !== undefined && enrolled.length === 0 ? null : (
        <div className="grid gap-2">
          <Text variant="heading">{m.agents_computer_choice_existing_heading()}</Text>
          {enrolled === undefined ? (
            computersQuery.isError ? (
              <>
                <p>{m.agents_computer_choice_read_failed()}</p>
                <div>
                  <Button size="compact" variant="secondary" onClick={() => void computersQuery.refetch()}>
                    {m.common_try_again()}
                  </Button>
                </div>
              </>
            ) : (
              <p>{m.agents_computer_choice_loading()}</p>
            )
          ) : (
            <ul className="grid gap-2">
              {enrolled.map((computer) => (
                <li className="flex flex-wrap items-center justify-between gap-3" key={computer.computerId}>
                  <span>
                    {computer.displayName} · {platformLabel(computer.platform)} ·{" "}
                    {computer.connectionStatus === "online"
                      ? m.agents_computer_choice_online()
                      : m.agents_computer_choice_offline()}
                  </span>
                  <Button
                    disabled={binding}
                    size="compact"
                    variant="secondary"
                    onClick={() => void bind(computer.computerId)}
                  >
                    {m.agents_computer_choice_use({ name: computer.displayName })}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="grid gap-2">
        <Text variant="heading">{m.agents_computer_choice_connect_new()}</Text>
        {/*
         * Connecting adds the machine to the list above; it does not bind it. What this step
         * observes is an arrival -- a Computer that appeared or reconnected since it started -- and
         * an arrival cannot prove which machine ran the command. Picking it is the reader's, and it
         * is one click away once it appears.
         */}
        <ComputerSetup onConnected={() => void computersQuery.refetch()} />
      </div>
    </div>
  );
}
