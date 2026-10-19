# Connector management

The list keeps the enable switch and ellipsis menu vertically centered on the right. The entire left
area opens Details, including its icon, name, description, and surrounding space. Like Skills, it
uses a shared hover background and keyboard focus outline without an arrow beside the name. A short reason
replaces the description when attention is needed; Authorization required is neutral. Recovery
actions live in Details. Successful snapshots have no Connected badge, success dot, or tool count.
Disabled connectors use only the switch. The menu contains Details and Delete. A compact confirmation shows “Delete {name}?” above “This Agent won’t be able to use {name}
until you add it again.” Cancel and Delete sit at the bottom right, with initial focus on Cancel.
There is no duplicate close button; Escape cancels. It removes this Agent's installation and its
unused definition; a historical definition still used by another Agent is retained.

Feedback describes only known evidence: Authorization expired, Authorization failed, Cannot reach
service, Request timed out, or Couldn't load tools. More specific rejection or revocation copy requires
explicit provider evidence; an internal revoked row alone does not establish provider revocation.
Authentication recovery uses Authorize or Reauthorize; tool loading uses Retry. A completed empty
inventory shows No tools available without a retry. Partial inventories remain usable. There are no
error popovers or raw upstream responses.

Discover retains its card layout. Progress or an error replaces the description; its action remains
in the original action area. Completion restores the description and shows only a gray check mark,
with an accessible Added label. It preserves search, category, scroll, and an open directory. Closing
the directory does not interrupt OAuth; explicit Cancel and blocked-popup Open remain in the card.
The close button remains available during OAuth. The list reads the same in-progress attempt, so
closing Discover preserves Authorizing in the description; opening Details exposes the same attempt's
Cancel and blocked-popup Open actions. Completion shows tool loading or the failure in place.
Reopening the directory preserves a failed attempt until retry, and the same connector cannot start
another authorization while its Discover attempt is running.

Preset Details places Authentication first and the visible copyable Connector address below it as
read-only text. Account sign-in uses Authorize or Reauthorize. A saved API key or token is masked and
has Update; editing uses Save and Cancel in the same action position. A preset with multiple
configured methods uses the shared method Select; a single-method preset shows plain text.
Selecting an alternative is local until submission. Switching to
OAuth uses Authorize. Tools, Advanced settings, deletion, credential clearing, and a global save
footer are absent. Custom Details keeps editable connection settings and Advanced settings.
Primary authentication actions use the shared 40px desktop control height, with 44px mobile touch
targets; supporting text actions retain the compact recipe.

In preset Details, feedback occupies a shared row below the authentication controls. Retry and
Open window follow their reason with a 12px gap; on narrow screens the action wraps and stays
left-aligned. The primary authentication action keeps its position. The dialog heading remains
anchored when an intentional method switch expands its form. Editing failures remain with the authentication fields.
URL validation stays below its input, and connection or configuration failures stay by their form's
submission action. Discover's key form has only Cancel and Save, with inline feedback under the key;
its catalog retains the close button and per-card feedback.

Preset defaults and alternate key endpoint/header rules live in packages/mcp-presets/mcp-catalog.yaml;
the generator validates them and emits the public registry. Existing installations are not rewritten.
Submission replaces the saved configuration without candidate validation, backup, or rollback.
OAuth success followed by a tool failure retains credentials and supports Retry.
Retry from Details or Discover does not open an authorization window when credentials remain active.
A retry keeps Details open; closing and reopening Details preserves an ongoing authorization.
Discover also shows an authorization started in Details and cannot start a duplicate attempt for
that connector. A successful Discover recovery clears an earlier Details failure from the list.
OAuth completion immediately refreshes authorization data, including when started from Details.
Retry reads the latest confirmed authorization. A failed method switch keeps the preset form and
submitted configuration. Editable fields stay disabled while a credential write is pending;
OAuth Cancel and Open remain available during authorization.
Retry that starts OAuth uses the connector's existing session too. A network failure followed by
Retry and a blocked authorization window retains Open window, Cancel, and dialog dismissal,
including after closing and reopening Details. Failed key or anonymous-method saves remain local
to the form and do not create a misleading tool Retry on the installed connector.

The list, Details, and Discover keep a previous tool snapshot visible during background refresh.
Loading tools is shown before the first completed snapshot; explicit authorization and Retry retain
their progress feedback. Confirmed authorization or probe failures still show their recovery action.

Browser journeys use fictional provider responses. Actual provider consent and platform-client setup
are not verified by those tests.

Details evidence verified on 2026-10-19; browser checks cover 320px, 390px, 768px, and 1440px:

The complete Browser Smoke suite passed all 84 cases, including English and Chinese, OAuth popup
and mobile-return flows, cross-dialog continuation, key editing, keyboard interaction, axe checks,
and layout bounds. The two new cross-dialog regressions failed before their corrections. Shared
Dialog headers use `data-ui="dialog-header"` without adding a banner landmark; layout selectors and
browser geometry checks follow that marker.

- [Preset Details with an authorization error, 1440px](./details-current-1440.png)
- [Preset Details with an authorization error, 320px](./details-current-320.png)
- [Blocked authorization with an inline recovery action, 1440px](./details-recovery-1440.png)
- [Blocked authorization with a wrapped recovery action, 320px](./details-recovery-320.png)

[Discover during authorization, 1440px](./discover-current-1440.png) was verified on 2026-10-15.
Other screenshots in this directory show the previous design.
