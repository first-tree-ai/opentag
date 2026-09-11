import { useEffect, useState } from "react";
import * as m from "../paraglide/messages.js";
import { Banner, Button, Icon } from "../ui/design-system.js";

/*
 * The document's theme identity lives on the root element's data-opentag-* attributes (see
 * app.css). Outside code can rewrite those attributes — or set the generic data-theme/data-mode
 * the scaffold deliberately leaves unset — and detach the palette. This observer watches exactly
 * those four attributes on the root element only: no subtree, style, class, or content scanning,
 * so the notice's own local theme attributes below can never trip it. It only reads; rewriting a
 * root attribute would fight the same outside code for control of the document.
 */
const WATCHED_ATTRIBUTES = ["data-theme", "data-mode", "data-opentag-theme", "data-opentag-mode"] as const;

type WatchedAttribute = (typeof WATCHED_ATTRIBUTES)[number];

/** The scaffold index.html ships: generic attributes absent, OpenTag's own pinned to light. */
const EXPECTED_VALUES: Record<WatchedAttribute, string | null> = {
  "data-theme": null,
  "data-mode": null,
  "data-opentag-theme": "opentag",
  "data-opentag-mode": "light",
};

function hasDrifted(): boolean {
  return WATCHED_ATTRIBUTES.some(
    (attribute) => document.documentElement.getAttribute(attribute) !== EXPECTED_VALUES[attribute],
  );
}

function recordsDrift(records: MutationRecord[]): boolean {
  // The final snapshot first: a change that is still in effect when the batch is delivered.
  if (hasDrifted()) return true;
  // A change restored inside the same batch leaves no trace in the final values; the records'
  // old values are the only place it still shows.
  return records.some((record) => {
    if (record.type !== "attributes") return false;
    const attribute = record.attributeName ?? "";
    if (!(WATCHED_ATTRIBUTES as readonly string[]).includes(attribute)) return false;
    return record.oldValue !== EXPECTED_VALUES[attribute as WatchedAttribute];
  });
}

/**
 * One dismissible warning per App mount when the document's theme attributes drift from the
 * shipped scaffold. Rendered in normal flow above the route content; the wrapper republishes the
 * light theme locally so the notice keeps its palette even if the root attributes are gone.
 */
export function ThemeIntegrityNotice() {
  const [tampered, setTampered] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Drift that predates React (an early content script) is visible in the initial snapshot, so
    // check before observing. Once drift is found there is nothing more to watch for this mount.
    if (hasDrifted()) {
      setTampered(true);
      return;
    }
    const observer = new MutationObserver((records) => {
      if (!recordsDrift(records)) return;
      setTampered(true);
      observer.disconnect();
    });
    observer.observe(document.documentElement, {
      attributeFilter: [...WATCHED_ATTRIBUTES],
      attributeOldValue: true,
      attributes: true,
    });
    return () => observer.disconnect();
  }, []);

  if (!tampered || dismissed) return null;
  return (
    /*
     * The wrapper's local theme scope does not cover Kumo status tokens: a root rewritten into a
     * generic dark mode would re-theme the warning banner into poor contrast over the warm light
     * page. Keep the banner surface on existing Kumo/Tailwind light palette primitives — static
     * strings so Tailwind emits them, the same pattern as the button emphasis adapter.
     */
    <div
      className="[color-scheme:light] [--text-color-kumo-warning:var(--color-orange-800)] [--color-kumo-warning-tint:var(--color-yellow-100)]"
      data-opentag-mode="light"
      data-opentag-theme="opentag"
      data-ui="theme-integrity-notice"
    >
      <Banner
        action={
          <Button
            aria-label={m.common_close()}
            onClick={() => setDismissed(true)}
            shape="square"
            size="compact"
            variant="ghost"
          >
            <Icon name="close" />
          </Button>
        }
        description={m.common_appearance_changed_description()}
        role="status"
        title={m.common_appearance_changed_title()}
        variant="alert"
      />
    </div>
  );
}
