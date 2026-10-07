# Cloud billing MVP

Cloud billing is optional and disabled by default. Local Agents keep their existing provider credentials and execution path. Hosted cloud completions and Cloud Agent connectivity probes use prepaid Account credit when billing is enabled.

The private `@opentag/cloud-billing` package owns pricing, Stripe Checkout, encrypted per-Account OpenRouter keys and durable credit records. It runs inside the cloud server and uses the same PostgreSQL database URL. OpenRouter meters token usage and cost. The public repository owns the module interface, authentication, cloud forwarding, Account UI and database schema/migrations. Public builds have no dependency on the private package when billing is disabled.

The production cloud image contains the private package's code and may be public. The private source repository does not make bundled code secret; provider credentials and pricing configuration remain runtime settings. A private image can be adopted later without reintroducing a separate service.

## Enable

Build a combined cloud image from the selected public application image and private package. Set `OPENTAG_CLOUD_BILLING_ENABLED=true` alongside the existing Cloud Runner and cloud model configuration. Add the billing package's encryption, OpenRouter management, Stripe, pricing and welcome-credit settings to the application in CapRover. There is no billing URL, service token or separate database credential. Set `OPENTAG_AUTO_MIGRATE=true`: application startup applies the public Drizzle migrations before initializing billing. Billing tables live in the `billing` schema and reference `public.users.id`.

Stripe's signed webhook endpoint is the application's `/stripe/webhook`; Checkout returns to `/account` on `OPENTAG_PUBLIC_URL`. Follow the private checkout's README and `DEPLOYING.md`, and use Stripe test mode before accepting real payments. The model catalog remains the existing Server-owned Router catalog with approved OpenRouter model IDs and capabilities.

Account shows one available USD credit balance, including the starting allowance and paid top-ups, and a custom-amount top-up form ($10–$1,000, in cents). The UI does not display pricing details or individual billing records. View usage opens account-wide cloud model-call totals, total tokens, and a daily chart for 1, 7, 30, or 90 days. These totals come from all recorded cloud calls in the billing ledger, including connectivity probes; local usage is excluded. Unknown token counts remain unmeasured and are identified as partial data. Checkout redirects back to Account; only a verified paid Stripe webhook adds credit. The balance refreshes automatically while payment fulfillment is pending. The welcome grant is a one-time USD allowance, so its token quantity depends on the chosen model.

The server resolves Account ownership from the authenticated user for balance and checkout, and from the verified Sandbox/Session/Agent relationship for executions. Browser mutations retain the existing CSRF protection. Hosted connectivity tests use the caller's authenticated Account. When billing is enabled, a billing module failure refuses cloud requests without falling back to a platform key. Turning the billing switch off deliberately restores the existing unmetered cloud path; keep it enabled once selling credit.

## MVP limits

This release uses manual prepaid USD top-ups, one fixed cost multiplier, and one welcome grant per Account. It includes duplicate-payment protection, encrypted keys, durable usage records, missing-generation reconciliation, and refund/dispute blocking for operator review. No auto-recharge, subscriptions, strict request reservations, billing admin UI, or automated refund review is included.

Credit consumption uses the greater of OpenRouter cumulative key usage and summed reported request charges, with persisted observed spend. Finalized request costs drain credit while cumulative usage catches up; cumulative usage also covers interrupted streams. Missing token counts and per-request costs remain pending until reconciliation. Overrun is absorbed by OpenTag and does not become customer debt. Concurrency, output, body, response, and timeout limits constrain exposure, but do not guarantee a fixed dollar overrun ceiling across models or provider-metering delays. Validate that exposure with the production catalog in Stripe test mode before enabling real payments.

See [OpenRouter limits](https://openrouter.ai/docs/api_reference/limits) and [Stripe fulfillment](https://docs.stripe.com/checkout/fulfillment) for the provider behavior this integration relies on.

## Coordinated CapRover deployment

The private repository contains the package, combined-image Dockerfile, `Build Cloud` and `Deploy Cloud` workflows. One digest-pinned cloud image packages both application and billing revisions. A reviewed release JSON file records those source SHAs, that image and the published Runner. This keeps application and billing deployment atomic while retaining CapRover. The private `DEPLOYING.md` documents configuration and recovery.

Set the public repository Actions variable `OPENTAG_DEPLOYMENT_AUTHORITY=private`, drain older deployment jobs and disable CapRover source webhooks. Public `Deploy Staging` and `Deploy Runner` then skip; public image and CLI/Runner publication continue. The private workflow is the sole deployment writer and verifies this variable with a read-only repository Variables token.

Run the release in check mode, then apply: deploy the combined application image, wait for startup migrations and `/cloud-readyz` at the selected application/billing revisions, activate the published Runner and verify the final combination. `/cloud-readyz` calls billing readiness directly; ordinary `/readyz` remains independent so billing failures do not take local usage offline. There is no inter-service protocol or migration job outside application startup.

Use one application replica with stop-first replacement and sufficient request drain time. Durable state lives in the shared PostgreSQL database. Rollback uses a compatible combined image through the same workflow, preserving credit records and the encryption key. The application checks an exact migration journal, so an older image cannot roll back migrations already applied; prefer a forward fix. Back up the whole database and retain the encryption key separately. Keep billing enforced once selling credit. Adding these files does not configure or deploy a live environment.
