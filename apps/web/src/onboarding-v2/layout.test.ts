import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Root } from "postcss";
import { describe, expect, it } from "vitest";

const stylesheet: Root = postcss.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "onboarding-v2.css"), "utf8"),
);

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

/** Reads a declaration from inside the narrow-viewport media query only. */
function narrowViewportValue(selector: string, property: string): string {
  let value: string | undefined;
  stylesheet.walkAtRules("media", (atRule) => {
    if (!atRule.params.includes("640px")) return;
    atRule.walkRules((rule) => {
      if (!rule.selectors.includes(selector)) return;
      rule.walkDecls(property, (declaration) => {
        value = declaration.value;
      });
    });
  });
  if (!value) throw new Error(`Missing narrow-viewport ${property} declaration for ${selector}`);
  return value;
}

describe("onboarding flow layout", () => {
  it("lets choice-card copy wrap instead of scrolling a narrow viewport sideways", () => {
    // Buttons do not inherit the document's wrapping, so this has to be declared rather than assumed.
    expect(declarationValue(".otv2-choice", "white-space")).toBe("normal");
  });

  it("collapses the runtime grid to one column below its minimum track width", () => {
    // `minmax(220px, 1fr)` would otherwise demand more than a 390px phone's content box allows.
    expect(declarationValue(".otv2-choices--grid", "grid-template-columns")).toBe(
      "repeat(auto-fit, minmax(220px, 1fr))",
    );
    expect(narrowViewportValue(".otv2-choices--grid", "grid-template-columns")).toBe("1fr");
  });

  it("gives every bare button its own hover, so the global button hover cannot show through", () => {
    // `styles.css` has a bare `button:hover { background: var(--brand-ink) }`. Anything on this
    // surface that is a plain <button> has to state its own hover or it turns dark green — which
    // is how the disabled Cloud card ended up lighting up.
    const selectors = [
      ".otv2-choice:hover:not(:disabled)",
      ".otv2-choice:disabled:hover",
      ".otv2-restart:hover",
      ".otv2-lab__toggle:hover",
      ".otv2-lab__segmented button:hover",
    ];
    for (const selector of selectors) {
      expect(() => declarationValue(selector, "background")).not.toThrow();
    }
  });

  it("answers a press with colour rather than shrinking the control", () => {
    // Nothing on this surface may shrink under a click.
    expect(declarationValue(".otv2-shell button:active", "transform")).toBe("none");
    for (const selector of [
      ".otv2-nav__next button:active:not(:disabled)",
      ".otv2-nav__back button:active",
      ".otv2-choice:active:not(:disabled)",
      ".otv2-lab__toggle:active",
    ]) {
      expect(() => declarationValue(selector, "background")).not.toThrow();
    }
    // No `:active` rule may reintroduce a scale. Waiting animations still use one, deliberately.
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
  });
});
