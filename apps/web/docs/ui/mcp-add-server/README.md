# Custom connector installation

Custom connectors retain a separate Add custom entry. Before the first request, the form shows
Connector address and Authentication, with Account sign-in selected. The other choices are
API key or token and No authentication. Key mode reveals one password field.

Advanced settings is collapsed initially. Auth header and Prefix are available only for a key;
the defaults are authorization and Bearer, and an empty prefix is valid. Extra headers are available
for every method. Names remain automatic. The primary action is Connect; X and Escape dismiss an
unsubmitted form without a duplicate footer Cancel.

Authentication is explicit. Rejection never silently switches methods. Submission saves the selected
configuration using existing definition, binding, and authorization APIs. Failures preserve form
inputs and the submitted configuration; successful empty tool lists are completed results.

An explicit OAuth Cancel cancels only the issued attempt. A first-add installation owned by that
journey is deleted unless a completed credential won the race. Closing a view does not cancel a
submitted authorization. No candidate credential, backup, rollback, database field, or migration is
introduced. The authorization DELETE endpoint accepts an optional expectedOAuthState for conditional
cancellation; its existing bodyless behavior remains available internally.

Discover and Add custom create independent definitions, and current-Agent duplicates are located
instead of installed again. Full migration of the historical sharing model is outside this change.

UI evidence verified on 2026-10-15: [custom setup and URL validation at 390px](./custom-current-390.png).
Other screenshots in this directory describe older layouts.
