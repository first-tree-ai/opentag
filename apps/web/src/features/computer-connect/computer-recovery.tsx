import type { AccountComputerSummary } from "@opentag/shared/browser";
import * as m from "../../paraglide/messages.js";
import { Button, Collapsible, Icon } from "../../ui/design-system.js";
import {
  type ComputerConnectAdapter,
  type ComputerConnectIntent,
  type ComputerConnectLifecycle,
  ComputerConnectLifecycleRoot,
  ComputerConnectPresentation,
} from "./computer-connect.js";
import { ComputerRecoveryInstructions } from "./computer-recovery-instructions.js";

type RecoveryComputer = Pick<AccountComputerSummary, "computerId" | "displayName" | "platform">;

/** Account management and setup share the same help without treating ordinary offline as a reinstall. */
export function ComputerRecovery({
  computer,
  adapter,
  onConnected,
}: {
  readonly computer: RecoveryComputer;
  readonly adapter?: ComputerConnectAdapter;
  readonly onConnected: () => void;
}) {
  const intent: ComputerConnectIntent = { mode: "repair", target: computer };
  return (
    <ComputerConnectLifecycleRoot adapter={adapter} intent={intent} onConnected={onConnected}>
      {(lifecycle) => (
        <div className="grid min-w-0 gap-3 text-sm" data-ui="computer-recovery">
          <p>{m.computer_connect_recovery_wake()}</p>
          <Collapsible.Root>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-kumo-subtle">{m.computer_connect_recovery_still_offline()}</span>
              <Collapsible.Trigger render={<Button variant="ghost" size="compact" className="text-kumo-link" />}>
                {m.computer_connect_recovery_help()}
                <Icon name="chevron-right" className="size-4 in-data-[panel-open]:rotate-90" />
              </Collapsible.Trigger>
            </div>
            <Collapsible.Panel className="grid min-w-0 gap-4 pt-4">
              <RecoveryHelp computer={computer} intent={intent} lifecycle={lifecycle} />
            </Collapsible.Panel>
          </Collapsible.Root>
        </div>
      )}
    </ComputerConnectLifecycleRoot>
  );
}

function RecoveryHelp({
  computer,
  intent,
  lifecycle,
}: {
  readonly computer: RecoveryComputer;
  readonly intent: ComputerConnectIntent;
  readonly lifecycle: ComputerConnectLifecycle;
}) {
  // The lifecycle lives above the disclosure: closing help never loses or reissues a live command.
  // Once repair starts, replace the diagnostic instructions with the requested authorization.
  if (lifecycle.state.kind !== "idle") {
    return <ComputerConnectPresentation intent={intent} lifecycle={lifecycle} />;
  }
  return (
    <div className="grid min-w-0 gap-5" data-ui="computer-recovery-help">
      <ComputerRecoveryInstructions computer={computer} />
      <Collapsible.Root>
        <Collapsible.Trigger render={<Button variant="ghost" size="compact" className="text-kumo-subtle" />}>
          {m.computer_connect_recovery_repair_help()}
          <Icon name="chevron-right" className="size-4 in-data-[panel-open]:rotate-90" />
        </Collapsible.Trigger>
        <Collapsible.Panel className="grid gap-3 pt-3">
          <p className="text-kumo-subtle">{m.computer_connect_recovery_repair_scope()}</p>
          <Button className="w-fit" variant="secondary" size="compact" onClick={lifecycle.issue}>
            {m.computer_connect_repair_action()}
          </Button>
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  );
}
