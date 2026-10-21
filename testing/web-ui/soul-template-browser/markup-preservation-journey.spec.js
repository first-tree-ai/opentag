async function _markupPreservation(page) {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press("Escape");
  assert(
    (await page.getByRole("button", { name: /Soul editor verification \(PR\)/ }).count()) === 1,
    "Use only the separate PR verification Agent",
  );
  const editor = () => page.getByRole("textbox", { name: "Soul", exact: true });
  const source = () => page.locator('input[name="instructions"]').inputValue();
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.evaluate(() => localStorage.setItem("PARAGLIDE_LOCALE", "en"));
  await page.reload();
  await page.getByRole("heading", { name: "Soul", exact: true }).waitFor();
  if (await editor().count()) {
    await editor().fill("");
    await button("Apply changes").click();
    await page.getByRole("heading", { name: "No Soul yet", exact: true }).waitFor();
  }
  await button("write your own").click();
  const original = [
    "<![CDATA[Keep this instruction]]>",
    "",
    "Intro.",
    "",
    "---",
    "",
    "## Working principles",
    "",
    "- Verify facts.",
    "- Cite evidence.",
    "",
    "---",
    "",
    'Use <![CDATA[Keep this inline rule]]> and <?xml version="1.0"?> inline.',
    "",
    'Use <rule when="a > b">x</rule> and read [policy].',
    "",
    "  <!-- keep this indented note -->",
    "",
    "  [policy]: https://example.com/policy",
    "",
    "![diagram][source]",
    "",
    "[source]: https://example.com/private.png",
    "",
    "Keep &lt;literal&gt; and &amp; unchanged.",
    "",
    "If score > 0.8 then stop. Use a < b, Q&A, and R&D.",
    "",
    "Call read_file and chat_send with {{user_name}}.",
    "",
    "1\\. Not a list item.",
    "",
    "\\# Not a heading",
    "",
    "\\- not a bullet",
  ].join("\n");
  await editor().evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, original);
  await button("Apply changes").click();
  await page.getByRole("status").filter({ hasText: "Saved." }).waitFor();
  await page.reload();
  await editor().waitFor();
  assert((await source()).includes("<![CDATA[Keep this instruction]]>"), "Saved CDATA survives reload");
  assert((await editor().locator("hr").count()) === 2, "Ordinary separators remain horizontal rules");
  assert(
    (await editor().getByRole("heading", { name: "Working principles", exact: true }).count()) === 1,
    "Heading between separators stays formatted",
  );
  assert((await editor().locator("li").count()) === 2, "Lists between separators stay formatted");
  await editor().focus();
  await editor().evaluate(async (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type(
    'Wrap replies in <answer>...</answer>. Use <rule when="a > b">x</rule>. If score > 0.8, call read_file & chat_send with {{user_name}}.',
  );
  const typed = await source();
  assert(typed.includes("Wrap replies in <answer>...</answer>."), "Keyboard-created tags remain literal");
  assert(typed.includes("<![CDATA[Keep this instruction]]>"), "Unrelated typing retains XML content");
  assert(typed.includes("<![CDATA[Keep this inline rule]]>"), "Unrelated typing retains inline XML");
  assert(typed.includes('<?xml version="1.0"?>'), "Unrelated typing retains inline processing instructions");
  assert(typed.includes("![diagram][source]"), "Reference image syntax remains intact");
  assert(typed.includes('<rule when="a > b">x</rule>'), "Quoted angle brackets remain intact");
  assert(typed.includes("read [policy]."), "Shortcut references remain intact");
  assert(typed.includes("  <!-- keep this indented note -->"), "Indented source remains intact");
  assert(typed.includes("Keep &lt;literal&gt; and &amp; unchanged."), "Existing entity literals remain unchanged");
  assert(
    typed.includes("If score > 0.8 then stop. Use a < b, Q&A, and R&D."),
    "Prose comparisons and ampersands stay literal",
  );
  assert(
    typed.includes("Call read_file and chat_send with {{user_name}}."),
    "Loaded tool names and placeholders gain no escapes",
  );
  assert(
    typed.includes("If score > 0.8, call read_file & chat_send with {{user_name}}."),
    "Typed prompt text gains no entities or identifier escapes",
  );
  for (const literal of ["1\\. Not a list item.", "\\# Not a heading", "\\- not a bullet"])
    assert(typed.includes(literal), "Literal line starts retain their structural escapes");
  await button("Apply changes").click();
  await page.getByRole("status").filter({ hasText: "Saved." }).waitFor();
  const path = new URL(page.url()).pathname.replace(/\/instructions$/, "/config");
  const saved = await page.request.get(new URL(`/api/v1${path}`, page.url()).href);
  assert(
    saved.ok() && (await saved.json()).runtimeConfig.instructions === typed,
    "Real API persists the exact emitted prompt",
  );
  await page.reload();
  await editor().waitFor();
  assert((await source()) === typed, "Reload preserves the saved prompt exactly");
  assert(
    (await editor().textContent()).includes("If score > 0.8 then stop."),
    "Reload displays comparison symbols literally",
  );
  assert(
    (await editor().getByRole("heading", { name: "Not a heading", exact: true }).count()) === 0,
    "Escaped heading remains paragraph text",
  );
  assert((await editor().locator("answer, script, img").count()) === 0, "Prompt markup remains inert");
  await page.screenshot({ path: "testing/web-ui/soul-template-browser/markup-preservation-en-1440.png" });
  await editor().fill("");
  await button("Apply changes").click();
  await page.getByRole("heading", { name: "No Soul yet", exact: true }).waitFor();
  return [
    "Loaded XML survives unrelated edits",
    "Keyboard prompt tags remain literal",
    "Entities remain exact",
    "Comparisons, ampersands, identifiers, and escaped line starts remain stable",
    "Horizontal rules retain editable headings/lists",
    "Real save/reload and confirmed clear",
  ];
}
