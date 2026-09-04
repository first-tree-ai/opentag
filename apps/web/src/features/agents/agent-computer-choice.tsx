import type { AccountComputerSummary } from "@opentag/shared/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Text } from "../../ui/design-system.js";
import { ComputerConnect, type ComputerConnectAdapter } from "../computer-connect/computer-connect.js";
import { platformLabel } from "./agent-presentation.js";
import { useComputersQuery } from "./agent-queries.js";

/** What a bind is aimed at, named so a failure can be reported and retried against it. */
type BindTarget = { computerId: string; displayName: string };

/** The Server reads and writes that the Review Lab replaces with its in-memory Account. */
export interface AgentComputerInventoryAdapter {
  readonly bindComputer: (agentId: string, computerId: string) => Promise<void>;
  readonly computers: () => Promise<{ readonly computers: readonly AccountComputerSummary[] }>;
}

interface MemoryInventoryState {
  readonly computers: readonly AccountComputerSummary[] | undefined;
  readonly error: boolean;
}

function useComputerInventory(inventoryAdapter: AgentComputerInventoryAdapter | undefined) {
  const computersQuery = useComputersQuery(false, inventoryAdapter === undefined);
  const [memoryInventory, setMemoryInventory] = useState<MemoryInventoryState>({
    computers: undefined,
    error: false,
  });
  const readMemoryInventory = useCallback(async () => {
    if (!inventoryAdapter) return;
    setMemoryInventory({ computers: undefined, error: false });
    try {
      const result = await inventoryAdapter.computers();
      setMemoryInventory({ computers: result.computers, error: false });
    } catch {
      setMemoryInventory({ computers: undefined, error: true });
    }
  }, [inventoryAdapter]);

  useEffect(() => {
    void readMemoryInventory();
  }, [readMemoryInventory]);

  return inventoryAdapter
    ? { computers: memoryInventory.computers, error: memoryInventory.error, refetch: readMemoryInventory }
    : {
        computers: computersReadAfterMount(computersQuery),
        error: computersQuery.isError,
        refetch: computersQuery.refetch,
      };
}

/**
 * The Account's Computers, from a read this mount made and no other.
 *
 * Only a successful read speaks for the Account: answering a failed one with "connect a Computer"
 * would send someone to enrol a machine they already own -- the same conflation the Agent's
 * availability refuses to make one layer up.
 *
 * And only a read made after this mount. The cache is served on mount while the re-read runs, and
 * it is filled by whichever page the reader came from: a bind decided from it can pick the one
 * Computer the Account had before a second was connected elsewhere, or one it no longer has -- a
 * durable placement the reader never chose. The re-read is what the automatic bind waits for, so
 * until it lands there is nothing to bind from.
 */
function computersReadAfterMount(query: ReturnType<typeof useComputersQuery>) {
  return query.isSuccess && query.isFetchedAfterMount ? query.data.computers : undefined;
}

/**
 * Giving an Agent a Computer to run on.
 *
 * An Account may hold no Computers, one, or several, and the surface answers each honestly. With
 * several, which one an Agent runs on is the reader's to say and nothing here decides it for them:
 * binding on list order would hand an Agent a durable home on the strength of an array index. With
 * exactly one there is nothing to disambiguate, so the read is the decision and no click is asked
 * for. With none, connecting is the answer, and the connect step names the machine it connected.
 *
 * It is shared because the two places an Agent can be found without a Computer -- its Settings, and
 * an onboarding run that resumed into it -- must resolve it the same way; the second copy is how the
 * onboarding recovery once ended up pointing at a route the setup gate refuses.
 */
export function AgentComputerChoice({
  adapter,
  agentId,
  inventoryAdapter,
  onBound,
}: {
  /** Lets Agent setup issue a command targeted at the Agent being recovered. */
  adapter?: ComputerConnectAdapter;
  agentId: string;
  /** Keeps Internal Tools on its in-memory Account instead of reading or mutating the Server. */
  inventoryAdapter?: AgentComputerInventoryAdapter;
  /**
   * Called when the Agent's Computer may have changed -- after a bind here, or after the reader
   * resolved it somewhere this surface cannot see -- so the surface around this reads again.
   */
  onBound: () => void;
}) {
  const inventory = useComputerInventory(inventoryAdapter);
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState<string>();
  /*
   * What this surface is binding to, held here rather than read back out of the Computers query.
   * A Computer that just connected is known to the connect step and not to that query -- it reads
   * through its own adapter and does not refill this cache -- so deriving the bind target from the
   * inventory would leave a failed bind for a brand new Computer invisible and unretryable.
   */
  const [pending, setPending] = useState<BindTarget>();
  /** Retires the writes of a bind that a later one, or a different Agent, has superseded. */
  const generation = useRef(0);
  // A bind is attempted once per Agent-and-Computer pair, so a failure is not restarted by every
  // render it causes. The Agent belongs in the key because this surface outlives any one of them.
  const attempted = useRef<string | undefined>(undefined);
  const connected = inventory.computers;
  const sole = connected?.length === 1 ? connected[0] : undefined;
  const soleTarget = sole ? `${agentId}:${sole.computerId}` : undefined;

  const bind = useCallback(
    async (goal: BindTarget) => {
      const mine = generation.current + 1;
      generation.current = mine;
      attempted.current = `${agentId}:${goal.computerId}`;
      setPending(goal);
      setBinding(true);
      setError(undefined);
      try {
        if (inventoryAdapter) await inventoryAdapter.bindComputer(agentId, goal.computerId);
        else await browserApi.rebindAgentComputer(agentId, goal.computerId);
        /*
         * Two binds can be in flight when this surface is reused for a second Agent, and they can
         * settle in either order. Every write below belongs to the attempt that is still current;
         * without this an older Agent's late reply would overwrite the newer one's result and clear
         * a `binding` that is still true, which is an invitation to start a second bind for it.
         */
        if (generation.current !== mine) return;
        /*
         * Reading again is also how an automatic bind is revalidated. If the Account gained a second
         * Computer while this was in flight, the placement is still whatever the Server now records,
         * and asking the surface around this to re-read reports that rather than asserting a choice
         * from an inventory that has since changed.
         */
        onBound();
      } catch (cause) {
        if (generation.current !== mine) return;
        setError(cause instanceof Error && cause.message ? cause.message : m.agents_computer_choice_bind_failed());
      } finally {
        if (generation.current === mine) setBinding(false);
      }
    },
    [agentId, inventoryAdapter, onBound],
  );

  // A different Agent answers for itself: the previous one's target and failure are not its result,
  // and any bind still in flight for it must not write over this one.
  useEffect(() => {
    if (attempted.current?.startsWith(`${agentId}:`)) return;
    generation.current += 1;
    setPending(undefined);
    setError(undefined);
    setBinding(false);
  }, [agentId]);

  // Only the unambiguous case binds itself. Several Computers is a question for the reader, and an
  // automatic bind must never start from one.
  useEffect(() => {
    if (!sole || !soleTarget || attempted.current === soleTarget) return;
    void bind(sole);
  }, [sole, soleTarget, bind]);

  if (connected === undefined) {
    return (
      <div className="grid gap-2">
        {inventory.error ? (
          <>
            <p>{m.agents_computer_choice_read_failed()}</p>
            <div>
              <Button size="compact" variant="secondary" onClick={() => void inventory.refetch()}>
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

  // Keyed on what was actually being bound, not on the inventory, so a Computer the connect step
  // just produced can still report its failure and be retried -- without issuing a second code.
  if (error && pending && !sole && connected.length <= 1) {
    return (
      <div className="grid gap-4">
        <Banner variant="error" role="alert" description={error} />
        <div>
          <Button disabled={binding} size="compact" variant="secondary" onClick={() => void bind(pending)}>
            {m.common_try_again()}
          </Button>
        </div>
      </div>
    );
  }

  if (sole) {
    if (error) {
      return (
        <div className="grid gap-4">
          <Banner variant="error" role="alert" description={error} />
          <div>
            <Button disabled={binding} size="compact" variant="secondary" onClick={() => void bind(sole)}>
              {m.common_try_again()}
            </Button>
          </div>
        </div>
      );
    }
    return <p>{m.agents_computer_choice_binding({ name: sole.displayName })}</p>;
  }

  // `pending` covers the moment after a Computer enrols: it is on the Account, but this query has
  // not been told about it, and offering to connect another one there would be wrong.
  if (connected.length === 0 && pending) {
    return <p>{m.agents_computer_choice_binding({ name: pending.displayName })}</p>;
  }

  return (
    <div className="grid gap-4">
      {error ? <Banner variant="error" role="alert" description={error} /> : null}
      {connected.length > 0 ? (
        <div className="grid gap-2">
          <Text as="h3" variant="heading">
            {m.agents_computer_choice_existing_heading()}
          </Text>
          <ul className="grid gap-2">
            {connected.map((computer) => (
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
                  onClick={() => void bind({ computerId: computer.computerId, displayName: computer.displayName })}
                >
                  {m.agents_computer_choice_use({ name: computer.displayName })}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="grid gap-2">
        {/*
         * The connect step reports the machine it connected, so what gets bound is the Computer that
         * answered this command rather than whatever a re-read of the inventory happens to find.
         */}
        <ComputerConnect
          adapter={adapter}
          intent={{ mode: "create" }}
          onConnected={(connected) =>
            void bind({ computerId: connected.computerId, displayName: connected.displayName })
          }
        />
      </div>
    </div>
  );
}
