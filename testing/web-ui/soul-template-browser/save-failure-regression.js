async function _firstSaveFailureRegression(page) {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const editor = () => page.getByRole("textbox", { name: "Soul", exact: true });
  async function setText(text) {
    await editor().focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    if (text) await page.keyboard.insertText(text);
  }
  const button = (scope, name) => scope.getByRole("button", { name, exact: true });
  const copy = {
    en: {
      write: "write your own",
      start: "Start with a template",
      dialog: "Choose a template",
      role: "Engineering",
      use: "Use template",
      apply: "Apply changes",
      cancel: "Cancel",
      empty: "No Soul yet",
      failed: "Couldn’t confirm the update. Try again.",
      saved: "Saved. Takes effect with the next response.",
    },
    zh: {
      write: "按你的想法编写",
      start: "从模板开始",
      dialog: "选择模板",
      role: "工程",
      use: "使用模板",
      apply: "应用修改",
      cancel: "取消",
      empty: "尚未设置 Soul",
      failed: "无法确认更新结果，请重试。",
      saved: "已保存，将从下次回复开始生效。",
    },
  };
  const apiPath = `/api/v1/agents/${page.url().split("/").at(-2)}`;
  const results = [];
  for (const language of ["en", "zh"]) {
    const c = copy[language];
    await page.evaluate((locale) => localStorage.setItem("PARAGLIDE_LOCALE", locale), language);
    await page.reload();
    await page.getByRole("heading", { name: c.empty, exact: true }).waitFor();
    await page.setViewportSize({ width: language === "en" ? 1440 : 390, height: 900 });
    for (const entry of ["manual", "template"]) {
      const fail = (route) =>
        route.request().method() === "PATCH"
          ? route.fulfill({ status: 503, json: { error: { message: "Save regression fixture" } } })
          : route.continue();
      await page.route(`**${apiPath}`, fail);
      if (entry === "manual") {
        await button(page, c.write).click();
      } else {
        await button(page, c.start).click();
        const dialog = page.getByRole("dialog", { name: c.dialog, exact: true });
        await button(dialog, c.role).click();
        await button(dialog, c.use).click();
      }
      await setText("First draft.");
      await button(page, c.apply).click();
      await page.getByRole("alert").filter({ hasText: c.failed }).waitFor();
      await page.unroute(`**${apiPath}`, fail);
      const originalEditor = await editor().elementHandle();
      await setText("");
      assert(await editor().isVisible(), `${language} ${entry}: editor must remain visible after clearing`);
      await page.waitForFunction((el) => el === document.activeElement, originalEditor);
      assert(await button(page, c.cancel).isVisible(), "Blank editing retains explicit Cancel");
      assert((await button(page, c.apply).count()) === 0, "Unchanged blank draft cannot save");
      await page.screenshot({
        path: `testing/web-ui/soul-template-browser/fixed-clear-after-save-error-${language}-${entry}.png`,
      });
      const rewritten = `${language} ${entry}: rewritten after a failed first save.`;
      await setText(rewritten);
      await button(page, c.apply).click();
      await page.getByRole("status").filter({ hasText: c.saved }).waitFor();
      assert(
        (await page.locator('input[name="instructions"]').inputValue()) === rewritten,
        "Retry preserves confirmed content",
      );
      const persisted = await page.request.get(`http://127.0.0.1:8137${apiPath}/config`);
      assert(persisted.ok(), "Read confirmed saved content");
      assert((await persisted.json()).runtimeConfig.instructions === rewritten, "Retry persists the rewritten draft");
      await setText("");
      await button(page, c.apply).click();
      await page.getByRole("heading", { name: c.empty, exact: true }).waitFor();
      assert((await editor().count()) === 0, "Confirmed clearing restores empty state");
      results.push(
        `${language} ${entry}: failed first save, clear with retained focus, rewrite, real save, and confirmed clear passed`,
      );
    }
    const fail = (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 503, json: { error: { message: "Save regression fixture" } } })
        : route.continue();
    await page.route(`**${apiPath}`, fail);
    await button(page, c.write).click();
    await setText("Cancel after a failed first save.");
    await button(page, c.apply).click();
    await page.getByRole("alert").filter({ hasText: c.failed }).waitFor();
    await page.unroute(`**${apiPath}`, fail);
    await setText("");
    await button(page, c.cancel).click();
    await page.getByRole("heading", { name: c.empty, exact: true }).waitFor();
    await page.waitForFunction((el) => el === document.activeElement, await button(page, c.write).elementHandle());
    results.push(
      `${language}: explicit Cancel after clearing a failed first draft restores the empty state and writing focus`,
    );
  }
  return results;
}
