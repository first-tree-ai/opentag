async function _literalPaste(page) {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press("Escape");
  assert(
    (await page.getByRole("button", { name: /Soul editor verification \(PR\)/ }).count()) === 1,
    "Use the PR verification Agent",
  );
  const discard = page.getByRole("button", { name: /^(Discard changes|放弃修改)$/ });
  if (await discard.count()) await discard.click();
  await page.evaluate(() => localStorage.setItem("PARAGLIDE_LOCALE", "en"));
  await page.reload();
  const results = [];
  for (const [label, source, selector] of [
    ["fenced code", "```text\nbefore\n```", "pre code"],
    ["prompt source", "<rules>before</rules>", "pre[data-soul-source]"],
    ["inline code", "Keep `before` literal.", "code"],
    ["inline source", "Use <rule> inline.", "span[data-soul-source=inline]"],
    ["image source", "![diagram](https://example.com/image.png)", "span[data-soul-source=image]"],
  ]) {
    await page.getByRole("button", { name: "write your own", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Soul", exact: true });
    await paste(editor, source);
    const literal = editor.locator(selector);
    await literal.waitFor();
    await editor.focus();
    await literal.evaluate(async (el) => {
      const range = document.createRange();
      range.setStart(el.firstChild, 2);
      range.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    await paste(editor, label.includes("inline") || label === "image source" ? "one **two**" : "one\n**two**");
    assert((await literal.count()) === 1, `${label}: no split literal blocks`);
    assert((await literal.textContent()).includes("**two**"), `${label}: Markdown punctuation stays literal`);
    assert((await editor.locator("strong").count()) === 0, `${label}: no parsed formatting`);
    const saved = await page.locator('input[name="instructions"]').inputValue();
    assert(saved.includes("**two**"), `${label}: source retains pasted punctuation`);
    results.push(`${label}: plain text stays inside the literal context`);
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  }
  return results;

  async function paste(editor, text) {
    await editor.evaluate((el, value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
  }
}
