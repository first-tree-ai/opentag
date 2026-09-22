import type { AccountComputerSummary } from "@opentag/shared/browser";
import * as m from "../../paraglide/messages.js";
import { InstructionBlock } from "../../setup/index.js";

export function ComputerRecoveryInstructions({
  computer,
  expandable = false,
}: {
  readonly expandable?: boolean;
  readonly computer: Pick<AccountComputerSummary, "computerId" | "displayName">;
}) {
  const instructions = m.computer_connect_recovery_instructions({
    computerName: computer.displayName,
    computerId: computer.computerId,
  });
  return (
    <div className="grid min-w-0 gap-3" data-ui="computer-recovery-instructions">
      <p className="text-kumo-subtle">{m.computer_connect_recovery_intro({ computerName: computer.displayName })}</p>
      <InstructionBlock
        key={instructions}
        expansion={
          expandable ? { show: m.computer_instructions_show(), hide: m.computer_instructions_hide() } : undefined
        }
        instructions={instructions}
        label={m.computer_connect_recovery_title()}
        copyLabel={m.computer_connect_recovery_copy()}
        copiedLabel={m.computer_connect_recovery_copied()}
        fallbackHint={m.computer_connect_recovery_copy_fallback()}
      />
    </div>
  );
}
