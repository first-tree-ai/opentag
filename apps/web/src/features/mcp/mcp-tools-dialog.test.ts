import { describe, expect, it } from "vitest";
import { toolExcerpt } from "./mcp-tools-dialog.js";

describe("MCP tool sentence previews", () => {
  it.each([
    [null, "", ""],
    ["   ", "", ""],
    ["Retrieve an attachment by ID. Use format=url to download.", "", "Retrieve an attachment by ID."],
    ["Search https://example.com/docs for pages. Returns matches.", "", "Search https://example.com/docs for pages."],
    ["查找工作区中的页面。支持按标题筛选。", "", "查找工作区中的页面。"],
    ["Find pages.\n\nReturns matches by title.", "TITLE", "Returns matches by title."],
    ["Find pages. Returns matches. Supports filters.", "pages. returns", "Find pages. Returns matches."],
    ["Search pages. Returns matches.", "tool_name", "Search pages."],
    ["Before searching, check access. Search workspace pages.", "", "Before searching, check access."],
    ["Search pages without terminal punctuation", "", "Search pages without terminal punctuation"],
  ])("keeps complete source sentences for %j / %j", (description, query, expected) => {
    expect(toolExcerpt(description, query)).toBe(expected);
  });
});
