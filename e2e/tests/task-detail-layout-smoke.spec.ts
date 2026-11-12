import { randomUUID } from "node:crypto";
import type { TaskReply } from "@opentag/shared/browser";
import type { Page } from "@playwright/test";
import { baseURL } from "../playwright.config.js";
import { expectAccessible, expectNoPageOverflow } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";

const taskId = "10000000-0000-4000-8000-0000000000aa";
// The Server bounds an internal Session title at 120 code points; wide characters are the worst case.
const longTitle = "在协作群里构建完整的本地开发及测试环境，然后持续识别体验问题并提交修复。".repeat(4).slice(0, 120);
const unbrokenText = `https://example.com/${"long-path-segment-".repeat(30)}`;
const shortRequest = "Short request";
const internalSessionId = "40000000-0000-4000-8000-0000000000aa";
const untitledInternalSessionId = "40000000-0000-4000-8000-0000000000ab";

async function createAgent(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((cookie) => cookie.name === "opentag_csrf")?.value;
  if (!csrf) throw new Error("The authenticated storage state has no openTag CSRF cookie");
  const response = await page.request.post("/api/v1/agents", {
    data: {
      creationIntentId: randomUUID(),
      name: `task-layout-${randomUUID()}`,
      displayName: "Task Layout Agent",
      runtimeProvider: "codex",
    },
    headers: { Origin: baseURL, "content-type": "application/json", "x-opentag-csrf": csrf },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { id: string }).id;
}

/** The real Task page and shell over a synthetic Task: no route creates internal Sessions in a smoke run. */
async function installTask(
  page: Page,
  agentId: string,
  {
    turnCount = 0,
    internalSessionCount = 0,
    latestReply = false,
  }: { turnCount?: number; internalSessionCount?: number; latestReply?: boolean } = {},
): Promise<void> {
  const at = new Date(Date.now() - 60_000).toISOString();
  const task = {
    id: taskId,
    agent: { id: agentId, name: "task-layout", displayName: "Task Layout Agent", runtimeProvider: "codex" },
    source: { provider: "feishu", conversationKind: "channel", channelId: "layout-channel", threadKey: null },
    sessionKind: "channel",
    title: "Task with a long internal Session",
    status: "running",
    createdAt: at,
    endedAt: null,
    lastActivityAt: at,
  };
  const turn = {
    deliveryId: "20000000-0000-4000-8000-0000000000aa",
    attention: "direct",
    delivery: {
      state: "accepted",
      attemptCount: 1,
      acceptedAt: at,
      steeredAt: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason: null,
      lastErrorCode: null,
      isRunning: true,
    },
    message: {
      id: "30000000-0000-4000-8000-0000000000aa",
      externalMessageId: "layout-message",
      operation: "created",
      authorKind: "human",
      authorDisplayName: "Layout Tester",
      fallbackText: unbrokenText,
      truncated: false,
      occurredAt: at,
    },
    absorbedBy: null,
    report: null,
  };
  const shortTurn = {
    ...turn,
    deliveryId: "20000000-0000-4000-8000-0000000000ab",
    message: {
      ...turn.message,
      id: "30000000-0000-4000-8000-0000000000ab",
      externalMessageId: "layout-short-message",
      fallbackText: shortRequest,
      occurredAt: new Date(Date.now() - 30_000).toISOString(),
    },
  };
  const extraTurns = Array.from({ length: turnCount }, (_, index) => {
    const suffix = String(index).padStart(12, "0");
    return {
      ...shortTurn,
      deliveryId: `20000000-0000-4000-8000-${suffix}`,
      message: {
        ...shortTurn.message,
        id: `30000000-0000-4000-8000-${suffix}`,
        externalMessageId: `layout-message-${index}`,
        occurredAt: new Date(Date.now() - 20_000 + index).toISOString(),
      },
    };
  }).reverse();
  const internalSession = {
    id: internalSessionId,
    createdBySessionId: taskId,
    createdAt: at,
    endedAt: null,
    runtimeModel: null,
    runtimeReasoningEffort: null,
    title: longTitle,
    lastActivityAt: at,
  };
  const untitledInternalSession = { ...internalSession, id: untitledInternalSessionId, title: null };
  const extraSessions = Array.from({ length: internalSessionCount }, (_, index) => ({
    ...internalSession,
    id: `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  }));
  const replies: TaskReply[] = latestReply
    ? [
        {
          id: "60000000-0000-4000-8000-0000000000aa",
          provider: "feishu",
          channelId: task.source.channelId,
          externalMessageId: "layout-latest-reply",
          authorKind: "bot",
          authorDisplayName: null,
          messageType: "text",
          contentAvailable: true,
          fallbackText: "Latest reply: [Read the result](https://example.com/result)",
          truncated: false,
          occurredAt: new Date().toISOString(),
          timeSource: "provider",
        },
      ]
    : [];
  const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
  await page.route(`**/api/v1/sessions/${taskId}/detail?**`, (route) =>
    route.fulfill(json({ task, turns: { items: [...extraTurns, shortTurn, turn], nextCursor: null } })),
  );
  await page.route(`**/api/v1/sessions/${taskId}/detail/internal-sessions**`, (route) =>
    route.fulfill(json({ items: [internalSession, untitledInternalSession, ...extraSessions], nextCursor: null })),
  );
  await page.route(`**/api/v1/sessions/${taskId}/replies**`, (route) =>
    route.fulfill(json({ items: replies, nextCursor: null })),
  );
}

async function expectContentNotScrolledSideways(page: Page): Promise<void> {
  const content = await page.locator('[data-ui="content"]').evaluate((element) => {
    const before = element.scrollLeft;
    // The region clips overflow but scripts can still scroll it, as the Task page's load-time scroll does.
    element.scrollLeft = 10_000;
    const reachable = element.scrollLeft;
    element.scrollLeft = before;
    return { before, reachable, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
  });
  expect(content.scrollWidth, "content region horizontal overflow").toBeLessThanOrEqual(content.clientWidth);
  expect(content.before, "content region scrollLeft").toBe(0);
  expect(content.reachable, "content region reachable scrollLeft").toBe(0);
}

function titleLines(element: Element): number {
  return Math.round(element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).lineHeight));
}

/** The overview sits beside the conversation once the content frame has room, and above it before that. */
async function expectColumnsFor(page: Page, width: number): Promise<void> {
  const [overview, thread] = await Promise.all([
    page.locator('[data-ui="task-detail-overview"]').boundingBox(),
    page.locator('[data-ui="task-thread"]').boundingBox(),
  ]);
  if (!overview || !thread) throw new Error("Expected the overview and the conversation to have layout boxes");
  if (width >= 1440) expect(overview.x, "overview beside the conversation").toBeGreaterThan(thread.x + thread.width);
  else expect(thread.y, "conversation below the overview").toBeGreaterThanOrEqual(overview.y + overview.height);
}

async function expectInsideArticle(page: Page, selector: string): Promise<void> {
  const [article, element] = await Promise.all([
    page.locator('[data-ui="task-conversation-page"]').boundingBox(),
    page.locator(selector).first().boundingBox(),
  ]);
  if (!article || !element) throw new Error(`Expected ${selector} and the Task page to have layout boxes`);
  expect(element.x + element.width, `${selector} right edge`).toBeLessThanOrEqual(article.x + article.width + 0.5);
}

for (const width of [390, 1024, 1440, 2000]) {
  test.describe(`Task detail at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("keeps a long internal Session title from widening the page", async ({ page }) => {
      const agentId = await createAgent(page);
      await installTask(page, agentId);
      const row = page.locator('[data-ui="task-internal-session-row"]').first();
      const detailURL = `/agents/${agentId}/tasks/${taskId}`;

      await page.goto(detailURL, { waitUntil: "networkidle" });
      await expect(row).toBeVisible();
      await expectContentNotScrolledSideways(page);
      await expectNoPageOverflow(page);
      await expect
        .poll(() => row.locator('[tabindex="0"]').evaluate(titleLines), { message: "title lines" })
        .toBe(width === 1024 ? 1 : 2);
      await expectInsideArticle(page, '[data-ui="task-thread"]');
      await expectInsideArticle(page, '[data-ui="task-internal-sessions"]');
      await expectInsideArticle(page, '[data-ui="task-message-request"]');
      await expect(page.locator('[data-ui="task-detail-overview"]')).toContainText("Running");
      await expectColumnsFor(page, width);

      // Reopening lays out the cached internal Sessions before the Task page's load-time scroll runs.
      await page.getByRole("navigation", { name: "Back to Tasks" }).getByRole("link").click();
      await expect(page).toHaveURL(new RegExp(`/agents/${agentId}/tasks(\\?.*)?$`));
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${taskId}$`));
      await expect(row).toBeVisible();
      await expectContentNotScrolledSideways(page);
    });
  });
}

for (const [activation, width] of [
  ["Enter", 1440],
  ["Space", 390],
  ["pointer", 390],
] as const) {
  test(`jumps to the latest Task entry and keeps focus with ${activation} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const agentId = await createAgent(page);
    await installTask(page, agentId, { turnCount: 30, latestReply: true });
    await page.goto(`/agents/${agentId}/tasks/${taskId}`, { waitUntil: "networkidle" });

    const content = page.locator('[data-ui="content"]');
    const resultLink = page.getByRole("link", { name: "Read the result" });
    const latestEntry = page.locator("[data-task-entry-id]").last();
    const jump = page.getByRole("button", { name: "Jump to latest" });
    await expect(latestEntry).toContainText("Latest reply");
    await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(latestEntry).toBeInViewport({ ratio: 1 });

    const scrollIntoHistory = () =>
      content.evaluate((element) => {
        element.scrollTop -= 600;
      });
    await scrollIntoHistory();
    await expect(latestEntry).not.toBeInViewport();
    await expect(jump).toBeInViewport();

    if (activation === "pointer") {
      await jump.click();
    } else {
      await jump.focus();
      await expect(jump).toBeFocused();
      await page.keyboard.press(activation);
    }

    await expect(jump).toHaveCount(0);
    await expect
      .poll(() => content.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
      .toBeLessThanOrEqual(1);
    await expect(latestEntry).toBeInViewport({ ratio: 1 });
    await expect(latestEntry).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(resultLink).toBeFocused();

    await scrollIntoHistory();
    await expect(jump).toBeInViewport();
  });
}

test.describe("Task detail composition", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("shows internal Sessions as ruled rows and sizes a request's fill to its message", async ({ page }) => {
    const agentId = await createAgent(page);
    await installTask(page, agentId);
    await page.goto(`/agents/${agentId}/tasks/${taskId}`, { waitUntil: "networkidle" });

    await expectAccessible(page);
    const section = page.locator('[data-ui="task-internal-sessions"]');
    const size = (selector: string) =>
      page.locator(selector).evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    expect(await size('[data-ui="task-internal-sessions"] h2')).toBeLessThanOrEqual(await size("h1"));
    await expect(section).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    // The id waits in the tooltip, which hover and keyboard focus both open.
    const idLabel = `Session ID: ${internalSessionId}`;
    const tooltip = page.getByText(idLabel, { exact: true }).and(page.locator(":not(.sr-only)"));
    const title = section.getByText(longTitle, { exact: false }).first();
    await expect(title).toHaveCSS("font-weight", "400");
    await expect(tooltip).toHaveCount(0);
    await title.hover();
    await expect(tooltip).toBeVisible();
    await page.mouse.move(0, 0);
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
    await title.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(title).toBeFocused();
    await expect(tooltip).toBeVisible();

    // A row named by its id has nothing more to show, so it stays out of the keyboard order.
    await expect(section.getByText(untitledInternalSessionId, { exact: true })).not.toHaveAttribute("tabindex", /.*/);

    const bodies = page.locator('[data-ui="task-message-request-body"]');
    const longBox = await bodies.filter({ hasText: "long-path-segment" }).boundingBox();
    const shortBody = bodies.filter({ hasText: shortRequest });
    const shortBox = await shortBody.boundingBox();
    if (!longBox || !shortBox) throw new Error("Expected both requests to have layout boxes");
    expect(shortBox.width).toBeLessThan(longBox.width / 2);
    await expect(shortBody).toHaveCSS("box-shadow", "none");

    const requestAvatar = page.locator('[data-ui="task-message-request"] > span').first();
    await expect(requestAvatar).toHaveClass(/rounded-full/);
  });

  test("keeps the overview in view beside a long conversation and scrolls it only when it is too tall", async ({
    page,
  }) => {
    const agentId = await createAgent(page);
    await installTask(page, agentId, { turnCount: 30, internalSessionCount: 25 });
    await page.goto(`/agents/${agentId}/tasks/${taskId}`, { waitUntil: "networkidle" });

    const content = page.locator('[data-ui="content"]');
    const overview = page.locator('[data-ui="task-detail-overview"]');
    await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await content.evaluate((element) => {
      element.scrollTop = 200;
    });
    await expect.poll(async () => (await overview.boundingBox())?.y).toBe(24);

    // The conversation's jump control stays in its own column.
    const jump = page.locator('[data-ui="task-activity-jump-latest"]');
    await expect(jump).toBeVisible();
    const [jumpBox, overviewBox] = await Promise.all([jump.boundingBox(), overview.boundingBox()]);
    if (!jumpBox || !overviewBox) throw new Error("Expected the jump control and the overview to have layout boxes");
    expect(jumpBox.x + jumpBox.width).toBeLessThan(overviewBox.x);

    // Too tall for the window, it scrolls by itself and takes a keyboard stop; the page stays put.
    await expect(overview).toHaveAttribute("tabindex", "0");
    const scrolled = await overview.evaluate((element) => {
      const page = element.closest('[data-ui="content"]') as HTMLElement;
      const before = page.scrollTop;
      element.scrollTop = 100;
      return { overview: element.scrollTop, moved: page.scrollTop - before };
    });
    expect(scrolled).toEqual({ overview: 100, moved: 0 });
    await expectAccessible(page);
  });
});
