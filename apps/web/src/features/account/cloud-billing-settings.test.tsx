import type { CloudBillingSummary } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { CloudBillingSettings } from "./cloud-billing-settings.js";

const summary: CloudBillingSummary = {
  enabled: true,
  currency: "USD",
  availableMicros: 1_000_000,
  blocked: false,
  usagePaused: false,
  minimumTopUpCents: 1000,
  maximumTopUpCents: 100_000,
};
afterEach(() => vi.restoreAllMocks());
function mount(initialSummary?: CloudBillingSummary) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (initialSummary) client.setQueryData(["cloud-billing"], initialSummary);
  const view = render(
    <QueryClientProvider client={client}>
      <CloudBillingSettings />
    </QueryClientProvider>,
  );
  return { ...view, client };
}
function checkoutFailure() {
  return vi.spyOn(browserApi, "cloudCreditCheckout").mockRejectedValue(new Error("temporarily unavailable"));
}

describe("cloud credit settings", () => {
  it("keeps billing invisible while its flag loads, including when it resolves disabled", async () => {
    let resolve!: (value: CloudBillingSummary) => void;
    vi.spyOn(browserApi, "cloudBilling").mockImplementation(
      () =>
        new Promise((complete) => {
          resolve = complete;
        }),
    );
    const view = mount();
    expect(view.container.innerHTML).toBe("");
    await act(async () => resolve({ enabled: false }));
    expect(view.container.innerHTML).toBe("");
  });
  it("keeps billing invisible when its flag cannot be loaded", async () => {
    vi.spyOn(browserApi, "cloudBilling").mockRejectedValue(new Error("offline"));
    const view = mount();
    await waitFor(() => expect(view.client.getQueryState(["cloud-billing"])?.status).toBe("error"));
    expect(view.container.innerHTML).toBe("");
  });
  it("hides disabled billing", async () => {
    const load = vi.spyOn(browserApi, "cloudBilling").mockResolvedValue({ enabled: false });
    mount();
    await waitFor(() => expect(load).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("region", { name: "Cloud credits" })).toBeNull());
  });
  it("shows a single starting balance without pricing or usage breakdowns", async () => {
    vi.spyOn(browserApi, "cloudBilling").mockResolvedValue(summary);
    mount();
    expect(await screen.findByText("$1.00")).toBeTruthy();
    expect(screen.getByText("Available credit")).toBeTruthy();
    expect(screen.queryByText(/Purchased credit|Free credit|Recent cloud usage|OpenRouter/)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
  it("allows top-ups at exhaustion and reuses the purchase ID after a failed retry", async () => {
    vi.spyOn(browserApi, "cloudBilling").mockResolvedValue({ ...summary, availableMicros: 0 });
    const checkout = checkoutFailure();
    mount();
    const button = await screen.findByRole("button", { name: "Add credits" });
    fireEvent.click(button);
    await screen.findByRole("alert");
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(checkout).toHaveBeenCalledTimes(2));
    expect(checkout.mock.calls[0]?.[0]).toEqual(checkout.mock.calls[1]?.[0]);
    expect(checkout.mock.calls[0]?.[0]).toMatchObject({ amountCents: 1000, idempotencyKey: expect.any(String) });
  });
  it("submits custom amounts in exact cents and starts a new purchase when the amount changes", async () => {
    vi.spyOn(browserApi, "cloudBilling").mockResolvedValue(summary);
    const checkout = checkoutFailure();
    mount();
    const input = await screen.findByRole("textbox", { name: "Amount (USD)" });
    fireEvent.change(input, { target: { value: "12.34" } });
    fireEvent.click(screen.getByRole("button", { name: "Add credits" }));
    await screen.findByRole("alert");
    expect(checkout.mock.calls[0]?.[0].amountCents).toBe(1234);
    fireEvent.change(input, { target: { value: "20.01" } });
    fireEvent.click(screen.getByRole("button", { name: "Add credits" }));
    await waitFor(() => expect(checkout).toHaveBeenCalledTimes(2));
    expect(checkout.mock.calls[1]?.[0].amountCents).toBe(2001);
    expect(checkout.mock.calls[1]?.[0].idempotencyKey).not.toBe(checkout.mock.calls[0]?.[0].idempotencyKey);
  });
  it.each(["", "9.99", "1000.01", "12.345", "-10", "1e3", "NaN"])(
    "rejects invalid amount %s without starting checkout",
    async (amount) => {
      vi.spyOn(browserApi, "cloudBilling").mockResolvedValue(summary);
      const checkout = checkoutFailure();
      mount();
      const input = await screen.findByRole("textbox", { name: "Amount (USD)" });
      fireEvent.change(input, { target: { value: amount } });
      fireEvent.click(screen.getByRole("button", { name: "Add credits" }));
      expect((await screen.findByRole("alert")).textContent).toContain("Enter an amount from $10.00 to $1,000.00");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(checkout).not.toHaveBeenCalled();
      fireEvent.change(input, { target: { value: "15" } });
      expect(input.hasAttribute("aria-invalid")).toBe(false);
    },
  );
  it("guards overlapping form submissions and disables the amount while opening checkout", async () => {
    vi.spyOn(browserApi, "cloudBilling").mockResolvedValue(summary);
    let rejectCheckout: (error: Error) => void = () => {};
    const checkout = vi.spyOn(browserApi, "cloudCreditCheckout").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCheckout = reject;
        }),
    );
    mount();
    const input = await screen.findByRole("textbox", { name: "Amount (USD)" });
    const button = screen.getByRole("button", { name: "Add credits" });
    const form = button.closest("form");
    if (!form) throw new Error("Missing form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(checkout).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Opening checkout…" }).hasAttribute("disabled")).toBe(true);
    expect(input.hasAttribute("disabled")).toBe(true);
    rejectCheckout(new Error("unavailable"));
    await screen.findByRole("alert");
    expect(input.hasAttribute("disabled")).toBe(false);
  });
  it("disables purchases for an Account blocked for payment review", async () => {
    vi.spyOn(browserApi, "cloudBilling").mockResolvedValue({ ...summary, blocked: true });
    const checkout = checkoutFailure();
    mount();
    const button = await screen.findByRole("button", { name: "Add credits" });
    expect(button.hasAttribute("disabled")).toBe(true);
    const form = button.closest("form");
    if (!form) throw new Error("Missing form");
    fireEvent.submit(form);
    expect(checkout).not.toHaveBeenCalled();
  });
  it("shows unsettled usage separately from payment restrictions and keeps top-ups available", async () => {
    vi.spyOn(browserApi, "cloudBilling").mockResolvedValue({ ...summary, usagePaused: true });
    const checkout = checkoutFailure();
    mount();
    expect(await screen.findByText(/New cloud requests are temporarily paused/)).toBeTruthy();
    expect(screen.getByText("$1.00")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add credits" }));
    await waitFor(() => expect(checkout).toHaveBeenCalledTimes(1));
  });
  it("allows retrying a failed balance load", async () => {
    vi.spyOn(browserApi, "cloudBilling").mockRejectedValueOnce(new Error("offline")).mockResolvedValue(summary);
    mount(summary);
    fireEvent.click(await screen.findByRole("button", { name: "Refresh balance" }));
    expect(await screen.findByText("$1.00")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
