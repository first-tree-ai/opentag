import { describe, expect, it } from "vitest";
import {
  parseSkillManifest,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_MANIFEST_MAX_BYTES,
  SkillManifestSchema,
} from "../skill.js";

describe("parseSkillManifest", () => {
  function expectManifest(markdown: string, manifest: { name: string; description: string }) {
    const result = parseSkillManifest(markdown);
    expect(result).toEqual({ ok: true, manifest });
  }

  function expectReason(markdown: string, fragment: string) {
    const result = parseSkillManifest(markdown);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(fragment);
  }

  it("reads a plain scalar manifest", () => {
    expectManifest("---\nname: demo\ndescription: A demo skill\n---\n# Demo\n", {
      name: "demo",
      description: "A demo skill",
    });
  });

  it("reads single-quoted scalars and unescapes doubled quotes", () => {
    expectManifest("---\nname: demo\ndescription: 'It''s fine'\n---\n", {
      name: "demo",
      description: "It's fine",
    });
  });

  it("reads double-quoted scalars and their escapes", () => {
    expectManifest('---\nname: demo\ndescription: "line\\nnext"\n---\n', {
      name: "demo",
      description: "line\nnext",
    });
  });

  it("folds a `>` block scalar", () => {
    expectManifest("---\nname: demo\ndescription: >\n  Folded\n  text\n---\n", {
      name: "demo",
      description: "Folded text",
    });
  });

  it("keeps paragraph breaks in a folded block scalar", () => {
    expectManifest("---\nname: demo\ndescription: >\n  Para one\n\n  Para two\n---\n", {
      name: "demo",
      description: "Para one\nPara two",
    });
  });

  it("keeps newlines in a literal `|` block scalar", () => {
    expectManifest("---\nname: demo\ndescription: |\n  Line one\n  Line two\n---\n", {
      name: "demo",
      description: "Line one\nLine two",
    });
  });

  it("trims folded, literal, and keep-chomped block descriptions", () => {
    const markdowns = [
      "---\nname: demo\ndescription: >\n  Folded\n  text\n---\n",
      "---\nname: demo\ndescription: |\n  Line one\n  Line two\n---\n",
      "---\nname: demo\ndescription: >+\n  Folded\n  text\n\n---\n",
    ];
    for (const markdown of markdowns) {
      const result = parseSkillManifest(markdown);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.description).toBe(result.manifest.description.trim());
        expect(result.manifest.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("honors the strip and keep chomping indicators", () => {
    expectManifest("---\nname: demo\ndescription: >-\n  Folded\n  text\n---\n", {
      name: "demo",
      description: "Folded text",
    });
    expectManifest("---\nname: demo\ndescription: >+\n  Folded\n  text\n\n---\n", {
      name: "demo",
      description: "Folded text",
    });
    expectManifest("---\nname: demo\ndescription: |+\n  Line one\n\n---\n", {
      name: "demo",
      description: "Line one",
    });
  });

  it("reads CRLF line endings", () => {
    expectManifest("---\r\nname: demo\r\ndescription: A demo skill\r\n---\r\n", {
      name: "demo",
      description: "A demo skill",
    });
  });

  it("ignores unknown top-level keys", () => {
    expectManifest("---\nname: demo\nlicense: MIT\nallowed-tools: [read]\ndescription: A demo skill\n---\n", {
      name: "demo",
      description: "A demo skill",
    });
  });

  it("ignores nested maps and block sequences under unknown keys", () => {
    const markdown = [
      "---",
      "name: demo",
      "description: A demo skill",
      "license: MIT",
      "metadata:",
      "  author: x",
      "  requires:",
      "    - y",
      "allowed-tools:",
      "  - read",
      "  - write",
      "---",
    ].join("\n");
    expectManifest(markdown, { name: "demo", description: "A demo skill" });
  });

  it("accepts OpenTag's own context-tree-read manifest shape", () => {
    const markdown = [
      "---",
      "name: context-tree-read",
      "description: Read a node, subtree, or search result from Context Tree.",
      "metadata:",
      "  author: x",
      "  requires:",
      "    - y",
      "allowed-tools:",
      "- read",
      "---",
    ].join("\n");
    expectManifest(markdown, {
      name: "context-tree-read",
      description: "Read a node, subtree, or search result from Context Tree.",
    });
  });

  it("folds a multi-line plain description", () => {
    expectManifest("---\nname: demo\ndescription: This is\n  a long description\n  over lines\n---\n", {
      name: "demo",
      description: "This is a long description over lines",
    });
  });

  it("keeps paragraph breaks in a multi-line plain description", () => {
    expectManifest("---\nname: demo\ndescription:\n  Para one\n\n  Para two\n---\n", {
      name: "demo",
      description: "Para one\nPara two",
    });
  });

  it("rejects an indented line with no preceding key", () => {
    expectReason("---\n  orphan: x\n---\n", "indented line with no preceding key");
  });

  it("rejects an inline comment on a plain name or description value", () => {
    expectReason("---\nname: demo\ndescription: A demo # comment\n---\n", "inline comment");
    expectReason("---\nname: demo # comment\ndescription: A demo skill\n---\n", "inline comment");
    expectReason("---\nname: demo\ndescription: A demo\n  more # comment\n---\n", "inline comment");
  });

  it("rejects a duplicate name or description field", () => {
    expectReason("---\nname: demo\nname: other\ndescription: A demo skill\n---\n", "duplicate name field");
    expectReason(
      "---\nname: demo\ndescription: A demo skill\ndescription: Another\n---\n",
      "duplicate description field",
    );
  });

  it("rejects a structurally collection-valued description", () => {
    const reason = "description must be a string, not a list or map";
    for (const indicator of ["[", "{", "]", "}", ",", "&", "*", "!", "|", ">", "%", "@", "`", "#"]) {
      expectReason(`---\nname: demo\ndescription:\n  ${indicator} x\n---\n`, reason);
    }
    expectReason("---\nname: demo\ndescription: [read, write]\n---\n", reason);
    expectReason("---\nname: demo\ndescription: {purpose: read files}\n---\n", reason);
    expectReason("---\nname: demo\ndescription:\n  - read\n  - write\n---\n", reason);
    expectReason("---\nname: demo\ndescription:\n  - x\n---\n", reason);
    expectReason("---\nname: demo\ndescription:\n  ? x\n---\n", reason);
    expectReason("---\nname: demo\ndescription:\n  : x\n---\n", reason);
    expectReason("---\nname: demo\ndescription:\n  -\n---\n", reason);
    expectReason("---\nname: demo\ndescription:\n  purpose: read files\n---\n", reason);
    expectReason('---\nname: demo\ndescription:\n  "purpose": read files\n---\n', reason);
    expectReason("---\nname: demo\ndescription:\n  'purpose': read files\n---\n", reason);
    expectReason("---\nname: demo\ndescription:\n  purpose:\n---\n", reason);
    expectReason("---\nname: demo\ndescription:\n  ? purpose\n  : read\n---\n", reason);
    expectReason("---\nname: demo\ndescription: Use when: the user asks\n---\n", reason);
    expectReason("---\nname: demo\ndescription: First line\n  second: line\n---\n", reason);
  });

  it("rejects a malformed quoted scalar on a continuation line", () => {
    const reason = "description must be one complete quoted string";
    expectReason('---\nname: demo\ndescription:\n  "quoted" trailing\n---\n', reason);
    expectReason('---\nname: demo\ndescription:\n  "unterminated\n---\n', reason);
    expectReason("---\nname: demo\ndescription:\n  'unterminated\n---\n", reason);
  });

  it("rejects a structurally collection-valued name", () => {
    const reason = "name must be a string, not a list or map";
    expectReason("---\nname:\n  - a\n  - b\ndescription: A demo skill\n---\n", reason);
    expectReason("---\nname: [a, b]\ndescription: A demo skill\n---\n", reason);
    expectReason("---\nname:\n  purpose: read files\ndescription: A demo skill\n---\n", reason);
    expectReason("---\nname:\n  ? x\ndescription: A demo skill\n---\n", reason);
  });

  it("accepts a quoted scalar that starts on a continuation line", () => {
    const markdown = [
      "---",
      "name: demo",
      "description:",
      '  "Solve competition math problems with adversarial',
      "  verification. See 'IMO', 'Putnam'.\"",
      "---",
    ].join("\n");
    const result = parseSkillManifest(markdown);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.description).toBe(
        "Solve competition math problems with adversarial verification. See 'IMO', 'Putnam'.",
      );
      expect(result.manifest.description).not.toMatch(/^["']|["']$/);
    }
  });

  it("accepts a single-quoted continuation scalar with a doubled-quote escape", () => {
    expectManifest("---\nname: demo\ndescription:\n  'It''s fine'\n---\n", {
      name: "demo",
      description: "It's fine",
    });
  });

  it("accepts plain strings, including a blank first line and list-like text", () => {
    expectManifest("---\nname: demo\ndescription:\n  plain text over\n  lines\n---\n", {
      name: "demo",
      description: "plain text over lines",
    });
    expectManifest("---\nname: demo\ndescription: This is\n  a plain continuation\n---\n", {
      name: "demo",
      description: "This is a plain continuation",
    });
  });

  it("accepts plain values that merely contain indicator characters", () => {
    expectManifest("---\nname: demo\ndescription: http://x and 12:30 and C# notes\n---\n", {
      name: "demo",
      description: "http://x and 12:30 and C# notes",
    });
    expectManifest("---\nname: demo\ndescription: pre-commit hooks\n---\n", {
      name: "demo",
      description: "pre-commit hooks",
    });
  });

  it("accepts a `|` block whose text contains sequence-item and mapping lines", () => {
    expectManifest("---\nname: demo\ndescription: |\n  - item\n  key: value\n---\n", {
      name: "demo",
      description: "- item\nkey: value",
    });
  });

  it("still skips collections under unknown keys", () => {
    expectManifest(
      "---\nname: demo\ndescription: A demo skill\nmetadata:\n  - one\n  - two\nallowed-tools:\n  - read\n---\n",
      { name: "demo", description: "A demo skill" },
    );
  });

  it("rejects plain values that YAML resolves to null", () => {
    expectReason("---\nname: demo\ndescription: ~\n---\n", "description must be a string, not a null");
    expectReason("---\nname: demo\ndescription: null\n---\n", "description must be a string, not a null");
    expectReason("---\nname: demo\ndescription: NULL\n---\n", "description must be a string, not a null");
    expectReason("---\nname: ~\ndescription: A demo skill\n---\n", "name must be a string, not a null");
  });

  it("rejects plain values that YAML resolves to a boolean", () => {
    for (const value of ["true", "True", "TRUE", "false", "yes", "Yes", "no", "NO", "on", "Off", "y", "N"]) {
      expectReason(`---\nname: demo\ndescription: ${value}\n---\n`, "description must be a string, not a boolean");
    }
    expectReason("---\nname: no\ndescription: A demo skill\n---\n", "name must be a string, not a boolean");
  });

  it("rejects plain values that YAML resolves to a number", () => {
    const integers = ["123", "+42", "-7", "1_000", "0x1F", "0o17", "0b101", "0123", "1.5", ".5", "1e3", "-1.5e-3"];
    for (const value of [...integers, ".inf", "-.INF", ".nan", ".NaN"]) {
      expectReason(`---\nname: demo\ndescription: ${value}\n---\n`, "description must be a string, not a number");
    }
    expectReason("---\nname: 123\ndescription: A demo skill\n---\n", "name must be a string, not a number");
  });

  it("rejects plain values that YAML resolves to a date", () => {
    for (const value of ["2024-01-01", "2024-01-01T00:00:00Z", "2024-01-01 12:30:00"]) {
      expectReason(`---\nname: demo\ndescription: ${value}\n---\n`, "description must be a string, not a date");
    }
  });

  it("keeps quoted non-string tokens and embedded tokens as strings", () => {
    expectManifest('---\nname: demo\ndescription: "123"\n---\n', { name: "demo", description: "123" });
    expectManifest("---\nname: demo\ndescription: 'true'\n---\n", { name: "demo", description: "true" });
    expectManifest('---\nname: demo\ndescription: "2024-01-01"\n---\n', {
      name: "demo",
      description: "2024-01-01",
    });
    expectManifest("---\nname: demo\ndescription: true story\n---\n", { name: "demo", description: "true story" });
    expectManifest("---\nname: v2\ndescription: 123 things\n---\n", { name: "v2", description: "123 things" });
  });

  it("rejects a missing frontmatter block", () => {
    expectReason("# Demo\nname: demo\n", "missing its frontmatter");
  });

  it("rejects unterminated frontmatter", () => {
    expectReason("---\nname: demo\ndescription: A demo skill\n", "unterminated");
  });

  it("rejects a manifest missing name or description", () => {
    expectReason("---\ndescription: A demo skill\n---\n", "missing the name field");
    expectReason("---\nname: demo\n---\n", "missing the description field");
  });

  it("rejects an invalid name", () => {
    expectReason("---\nname: Demo\ndescription: A demo skill\n---\n", "Skill name must be 1 to 64 characters");
  });

  it("rejects an over-long or empty description", () => {
    expectReason(`---\nname: demo\ndescription: ${"x".repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1)}\n---\n`, "Too big");
    expectReason("---\nname: demo\ndescription: ''\n---\n", "Too small");
  });

  it("rejects a whitespace-only description", () => {
    expectReason("---\nname: demo\ndescription: '   '\n---\n", "Too small");
    expectReason("---\nname: demo\ndescription: >\n   \n---\n", "Too small");
  });

  it("rejects input larger than the manifest limit before parsing", () => {
    const oversize = `---\nname: demo\ndescription: ${"x".repeat(SKILL_MANIFEST_MAX_BYTES)}\n---\n`;
    expectReason(oversize, "exceeds");
  });

  it("never throws for malformed input", () => {
    for (const input of ["", "---", "---\n---", "---\nname: |\n", "---\n\u0000: x\n---\n", "---\nname: demo\n"]) {
      expect(() => parseSkillManifest(input)).not.toThrow();
    }
  });

  it("exposes a manifest schema that matches the parsed result", () => {
    const result = parseSkillManifest("---\nname: demo\ndescription: A demo skill\n---\n");
    expect(result.ok).toBe(true);
    if (result.ok) expect(SkillManifestSchema.safeParse(result.manifest).success).toBe(true);
  });
});
