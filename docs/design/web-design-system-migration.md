# Web design system migration inventory

This inventory records the legacy UI implementations found at the start of the incremental site migration from baseline
`17077fd`. It is intentionally scoped to the requested pages and avoids treating specialized controls as generic buttons.

| Page group | Legacy implementation found | Migration target |
| --- | --- | --- |
| Login, invitation, Workspace creation | `.button` links/buttons; native Workspace label/input | `Button` styling for links, `Button`, `Field` |
| Account and Workspace profile | `.tertiary`, `.button.commit`; native labels and help copy | `Button`, `Field` |
| Onboarding | `.button`, `.secondary`, `.tertiary`; native Agent field; action links using button classes | `Button`, `Field`, design-system button-link classes |
| Computer setup | `.button` and `.button.secondary` | `Button` |
| Runtime configuration | four `.form-field`/`.field-help` groups and `.button` submit | `Field`, `Button` |
| Feishu setup and Agent messaging | legacy primary/secondary/danger buttons; ad hoc binding status presentation | `Button`, `StatusIndicator` |
| Integrations, Resources, Usage | legacy Connect/Add buttons; native range label/select | `Button`, `Field`; keep the resource filter as a specialized pressed-button group |
| Shared navigation/action affordances | Unicode right arrow and current-Workspace check mark | `Icon` |
| Legacy CSS | `.button` variants, compact modifier, old field helpers, unused availability/settings dots | Remove only after their migrated call sites are gone |

## Intentionally specialized controls

- Account-menu items remain native menu buttons because their menu layout and keyboard behavior are purpose-specific.
- Messaging receive-mode buttons remain native buttons inside the existing segmented control.
- Onboarding Computer/Agent choices remain native buttons with the existing choice-card interaction.
- Resource filters remain native pressed buttons; replacing them with generic action buttons would weaken their selected-state
  semantics.
- Simple table role selects continue to use `ds-control` without an extra `Field` wrapper.

## Completion status

All legacy variant-class call sites in the scoped pages have been migrated. The shared base `button` rules remain because
the specialized native controls above still use them; removing that base would be a separate, broader control-system
rewrite. No `.button`, `.secondary`, `.tertiary`, `.danger`, `.danger-text`, `.commit`, or `.compact-button` call sites
remain in the web TSX source.
