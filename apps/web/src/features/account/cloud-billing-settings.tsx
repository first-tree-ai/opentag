import type { CloudBillingSummary } from "@opentag/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { linkOptions } from "@tanstack/react-router";
import { type FormEvent, useId, useRef, useState } from "react";
import { browserApi } from "../../api.js";
import { getLocale } from "../../i18n/locale.js";
import * as m from "../../paraglide/messages.js";
import {
  Banner,
  Button,
  Field,
  KumoInputControl,
  Link,
  SettingsList,
  SettingsRow,
  Text,
} from "../../ui/design-system.js";
import { dismissCheckoutReturn, hasCheckoutReturn, rememberCheckoutReturn } from "./checkout-return.js";

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

export function CloudBillingSettings({ accountId }: { accountId: string }) {
  const [returnedFromCheckout, setReturnedFromCheckout] = useState(() => hasCheckoutReturn(accountId));
  const query = useQuery({
    queryKey: ["cloud-billing"],
    queryFn: () => browserApi.cloudBilling(),
    refetchInterval: (query) => (query.state.data?.enabled && query.state.data.usagePaused ? 5_000 : 30_000),
  });
  const summary = query.data;
  if (!summary?.enabled) return null;

  return (
    <section className="grid gap-4" aria-label={m.account_billing_title()}>
      <Text as="h2" variant="heading">
        {m.account_billing_title()}
      </Text>
      {query.isError ? (
        <Banner
          role="alert"
          variant="error"
          title={m.account_billing_error()}
          action={
            <Banner.Action type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
              {m.account_billing_refresh()}
            </Banner.Action>
          }
        />
      ) : null}
      {returnedFromCheckout ? (
        <Banner
          role="status"
          title={m.account_billing_checkout_return_title()}
          description={
            <div className="grid gap-3">
              <p>{m.account_billing_checkout_return_description()}</p>
              <div className="flex flex-wrap gap-2">
                {!query.isError ? (
                  <Banner.Action type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
                    {m.account_billing_refresh()}
                  </Banner.Action>
                ) : null}
                <Banner.Action
                  type="button"
                  onClick={() => {
                    dismissCheckoutReturn(accountId);
                    setReturnedFromCheckout(false);
                  }}
                >
                  {m.account_billing_checkout_return_dismiss()}
                </Banner.Action>
              </div>
            </div>
          }
        />
      ) : null}
      <CloudCreditForm accountId={accountId} summary={summary} />
    </section>
  );
}

function CloudCreditForm({
  accountId,
  summary,
}: {
  accountId: string;
  summary: Extract<CloudBillingSummary, { enabled: true }>;
}) {
  const amountId = useId();
  const amountRef = useRef<HTMLInputElement>(null);
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
      rememberCheckoutReturn(accountId);
      window.location.assign(checkout.url);
    } catch {
      setError(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-4" noValidate onSubmit={topUp}>
      {summary.blocked ? (
        <Banner role="status" size="sm" variant="alert" title={m.account_billing_blocked()} />
      ) : summary.usagePaused ? (
        <Banner role="status" size="sm" variant="alert" title={m.account_billing_usage_paused()} />
      ) : summary.availableMicros === 0 ? (
        <Banner
          role="status"
          size="sm"
          variant="alert"
          title={m.account_billing_exhausted()}
          description={m.account_billing_exhausted_description()}
          action={
            <Banner.Action type="button" onClick={() => amountRef.current?.focus()}>
              {m.account_billing_buy()}
            </Banner.Action>
          }
        />
      ) : null}
      <SettingsList>
        <SettingsRow label={m.account_billing_balance()}>
          <p className="text-2xl font-semibold text-kumo-strong tabular-nums">{dollars(summary.availableMicros)}</p>
        </SettingsRow>
        <SettingsRow label={m.account_billing_buy()}>
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
              hint={m.account_billing_amount_hint({
                minimum: dollars(summary.minimumTopUpCents * 10_000),
                maximum: dollars(summary.maximumTopUpCents * 10_000),
              })}
            >
              <KumoInputControl
                id={amountId}
                ref={amountRef}
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
        </SettingsRow>
      </SettingsList>
      <Link className="w-fit text-sm" href={usageLink.to}>
        {m.account_billing_view_usage()}
      </Link>
      {error ? <Banner role="alert" variant="error" title={m.account_billing_error()} /> : null}
    </form>
  );
}
