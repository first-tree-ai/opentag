async function _sharedSoulDocument(page) {
  const assert = (value, message) => {
    if (!value) throw new Error(message);
  };
  await page.keyboard.press("Escape");
  assert(
    (await page.getByRole("button", { name: /Soul editor verification/ }).count()) === 1,
    "Use the disposable Soul editor verification Agent",
  );
  const discard = page.getByRole("button", { name: /^(Discard changes|放弃修改)$/ });
  if (await discard.count()) await discard.click();
  const results = [];
  const copy = {
    en: { browse: "Browse templates", research: "Research", use: "Use template", discard: "Discard changes" },
    zh: { browse: "浏览模板", research: "研究", use: "使用模板", discard: "放弃修改" },
  };
  await page.route("**/acceptance-axe.js", (route) =>
    route.fulfill({
      path: "node_modules/.pnpm/axe-core@4.13.0/node_modules/axe-core/axe.min.js",
      contentType: "text/javascript",
    }),
  );
  for (const language of ["en", "zh"]) {
    await page.evaluate((locale) => localStorage.setItem("PARAGLIDE_LOCALE", locale), language);
    await page.reload();
    await page.getByRole("heading", { name: "Soul", exact: true }).waitFor();
    for (const width of [1440, 768, 390, 320]) await check(width, language);
  }
  return results;

  async function check(width, language) {
    const c = copy[language];
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: c.browse, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: c.research, exact: true }).click();
    await dialog.evaluate(async (el) => {
      await new Promise(requestAnimationFrame);
      await Promise.allSettled(el.getAnimations({ subtree: true }).map((animation) => animation.finished));
    });
    const preview = dialog.locator(".soul-document");
    const before = await typography(preview);
    assert(before.root.fontSize === (width < 768 ? "16px" : "14px"), "Responsive body font");
    assert(before.heading.fontSize === "16px" && before.heading.fontWeight === "600", "Section heading");
    assert(before.heading.marginBottom === "8px" && before.section.marginTop === "24px", "Section spacing");
    assert(before.paragraph.marginBottom === "16px", "Paragraph spacing");
    assert(before.list.listStyleType === "disc" && before.list.paddingLeft === "24px", "Visible bullets");
    const originalItems = await preview.locator("li").allTextContents();
    assert(originalItems.length === 6 && (await preview.locator("ul").count()) === 2, "Research lists");
    await accessible(`preview ${language} ${width}`);
    await screenshot("preview", language, width);
    await dialog.getByRole("button", { name: c.use, exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Soul", exact: true });
    await editor.waitFor();
    const after = await typography(editor);
    assert(
      JSON.stringify(before) === JSON.stringify(after),
      `Preview/editor typography: ${JSON.stringify({ before, after })}`,
    );
    assert(
      JSON.stringify(await editor.locator("li").allTextContents()) === JSON.stringify(originalItems),
      "Template list text preserved",
    );
    const originalText = await editor.textContent();
    const source = await page.locator('input[name="instructions"]').inputValue();
    assert(
      source.match(/^## /gm)?.length === 4 && source.match(/^- /gm)?.length === 6,
      "Markdown body structure preserved",
    );
    const personal = language === "en" ? "Personal notes" : "个人补充";
    const rule = language === "en" ? "Keep recommendations concise." : "建议保持简洁。";
    await editor.locator(":scope > p").last().click({ clickCount: 3 });
    await page.keyboard.press("ArrowRight");
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("## ");
    await page.keyboard.insertText(personal);
    await page.keyboard.press("Enter");
    await page.keyboard.type("- ");
    await page.keyboard.insertText(rule);
    const personalHeading = editor.getByRole("heading", { name: personal, exact: true });
    assert((await personalHeading.count()) === 1, "User heading shortcut");
    assert((await editor.locator("ul").count()) === 3, "User bullet shortcut");
    const headingStyle = await style(personalHeading);
    assert(
      JSON.stringify(headingStyle) === JSON.stringify(after.section),
      `User/template heading typography: ${JSON.stringify({ headingStyle, expected: after.section })}`,
    );
    const itemStyle = await style(editor.locator("li").last());
    assert(JSON.stringify(itemStyle) === JSON.stringify(after.item), "User/template list typography");
    assert(
      (await page.locator('input[name="instructions"]').inputValue()).includes(rule),
      "User content retained in Markdown",
    );
    assert(
      (await editor.textContent()).startsWith(originalText),
      "Original template remains intact before personal additions",
    );
    await accessible(`editor ${language} ${width}`);
    await editor.evaluate((el) => {
      el.scrollTop = 0;
    });
    await screenshot("editor", language, width);
    await page.getByRole("button", { name: c.discard, exact: true }).click();
    results.push({ language, width, typography: after, templateItems: 6, userHeadingAndList: true, axe: "passed" });
  }

  async function screenshot(kind, language, width) {
    if (width !== 1440 && width !== 390) return;
    await page.screenshot({
      path: `testing/web-ui/soul-template-browser/shared-document-${kind}-${language}-${width}.png`,
    });
  }

  async function style(locator) {
    return locator.evaluate((el) => {
      const s = getComputedStyle(el);
      return Object.fromEntries(
        [
          "fontFamily",
          "fontSize",
          "fontWeight",
          "lineHeight",
          "marginTop",
          "marginBottom",
          "paddingLeft",
          "listStyleType",
        ].map((key) => [key, s[key]]),
      );
    });
  }
  async function typography(root) {
    return {
      root: await root.evaluate((el) => {
        const s = getComputedStyle(el);
        return { fontFamily: s.fontFamily, fontSize: s.fontSize, lineHeight: s.lineHeight };
      }),
      heading: await style(root.locator("h2, h3").first()),
      section: await style(root.locator("h2, h3").nth(1)),
      paragraph: await style(root.locator(":scope > p").first()),
      list: await style(root.locator("ul").first()),
      item: await style(root.locator("li").first()),
    };
  }
  async function accessible(label) {
    if (!(await page.evaluate(() => typeof window.axe !== "undefined")))
      await page.addScriptTag({ url: "/acceptance-axe.js" });
    const violations = await page.evaluate(async () =>
      (await window.axe.run()).violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
    );
    assert(violations.length === 0, `${label}: ${JSON.stringify(violations)}`);
  }
}
