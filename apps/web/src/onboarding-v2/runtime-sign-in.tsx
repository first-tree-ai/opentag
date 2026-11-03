import type { AgentRuntimeProvider } from "@opentag/shared/browser";
import { useEffect, useId, useRef, useState } from "react";
import { RUNTIME_SIGN_IN_HASH } from "../features/agents/agent-routes.js";
import * as m from "../paraglide/messages.js";
import { Button, Icon } from "../ui/design-system.js";

const COPY_FEEDBACK_MS = 1_600;

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
                {m.onboarding_v2_runtime_sign_in_run()} <CopyChip text="claude" />
              </li>
              <li>
                {m.onboarding_v2_runtime_sign_in_enter()} <CopyChip text="/login" />
                {m.onboarding_v2_runtime_sign_in_follow()}
              </li>
            </>
          ) : (
            <li>
              {m.onboarding_v2_runtime_sign_in_run()} <CopyChip text="codex login" />
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

/** One command, copyable in place. */
function CopyChip({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // Without clipboard access the command stays selectable on screen.
    }
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-kumo-recessed py-0.5 pr-0.5 pl-2 align-middle">
      <code className="font-mono text-sm text-kumo-strong select-all">{text}</code>
      <Button
        aria-label={copied ? m.common_copied() : `${m.common_copy()} ${text}`}
        onClick={() => void copy()}
        shape="square"
        size="compact"
        variant="ghost"
      >
        <Icon className="size-3.5" name={copied ? "check" : "copy"} />
      </Button>
    </span>
  );
}
