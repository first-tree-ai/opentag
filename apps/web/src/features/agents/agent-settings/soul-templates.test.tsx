import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSoul, replaceSoul } from "../../../__tests__/soul-editor.js";
import { overwriteGetLocale } from "../../../paraglide/runtime.js";
import { SoulConfigurationSection } from "./soul-configuration-section.js";
import { soulTemplates } from "./soul-templates.js";

afterEach(() => overwriteGetLocale(() => "en"));

describe("Soul template catalog", () => {
  const approved = JSON.parse(
    readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../../../testing/design/soul-template-catalog-v2/catalog.json",
      ),
      "utf8",
    ),
  );
  it.each(["en", "zh"] as const)("ships every approved %s name, summary, overview, and complete body", (locale) => {
    overwriteGetLocale(() => locale);
    const templates = soulTemplates();
    expect(templates).toHaveLength(8);
    for (const [index, template] of templates.entries()) {
      expect(template.id).toBe(approved.templates[index].id);
      expect({
        name: template.name,
        summary: template.summary,
        overview: template.overview,
        body: template.body,
      }).toEqual(approved.templates[index][locale]);
      const sections = template.body.split(/\n\n(?=## )/);
      expect(sections).toHaveLength(4);
      const principles = (sections[1] ?? "").split("\n").filter((line) => line.startsWith("- "));
      expect(principles.length).toBeGreaterThanOrEqual(3);
      expect(principles.length).toBeLessThanOrEqual(5);
    }
  });

  it.each(["en", "zh"] as const)("keeps %s template lists editable alongside personal additions", async (locale) => {
    overwriteGetLocale(() => locale);
    function EditableSoul() {
      const [value, setValue] = useState("");
      return (
        <SoulConfigurationSection
          busy={false}
          dirty={value !== ""}
          feedback={undefined}
          id="soul"
          standalone
          value={value}
          onDiscard={() => setValue("")}
          onSubmit={async () => false}
          onValueChange={setValue}
        />
      );
    }
    render(<EditableSoul />);
    fireEvent.click(screen.getByRole("button", { name: locale === "en" ? "Browse templates" : "浏览模板" }));
    const dialog = await screen.findByRole("dialog");
    const template = soulTemplates()[3];
    fireEvent.click(within(dialog).getByRole("button", { name: template.name }));
    const preview = within(dialog).getByRole("region", { name: template.name });
    const items = within(preview)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(within(preview).getAllByRole("list")).toHaveLength(2);
    expect(items).toHaveLength(6);
    fireEvent.click(within(dialog).getByRole("button", { name: locale === "en" ? "Use template" : "使用模板" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const editor = screen.getByRole("textbox", { name: "Soul" });
    expect(readSoul(editor)).toBe(template.body);
    expect(
      within(editor)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(items);
    const personal = locale === "en" ? "Personal notes" : "个人补充";
    const rule = locale === "en" ? "Keep the recommendation concise." : "建议保持简洁。";
    replaceSoul(editor, `${readSoul(editor)}\n\n## ${personal}\n\n- ${rule}`);
    expect(within(editor).getByRole("heading", { name: personal })).toBeTruthy();
    expect(within(editor).getAllByRole("list")).toHaveLength(3);
    expect(
      within(editor)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([...items, rule]);
  });

  it("localizes catalog previews without translating existing editor content", async () => {
    const onValueChange = vi.fn();
    const props = {
      busy: false,
      dirty: true,
      feedback: undefined,
      id: "soul",
      onDiscard: vi.fn(),
      onSubmit: vi.fn(async () => false),
      onValueChange,
      standalone: true,
      value: "Keep my English draft.",
    };
    const view = render(<SoulConfigurationSection {...props} />);
    overwriteGetLocale(() => "zh");
    view.rerender(<SoulConfigurationSection {...props} />);
    expect(readSoul(screen.getByRole("textbox", { name: "Soul" }))).toBe(props.value);
    expect(screen.getByRole("button", { name: "放弃修改" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "应用修改" })).toBeTruthy();
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "浏览模板" }));
    const dialog = await screen.findByRole("dialog", { name: "选择模板" });
    fireEvent.click(within(dialog).getByRole("button", { name: "研究" }));
    expect(within(dialog).getByRole("heading", { name: "交付要求" })).toBeTruthy();
    expect(within(dialog).getByText(soulTemplates()[3].overview)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "使用模板" }));
    await waitFor(() => expect(onValueChange).toHaveBeenCalledWith(soulTemplates()[3].body));
  });
});
