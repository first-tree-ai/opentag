import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../__tests__/support/router.js";
import { overwriteGetLocale } from "../paraglide/runtime.js";
import { ImFeedbackDestinationPage } from "./im-feedback-destination-page.js";

const redirects = vi.hoisted(() => [] as unknown[]);
vi.mock("./navigation/redirect.js", () => ({
  Redirect: (props: unknown) => {
    redirects.push(props);
    return null;
  },
}));

const ID = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const TASK = "55555555-5555-4555-8555-555555555555";
const owner = { imFeedbackDestination: vi.fn(async () => ({ owner: true as const, agentId: AGENT, taskId: TASK })) };
const other = {
  imFeedbackDestination: vi.fn(async () => ({ owner: false as const, ownerDisplayName: "Alice", agentName: "Helper" })),
};

afterEach(() => {
  overwriteGetLocale(() => "en");
  redirects.length = 0;
});
describe("IM card links", () => {
  it.each([
    ["settings", { to: "/agents/$agentId/settings/$section", params: { agentId: AGENT, section: "execution" } }],
    ["restore", { to: "/agents/$agentId/settings/$section", params: { agentId: AGENT, section: "computer" } }],
    ["task", { to: "/agents/$agentId/tasks/$taskId", params: { agentId: AGENT, taskId: TASK } }],
  ] as const)("sends the Agent owner straight to %s", async (link, expected) => {
    await renderInRouter(<ImFeedbackDestinationPage feedbackId={ID} link={link} api={owner} />);
    await vi.waitFor(() => expect(redirects.at(-1)).toEqual({ ...expected, replace: true }));
  });
  it("tells anyone else that only the owner can act, and who that is", async () => {
    overwriteGetLocale(() => "zh");
    await renderInRouter(<ImFeedbackDestinationPage feedbackId={ID} link="settings" api={other} />);
    expect(await screen.findByRole("heading", { name: "只有 Agent 所有者能修改设置" })).toBeTruthy();
    expect(screen.getByText("Helper 的所有者是 Alice")).toBeTruthy();
    expect(redirects).toHaveLength(0);
  });
  it("says the record is unavailable when the read fails", async () => {
    const failing = { imFeedbackDestination: vi.fn(async () => Promise.reject(new Error("404"))) };
    await renderInRouter(<ImFeedbackDestinationPage feedbackId={ID} link="task" api={failing} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
