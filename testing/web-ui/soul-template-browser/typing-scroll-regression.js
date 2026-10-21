async function _typingScrollRegression(page) {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  assert(
    (await page.getByRole("button", { name: /Soul editor verification/ }).count()) === 1,
    "Run only against the disposable Soul editor verification Agent",
  );
  const editor = () => page.getByRole("textbox", { name: "Soul", exact: true });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const discard = page.getByRole("button", { name: /^(Discard changes|放弃修改)$/ });
  if (await discard.count()) await discard.click();
  await page.evaluate(() => localStorage.setItem("PARAGLIDE_LOCALE", "en"));
  await page.reload();
  const results = [];
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1440, height: 700 },
    { width: 390, height: 844 },
  ]) {
    results.push(await check(viewport));
  }
  return results;

  async function check(viewport) {
    await page.setViewportSize(viewport);
    if (!(await editor().count())) await button("write your own").click();
    await editor().evaluate((el) => {
      const data = new DataTransfer();
      data.setData(
        "text/plain",
        Array.from(
          { length: 55 },
          (_, i) =>
            `Paragraph ${i + 1}: Keep the user focused on their current writing and preserve the position of the caret.`,
        ).join("\n\n"),
      );
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await editor().focus();
    await page.keyboard.press("ControlOrMeta+End");
    await editor().evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    async function measure() {
      await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      return await editor().evaluate((el) => {
        const r = window.getSelection().getRangeAt(0).getBoundingClientRect();
        const b = el.getBoundingClientRect();
        return {
          scroll: el.scrollTop,
          height: el.clientHeight,
          caretTop: r.top,
          caretBottom: r.bottom,
          top: b.top,
          bottom: b.bottom,
          visible: r.height > 0 && r.top >= Math.max(0, b.top) && r.bottom <= Math.min(innerHeight, b.bottom),
        };
      });
    }
    const before = await measure();
    assert(before.visible, "Fixture starts with the caret visible at the end of a long document");
    await page.keyboard.type("x");
    const after = await measure();
    assert(after.visible, `Typing hides the caret: ${JSON.stringify({ before, after })}`);
    for (const text of [" continuing to write", "，继续输入中文。"]) {
      await page.keyboard.insertText(text);
      const state = await measure();
      assert(state.visible, `Continuing input hides the caret: ${JSON.stringify(state)}`);
    }
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Enter");
      await page.keyboard.type(`New line ${i + 1}.`);
      const state = await measure();
      assert(state.visible, `Newline hides the caret: ${JSON.stringify(state)}`);
    }
    await page.screenshot({
      path: `testing/web-ui/soul-template-browser/typing-scroll-fixed-${viewport.width}x${viewport.height}.png`,
    });
    await button("Discard changes").click();
    return {
      viewport,
      before,
      after,
      result: "Long-document typing, Chinese committed text, wrapping and new paragraphs keep the caret visible",
    };
  }
}
