import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Root } from "postcss";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const stylesheet: Root = postcss.parse(readFileSync(resolve(here, "onboarding-v2.css"), "utf8"));
const steps = readFileSync(resolve(here, "steps.tsx"), "utf8");

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
   * The reserved heights moved onto the elements they belong to when this app gained a Tailwind
   * compiler. They are still measurements the flow depends on — each is the tallest state its slot
   * holds, and losing one lets the step's footer move while a check resolves — so they are guarded
   * here rather than left to be deleted as decoration.
   */
  it("holds a reserved height for every slot whose contents change length", () => {
    const reserved: readonly (readonly [string, readonly string[]])[] = [
      // The connect status: waiting on one line, connected on another.
      ["connect status", ["min-h-[28px]"]],
      // The check outcome: waiting, a two-line repair summary, or a pass.
      ["check outcome", ["min-h-[50px]", "max-[640px]:min-h-[71px]", "max-[359px]:min-h-[114px]"]],
      // A check row, whose failure detail takes a second line on a narrow screen.
      ["check row", ["min-h-[73px]", "max-[399px]:min-h-[90px]"]],
      // The name field's error line, which exists whether or not it says anything.
      ["name error", ["min-h-[20px]", "max-[640px]:min-h-[34px]"]],
      // The sign-in slot, which holds a button, a waiting line, or a result.
      ["sign-in", ["min-h-[40px]"]],
    ];
    for (const [what, classes] of reserved) {
      for (const className of classes) {
        expect(steps, `${what} lost ${className}`).toContain(className);
      }
    }
  });
});
