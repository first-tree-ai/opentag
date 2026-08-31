import { describe, expect, it } from "vitest";
import { defaultFeishuBrand, otherFeishuBrand } from "./brand.js";

describe("defaultFeishuBrand", () => {
  /*
   * The language a reader is being spoken to in is the only signal available before anything is
   * authorized: the Server sees no country, and the binding that would know the tenant's brand is
   * what the connect flow is trying to create. It is a default, not a conclusion — which is why
   * the connect screen carries a way to overrule it.
   */
  it("reads the brand a locale most likely belongs to", () => {
    expect(defaultFeishuBrand("zh")).toBe("feishu");
    expect(defaultFeishuBrand("en")).toBe("lark");
  });

  it("offers the other brand as the way out of a wrong guess", () => {
    expect(otherFeishuBrand("feishu")).toBe("lark");
    expect(otherFeishuBrand("lark")).toBe("feishu");
  });
});
