import type { CloudBillingSummary } from "@opentag/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { linkOptions } from "@tanstack/react-router";
import { type FormEvent, useId, useRef, useState } from "react";
import { browserApi } from "../../api.js";
import { getLocale } from "../../i18n/locale.js";
import * as m from "../../paraglide/messages.js";
import { Button, Field, KumoInputControl, Link, Text } from "../../ui/design-system.js";

const usageLink = linkOptions({ to: "/usage" });

function dollars(micros: number): string {
  return new Intl.NumberFormat(getLocale(), { style: "currency", currency: "USD" }).format(micros / 1_000_000);
}

function cents(amount: string, minimum: number, maximum: number): number | undefined {
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount.trim())) return undefined;
  const [whole = "", fraction = ""] = amount.trim().split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(result) && result >= minimum && result <= maximum ? result : undefined;
}

export function CloudBillingSettings() {
  const query = useQuery({
    queryKey: ["cloud-billing"],
    queryFn: () => browserApi.cloudBilling(),
    refetchInterval: (query) => (query.state.data?.enabled && query.state.data.usagePaused ? 5_000 : 30_000),
  });
  const summary = query.data;
  if (summary?.enabled === false) return null;

  return (
    <section className="grid gap-4" aria-label={m.account_billing_title()}>
      <Text as="h2" variant="heading">
        {m.account_billing_title()}
      </Text>
      {query.isPending ? <p role="status">{m.account_billing_loading()}</p> : null}
      {query.isError ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-kumo-danger" role="alert">
            {m.account_billing_error()}
          </p>
          <Button variant="ghost" disabled={query.isFetching} onClick={() => void query.refetch()}>
            {m.account_billing_refresh()}
          </Button>
        </div>
      ) : null}
      {summary?.enabled ? (
        <div className="ui-surface overflow-hidden bg-kumo-base">
          <div className="grid gap-2 bg-kumo-tint p-6 sm:p-8">
            <span className="text-sm text-kumo-subtle">{m.account_billing_balance()}</span>
            <p className="text-4xl font-semibold text-kumo-strong tabular-nums sm:text-5xl">
              {dollars(summary.availableMicros)}
            </p>
          </div>
          <CloudCreditForm summary={summary} />
        </div>
      ) : null}
    </section>
  );
}

function CloudCreditForm({ summary }: { summary: Extract<CloudBillingSummary, { enabled: true }> }) {
  const amountId = useId();
  const [amount, setAmount] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const purchase = useRef<{ amountCents: number; idempotencyKey: string } | undefined>(undefined);
  const inFlight = useRef(false);

  async function topUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || summary.blocked) return;
    const amountCents = cents(amount, summary.minimumTopUpCents, summary.maximumTopUpCents);
    if (amountCents === undefined) {
      setInvalid(true);
      setError(false);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(false);
    setInvalid(false);
    if (purchase.current?.amountCents !== amountCents)
      purchase.current = { amountCents, idempotencyKey: crypto.randomUUID() };
    try {
      const checkout = await browserApi.cloudCreditCheckout(purchase.current);
      window.location.assign(checkout.url);
    } catch {
      setError(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-5 border-t border-kumo-line p-6 sm:p-8" noValidate onSubmit={topUp}>
      <Text as="h3" variant="heading">
        {m.account_billing_buy()}
      </Text>
      <div className="grid gap-3">
        <Field
          htmlFor={amountId}
          label={m.account_billing_amount()}
          error={
            invalid
              ? m.account_billing_amount_error({
                  minimum: dollars(summary.minimumTopUpCents * 10_000),
                  maximum: dollars(summary.maximumTopUpCents * 10_000),
                })
              : undefined
          }
          errorId={`${amountId}-error`}
        >
          <KumoInputControl
            id={amountId}
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            maxLength={12}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${amountId}-error` : undefined}
            disabled={busy || summary.blocked}
            value={amount}
            onChange={(event) => {
              setAmount(event.currentTarget.value);
              setInvalid(false);
              setError(false);
            }}
          />
        </Field>
        <Button className="w-full" disabled={busy || summary.blocked} type="submit">
          {busy ? m.account_billing_redirecting() : m.account_billing_top_up()}
        </Button>
      </div>
      <Link className="w-fit text-sm" href={usageLink.to}>
        {m.account_billing_view_usage()}
      </Link>
      {summary.blocked ? (
        <p className="text-sm text-kumo-subtle" role="status">
          {m.account_billing_blocked()}
        </p>
      ) : null}
      {summary.usagePaused && !summary.blocked ? (
        <p className="text-sm text-kumo-subtle" role="status">
          {m.account_billing_usage_paused()}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-kumo-danger" role="alert">
          {m.account_billing_error()}
        </p>
      ) : null}
    </form>
  );
}
