import { CLOUD_BILLING_PATH, type CloudBillingSummary } from "@opentag/shared/browser";
import { expectAccessible, expectNoPageOverflow } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";

for (const width of [320, 390]) {
  test(`cloud credit banner actions retain mobile touch targets at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const me = await page.request.get("/api/v1/me");
    expect(me.ok()).toBe(true);
    const { user } = await me.json();
    await page.addInitScript((accountId) => {
      window.sessionStorage.setItem(`opentag.checkout-return:${accountId}`, String(Date.now()));
    }, user.id);

    // Only billing responses are mocked; authentication, the built app, and its styles are real.
    let unavailable = false;
    const summary: CloudBillingSummary = {
      enabled: true,
      currency: "USD",
      availableMicros: 0,
      blocked: false,
      usagePaused: false,
      minimumTopUpCents: 1000,
      maximumTopUpCents: 100_000,
    };
    await page.route(`**${CLOUD_BILLING_PATH}`, (route) =>
      route.fulfill(
        unavailable
          ? {
              status: 503,
              json: { error: { code: "CLOUD_BILLING_UNAVAILABLE", category: "transient", message: "Unavailable" } },
            }
          : { json: summary },
      ),
    );
    await page.goto("/account");
    const billing = page.getByRole("region", { name: "Cloud credits" });
    await expect(billing.getByText("Back from checkout", { exact: true })).toBeVisible();
    for (const name of ["Refresh balance", "Dismiss", "Buy credits", "Add credits"]) {
      const action = billing.getByRole("button", { name, exact: true });
      await expect(action).toBeVisible();
      await expect
        .poll(async () => (await action.boundingBox())?.height ?? 0, `${name} touch target`)
        .toBeGreaterThanOrEqual(44);
    }
    await billing.getByRole("button", { name: "Buy credits", exact: true }).click();
    await expect(billing.getByRole("textbox", { name: "Amount (USD)" })).toBeFocused();
    await expectNoPageOverflow(page);
    await expectAccessible(page);
    await testInfo.attach("billing-mobile", { body: await billing.screenshot(), contentType: "image/png" });

    unavailable = true;
    await billing.getByRole("button", { name: "Refresh balance", exact: true }).click();
    const refreshError = billing.getByRole("alert");
    await expect(refreshError).toContainText("Cloud billing could not be reached");
    const retry = refreshError.getByRole("button", { name: "Refresh balance", exact: true });
    await expect
      .poll(async () => (await retry.boundingBox())?.height ?? 0, "Refresh-error touch target")
      .toBeGreaterThanOrEqual(44);
    await expectNoPageOverflow(page);
    unavailable = false;
    await retry.click();
    await expect(refreshError).toHaveCount(0);
  });
}
