import { useCallback, useEffect, useRef, useState } from "react";
import { browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Text } from "../../ui/design-system.js";
import { useComputersQuery } from "./agent-queries.js";
import { ComputerSetup } from "./computer-setup.js";

/**
 * Giving an Agent the Computer its Account has.
 *
 * There is nothing here for a reader to decide. An Account has one Computer, so an Agent without one
 * has exactly one place it can run, and this surface's whole job is to put it there. It is shared
 * because the two places an Agent can be found without a Computer -- its Settings, and an onboarding
 * run that resumed into it -- must resolve it the same way; the second copy is how the onboarding
 * recovery once ended up pointing at a route the setup gate refuses.
 *
 * An Account with no Computer is the only case where connecting is the answer, and the machine that
 * arrives is by then the Account's only one. Several Computers is not a richer case to choose from
 * but a record that contradicts the product model, so this stops rather than guessing which one the
 * Agent was meant to run on.
 */
export function AgentComputerChoice({
  agentId,
  onBound,
}: {
  agentId: string;
  /** Called once the Agent has the Account's Computer, so the surface around this can move on. */
  onBound: () => void;
}) {
  const computersQuery = useComputersQuery();
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState<string>();
  // A bind is attempted once per Agent-and-Computer pair. Without this a failure would be retried by
  // every render the failure itself causes, and the reader would watch an error flicker instead of
  // reading it. The Agent belongs in the key because this surface outlives any one of them: reused
  // for a second unbound Agent on the same Account, a Computer-only key would report the first
  // Agent's bind as this one's and leave the second waiting on a bind that never ran.
  const attempted = useRef<string | undefined>(undefined);
  // Only a successful read speaks for the Account. Answering a failed one with "connect a Computer"
  // would send someone to enrol a machine they already own -- the same conflation the Agent's
  // availability refuses to make one layer up.
  const enrolled = computersQuery.isSuccess ? computersQuery.data.computers : undefined;
  const computer = enrolled?.length === 1 ? enrolled[0] : undefined;
  const target = computer ? `${agentId}:${computer.computerId}` : undefined;

  const bind = useCallback(
    async (computerId: string) => {
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
    },
    [agentId, onBound],
  );

  useEffect(() => {
    if (!computer || !target || attempted.current === target) return;
    attempted.current = target;
    // A new target answers for itself. Leaving the previous one's failure on screen would attribute
    // it to an Agent that has not been tried yet.
    setError(undefined);
    void bind(computer.computerId);
  }, [computer, target, bind]);

  function retry(computerId: string) {
    void bind(computerId);
  }

  if (error && computer) {
    return (
      <div className="grid gap-4">
        <Banner variant="error" role="alert" description={error} />
        <div>
          <Button disabled={binding} size="compact" variant="secondary" onClick={() => retry(computer.computerId)}>
            {m.common_try_again()}
          </Button>
        </div>
      </div>
    );
  }

  if (enrolled === undefined) {
    return (
      <div className="grid gap-2">
        {computersQuery.isError ? (
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
        )}
      </div>
    );
  }

  /*
   * Enrolments made before the one-Computer rule can still reach this client. Picking one of them
   * would hand the Agent a durable home on the strength of list order, so the contradiction is
   * reported and left to be repaired where the records are.
   */
  if (enrolled.length > 1) {
    return <Banner variant="error" role="alert" description={m.agents_computer_choice_multiple()} />;
  }

  if (computer) return <p>{m.agents_computer_choice_binding({ name: computer.displayName })}</p>;

  return (
    <div className="grid gap-2">
      <Text variant="heading">{m.agents_computer_choice_connect_new()}</Text>
      {/*
       * Connecting is offered only to an Account that has none, so the machine that arrives is the
       * Computer this Account has. Refetching is what binds it: the read that finds it runs the
       * bind above, and the Agent lands on it without asking the reader to confirm the obvious.
       */}
      <ComputerSetup onConnected={() => void computersQuery.refetch()} />
    </div>
  );
}
