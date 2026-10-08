# Cloud billing

Cloud model calls and connectivity probes use the configured self-hosted LiteLLM gateway. The public OpenTag server owns authentication, gateway requests, bounded streaming, usage capture, and reporting. The private `@opentag/cloud-billing` package runs inside the application and owns customer prices, credit admission, settlement, and Stripe Checkout. Both use the same PostgreSQL database; the public repository owns the `billing` schema and migrations. Local Agents use their existing execution and usage paths.

## Metering and prices

Every cloud model call has one durable record with its Account, Agent, optional Session, source, gateway identity, model, request IDs, token measurements, and settlement state. Execution attribution comes from verified grants and database relationships; connectivity probes use the ownership-checked Agent and authenticated Account. The server never stores prompts or response content in this ledger.

LiteLLM chat completions use OpenAI-compatible usage. Streaming requests always request `stream_options.include_usage=true`. Input totals include cached input; reasoning counts are already part of output totals and are not added again. Available models must have verified `max_input_tokens` and `max_output_tokens` metadata and, when billing is enabled, configured customer prices. Configure those capabilities in LiteLLM's model metadata and verify the deployed response shape for every offered model.

The private `BILLING_PRICES` configuration maps gateway IDs and model IDs to integer microdollar rates per million input, cached-input, and output tokens. Admission captures a rate snapshot. Settlement calculates `(input-cached)*input_rate + cached*cached_rate + output*output_rate`, divides by one million, and rounds up once to whole microdollars using integer arithmetic. Price changes affect future calls. A gateway that does not provide cache counts must use equal input and cached-input rates; discounted pricing requires complete cache measurements.

Account and Agent cloud totals read the same call records. Local report tokens and cloud ledger tokens are combined using the execution origin captured at dispatch. Cloud task-report token totals do not enter usage aggregates. Task counts and outcomes remain task-report metrics. Account usage includes connectivity probes and offers 1, 7, 30, and 90-day totals and daily charts. Unknown counts are partial data.

## Credit and settlement

Enable `OPENTAG_CLOUD_BILLING_ENABLED=true` in the cloud image. Admission locks the Account row in a short database transaction, applies known payment blocks, checks available credit and account concurrency, and inserts the priced call before contacting LiteLLM. Balance is granted credit minus finalized debits. The default starting grant is $1 once per Account and the default concurrency limit is two calls per Account. Billing-disabled calls use the same gateway and ledger with no credit debit.

Final usage settles the call and debit in one Account transaction. Repeated observations, payment fulfillment, and settlement cannot debit or grant twice. Already admitted calls may exceed remaining credit; their debit is capped at the available balance and OpenTag absorbs the difference between calculated price and debit. The public execution grant bounds output to at most 8,192 tokens. Body, response, timeout, and concurrency limits constrain exposure; timeout alone does not guarantee a dollar ceiling. Verify the exposure for offered models before accepting real payments.

A request definitely not sent is finalized without charge. A sent request with missing final usage becomes `pending_usage` and blocks new billed calls for that Account. Top-ups and balance reads remain available. The public worker checks LiteLLM `/spend/logs?request_id=...` using captured `x-litellm-call-id` and response IDs, with durable retries from 30 seconds to one hour. Empty, ambiguous, failed, or incomplete logs remain pending. Logging is asynchronous. Configure `OPENTAG_CLOUD_MODEL_USAGE_KEY` when spend-log access needs a separate server-only credential; otherwise lookup uses the model credential. Verify endpoint permissions, ID correlation, and cache detail availability on the deployed LiteLLM version.

Startup marks abandoned priced calls pending before cloud readiness. Calls whose settlement failed are recovered after their configured execution timeout plus a grace period. Operator-reviewed unresolved calls can be written off with `node scripts/write-off.mjs <call-id> <reason>` from the built private checkout using the application environment. The reason is recorded. Resolve pending calls and drain active calls before changing the gateway identity or endpoint.

## Payments

Account displays one available USD balance, including starting and purchased credit, with custom top-ups from $10 to $1,000 in cents. Stripe-hosted Checkout returns to `/account`; only verified paid Stripe sessions add credit. The signed webhook endpoint is `/stripe/webhook`. Register `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, and `charge.dispute.created`. Refunds remove purchased credit once; refunds and disputes block cloud spending for operator review. Events received before fulfillment remain durable. Provider availability does not affect payment fulfillment or balance reads.

Configure `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BILLING_PRICES`, and optionally `BILLING_FREE_CENTS` and `BILLING_MAX_CONCURRENT_PER_ACCOUNT` in the private package's application environment. Use Stripe test mode for acceptance testing. Auto-recharge, subscriptions, request reservations, and a billing administration UI are outside this MVP.

## CapRover deployment

The public `Docker`, `Deploy Staging`, and `Deploy Runner` workflows ship the application and billing package together. `cloud-billing.json` pins the exact private package commit. Configure `OPENTAG_BILLING_READ_TOKEN` with read-only Contents access to `first-tree-ai/opentag-billing`; trusted main image builds check out that revision, run its checks and tests against the application, and bundle it into `ghcr.io/first-tree-ai/opentag:<application SHA>`. The image records both source revisions. Pull-request and default local images build without private access. The production image contains the private code and may be public; runtime secrets stay in CapRover.

Enable cloud identities, cloud models, billing, and `OPENTAG_AUTO_MIGRATE=true`. Startup applies the public migrations before constructing the services. The staging flow publishes the application and CLI/Runner, deploys the application, then activates the matching Runner. `/cloud-readyz` verifies application and billing revisions; `/readyz` remains independent of billing availability.

Use one application replica, no predeploy function, and stop-first updates and rollbacks. Set `UpdateConfig` to `{"Order":"stop-first","Parallelism":1,"FailureAction":"pause"}`, `RollbackConfig` to `{"Order":"stop-first","Parallelism":1}`, and `TaskTemplate.ContainerSpec.StopGracePeriod` to at least `(OPENTAG_CLOUD_MODEL_REQUEST_TIMEOUT_MS + 30000) * 1000000` nanoseconds. The default 600-second timeout requires `630000000000`. This ensures startup recovery cannot mistake another live process's calls for abandoned work. Let the image supply `OPENTAG_BUILD_REVISION` and `OPENTAG_BILLING_REVISION`. Back up the shared database. Applied migrations require compatible application images; prefer forward fixes.

References: [LiteLLM usage](https://docs.litellm.ai/docs/completion/output), [LiteLLM spend tracking](https://docs.litellm.ai/docs/proxy/cost_tracking), [Stripe fulfillment](https://docs.stripe.com/checkout/fulfillment).
