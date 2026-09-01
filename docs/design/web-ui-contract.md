# Web UI contract

This document defines the interface that OpenTag Web feature code uses to build consistent, accessible product UI. It
complements the implementation notes in [`apps/web/src/ui/KUMO.md`](../../apps/web/src/ui/KUMO.md). Kumo owns the visual
primitives; this contract owns OpenTag's product semantics, composition rules, and acceptance criteria.

## Ownership and dependency seam

The Web UI has one third-party implementation and two product-facing seams:

```text
                         ┌─ src/ui/design-system.tsx semantic adapter ─┐
@cloudflare/kumo ────────┤                                               ├─ src/features
                         └─ src/components/kumo owned reusable blocks ──┘
                                  ▲
                                  └─ may reuse the semantic adapter
```

- Kumo owns primitive appearance, spacing, radii, shadows, and baseline interaction behavior.
- `src/ui/design-system.tsx` is the semantic adapter and the normal interface for product code. It owns OpenTag intent
  names, accessibility corrections, compatibility behavior, icon registration, and other rules that must remain
  consistent across callers.
- `src/components/kumo` contains reusable blocks whose behavior is deeper than a primitive, such as `PageHeader`. Their
  interfaces use OpenTag-owned types and must not expose Kumo-specific types or composition to callers.
- Feature modules compose either approved seam. They own domain state and copy, not new primitive conventions.

Feature modules must not import `@cloudflare/kumo` directly. Direct imports are limited to the application provider
wiring, the semantic adapter, and owned Kumo blocks. Tests may install their own provider wiring.

## Choosing where behavior belongs

Use an existing Kumo primitive through the semantic adapter when it already expresses the required behavior. Add or
deepen an adapter when OpenTag must consistently translate a product intent, repair accessibility, or hide Kumo-specific
composition from every caller.

Create an owned reusable block when either condition is true:

- the same product composition has at least three real callers; or
- the interaction or accessibility behavior is important and easy for callers to implement inconsistently.

Do not create a wrapper that only renames props or forwards styling. A reusable block should hide meaningful behavior
behind a smaller interface. Test it through that interface rather than through Kumo implementation details.

## Page and interaction states

A data-backed surface must deliberately handle every state that its domain can enter. The relevant set normally includes:

- initial loading;
- content;
- empty content;
- partial or unavailable data;
- recoverable failure with a retry path; and
- terminal failure with a useful next action.

An interactive action must deliberately handle the relevant default, hover, focus-visible, disabled, busy, success, and
failure states. Busy actions must prevent duplicate submission. Feedback must remain associated with the action or field
that caused it, and a failure must not erase valid user input.

Use Kumo `Loader` or `SkeletonLine` for loading, `Empty` for a genuine empty result, `Banner` for contextual status, and
the shared route or resource-state modules for failures. Do not use an empty table, a disabled action without an
explanation, or layout movement as the only indication that state changed.

Irreversible, high-impact, or uncertain-scope destructive actions require an explicit confirmation surface, a clear
description of impact, a non-destructive default focus target, and an execution state that cannot be dismissed while the
outcome is uncertain. A low-impact action may execute immediately only when it is reliably reversible and offers a clear,
keyboard-accessible Undo path for long enough to recover.

## Layout and responsive acceptance

Authenticated pages use the named `content` container and the shared content frame documented in `KUMO.md`. Prefer
container queries for page composition because the Sidebar changes the space available to the route without changing
the viewport. Add a breakpoint because content stops working at that width, not to reproduce a device catalogue.

UI changes must be checked at these representative widths when the surface can render there:

| Width | Acceptance purpose |
| --- | --- |
| 320px | Minimum supported width; no page-level horizontal scrolling |
| 390px | Primary mobile composition and touch interaction |
| 768px | Navigation and compact-to-wide layout transition |
| 1440px | Desktop hierarchy, density, and maximum content width |

Horizontal overflow belongs to the nearest table, code, log, or other intrinsically wide region. That region must be
keyboard focusable and have an accessible name when keyboard users need to scroll it.

Use Kumo and Tailwind spacing and type utilities. Arbitrary measurements are allowed only for a demonstrated content or
layout constraint and should carry a short explanation when the reason is not evident from the interface.

## Accessibility acceptance

OpenTag Web targets WCAG 2.2 AA for product UI:

- normal text contrast is at least 4.5:1;
- large text and meaningful non-text UI contrast are at least 3:1;
- every interactive control has a visible focus indicator with at least 3:1 contrast against adjacent colors;
- keyboard order follows the visual and task order;
- Enter and Space activate controls according to their native semantics;
- Escape closes dismissible overlays, and focus returns to the control that opened them;
- icon-only controls have an accessible name, while decorative icons are hidden from assistive technology;
- validation identifies the field, describes the problem, and exposes the update to assistive technology; and
- non-essential animation and transition are removed when `prefers-reduced-motion: reduce` is active.

Automated axe checks are required for representative browser flows, but they do not replace keyboard testing or review
of contrast, focus order, accessible names, and task completion.

## Theme, color, and motion

OpenTag currently ships light mode as the supported product theme. Dark theme values may remain for Kumo compatibility
or future work, but their presence does not make dark mode a supported acceptance target. A future dark-mode change must
define complete surface, text, status, illustration, chart, and browser-level behavior before changing this policy.

Feature code must use Kumo semantic utilities or the OpenTag variables defined at the theme seam. Raw color literals are
limited to theme sources and explicitly reviewed module-owned styles. Brand green communicates brand or selection; it
must not replace success, warning, danger, or informational status colors.

Motion must communicate a state change or spatial relationship. Prefer transform and opacity, avoid perpetual animation
outside an active progress state, and provide a reduced-motion result that communicates the same information without
movement.

## CSS exceptions

`src/app.css` is the application stylesheet entry. Product layout and appearance normally use Kumo and Tailwind
utilities. A module-owned stylesheet is an exception reserved for behavior that utilities cannot express clearly, such
as attribute-driven state, measured layout stability, or a specialized terminal surface.

Every module-owned stylesheet must:

- be imported by the module that owns the behavior;
- use a module-specific class prefix;
- explain non-obvious measurements or raw colors next to the rule;
- avoid styling unrelated pages or Kumo internals globally; and
- be added to the static stylesheet seam allowlist in `src/ui/kumo-contract.test.ts`.

## Internationalization and copy

User-facing copy goes through Paraglide messages. English and Simplified Chinese message catalogues must remain complete
and synchronized as described in `DEVELOPMENT.md`. UI review must include the locale most likely to stress the changed
layout; do not assume English is always the longest representation.

Controls use concise action labels. Errors explain what happened and what the user can do next. Do not rely on color,
placeholder text, an icon, or a tooltip as the only communication of essential information.

## Verification and pull request evidence

Tests should cross the same interface as product callers:

- adapter and owned-block tests verify public behavior and accessibility semantics;
- static contract tests enforce the Kumo import, interactive-element, token, and stylesheet seams;
- feature tests cover domain states and user-visible outcomes; and
- Playwright checks representative keyboard, axe, responsive, and stable visual paths against local fixtures.

The pull-request Browser Smoke maps the four representative widths to stable acceptance paths rather than multiplying
every page by every viewport: 320px sign-in, 390px touch dialog behavior, the 768px Account layout transition, and the
1440px bounded desktop content frame. These checks enforce page-level overflow and axe acceptance; feature-specific
responsive tests remain responsible for intrinsically wide regions and specialized compositions.

When a pull request changes rendered UI, its `UI validation` section records desktop and mobile evidence, the states that
were exercised, keyboard or accessibility checks, and any new reusable block, theme value, or CSS exception. A change
that cannot render at one of the representative widths should state why rather than silently omitting that check.
