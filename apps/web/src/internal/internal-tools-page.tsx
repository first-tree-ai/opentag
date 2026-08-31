import type { AccountSetupResetMode, UserProfile } from "@opentag/shared/browser";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { browserApi } from "../api.js";
import * as m from "../paraglide/messages.js";
import { Button, Dialog, Text } from "../ui/design-system.js";

export interface InternalToolsPageProps {
  /** Runs after a completed reset: refresh authoritative `/me` state, then enter ordinary onboarding. */
  readonly onResetSucceeded: (mode: AccountSetupResetMode) => Promise<void> | void;
  readonly user: UserProfile;
}

type ResetState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending"; readonly mode: AccountSetupResetMode }
  | { readonly kind: "error"; readonly error: Error };

interface ResetOperation {
  readonly action: string;
  readonly confirmDescription: string;
  readonly confirmTitle: string;
  readonly description: string;
  readonly mode: AccountSetupResetMode;
  readonly title: string;
}

/**
 * The two staging Account resets, described by what they cost rather than by what they call. Both
 * act on the signed-in Account and nobody else's, so the copy names the Account rather than warning
 * about scope.
 */
function resetOperations(): readonly ResetOperation[] {
  return [
    {
      action: m.common_reboard(),
      confirmDescription: m.common_reboard_confirm_description(),
      confirmTitle: m.common_reboard_confirm_title(),
      description: m.common_reboard_description(),
      mode: "reboard",
      title: m.common_reboard(),
    },
    {
      action: m.common_reset_and_start_onboarding(),
      confirmDescription: m.common_reset_all_confirm_description(),
      confirmTitle: m.common_reset_all_confirm_title(),
      description: m.common_reset_all_description(),
      mode: "all",
      title: m.common_reset_all(),
    },
  ];
}

/** Complex tools keep their own page; this index only points at them. */
function toolPages() {
  return [
    {
      description: m.common_onboarding_mock_description(),
      title: m.common_onboarding_mock(),
      to: "/internal/onboarding-v2",
    },
  ] as const;
}

/**
 * The staging-only internal tools index. Simple operations — the ones that are a button and a
 * confirmation — live here directly; anything that needs a flow of its own is a linked sub-page.
 *
 * Every mutation here is reflexive: it targets the authenticated Account and never accepts a
 * client-selected one, which is what makes the page safe to offer to every signed-in staging tester.
 */
export function InternalToolsPage({ onResetSucceeded, user }: InternalToolsPageProps) {
  const [confirming, setConfirming] = useState<ResetOperation | null>(null);
  const [resetState, setResetState] = useState<ResetState>({ kind: "idle" });
  const triggerRefs = useRef(new Map<AccountSetupResetMode, HTMLButtonElement | null>());
  const resetInFlight = useRef(false);

  async function run(operation: ResetOperation) {
    if (resetInFlight.current) return;
    resetInFlight.current = true;
    setConfirming(null);
    setResetState({ kind: "pending", mode: operation.mode });
    try {
      await browserApi.resetAccountSetup(operation.mode);
      await onResetSucceeded(operation.mode);
    } catch (cause) {
      setResetState({
        kind: "error",
        error: cause instanceof Error ? cause : new Error(m.common_account_reset_failed()),
      });
    } finally {
      resetInFlight.current = false;
    }
  }

  const pending = resetState.kind === "pending";
  const operations = resetOperations();
  const pages = toolPages();

  return (
    <main className="mx-auto grid w-full max-w-2xl gap-8 p-6" data-ui="internal-tools">
      <header className="grid gap-1">
        <span className="text-xs font-medium uppercase text-kumo-subtle">{m.common_staging_only()}</span>
        <Text as="h1" variant="heading">
          {m.common_internal_tools()}
        </Text>
        <p>{m.common_internal_tools_scope({ email: user.email })}</p>
      </header>

      <section aria-label={m.common_account_resets()} className="grid gap-3">
        <Text as="h2" variant="heading">
          {m.common_account_resets()}
        </Text>
        {operations.map((operation) => (
          <div className="grid gap-2 rounded-lg p-4 ring ring-kumo-line" key={operation.mode}>
            <Text as="h3" variant="heading">
              {operation.title}
            </Text>
            <p>{operation.description}</p>
            <div>
              <Button
                disabled={pending}
                loading={resetState.kind === "pending" && resetState.mode === operation.mode}
                ref={(element) => {
                  triggerRefs.current.set(operation.mode, element);
                }}
                size="compact"
                type="button"
                variant={operation.mode === "all" ? "danger" : "secondary"}
                onClick={() => setConfirming(operation)}
              >
                {operation.action}
              </Button>
            </div>
          </div>
        ))}
        {resetState.kind === "error" ? (
          <div className="rounded-md bg-kumo-danger-tint p-3 text-sm text-kumo-danger" role="alert">
            <p>{resetState.error.message}</p>
          </div>
        ) : null}
      </section>

      <section aria-label={m.common_tools_with_own_page()} className="grid gap-3">
        <Text as="h2" variant="heading">
          {m.common_tools_with_own_page()}
        </Text>
        <nav aria-label={m.common_internal_tool_pages()} className="grid gap-2">
          {pages.map((page) => (
            <Link className="grid gap-1 rounded-lg p-4 ring ring-kumo-line" key={page.to} to={page.to}>
              <strong className="text-kumo-strong">{page.title}</strong>
              <span className="text-sm text-kumo-subtle">{page.description}</span>
            </Link>
          ))}
        </nav>
      </section>

      {confirming ? (
        <Dialog
          busy={pending}
          description={confirming.confirmDescription}
          eyebrow={m.common_staging_only()}
          returnFocusRef={{ current: triggerRefs.current.get(confirming.mode) ?? null }}
          title={confirming.confirmTitle}
          onClose={() => setConfirming(null)}
        >
          <div className="flex flex-wrap gap-3">
            <Button
              loading={pending}
              variant={confirming.mode === "all" ? "danger" : "primary"}
              onClick={() => void run(confirming)}
            >
              {confirming.action}
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              {m.common_cancel()}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </main>
  );
}
