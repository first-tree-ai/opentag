import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Root } from "postcss";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const stylesheet: Root = postcss.parse(readFileSync(resolve(here, "onboarding-v2.css"), "utf8"));

/** Reads a declaration from the top-level rule only, ignoring media-query overrides. */
function declarationValue(selector: string, property: string): string {
  let value: string | undefined;
  stylesheet.walkRules((rule) => {
    if (rule.parent?.type !== "root" || !rule.selectors.includes(selector)) return;
    rule.walkDecls(property, (declaration) => {
      value = declaration.value;
    });
  });
  if (!value) throw new Error(`Missing ${property} declaration for ${selector}`);
  return value;
}

/** Reads a declaration from the rules inside a media query that names the given width limit. */
function mediaDeclarationValue(limit: string, selector: string, property: string): string {
  let value: string | undefined;
  stylesheet.walkAtRules("media", (atRule) => {
    if (!atRule.params.includes(limit)) return;
    atRule.walkRules((rule) => {
      if (!rule.selectors.includes(selector)) return;
      rule.walkDecls(property, (declaration) => {
        value = declaration.value;
      });
    });
  });
  if (!value) throw new Error(`Missing ${property} declaration for ${selector} within ${limit} media`);
  return value;
}

describe("onboarding flow layout", () => {
  it("selects the Codex mark from the app theme instead of the operating-system theme", () => {
    expect(declarationValue(".otv2-codex-mark--light", "display")).toBe("block");
    expect(declarationValue(".otv2-codex-mark--dark", "display")).toBe("none");

    const stylesheetText = stylesheet.toString();
    expect(stylesheetText).toContain('[data-mode="dark"] .otv2-codex-mark--light');
    expect(stylesheetText).toContain('[data-mode="dark"] .otv2-codex-mark--dark');
    expect(stylesheetText).not.toContain("prefers-color-scheme");
  });

  it("lets choice-card copy wrap instead of scrolling a narrow viewport sideways", () => {
    // Buttons do not inherit the document's wrapping, so this has to be declared rather than assumed.
    expect(declarationValue(".otv2-choice", "white-space")).toBe("normal");
  });

  it("lets destination and runtime choice cards grow beyond Kumo's single-line button height", () => {
    expect(declarationValue(".otv2-shell .otv2-choice", "height")).toBe("auto");
    expect(declarationValue(".otv2-shell .otv2-choice", "min-height")).toBe("80px");
  });

  it("keeps unavailable choice-card explanations readable", () => {
    expect(declarationValue(".otv2-choice:disabled", "opacity")).toBe("1");
  });

  it("answers a press with colour rather than shrinking the control", () => {
    // Nothing on this surface may shrink under a click.
    expect(declarationValue(".otv2-shell button:active", "transform")).toBe("none");
    expect(() => declarationValue(".otv2-choice:active:not(:disabled)", "background")).not.toThrow();
    // No `:active` rule may reintroduce a scale.
    stylesheet.walkRules((rule) => {
      if (!rule.selectors.some((selector) => selector.includes(":active"))) return;
      rule.walkDecls("transform", (declaration) => {
        expect(declaration.value).not.toContain("scale");
      });
    });
  });

  it("distinguishes selected choices from neutral hover and disabled states", () => {
    expect(declarationValue('.otv2-choice[aria-pressed="true"]', "background")).toBe("var(--brand-soft)");
    expect(declarationValue(".otv2-choice:hover:not(:disabled)", "background")).toBe("var(--color-kumo-fill-hover)");
    expect(declarationValue(".otv2-choice:disabled", "background")).toBe("var(--color-kumo-recessed)");
  });

  /*
   * The reserved heights are declarations again: this app compiles no utilities of its own, so a
   * bracketed class would be inert. They are still measurements the flow depends on — each is the
   * tallest state its slot holds, and losing one lets the step's footer move while a check
   * resolves — so they are guarded here rather than left to be deleted as decoration.
   */
  it("holds a reserved height for every slot whose contents change length", () => {
    // The check outcome: waiting, a two-line repair summary, or a pass.
    expect(declarationValue(".otv2-slot--outcome", "min-height")).toBe("50px");
    // The name field's error line, which exists whether or not it says anything.
    expect(declarationValue(".otv2-field-error", "min-height")).toBe("20px");
    // The sign-in slot, which holds a button, a waiting line, or a result.
    expect(declarationValue(".otv2-slot--signin", "min-height")).toBe("40px");
  });

  it("holds the taller reserve each slot needs once its copy wraps", () => {
    const atWidth = (limit: string, selector: string, property: string): string | undefined => {
      let value: string | undefined;
      stylesheet.walkAtRules("media", (atRule) => {
        if (!atRule.params.includes(limit)) return;
        atRule.walkRules((rule) => {
          if (!rule.selectors.includes(selector)) return;
          rule.walkDecls(property, (declaration) => {
            value = declaration.value;
          });
        });
      });
      return value;
    };
    expect(atWidth("640px", ".otv2-slot--outcome", "min-height")).toBe("71px");
    expect(atWidth("640px", ".otv2-field-error", "min-height")).toBe("34px");
    expect(atWidth("359px", ".otv2-slot--outcome", "min-height")).toBe("114px");
  });

  /*
   * The readiness rows follow the same rule as the slots above: the reserved heights and the
   * fixed marker are declarations the layout depends on, so they are guarded here rather than
   * left to be deleted as decoration.
   */
  it("lays the readiness list out as a bordered column of padded rows", () => {
    expect(declarationValue(".otv2-readiness", "display")).toBe("flex");
    expect(declarationValue(".otv2-readiness", "flex-direction")).toBe("column");
    expect(declarationValue(".otv2-readiness", "gap")).toBe("0.75rem");
    expect(declarationValue(".otv2-readiness__line", "padding")).toBe("0.75rem");
    expect(declarationValue(".otv2-readiness__line", "box-sizing")).toBe("border-box");
  });

  it("fixes the decorative readiness markers at 24px", () => {
    expect(declarationValue(".otv2-readiness__marker", "width")).toBe("24px");
    expect(declarationValue(".otv2-readiness__marker", "height")).toBe("24px");
    expect(declarationValue(".otv2-readiness__marker", "flex-shrink")).toBe("0");
  });

  it("reserves fixed heights for the readiness title and detail slots and scrolls their overflow", () => {
    expect(declarationValue(".otv2-readiness__title", "height")).toBe("2.75rem");
    expect(declarationValue(".otv2-readiness__title", "line-height")).toBe("1.25rem");
    expect(declarationValue(".otv2-readiness__detail", "height")).toBe("3.375rem");
    expect(declarationValue(".otv2-readiness__detail", "line-height")).toBe("1.125rem");
    // A fixed height only stays fixed when padding and borders are counted inside it.
    expect(declarationValue(".otv2-readiness__title", "box-sizing")).toBe("border-box");
    expect(declarationValue(".otv2-readiness__detail", "box-sizing")).toBe("border-box");
    // Copy that does not fit scrolls inside its own slot; the slots are keyboard-focusable in
    // the markup, and the visible focus answers the keyboard.
    expect(declarationValue(".otv2-readiness__title", "overflow-y")).toBe("auto");
    expect(declarationValue(".otv2-readiness__detail", "overflow-y")).toBe("auto");
    expect(declarationValue(".otv2-readiness__detail:focus-visible", "outline")).toBe(
      "2px solid var(--color-kumo-focus)",
    );
  });

  it("wraps long readiness copy instead of widening the rows or clipping it", () => {
    expect(declarationValue(".otv2-readiness__title", "white-space")).toBe("pre-wrap");
    expect(declarationValue(".otv2-readiness__title", "overflow-wrap")).toBe("anywhere");
    expect(declarationValue(".otv2-readiness__detail", "white-space")).toBe("pre-wrap");
    expect(declarationValue(".otv2-readiness__detail", "overflow-wrap")).toBe("anywhere");
    expect(declarationValue(".otv2-readiness__copy", "min-width")).toBe("0");
  });

  it("reserves the taller title and detail slots a narrow readiness layout needs", () => {
    expect(mediaDeclarationValue("640px", ".otv2-readiness__title", "height")).toBe("3.75rem");
    expect(mediaDeclarationValue("640px", ".otv2-readiness__detail", "height")).toBe("4.5rem");
  });

  it("lets lab select wrappers and their triggers shrink on narrow screens", () => {
    expect(declarationValue(".otv2-readiness-lab__controls > div", "min-width")).toBe("0");
    expect(declarationValue(".otv2-readiness-lab__scenario > div", "min-width")).toBe("0");
    expect(declarationValue(".otv2-readiness-lab__select", "width")).toBe("100%");
    expect(declarationValue('.otv2-readiness-lab__scenario [role="combobox"]', "width")).toBe("100%");
  });

  it("keeps readiness state emphasis on the marker, never in the row geometry", () => {
    expect(declarationValue('.otv2-readiness__line[data-state="passed"] .otv2-readiness__marker', "background")).toBe(
      "var(--brand-soft)",
    );
    expect(declarationValue('.otv2-readiness__line[data-state="passed"] .otv2-readiness__marker', "color")).toBe(
      "var(--brand-ink)",
    );
    expect(declarationValue('.otv2-readiness__line[data-state="failed"] .otv2-readiness__marker', "background")).toBe(
      "var(--color-kumo-recessed)",
    );
    expect(declarationValue('.otv2-readiness__line[data-state="blocked"] .otv2-readiness__marker', "background")).toBe(
      "var(--color-kumo-recessed)",
    );
    // No rule keyed on a row state may change a fixed size.
    stylesheet.walkRules((rule) => {
      if (!rule.selectors.some((selector) => selector.includes('data-state="'))) return;
      rule.walkDecls((declaration) => {
        expect(declaration.prop).not.toMatch(/^(height|min-height|max-height|padding|border-width)$/);
      });
    });
  });
});
