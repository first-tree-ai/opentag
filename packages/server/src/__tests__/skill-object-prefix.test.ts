import { describe, expect, it } from "vitest";
import { isSkillObjectKeyUnder } from "../services/skills/index.js";

/**
 * The prefix binding is what keeps two deployments that share a bucket from collecting each other's
 * objects, so it is pinned here directly: only a key exactly under the given prefix, with exactly
 * seven trailing segments, matches.
 */

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const SKILL = "33333333-3333-4333-8333-333333333333";
const SHA = "a".repeat(64);

function keyUnder(prefix: string): string {
  return `${prefix}/accounts/${ACCOUNT}/agents/${AGENT}/skills/${SKILL}/${SHA}.tar.gz`;
}

describe("isSkillObjectKeyUnder", () => {
  it("accepts exactly the prefix's own key, nested prefixes included", () => {
    expect(isSkillObjectKeyUnder("skills", keyUnder("skills"))).toBe(true);
    expect(isSkillObjectKeyUnder("skills/staging", keyUnder("skills/staging"))).toBe(true);
    expect(isSkillObjectKeyUnder("skills/nested/deep", keyUnder("skills/nested/deep"))).toBe(true);
  });

  it("rejects a key that has one extra namespace segment under the prefix", () => {
    expect(isSkillObjectKeyUnder("skills", keyUnder("skills/staging"))).toBe(false);
    expect(isSkillObjectKeyUnder("skills/staging", keyUnder("skills/staging/deeper"))).toBe(false);
  });

  it("rejects a different prefix with a valid tail", () => {
    expect(isSkillObjectKeyUnder("skills", keyUnder("other"))).toBe(false);
    expect(isSkillObjectKeyUnder("skills/staging", keyUnder("skills"))).toBe(false);
  });

  it("rejects a prefix that is only a string-prefix of the first segment", () => {
    expect(isSkillObjectKeyUnder("skills", keyUnder("skillsX"))).toBe(false);
    expect(isSkillObjectKeyUnder("skills", keyUnder("skills-staging"))).toBe(false);
  });

  it("rejects a tail that is not the expected shape", () => {
    expect(
      isSkillObjectKeyUnder("skills", `skills/accounts/${ACCOUNT}/agents/${AGENT}/skills/${SKILL}/not-a-digest`),
    ).toBe(false);
    expect(
      isSkillObjectKeyUnder("skills", `skills/accounts/${ACCOUNT}/agents/nope/skills/${SKILL}/${SHA}.tar.gz`),
    ).toBe(false);
  });
});
