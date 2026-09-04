import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Root } from "postcss";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const stylesheet: Root = postcss.parse(readFileSync(resolve(here, "setup.css"), "utf8"));

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

describe("setup piece layout", () => {
  it("keeps the command block wrapping rather than forcing a horizontal scroll", () => {
    expect(declarationValue(".ots-command__code", "white-space")).toBe("pre-wrap");
    expect(declarationValue(".ots-command__code", "overflow-wrap")).toBe("break-word");
    // `break-all` splits short tokens like `sh`, which reads as a typo in a runnable command.
    expect(() => declarationValue(".ots-command__code", "word-break")).toThrow();
    // The code alone breaks strictly by character, so a reissued one cannot change the block's
    // height. `overflow-wrap: anywhere` is not enough: it still prefers an existing break
    // opportunity, so codes ending in `-` or `_` took an extra line at some widths.
    expect(declarationValue(".ots-command__token", "word-break")).toBe("break-all");
  });

  it("answers a press with colour rather than shrinking the control", () => {
    // Nothing on these surfaces may shrink under a click.
    stylesheet.walkRules((rule) => {
      if (!rule.selectors.some((selector) => selector.includes(":active"))) return;
      rule.walkDecls("transform", (declaration) => {
        expect(declaration.value).not.toContain("scale");
      });
    });
  });

  it("keeps the expired-command action legible over its dark scrim", () => {
    expect(declarationValue(".ots-command__expired button", "color")).toBe("#b8d77d");
    expect(declarationValue(".ots-command__expired button:hover", "background")).toBe(
      "color-mix(in srgb, var(--on-dark) 14%, transparent)",
    );
    expect(declarationValue(".ots-command__expired button:hover", "color")).toBe("#c8e594");
  });

  it("keeps idle, issuing, issued, failed, and expired states on one measured command surface", () => {
    expect(declarationValue(".ots-command", "min-width")).toBe("0");
    expect(declarationValue(".ots-command-lead", "min-width")).toBe("0");
    expect(declarationValue(".ots-command__body", "height")).toBe("132px");
    expect(declarationValue(".ots-command__body", "overflow")).toBe("hidden");
    expect(declarationValue(".ots-command__action", "position")).toBe("absolute");
    expect(declarationValue(".ots-command__action", "inset")).toBe("0");
  });

  /*
   * The reserved heights are declarations rather than utilities: this app compiles none of its own,
   * so a bracketed class would be inert. They are still measurements the surfaces depend on — each
   * is the tallest state its slot holds, and losing one lets whatever sits below move while a check
   * resolves — so they are guarded here rather than left to be deleted as decoration.
   */
  it("holds a reserved height for every piece whose contents change length", () => {
    // The connect status, still rendered by ComputerConnect: waiting on one line, connected on another.
    expect(declarationValue(".ots-slot--status", "min-height")).toBe("28px");
    // The QR frame, which holds its box whether or not a code has arrived.
    expect(declarationValue(".ots-qr", "height")).toBe("208px");
    /*
     * Idle repair is the one state that reserves nothing: it has no announcement to make yet, and
     * the held-open row put dead space between the command block and the heading above it. Nothing
     * can move here either -- the first click swaps the whole surface for the pending skeleton.
     */
    expect(declarationValue('[data-ui="computer-connect"][data-state="idle"] .ots-slot--status', "min-height")).toBe(
      "0",
    );
  });
});
