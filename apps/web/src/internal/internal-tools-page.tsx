import type { UserProfile } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { browserApi } from "../api.js";
import * as m from "../paraglide/messages.js";
import { queryKeys } from "../query/keys.js";
import { Button, Dialog, Switch, Text } from "../ui/design-system.js";
import { useInternalNavigationVisibility } from "./navigation-visibility.js";

type InternalNavigationItem = "integrations" | "skills";

export interface InternalToolsPageProps {
  /** Runs after a completed reset: refresh authoritative `/me` state, then enter Agent creation. */
  readonly onResetSucceeded: () => Promise<void> | void;
  readonly user: UserProfile;
}

type ResetState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "error"; readonly error: Error };

interface ResetOperation {
  readonly action: string;
  readonly confirmDescription: string;
  readonly confirmTitle: string;
  readonly description: string;
  readonly title: string;
}

/**
 * The staging Account reset, described by what it costs rather than by what it calls. It acts on
 * the signed-in Account and nobody else's, so the copy names the Account rather than warning about
 * scope.
 *
 * There is one, because there is one thing to undo. An Account is offered Agent creation because it
 * has no Agent, so deleting its Agents is the whole reset; there is no separate marker left to
 * clear, and walking setup again for an Agent that still exists is that Agent's own setup URL.
 */
function resetOperations(): readonly ResetOperation[] {
  return [
    {
      action: m.common_reset_and_start_onboarding(),
      confirmDescription: m.common_reset_all_confirm_description(),
      confirmTitle: m.common_reset_all_confirm_title(),
      description: m.common_reset_all_description(),
      title: m.common_reset_all(),
    },
  ];
}

/** Complex tools keep their own page; this index only points at them. */
function toolPages() {
  return [
    {
      description: m.common_agent_setup_lab_description(),
      title: m.common_agent_setup_lab(),
      to: "/internal/agent-setup",
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
  const [preferenceError, setPreferenceError] = useState(false);
  const [pendingPreference, setPendingPreference] = useState<InternalNavigationItem>();
  const triggerRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const resetInFlight = useRef(false);
  const queryClient = useQueryClient();
  const internalNavigation = useInternalNavigationVisibility();

  async function setNavigationVisibility(item: InternalNavigationItem, visible: boolean) {
    if (pendingPreference) return;
    setPendingPreference(item);
    setPreferenceError(false);
    try {
      const updated = await browserApi.updateInternalNavigationVisibility({ ...internalNavigation, [item]: visible });
      queryClient.setQueryData(queryKeys.internalNavigationVisibility(), updated);
    } catch {
      setPreferenceError(true);
    } finally {
      setPendingPreference(undefined);
    }
  }

  async function run() {
    if (resetInFlight.current) return;
    resetInFlight.current = true;
    setConfirming(null);
    setResetState({ kind: "pending" });
    try {
      await browserApi.resetAccountSetup();
      await onResetSucceeded();
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

      <section aria-labelledby="internal-navigation-heading" className="grid gap-3">
        <div className="grid gap-1">
          <Text as="h2" id="internal-navigation-heading" variant="heading">
            {m.common_internal_navigation()}
          </Text>
          <p className="text-sm text-kumo-subtle">{m.common_internal_navigation_description()}</p>
        </div>
        <div className="divide-y divide-kumo-line rounded-lg ring ring-kumo-line">
          <NavigationVisibilityRow
            checked={internalNavigation.skills}
            description={m.common_show_skills_navigation_description()}
            disabled={pendingPreference !== undefined}
            label={m.common_show_skills_navigation()}
            transitioning={pendingPreference === "skills"}
            onCheckedChange={(checked) => void setNavigationVisibility("skills", checked)}
          />
          <NavigationVisibilityRow
            checked={internalNavigation.integrations}
            description={m.common_show_integrations_navigation_description()}
            disabled={pendingPreference !== undefined}
            label={m.common_show_integrations_navigation()}
            transitioning={pendingPreference === "integrations"}
            onCheckedChange={(checked) => void setNavigationVisibility("integrations", checked)}
          />
        </div>
        {preferenceError ? (
          <p className="text-sm text-kumo-danger" role="alert">
            {m.common_internal_navigation_save_failed()}
          </p>
        ) : null}
      </section>

      <section aria-label={m.common_account_resets()} className="grid gap-3">
        <Text as="h2" variant="heading">
          {m.common_account_resets()}
        </Text>
        {operations.map((operation) => (
          <div className="grid gap-2 rounded-lg p-4 ring ring-kumo-line" key={operation.title}>
            <Text as="h3" variant="heading">
              {operation.title}
            </Text>
            <p>{operation.description}</p>
            <div>
              <Button
                disabled={pending}
                loading={pending}
                ref={(element) => {
                  triggerRefs.current.set(operation.title, element);
                }}
                size="compact"
                type="button"
                variant="danger"
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
          returnFocusRef={{ current: triggerRefs.current.get(confirming.title) ?? null }}
          title={confirming.confirmTitle}
          onClose={() => setConfirming(null)}
        >
          <div className="flex flex-wrap gap-3">
            <Button loading={pending} variant="danger" onClick={() => void run()}>
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

function NavigationVisibilityRow({
  checked,
  description,
  disabled,
  label,
  onCheckedChange,
  transitioning,
}: {
  checked: boolean;
  description: string;
  disabled: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
  transitioning: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 p-4">
      <div className="grid gap-1">
        <strong className="text-kumo-strong">{label}</strong>
        <span className="text-sm text-kumo-subtle">{description}</span>
      </div>
      <Switch
        aria-label={label}
        checked={checked}
        className="shrink-0"
        disabled={disabled}
        transitioning={transitioning}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}
