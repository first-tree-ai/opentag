# Connector management

The list keeps two right-hand rows: the enable switch and an ellipsis menu above, a short reason and
recovery action below. Successful snapshots have no Connected badge, success dot, or tool count.
Disabled connectors use only the switch. Identity opens Details; the menu contains Details and
Delete. A compact confirmation shows “Delete {name}?” above “This Agent won’t be able to use {name}
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
closing Discover preserves Authorizing and Cancel, then shows tool loading or the failure in place.
Reopening the directory preserves a failed attempt until retry, and the same connector cannot start
another authorization while its Discover attempt is running.

Preset Details contains the name, logo, close button, a visible copyable Connector address, and
Authentication. Account sign-in uses Authorize or Reauthorize. A saved API key or token is masked and
has Update; editing uses Save and Cancel. A preset with multiple configured methods offers Use API
key or token or Use account sign-in. Selecting an alternative is local until submission. Switching to
OAuth uses Authorize. Tools, Advanced settings, deletion, credential clearing, and a global save
footer are absent. Custom Details keeps editable connection settings and Advanced settings.

In Details, OAuth feedback sits beside Authorize or Reauthorize, above the alternative-method link;
on narrow screens it wraps below the action. Editing failures remain with the authentication fields.
URL validation stays below its input, and connection or configuration failures stay by their form's
submission action. Discover's key form has only Cancel and Save, with inline feedback under the key;
its catalog retains the close button and per-card feedback.

Preset defaults and alternate key endpoint/header rules live in packages/mcp-presets/mcp-catalog.yaml;
the generator validates them and emits the public registry. Existing installations are not rewritten.
Submission replaces the saved configuration without candidate validation, backup, or rollback.
OAuth success followed by a tool failure retains credentials and supports Retry.
Retry from the list or Discover does not open an authorization window when credentials remain active.
OAuth completion immediately refreshes authorization data, including when started from Details.
Retry reads the latest confirmed authorization. A failed method switch keeps the preset form and
submitted configuration. Editable fields stay disabled while a credential write is pending;
OAuth Cancel and Open remain available during authorization.

Browser journeys use fictional provider responses. Actual provider consent and platform-client setup
are not verified by those tests.

UI evidence verified on 2026-10-15; browser checks cover 320px, 390px, 768px, and 1440px:

- [Discover during authorization, 1440px](./discover-current-1440.png)
- [Preset Details with an authorization error, 1440px](./details-current-1440.png)
- [Preset Details with an authorization error, 320px](./details-current-320.png)

Other screenshots in this directory show the previous design.
