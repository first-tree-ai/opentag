async function _formattingScroll(page) {
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
  await page.getByRole("button", { name: "write your own", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Soul", exact: true });
  await editor.evaluate((el) => {
    const data = new DataTransfer();
    data.setData(
      "text/plain",
      Array.from(
        { length: 40 },
        (_, index) => `Rule ${index + 1}: Keep each recommendation precise, useful, and supported by evidence.`,
      ).join("\n\n"),
    );
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    el.scrollTop = el.querySelectorAll("p")[12].offsetTop - el.clientHeight / 2;
  });
  const paragraph = editor.locator("p").nth(12);
  await paragraph.click({ clickCount: 3 });
  const toolbar = page.getByRole("toolbar", { name: "Text formatting", exact: true });
  await toolbar.waitFor();
  await toolbar.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  const menu = toolbar.locator("..");
  const before = await menu.boundingBox();
  const originalScroll = await editor.evaluate((el) => el.scrollTop);
  await editor.evaluate((el) => {
    el.scrollTop += 40;
  });
  const delta = (await editor.evaluate((el) => el.scrollTop)) - originalScroll;
  await page.waitForFunction(
    ({ el, top, delta }) => Math.abs(el.getBoundingClientRect().top - top + delta) < 2,
    { el: await menu.elementHandle(), top: before.y, delta },
    { timeout: 3000 },
  );
  const after = await menu.boundingBox();
  assert(Math.abs(before.y - after.y - delta) < 2, "Formatting menu follows the selection during internal scrolling");
  await page.screenshot({ path: "testing/web-ui/soul-template-browser/formatting-scroll-en-1440.png" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  return {
    scrollDelta: delta,
    menuDelta: before.y - after.y,
    result: "Formatting menu follows internal document scrolling",
  };
}
