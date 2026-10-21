async function _richEditorJourney(page) {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const editor = () => page.getByRole("textbox", { name: "Soul", exact: true });
  await page.route("**/acceptance-axe.js", (route) =>
    route.fulfill({
      path: "node_modules/.pnpm/axe-core@4.13.0/node_modules/axe-core/axe.min.js",
      contentType: "text/javascript",
    }),
  );
  const source = () => page.locator('input[name="instructions"]').inputValue();
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.evaluate(() => localStorage.setItem("PARAGLIDE_LOCALE", "en"));
  await page.reload();
  if (await button("Discard changes").count()) await button("Discard changes").click();
  await button("write your own").click();
  await editor().evaluate((el) => {
    const data = new DataTransfer();
    data.setData(
      "text/plain",
      "## Role and purpose\n\nBe precise and considerate.\n\n- Verify claims\n- Explain limits",
    );
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await editor().getByRole("heading", { name: "Role and purpose", exact: true }).waitFor();
  assert((await editor().locator("li").count()) === 2, "Markdown clipboard renders headings and lists");
  const baseline = await source();
  const paragraph = editor().locator("p").filter({ hasText: "Be precise and considerate." });
  await paragraph.click({ clickCount: 3 });
  await page.keyboard.press("Alt+F10");
  const toolbar = page.getByRole("toolbar", { name: "Text formatting", exact: true });
  await toolbar.waitFor();
  assert((await toolbar.getByRole("button").count()) === 3, "Only heading, bold, and list controls are exposed");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Heading");
  await page.keyboard.press("ArrowRight");
  assert(
    (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "Bold",
    "Kumo owns arrow-key navigation",
  );
  await page.keyboard.press("Enter");
  await editor().locator("strong").filter({ hasText: "Be precise and considerate." }).waitFor();
  assert((await source()).includes("**Be precise and considerate.**"), "Formatting updates Markdown");
  await editor().focus();
  await page.keyboard.press("ControlOrMeta+z");
  assert((await source()) === baseline, "Undo restores the unformatted document");
  await page.keyboard.press("Alt+F10");
  await toolbar.waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "textbox");
  await toolbar.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const footer = page.locator("form > div").last();
  await button("Apply changes").scrollIntoViewIfNeeded();
  const before = await footer.boundingBox();
  await editor().focus();
  await page.keyboard.press("Alt+F10");
  await toolbar.waitFor();
  const apiPattern = `**/api/v1/agents/${page.url().split("/").at(-2)}`;
  let heldSave;
  const hold = (route) => {
    if (route.request().method() === "PATCH") heldSave = route;
    else return route.continue();
  };
  await page.route(apiPattern, hold);
  await button("Apply changes").click();
  await page.waitForFunction(
    () => document.querySelector('[role="textbox"][aria-label="Soul"]')?.getAttribute("contenteditable") === "false",
  );
  const savingSource = await source();
  for (const control of await toolbar.getByRole("button", { hidden: true }).all()) {
    const disabled = await control.evaluate((el) => el.disabled || el.getAttribute("aria-disabled") === "true");
    assert(disabled, "Formatting is disabled while saving");
    await control.evaluate((el) => el.click());
  }
  assert((await source()) === savingSource, "Formatting cannot change an in-flight saved draft");
  assert(heldSave, "The save is held for the busy-state regression");
  await heldSave.continue();
  await page.unroute(apiPattern, hold);
  await page.getByRole("status").filter({ hasText: "Saved. Takes effect with the next response." }).waitFor();
  const after = await footer.boundingBox();
  assert(Math.abs(before.height - after.height) < 1, "Successful save keeps the footer height stable");
  assert((await button("Apply changes").count()) === 0, "Saved state hides redundant actions");
  await page.screenshot({ path: "testing/web-ui/soul-template-browser/rich-saved-en-1440.png" });
  await page.reload();
  await editor().waitFor();
  assert((await source()) === baseline, "Reload preserves saved Markdown exactly");
  assert((await button("Apply changes").count()) === 0, "Loading a document does not create an unsaved change");
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(() => localStorage.setItem("PARAGLIDE_LOCALE", "zh"));
  await page.reload();
  await editor().waitFor();
  assert((await source()) === baseline, "Changing interface language preserves the saved body");
  await editor().focus();
  await page.keyboard.press("ControlOrMeta+a");
  const mobileToolbar = page.getByRole("toolbar", { name: "文字格式", exact: true });
  await mobileToolbar.waitFor();
  for (const control of await mobileToolbar.getByRole("button").all()) {
    const target = await control.boundingBox();
    assert(target.width >= 44 && target.height >= 44, "Mobile toolbar controls use the shared 44px touch target");
  }
  const box = await mobileToolbar.boundingBox();
  assert(
    box.x >= 0 && box.y >= 0 && box.x + box.width <= 391 && box.y + box.height <= 900,
    "Selection toolbar stays inside a narrow viewport",
  );
  if (!(await page.evaluate(() => typeof window.axe !== "undefined")))
    await page.addScriptTag({ url: "/acceptance-axe.js" });
  const violations = await page.evaluate(async () => (await window.axe.run()).violations.map((v) => v.id));
  assert(violations.length === 0, `Editor accessibility: ${violations}`);
  await page.screenshot({ path: "testing/web-ui/soul-template-browser/rich-selection-zh-390.png" });
  await page.keyboard.press("Escape");
  await page.evaluate(() => localStorage.setItem("PARAGLIDE_LOCALE", "en"));
  await page.reload();
  await editor().fill("");
  await button("Apply changes").click();
  await page.getByRole("heading", { name: "No Soul yet", exact: true }).waitFor();
  return [
    "Markdown paste/rendering",
    "Kumo toolbar: three controls and keyboard navigation",
    "Bold/undo and Escape focus",
    "Stable single-row save feedback",
    "Reload and locale preserve source",
    "390px selection toolbar and axe",
    "Confirmed clear",
  ];
}
