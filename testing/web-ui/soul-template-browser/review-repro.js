async function _reviewFailureClear(page) {
  await page.evaluate(() => localStorage.setItem("PARAGLIDE_LOCALE", "en"));
  await page.reload();
  const write = page.getByRole("button", { name: "write your own", exact: true });
  await write.waitFor();
  const apiPath = `/api/v1/agents/${page.url().split("/").at(-2)}`;
  const fail = (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 503, json: { error: { message: "Independent review fixture" } } })
      : route.continue();
  await page.route(`**${apiPath}`, fail);
  await write.click();
  const editor = page.getByRole("textbox", { name: "Soul", exact: true });
  await editor.fill("Review draft before the first save.");
  await page.getByRole("button", { name: "Apply changes", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Couldn’t confirm the update. Try again." }).waitFor();
  await page.screenshot({ path: "testing/web-ui/soul-template-browser/review-first-save-error.png" });
  await editor.fill("");
  await page.screenshot({ path: "testing/web-ui/soul-template-browser/review-clear-after-first-save-error.png" });
  const result = {
    editorCountAfterClearing: await editor.count(),
    emptyHeadingVisible: await page.getByRole("heading", { name: "No Soul yet", exact: true }).isVisible(),
    focusedElement: await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      id: document.activeElement?.id,
    })),
    errorVisible: await page.getByRole("alert").count(),
  };
  await page.unroute(`**${apiPath}`, fail);
  await page.getByRole("button", { name: "Start with a template", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Choose a template", exact: true });
  const research = dialog.getByRole("button", { name: "Research", exact: true });
  await research.click();
  await research.focus();
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  const resizeFocus = await dialog.evaluate((el) => ({
    insideDialog: el.contains(document.activeElement),
    tag: document.activeElement?.tagName,
    label: document.activeElement?.getAttribute("aria-label"),
    visible: document.activeElement?.getClientRects().length > 0,
  }));
  await page.keyboard.press("Escape");
  return { firstSaveErrorThenClear: result, desktopToMobileFocus: resizeFocus };
}
