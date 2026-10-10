import type { AccountComputerSummary } from "@opentag/shared/browser";
import { type RefObject, useLayoutEffect, useRef } from "react";
import * as m from "../../paraglide/messages.js";
import { InstructionBlock } from "../../setup/index.js";

export function ComputerRecoveryInstructions({
  computer,
  command,
  returnFocusRef,
}: {
  readonly command: string;
  readonly computer: Pick<AccountComputerSummary, "computerId" | "displayName">;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const instructionsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const instructions = instructionsRef.current;
    return () => {
      // Expiry or a confirmed connection can remove the focused control asynchronously.
      if (instructions?.contains(document.activeElement)) {
        returnFocusRef.current?.focus({ preventScroll: true });
      }
    };
  }, [returnFocusRef]);
  const instructions = m.computer_connect_recovery_instructions({
    computerName: computer.displayName,
    computerId: computer.computerId,
    command,
  });
  return (
    <div ref={instructionsRef} className="grid min-w-0 gap-3" data-ui="computer-recovery-instructions">
      <p className="text-sm text-kumo-subtle">{m.computer_connect_recovery_intro()}</p>
      <InstructionBlock
        key={instructions}
        preview={m.computer_connect_recovery_preview()}
        expansion={{ show: m.computer_instructions_show(), hide: m.computer_instructions_hide() }}
        instructions={instructions}
        label={m.computer_connect_recovery_title()}
        copyLabel={m.computer_connect_recovery_copy()}
        copiedLabel={m.computer_connect_recovery_copied()}
        fallbackHint={m.computer_connect_recovery_copy_fallback()}
      />
    </div>
  );
}
