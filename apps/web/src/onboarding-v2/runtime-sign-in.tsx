import type { AgentRuntimeProvider } from "@opentag/shared/browser";
import { useId, useState } from "react";
import { RUNTIME_SIGN_IN_HASH } from "../features/agents/agent-routes.js";
import * as m from "../paraglide/messages.js";
import { Button, Icon } from "../ui/design-system.js";

/** The terminal commands that sign a runtime in on the reader's own computer, when it has them. */
export function runtimeSignInCommands(provider: AgentRuntimeProvider): readonly string[] | undefined {
  if (provider === "claude-code") return ["claude", "/login"];
  if (provider === "codex") return ["codex login"];
  return undefined;
}

/**
 * "Sign in" for a runtime that is installed but signed out. Sign-in stays on the reader's computer:
 * openTag only checks it and never holds Claude or Codex credentials, so the action opens the
 * terminal steps rather than a Web sign-in. The page's own Check again, with its hint, follows the
 * steps, so they do not repeat it. It opens already expanded when the page is reached from the Agent
 * list's "Sign in" link.
 */
export function RuntimeSignIn({
  computerName,
  provider,
}: {
  readonly computerName: string;
  readonly provider: AgentRuntimeProvider;
}) {
  const commands = runtimeSignInCommands(provider);
  const [open, setOpen] = useState(() => readOpenedFromLink());
  const stepsId = useId();
  if (!commands) return null;
  return (
    <div className="mt-2 flex flex-col items-start gap-2" data-ui="runtime-sign-in">
      <Button
        aria-controls={stepsId}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        size="compact"
        variant="secondary"
      >
        {m.onboarding_v2_runtime_sign_in_action()}
        <Icon className="size-3.5" name={open ? "chevron-up" : "chevron-down"} />
      </Button>
      {open ? (
        <ol className="m-0 flex list-decimal flex-col gap-2 pl-5 text-sm text-kumo-default" id={stepsId}>
          <li>{m.onboarding_v2_runtime_sign_in_open_terminal({ computerName })}</li>
          {provider === "claude-code" ? (
            <>
              <li>
                {m.onboarding_v2_runtime_sign_in_run()} <CommandChip text="claude" />
              </li>
              <li>
                {m.onboarding_v2_runtime_sign_in_enter()} <CommandChip text="/login" />
                {m.onboarding_v2_runtime_sign_in_follow()}
              </li>
            </>
          ) : (
            <li>
              {m.onboarding_v2_runtime_sign_in_run()} <CommandChip text="codex login" />
              {m.onboarding_v2_runtime_sign_in_follow()}
            </li>
          )}
        </ol>
      ) : null}
    </div>
  );
}

function readOpenedFromLink(): boolean {
  try {
    return window.location.hash === `#${RUNTIME_SIGN_IN_HASH}`;
  } catch {
    return false;
  }
}

/** A short command, shown inline; it is short enough to type, so it carries no copy control. */
function CommandChip({ text }: { readonly text: string }) {
  return <code className="rounded-md bg-kumo-recessed px-1.5 py-0.5 font-mono text-sm text-kumo-strong">{text}</code>;
}
