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

describe("onboarding flow layout", () => {
  it("lets choice-card copy wrap instead of scrolling a narrow viewport sideways", () => {
    // Buttons do not inherit the document's wrapping, so this has to be declared rather than assumed.
    expect(declarationValue(".otv2-choice", "white-space")).toBe("normal");
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

  it("keeps the command block wrapping rather than forcing a horizontal scroll", () => {
    expect(declarationValue(".otv2-command__code", "white-space")).toBe("pre-wrap");
    expect(declarationValue(".otv2-command__code", "overflow-wrap")).toBe("break-word");
    // `break-all` splits short tokens like `sh`, which reads as a typo in a runnable command.
    expect(() => declarationValue(".otv2-command__code", "word-break")).toThrow();
    // The code alone breaks strictly by character, so a reissued one cannot change the block's
    // height. `overflow-wrap: anywhere` is not enough: it still prefers an existing break
    // opportunity, so codes ending in `-` or `_` took an extra line at some widths.
    expect(declarationValue(".otv2-command__token", "word-break")).toBe("break-all");
  });

  /*
   * The reserved heights are declarations again: this app compiles no utilities of its own, so a
   * bracketed class would be inert. They are still measurements the flow depends on — each is the
   * tallest state its slot holds, and losing one lets the step's footer move while a check
   * resolves — so they are guarded here rather than left to be deleted as decoration.
   */
  it("holds a reserved height for every slot whose contents change length", () => {
    // The connect status: waiting on one line, connected on another.
    expect(declarationValue(".otv2-slot--status", "min-height")).toBe("28px");
    // The check outcome: waiting, a two-line repair summary, or a pass.
    expect(declarationValue(".otv2-slot--outcome", "min-height")).toBe("50px");
    // A check row, whose failure detail takes a second line on a narrow screen.
    expect(declarationValue(".otv2-check", "min-height")).toBe("73px");
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
    expect(atWidth("399px", ".otv2-check", "min-height")).toBe("90px");
    expect(atWidth("359px", ".otv2-slot--outcome", "min-height")).toBe("114px");
  });
});
