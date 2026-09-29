import { describe, expect, it } from "vitest";
import {
  declaredSkillContainers,
  discoverSkillDirectories,
  SKILL_CONTAINER_DEPTH,
  SKILL_CONTAINER_DIRECTORIES,
  SKILL_DISCOVERY_FALLBACK_DEPTH,
  skillNameFromDirectory,
} from "../skill-discovery.js";

/**
 * Discovery is a pure function of a path listing, so every rule is a table.
 *
 * `SKILL_CONTAINER_DIRECTORIES` is checked against this list rather than trusted: the list is data
 * copied from the ecosystem's documented discovery rules, and an accidental edit must fail here
 * instead of silently changing what a repository install offers.
 */
const EXPECTED_CONTAINER_DIRECTORIES = [
  "skills",
  "skills/.curated",
  "skills/.experimental",
  "skills/.system",
  ".aider-desk/skills",
  ".agents/skills",
  "data/skills",
  ".autohand/skills",
  ".augment/skills",
  ".bob/skills",
  ".claude/skills",
  ".codeartsdoer/skills",
  ".codebuddy/skills",
  ".codemaker/skills",
  ".codestudio/skills",
  ".commandcode/skills",
  ".continue/skills",
  ".cortex/skills",
  ".crush/skills",
  ".devin/skills",
  "agent/skills",
  ".forge/skills",
  ".fx/skills",
  ".goose/skills",
  ".grok/skills",
  ".hermes/skills",
  ".inferencesh/skills",
  ".jazz/skills",
  ".junie/skills",
  ".iflow/skills",
  ".kimchi/skills",
  ".kiro/skills",
  ".kode/skills",
  ".lingma/skills",
  ".mcpjam/skills",
  ".minimax/skills",
  ".vibe/skills",
  ".moxby/skills",
  ".mux/skills",
  ".openhands/skills",
  ".ona/skills",
  ".posit/assistant/skills",
  ".qoder/skills",
  ".qwen/skills",
  ".reasonix/skills",
  ".rovodev/skills",
  ".roo/skills",
  ".tabnine/agent/skills",
  ".terramind/skills",
  ".tinycloud/skills",
  ".trae/skills",
  ".windsurf/skills",
  ".zcode/skills",
  ".zencoder/skills",
  ".neovate/skills",
  ".pochi/skills",
  ".adal/skills",
] as const;

const CONTAINER = EXPECTED_CONTAINER_DIRECTORIES[0];

describe("Skill container directories", () => {
  it("matches the checked-in list, exactly, once each, with the skills directories first", () => {
    expect([...SKILL_CONTAINER_DIRECTORIES]).toEqual([...EXPECTED_CONTAINER_DIRECTORIES]);
    expect(new Set(EXPECTED_CONTAINER_DIRECTORIES).size).toBe(EXPECTED_CONTAINER_DIRECTORIES.length);
    expect(EXPECTED_CONTAINER_DIRECTORIES.slice(0, 4)).toEqual([
      "skills",
      "skills/.curated",
      "skills/.experimental",
      "skills/.system",
    ]);
  });

  it("pins the documented depth rules", () => {
    expect(SKILL_CONTAINER_DEPTH).toBe(3);
    expect(SKILL_DISCOVERY_FALLBACK_DEPTH).toBe(5);
  });
});

function paths(...value: readonly string[]): string[] {
  return [...value];
}

function discovered(...value: readonly string[]): string[] {
  return discoverSkillDirectories({ paths: paths(...value) }).map((entry) => entry.path);
}

describe("discoverSkillDirectories", () => {
  it("treats a root manifest as the whole source", () => {
    expect(discovered("SKILL.md", "other/SKILL.md", `${CONTAINER}/demo/SKILL.md`)).toEqual([""]);
  });

  it("finds flat and catalog layouts inside a container", () => {
    expect(discovered(`${CONTAINER}/flat/SKILL.md`)).toEqual([`${CONTAINER}/flat`]);
    expect(discovered(`${CONTAINER}/category/one/SKILL.md`)).toEqual([`${CONTAINER}/category/one`]);
    expect(discovered(`${CONTAINER}/a/b/three/SKILL.md`)).toEqual([`${CONTAINER}/a/b/three`]);
  });

  it("stops at the container depth when another Skill is found", () => {
    expect(discovered(`${CONTAINER}/ok/SKILL.md`, `${CONTAINER}/a/b/c/four/SKILL.md`)).toEqual([`${CONTAINER}/ok`]);
    expect(discovered(`${CONTAINER}/a/b/c/four/SKILL.md`)).toEqual([`${CONTAINER}/a/b/c/four`]);
  });

  it("lets a shallower manifest shadow everything nested below it", () => {
    expect(discovered(`${CONTAINER}/outer/SKILL.md`, `${CONTAINER}/outer/inner/SKILL.md`)).toEqual([
      `${CONTAINER}/outer`,
    ]);
  });

  it("finds a direct child directory of the search root", () => {
    expect(discovered("my-skill/SKILL.md")).toEqual(["my-skill"]);
  });

  it("finds every documented container", () => {
    for (const container of EXPECTED_CONTAINER_DIRECTORIES) {
      expect(discovered(`${container}/demo/SKILL.md`)).toEqual([`${container}/demo`]);
    }
  });

  it("ignores directories that are not containers unless nothing else matches", () => {
    expect(discovered("examples/foo/SKILL.md", `${CONTAINER}/demo/SKILL.md`)).toEqual([`${CONTAINER}/demo`]);
    expect(discovered("examples/foo/SKILL.md")).toEqual(["examples/foo"]);
  });

  it("never descends into skipped directories in the fallback walk", () => {
    expect(discovered("node_modules/pkg/SKILL.md", ".git/hooks/SKILL.md", "dist/SKILL.md")).toEqual([]);
  });

  it("scopes discovery to a subpath", () => {
    const listing = [
      "packages/demo/skills/inside/SKILL.md",
      "packages/demo/my-skill/SKILL.md",
      "other/skills/outside/SKILL.md",
    ];
    expect(
      discoverSkillDirectories({ paths: listing, subpath: "packages/demo/skills" }).map((entry) => entry.path),
    ).toEqual(["packages/demo/skills/inside"]);
    expect(discoverSkillDirectories({ paths: listing, subpath: "packages/demo/my-skill" }).map((e) => e.path)).toEqual([
      "packages/demo/my-skill",
    ]);
    expect(discoverSkillDirectories({ paths: listing, subpath: "absent" })).toEqual([]);
  });

  it("orders candidates deterministically regardless of input order", () => {
    const listing = [`${CONTAINER}/b/SKILL.md`, `${CONTAINER}/a/SKILL.md`];
    expect(discovered(...listing)).toEqual([`${CONTAINER}/a`, `${CONTAINER}/b`]);
    expect(discovered(...[...listing].reverse())).toEqual([`${CONTAINER}/a`, `${CONTAINER}/b`]);
  });

  it("ignores unsafe and non-normalized entries", () => {
    expect(discovered("./skills/demo/SKILL.md")).toEqual(["skills/demo"]);
    expect(discovered("../outside/SKILL.md")).toEqual([]);
    expect(discovered("/absolute/SKILL.md")).toEqual([]);
  });

  it("adds containers declared by a plugin manifest", () => {
    const listing = [`${CONTAINER}/standard/SKILL.md`, "plugins/alpha/review/SKILL.md"];
    expect(discoverSkillDirectories({ paths: listing }).map((entry) => entry.path)).toEqual([`${CONTAINER}/standard`]);
    expect(
      discoverSkillDirectories({ paths: listing, declaredContainers: ["plugins/alpha"] }).map((entry) => entry.path),
    ).toEqual([`${CONTAINER}/standard`, "plugins/alpha/review"]);
  });
});

describe("declaredSkillContainers", () => {
  it("resolves marketplace plugins against their plugin root", () => {
    const marketplace = JSON.stringify({
      metadata: { pluginRoot: "./plugins" },
      plugins: [
        { name: "alpha", source: "alpha", skills: ["./review", "./test"] },
        { name: "remote", source: { source: "github", repo: "o/r" } },
        { name: "unrelative", source: "beta", skills: ["review"] },
      ],
    });
    expect(declaredSkillContainers({ marketplace })).toEqual([
      "plugins/alpha",
      "plugins/alpha/skills",
      "plugins/beta",
      "plugins/beta/skills",
    ]);
  });

  it("skips the whole catalog when the plugin root escapes the source", () => {
    const marketplace = JSON.stringify({ metadata: { pluginRoot: "../plugins" }, plugins: [{ source: "alpha" }] });
    expect(declaredSkillContainers({ marketplace })).toEqual([]);
  });

  it("falls back to the root skills directory for a single plugin manifest", () => {
    expect(declaredSkillContainers({ plugin: JSON.stringify({ skills: ["./skills/review"] }) })).toEqual(["skills"]);
    expect(declaredSkillContainers({ plugin: "not json" })).toEqual([]);
    expect(declaredSkillContainers({})).toEqual([]);
  });

  it("never returns a container that escapes the source root", () => {
    const marketplace = JSON.stringify({ plugins: [{ source: "alpha", skills: ["./../../etc"] }] });
    expect(declaredSkillContainers({ marketplace })).toEqual(["alpha/skills"]);
  });
});

describe("skillNameFromDirectory", () => {
  it("uses the last path segment", () => {
    expect(skillNameFromDirectory("skills/demo")).toBe("demo");
    expect(skillNameFromDirectory("demo")).toBe("demo");
  });
});
