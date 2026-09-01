import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkOwnershipPolicy } from "../check-ownership-policy.mjs";

const repoRoot = join(import.meta.dirname, "..", "..");

const OWNERS = "@bestony @yuezengwu";

/** The shape shipped in .github/, minus the ordering defect each test injects. */
function fixture({ codeowners, rules, pins = [] }) {
  const root = mkdtempSync(join(tmpdir(), "ownership-policy-"));
  mkdirSync(join(root, ".github"));
  writeFileSync(join(root, ".github", "CODEOWNERS"), `${codeowners}\n`);
  writeFileSync(join(root, ".github", "ownership-modes.json"), JSON.stringify({ version: 1, rules, pins }));
  return root;
}

function check(options, files) {
  const root = fixture(options);
  try {
    return checkOwnershipPolicy({ repositoryRoot: root, files });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertFails(result, pattern) {
  assert.ok(result.failures.length > 0, "expected at least one failure");
  assert.ok(
    result.failures.some((failure) => pattern.test(failure)),
    `no failure matched ${pattern}\n${result.failures.join("\n")}`,
  );
}

test("the repository's own ownership policy is valid", () => {
  const result = checkOwnershipPolicy({ repositoryRoot: repoRoot });
  assert.deepEqual(result.failures, []);
  assert.ok(result.files > 0);
});

test("the repository gates every tracked file that is not deliberately carved out", () => {
  const result = checkOwnershipPolicy({ repositoryRoot: repoRoot });
  assert.ok(result.counts.get("*") > 0, "the fail-safe default rule must own the bulk of the tree");
  assert.equal(result.counts.get("/apps/web/") > 0, true);
});

test("a pin that a later rule overrides is reported with the file that proves it", () => {
  // This is the defect the drizzle pin had in the original draft: the pin sat
  // above *.md, so the one markdown file beneath it silently joined the docs
  // fast lane and the pin protected nothing.
  const result = check(
    {
      codeowners: [`* ${OWNERS}`, `/packages/server/drizzle/ ${OWNERS}`, "*.md @gandy2025"].join("\n"),
      rules: [
        { pattern: "*", mode: "gate" },
        { pattern: "/packages/server/drizzle/", mode: "gate" },
        { pattern: "*.md", mode: "territory" },
      ],
      pins: [{ pattern: "/packages/server/drizzle/", reason: "migrations stay mutually reviewed" }],
    },
    ["packages/server/drizzle/0001_init.sql", "packages/server/drizzle/README.md"],
  );
  assertFails(result, /later rule wins over the pin .*drizzle.*README\.md -> \*\.md/s);
});

test("the same pin below the overriding rule passes", () => {
  const result = check(
    {
      codeowners: [`* ${OWNERS}`, "*.md @gandy2025", `/packages/server/drizzle/ ${OWNERS}`].join("\n"),
      rules: [
        { pattern: "*", mode: "gate" },
        { pattern: "*.md", mode: "territory" },
        { pattern: "/packages/server/drizzle/", mode: "gate" },
      ],
      pins: [{ pattern: "/packages/server/drizzle/", reason: "migrations stay mutually reviewed" }],
    },
    ["packages/server/drizzle/0001_init.sql", "packages/server/drizzle/README.md"],
  );
  assert.deepEqual(result.failures, []);
});

test("a pin that protects nothing is reported", () => {
  const result = check(
    {
      codeowners: `* ${OWNERS}`,
      rules: [{ pattern: "*", mode: "gate" }],
      pins: [{ pattern: "/packages/server/drizzle/", reason: "migrations stay mutually reviewed" }],
    },
    ["README.md"],
  );
  assertFails(result, /matches no tracked file/);
});

test("a mode entry whose pattern no longer exists is reported, because that is how an exemption grows back", () => {
  const result = check(
    {
      codeowners: `* ${OWNERS}`,
      rules: [
        { pattern: "*", mode: "gate" },
        { pattern: "*.sql", mode: "territory" },
      ],
    },
    ["README.md"],
  );
  assertFails(result, /mode declared for pattern \*\.sql, which no longer exists/);
});

test("a CODEOWNERS rule with no mode entry is reported even though the runtime would gate it", () => {
  const result = check(
    {
      codeowners: [`* ${OWNERS}`, `*.sql ${OWNERS}`].join("\n"),
      rules: [{ pattern: "*", mode: "gate" }],
    },
    ["README.md"],
  );
  assertFails(result, /no mode declared for .* pattern \*\.sql/);
});

test("an ownerless rule must be declared exempt", () => {
  const result = check(
    {
      codeowners: [`* ${OWNERS}`, "/apps/web/"].join("\n"),
      rules: [
        { pattern: "*", mode: "gate" },
        { pattern: "/apps/web/", mode: "gate" },
      ],
    },
    ["apps/web/index.html"],
  );
  assertFails(result, /lists no owners but is declared gate/);
});

test("an exempt rule must not name owners", () => {
  const result = check(
    {
      codeowners: [`* ${OWNERS}`, `/apps/web/ ${OWNERS}`].join("\n"),
      rules: [
        { pattern: "*", mode: "gate" },
        { pattern: "/apps/web/", mode: "exempt" },
      ],
    },
    ["apps/web/index.html"],
  );
  assertFails(result, /declared exempt but names owners/);
});

test("a pattern declared twice in CODEOWNERS is reported, because the mode table cannot tell them apart", () => {
  const result = check(
    {
      codeowners: [`* ${OWNERS}`, "*.md @gandy2025", "*.md @liuchao-001"].join("\n"),
      rules: [
        { pattern: "*", mode: "gate" },
        { pattern: "*.md", mode: "territory" },
      ],
    },
    ["README.md"],
  );
  assertFails(result, /is already declared on line/);
});

test("a team owner is rejected, because the gate reads submitted reviews and cannot expand a team", () => {
  const result = check(
    {
      codeowners: "* @first-tree-ai/maintainers",
      rules: [{ pattern: "*", mode: "gate" }],
    },
    ["README.md"],
  );
  assertFails(result, /is a team or email owner/);
});

test("a tracked file matching no rule at all is reported", () => {
  const result = check(
    {
      codeowners: `/docs/ ${OWNERS}`,
      rules: [{ pattern: "/docs/", mode: "gate" }],
    },
    ["docs/a.md", "src/index.ts"],
  );
  assertFails(result, /match no rule at all/);
});

test("an unparseable pattern is reported rather than silently dropped", () => {
  const result = check(
    {
      codeowners: [`* ${OWNERS}`, `/a***b ${OWNERS}`].join("\n"),
      rules: [{ pattern: "*", mode: "gate" }],
    },
    ["README.md"],
  );
  assertFails(result, /three consecutive asterisks/);
});

test("a malformed mode table stops the check instead of defaulting", () => {
  const result = check(
    {
      codeowners: `* ${OWNERS}`,
      rules: [{ pattern: "*", mode: "advisory" }],
    },
    ["README.md"],
  );
  assertFails(result, /expected one of/);
});
