async function _soulAcceptance(page) {
  const results = [];
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const copy = {
    en: {
      browse: "Browse templates",
      contextual: "Start with a template",
      dialog: "Choose a template",
      list: "Templates",
      role: "Engineering",
      use: "Use template",
      cancel: "Cancel",
      back: "All templates",
      last: "Communication style",
    },
    zh: {
      browse: "浏览模板",
      contextual: "从模板开始",
      dialog: "选择模板",
      list: "模板",
      role: "工程",
      use: "使用模板",
      cancel: "取消",
      back: "全部模板",
      last: "沟通风格",
    },
  };
  const editor = () => page.getByRole("textbox", { name: "Soul", exact: true });
  async function setText(text) {
    await editor().focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    if (text) await page.keyboard.insertText(text);
  }
  const button = (scope, name) => scope.getByRole("button", { name, exact: true });
  await page.keyboard.press("Escape");
  assert(/\/agents\/[^/]+\/instructions$/.test(page.url()), "Open a disposable test Agent's Soul first");
  await page.route("**/acceptance-axe.js", (route) =>
    route.fulfill({
      path: "node_modules/.pnpm/axe-core@4.13.0/node_modules/axe-core/axe.min.js",
      contentType: "text/javascript",
    }),
  );

  async function accessible(label) {
    const modal = page.getByRole("dialog");
    if (await modal.count()) {
      await modal.evaluate(async (element) => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        await Promise.allSettled(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
      });
    }
    if (!(await page.evaluate(() => typeof window.axe !== "undefined")))
      await page.addScriptTag({ url: "/acceptance-axe.js" });
    const violations = await page.evaluate(async () =>
      (await window.axe.run()).violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
    );
    assert(violations.length === 0, `${label}: ${JSON.stringify(violations)}`);
  }
  async function bounds(locator, label) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    const viewport = page.viewportSize();
    assert(
      box &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width + 1 &&
        box.y + box.height <= viewport.height + 1,
      `${label}: outside viewport`,
    );
  }
  async function focused(locator, label) {
    try {
      await page.waitForFunction((element) => element === document.activeElement, await locator.elementHandle());
    } catch (cause) {
      throw new Error(label, { cause });
    }
  }
  async function locale(value) {
    await page.evaluate((next) => localStorage.setItem("PARAGLIDE_LOCALE", next), value);
    await page.reload();
    await page.getByRole("heading", { name: "Soul", exact: true }).waitFor();
  }
  async function audit(width, language) {
    const c = copy[language];
    await page.setViewportSize({ width, height: 900 });
    assert((await editor().count()) === 0, "Initial empty state has no editor frame");
    const entry = button(page.getByRole("main"), c.browse).first();
    await bounds(entry, "persistent entry");
    await page.screenshot({ path: `testing/web-ui/soul-template-browser/empty-${language}-${width}.png` });
    await accessible(`empty ${language} ${width}`);
    await button(page.getByRole("main"), c.contextual).last().click();
    const dialog = page.getByRole("dialog", { name: c.dialog, exact: true });
    await dialog.waitFor();
    await dialog.evaluate(async (element) => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      await Promise.allSettled(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
    });
    const list = dialog.getByRole("navigation", { name: c.list, exact: true });
    assert((await list.getByRole("button").count()) === 8, "Eight templates expected");
    if (width < 768) {
      assert(!(await dialog.locator("section").isVisible()), "Mobile starts at the list");
      await accessible(`list ${language} ${width}`);
      await page.screenshot({ path: `testing/web-ui/soul-template-browser/list-${language}-${width}.png` });
    }
    await button(list, c.role).click();
    const reader = dialog.getByRole("region", { name: c.role, exact: true });
    await reader.waitFor();
    assert((await reader.locator("h3").count()) === 4, "All four body sections are expanded");
    assert((await reader.locator("p").first().innerText()).length > 30, "Task applicability overview is present");
    await bounds(dialog, "chooser");
    await bounds(button(dialog, c.use), "Use template");
    const footerBefore = await button(dialog, c.use).boundingBox();
    await reader.focus();
    await page.keyboard.press("End");
    await reader.getByRole("heading", { name: c.last, exact: true }).scrollIntoViewIfNeeded();
    const footerAfter = await button(dialog, c.use).boundingBox();
    assert(Math.abs(footerBefore.y - footerAfter.y) < 1, "Reader scrolling keeps footer stable");
    await reader.evaluate((el) => {
      el.scrollTop = 0;
    });
    await accessible(`detail ${language} ${width}`);
    await page.screenshot({ path: `testing/web-ui/soul-template-browser/templates-${language}-${width}.png` });
    if (width < 768) {
      await button(dialog, c.back).click();
      await button(list, c.role).waitFor();
      await focused(button(list, c.role), "Back returns focus to selection");
      await button(list, c.role).click();
    }
    await button(dialog, c.cancel).click();
    await dialog.waitFor({ state: "hidden" });
    assert((await editor().count()) === 0, "Cancel leaves the empty state unchanged");
    await focused(button(page.getByRole("main"), c.contextual).last(), "Cancel restores the contextual opener");
    await entry.click();
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await focused(entry, "Escape restores the header opener");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    assert(!overflow, "No page-level horizontal overflow");
    results.push(`${language} ${width}: layout, full reader, focus, cancel, Escape, axe`);
  }
  for (const language of ["en", "zh"]) {
    await locale(language);
    for (const width of [1440, 768, 390, 320]) await audit(width, language);
  }
  await locale("en");
  await page.setViewportSize({ width: 1440, height: 900 });
  const path = page.url();
  const apiPath = `/api/v1/agents/${path.split("/").at(-2)}`;
  let writes = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === apiPath && request.method() === "PATCH") writes++;
  });
  await button(page, "write your own").click();
  await setText("Keep my unsaved custom workflow.");
  await button(page, "Browse templates").first().click();
  let dialog = page.getByRole("dialog", { name: copy.en.dialog });
  await button(dialog, "Research").click();
  await button(dialog, "Cancel").click();
  await dialog.waitFor({ state: "hidden" });
  assert(
    (await page.locator('input[name="instructions"]').inputValue()) === "Keep my unsaved custom workflow.",
    "Preview preserves dirty draft",
  );
  await button(page, "Discard changes").click();
  await button(page, "Browse templates").first().click();
  dialog = page.getByRole("dialog", { name: copy.en.dialog });
  await button(dialog, "Use template").click();
  await dialog.waitFor({ state: "hidden" });
  const body = await page.locator('input[name="instructions"]').inputValue();
  assert(
    body.startsWith("## Role and purpose\n") && body.includes("## Communication style\n"),
    "Only the complete body fills the editor",
  );
  assert(writes === 0, "Use template does not save");
  await focused(editor(), "Use template focuses editor");
  await page.screenshot({ path: "testing/web-ui/soul-template-browser/draft-en-1440.png" });
  await button(page, "Apply changes").click();
  await page.getByText("Saved. Takes effect with the next response.", { exact: true }).waitFor();
  assert(writes === 1, "One explicit write");
  await accessible("saved");
  await page.screenshot({ path: "testing/web-ui/soul-template-browser/saved-en-1440.png" });
  await setText("Temporary edit");
  await button(page, "Discard changes").click();
  assert((await page.locator('input[name="instructions"]').inputValue()) === body, "Discard restores latest save");
  await locale("zh");
  assert(
    (await page.locator('input[name="instructions"]').inputValue()) === body,
    "Locale preserves English saved body",
  );
  await button(page, copy.zh.browse).first().click();
  dialog = page.getByRole("dialog", { name: copy.zh.dialog });
  await button(dialog, copy.zh.use).click();
  await dialog.waitFor({ state: "hidden" });
  assert(
    (await page.locator('input[name="instructions"]').inputValue()).startsWith("## 角色与目标\n"),
    "Chinese selection uses Chinese body",
  );
  await button(page, "放弃修改").click();
  assert((await page.locator('input[name="instructions"]').inputValue()) === body, "Discard restores saved language");
  await locale("en");
  await setText("Keep this during failure");
  const failWrite = (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 503, json: { error: { message: "Fixture unavailable" } } })
      : route.continue();
  await page.route(`**${apiPath}`, failWrite);
  await button(page, "Apply changes").click();
  await page.getByRole("alert").filter({ hasText: "Couldn’t confirm the update. Try again." }).waitFor();
  assert(
    (await page.locator('input[name="instructions"]').inputValue()) === "Keep this during failure",
    "Failure preserves draft",
  );
  await accessible("save failure");
  await page.screenshot({ path: "testing/web-ui/soul-template-browser/error-en-1440.png" });
  await page.unroute(`**${apiPath}`, failWrite);
  let releaseSave;
  const saveGate = new Promise((resolve) => {
    releaseSave = resolve;
  });
  const holdWrite = async (route) => {
    if (route.request().method() === "PATCH") await saveGate;
    await route.continue();
  };
  await page.route(`**${apiPath}`, holdWrite);
  try {
    await button(page, "Apply changes").click();
    await button(page, "Applying…").waitFor();
    assert((await editor().getAttribute("contenteditable")) === "false", "Saving disables editing");
    assert(await button(page, "Browse templates").isDisabled(), "Saving disables template replacement");
    assert(await button(page, "Discard changes").isDisabled(), "Saving disables discard");
  } finally {
    releaseSave();
  }
  await page.getByText("Saved. Takes effect with the next response.", { exact: true }).waitFor();
  await page.unroute(`**${apiPath}`, holdWrite);
  const latestSaved = "Keep this during failure";
  await setText("Leave guard draft");
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  const guard = page.getByRole("dialog", { name: "Discard your changes?", exact: true });
  await guard.waitFor();
  await button(guard, "Keep editing").click();
  await guard.waitFor({ state: "hidden" });
  assert(
    (await page.locator('input[name="instructions"]').inputValue()) === "Leave guard draft",
    "Keep editing preserves draft",
  );
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await button(guard, "Discard and leave").click();
  await page.waitForURL(path.replace(/\/instructions$/, ""));
  await page.goto(path);
  await editor().waitFor();
  assert(
    (await page.locator('input[name="instructions"]').inputValue()) === latestSaved,
    "Discard and leave does not alter saved Soul",
  );
  await setText("");
  await page.getByText("Apply to clear Soul.", { exact: true }).waitFor();
  await button(page, "Apply changes").click();
  await page.getByText("Saved. Takes effect with the next response.", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "No Soul yet", exact: true }).waitFor();
  assert((await editor().count()) === 0, "Explicit clear restores the empty state without saving guidance");
  await accessible("cleared");
  results.push(
    "Save, draft replacement, latest-saved discard, locale preservation, error recovery, busy controls, unsaved-navigation guard, explicit clear",
  );
  return results;
}
