import type { AccountSetupResetMode, UserProfile } from "@opentag/shared/browser";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { browserApi } from "../api.js";
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
const RESET_OPERATIONS: readonly ResetOperation[] = [
  {
    action: "Re-board",
    confirmDescription:
      "Your Agents, Computers and messaging connections all stay. Onboarding opens again from the Agent you already have.",
    confirmTitle: "Walk onboarding again?",
    description:
      "Opens onboarding again and keeps everything: Agents, Computers and messaging connections all stay. Because an Agent still exists, this walks the resume path rather than the first-run one.",
    mode: "reboard",
    title: "Re-board",
  },
  {
    action: "Reset and start onboarding",
    confirmDescription:
      "This deletes your current Agents and revokes your Computer enrollments and messaging connections on staging. Nobody else's Account is touched.",
    confirmTitle: "Reset your staging Account?",
    description:
      "Returns this Account to a genuine first-run state: its Agents are deleted and its Computer access revoked. Use it to test the create path — the next run needs a fresh Computer connect command.",
    mode: "all",
    title: "Reset all",
  },
];

/** Complex tools keep their own page; this index only points at them. */
const TOOL_PAGES = [
  {
    description: "The onboarding flow against its in-page mock, reaching no Server.",
    title: "Onboarding mock",
    to: "/internal/onboarding-v2",
  },
] as const;

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
        error: cause instanceof Error ? cause : new Error("This Account could not be reset"),
      });
    } finally {
      resetInFlight.current = false;
    }
  }

  const pending = resetState.kind === "pending";

  return (
    <main className="mx-auto grid w-full max-w-2xl gap-8 p-6" data-ui="internal-tools">
      <header className="grid gap-1">
        <span className="text-xs font-medium uppercase text-kumo-subtle">Staging only</span>
        <Text as="h1" variant="heading">
          Internal tools
        </Text>
        <p>
          These act on the Account signed in as {user.email} and reach nothing of anyone else's. Another tester signed
          in as themselves is unaffected.
        </p>
      </header>

      <section aria-label="Account resets" className="grid gap-3">
        <Text as="h2" variant="heading">
          Account resets
        </Text>
        {RESET_OPERATIONS.map((operation) => (
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

      <section aria-label="Tools with their own page" className="grid gap-3">
        <Text as="h2" variant="heading">
          Tools with their own page
        </Text>
        <nav aria-label="Internal tool pages" className="grid gap-2">
          {TOOL_PAGES.map((page) => (
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
          eyebrow="Staging only"
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
              Cancel
            </Button>
          </div>
        </Dialog>
      ) : null}
    </main>
  );
}
