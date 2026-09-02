import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  collectOwners,
  compilePattern,
  createMatcher,
  matchRule,
  ownerLogin,
  parseCodeowners,
} from "../ownership-gate/codeowners.mjs";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..");

/**
 * Ported verbatim from the hmarr/codeowners pattern corpus, the de-facto
 * reference implementation validated against live GitHub. These cases are the
 * contract; the algorithm serves them rather than the other way round.
 */
const CORPUS = [
  {
    name: "single-segment pattern",
    pattern: "foo",
    paths: {
      foo: true,
      "foo.txt": false,
      "foo/bar": true,
      "bar/foo": true,
      "bar/foo.txt": false,
      "bar/baz": false,
      "bar/foo/baz": true,
    },
  },
  {
    name: "single-segment pattern with leading slash",
    pattern: "/foo",
    paths: {
      foo: true,
      "fool.txt": false,
      "foo/bar": true,
      "bar/foo": false,
      "bar/baz": false,
      "foo/bar/baz": true,
      "bar/foo/baz": false,
    },
  },
  {
    name: "single-segment pattern with trailing slash",
    pattern: "foo/",
    paths: {
      foo: false,
      "foo/bar": true,
      "foo/bar/baz": true,
      "bar/foo": false,
      "bar/baz": false,
      "bar/foo/baz": true,
      "bar/foo/baz/qux": true,
    },
  },
  {
    name: "single-segment pattern with leading and trailing slash",
    pattern: "/foo/",
    paths: {
      foo: false,
      "foo/bar": true,
      "foo/bar/baz": true,
      "bar/foo": false,
      "bar/baz": false,
      "bar/foo/baz": false,
      "bar/foo/baz/qux": false,
    },
  },
  {
    name: "multi-segment (implicitly left-anchored) pattern",
    pattern: "foo/bar",
    paths: {
      "foo/bar": true,
      "foo/bart": false,
      "foo/bar/baz": true,
      "baz/foo/bar": false,
      "baz/foo/bar/qux": false,
    },
  },
  {
    name: "multi-segment pattern with leading slash",
    pattern: "/foo/bar",
    paths: {
      "foo/bar": true,
      "foo/bart": false,
      "foo/bar/baz": true,
      "baz/foo/bar": false,
      "baz/foo/bar/qux": false,
    },
  },
  {
    name: "multi-segment pattern with trailing slash",
    pattern: "foo/bar/",
    paths: {
      "foo/bar": false,
      "foo/bart": false,
      "foo/bar/baz": true,
      "baz/foo/bar": false,
      "baz/foo/bar/qux": false,
    },
  },
  {
    name: "multi-segment pattern with leading and trailing slash",
    pattern: "/foo/bar/",
    paths: {
      "foo/bar": false,
      "foo/bart": false,
      "foo/bar/baz": true,
      "foo/bar/baz/qux": true,
      "baz/foo/bar": false,
      "baz/foo/bar/qux": false,
    },
  },
  {
    name: "single segment lone wildcard",
    pattern: "*",
    paths: {
      foo: true,
      "foo/bar": true,
      "bar/foo": true,
      "bar/foo/baz": true,
      "bar/baz": true,
      xfoo: true,
    },
  },
  {
    name: "single segment pattern with wildcard",
    pattern: "f*",
    paths: {
      foo: true,
      "foo/bar": true,
      "foo/bar/baz": true,
      "bar/foo": true,
      "bar/foo/baz": true,
      "bar/baz": false,
      xfoo: false,
    },
  },
  {
    name: "single segment pattern with leading slash and lone wildcard",
    pattern: "/*",
    paths: {
      foo: true,
      bar: true,
      "foo/bar": false,
      "foo/bar/baz": false,
    },
  },
  {
    name: "single segment pattern with leading slash and wildcard",
    pattern: "/f*",
    paths: {
      foo: true,
      "foo/bar": true,
      "foo/bar/baz": true,
      "bar/foo": false,
      "bar/foo/baz": false,
      "bar/baz": false,
      xfoo: false,
    },
  },
  {
    name: "single segment pattern with trailing slash and wildcard",
    pattern: "f*/",
    paths: {
      foo: false,
      "foo/bar": true,
      "bar/foo": false,
      "bar/foo/baz": true,
      "bar/baz": false,
      xfoo: false,
    },
  },
  {
    name: "single segment pattern with leading and trailing slash and lone wildcard",
    pattern: "/*/",
    paths: {
      foo: false,
      "foo/bar": true,
      "bar/foo": true,
      "bar/foo/baz": true,
    },
  },
  {
    name: "single segment pattern with leading and trailing slash and wildcard",
    pattern: "/f*/",
    paths: {
      foo: false,
      "foo/bar": true,
      "bar/foo": false,
      "bar/foo/baz": false,
      "bar/baz": false,
      xfoo: false,
    },
  },
  {
    name: "single segment pattern with escaped wildcard",
    pattern: "f\\*o",
    paths: {
      foo: false,
      "f*o": true,
    },
  },
  {
    name: "pattern with trailing wildcard segment",
    pattern: "foo/*",
    paths: {
      foo: false,
      "foo/bar": true,
      "foo/bar/baz": false,
      "bar/foo": false,
      "bar/foo/baz": false,
      "bar/baz": false,
      xfoo: false,
    },
  },
  {
    name: "multi-segment pattern with wildcard",
    pattern: "foo/*.txt",
    paths: {
      foo: false,
      "foo/bar.txt": true,
      "foo/bar/baz.txt": false,
      "qux/foo/bar.txt": false,
      "qux/foo/bar/baz.txt": false,
    },
  },
  {
    name: "multi-segment pattern with lone wildcard",
    pattern: "foo/*/baz",
    paths: {
      foo: false,
      "foo/bar": false,
      "foo/baz": false,
      "foo/bar/baz": true,
      "foo/bar/baz/qux": true,
    },
  },
  {
    name: "single segment pattern with single-character wildcard",
    pattern: "f?o",
    paths: {
      foo: true,
      fo: false,
      fooo: false,
    },
  },
  {
    name: "single segment pattern with escaped single-character wildcard",
    pattern: "f\\?o",
    paths: {
      foo: false,
      "f?o": true,
    },
  },
  {
    name: "leading double-asterisk wildcard",
    pattern: "**/foo/bar",
    paths: {
      "foo/bar": true,
      "qux/foo/bar": true,
      "qux/foo/bar/baz": true,
      "foo/baz/bar": false,
      "qux/foo/baz/bar": false,
    },
  },
  {
    name: "leading double-asterisk wildcard with regular wildcard",
    pattern: "**/*bar*",
    paths: {
      bar: true,
      "foo/bar": true,
      "foo/rebar": true,
      "foo/barrio": true,
      "foo/qux/bar": true,
    },
  },
  {
    name: "trailing double-asterisk wildcard",
    pattern: "foo/bar/**",
    paths: {
      "foo/bar": false,
      "foo/bar/baz": true,
      "foo/bar/baz/qux": true,
      "qux/foo/bar": false,
      "qux/foo/bar/baz": false,
    },
  },
  {
    name: "middle double-asterisk wildcard",
    pattern: "foo/**/bar",
    paths: {
      "foo/bar": true,
      "foo/bar/baz": true,
      "foo/qux/bar/baz": true,
      "foo/qux/quux/bar/baz": true,
      "foo/bar/baz/qux": true,
      "qux/foo/bar": false,
      "qux/foo/bar/baz": false,
    },
  },
  {
    name: "middle double-asterisk wildcard with trailing slash",
    pattern: "foo/**/",
    paths: {
      foo: false,
      "foo/bar": true,
      "foo/bar/": true,
      "foo/bar/baz": true,
    },
  },
  {
    name: "middle double-asterisk wildcard with trailing wildcard",
    pattern: "foo/**/bar/b*",
    paths: {
      "foo/bar": false,
      "foo/bar/baz": true,
      "foo/bar/qux": false,
      "foo/qux/bar": false,
      "foo/qux/bar/baz": true,
      "foo/qux/bar/qux": false,
    },
  },
  {
    name: "pattern with square brackets",
    pattern: "/apps/[param]/file.ts",
    paths: {
      "apps/[param]/file.ts": true,
      "apps/other/file.ts": false,
      "apps/[other]/file.ts": false,
      "apps/param/file.ts": false,
    },
  },
  {
    name: "pattern with colon",
    pattern: "services/foo:bar/**/*",
    paths: {
      "services/foo:bar/baz.json": true,
      "services/foo-bar/baz.json": false,
    },
  },
  {
    name: "pattern with caret",
    pattern: "vllm/v1/worker/^cpu",
    paths: {
      "vllm/v1/worker/^cpu": true,
      "vllm/v1/worker/cpu": false,
    },
  },
];

/** Builds a rule list the way parseCodeowners would, for matcher-only tests. */
function rulesFor(...patterns) {
  return patterns.map((pattern, index) => ({
    pattern,
    owners: [],
    ownerless: true,
    line: index + 1,
  }));
}

function matches(pattern, path) {
  return compilePattern(pattern).test(path);
}

test("the hmarr reference corpus matches path for path", () => {
  for (const entry of CORPUS) {
    const regexp = compilePattern(entry.pattern);
    for (const [path, expected] of Object.entries(entry.paths)) {
      assert.equal(
        regexp.test(path),
        expected,
        `${entry.name}: pattern "${entry.pattern}" against "${path}" (source ${regexp.source})`,
      );
    }
  }
});

test("a bare asterisk owns every file at every depth", () => {
  for (const path of ["LICENSE", "apps/web/src/main.tsx", "a/b/c/d/e/f.ts"]) {
    assert.equal(matches("*", path), true, path);
  }
});

test("a leading slash before a bare asterisk owns root-level files only", () => {
  assert.equal(matches("/*", "LICENSE"), true);
  assert.equal(matches("/*", "apps/web/src/main.tsx"), false);
  assert.equal(matches("/*", "apps/package.json"), false);
});

test("an extension pattern without a slash matches at any depth", () => {
  assert.equal(matches("*.md", "README.md"), true);
  assert.equal(matches("*.md", "docs/guide/setup.md"), true);
  assert.equal(matches("*.md", "docs/guide/setup.mdx"), false);
});

test("an interior slash anchors the pattern to the root exactly like a leading slash", () => {
  assert.equal(matches("docs/foo", "docs/foo"), true);
  assert.equal(matches("docs/foo", "packages/docs/foo"), false);
  assert.equal(compilePattern("docs/foo").source, compilePattern("/docs/foo").source);
});

test("a directory pattern with a trailing slash owns descendants but not the entry itself", () => {
  assert.equal(matches("/apps/web/", "apps/web/src/main.tsx"), true);
  assert.equal(matches("/apps/web/", "apps/web/vite.config.ts"), true);
  assert.equal(matches("/apps/web/", "apps/web"), false);
  assert.equal(matches("/apps/web/", "apps/webhooks/index.ts"), false);
});

test("a root-anchored file pattern owns both the file and anything beneath its name", () => {
  assert.equal(matches("/LICENSE", "LICENSE"), true);
  assert.equal(matches("/LICENSE", "LICENSE/third-party.txt"), true);
  assert.equal(matches("/LICENSE", "LICENSE.md"), false);
});

test("a trailing literal is recursive while a trailing single asterisk is one level deep", () => {
  assert.equal(matches("/docs", "docs/guide/setup.md"), true);
  assert.equal(matches("/docs/*", "docs/setup.md"), true);
  assert.equal(matches("/docs/*", "docs/guide/setup.md"), false);
});

test("matching is case sensitive and carries no ignore-case flag", () => {
  assert.equal(compilePattern("/README.md").flags, "");
  assert.equal(matches("/README.md", "README.md"), true);
  assert.equal(matches("/README.md", "readme.md"), false);
});

test("square brackets are literal characters rather than a character class", () => {
  assert.equal(matches("/apps/web/src/routes/[id]/page.tsx", "apps/web/src/routes/[id]/page.tsx"), true);
  assert.equal(matches("/apps/web/src/routes/[id]/page.tsx", "apps/web/src/routes/i/page.tsx"), false);
  assert.equal(matches("/apps/web/src/routes/[id]/page.tsx", "apps/web/src/routes/d/page.tsx"), false);
});

test("a gitlab-style section header is parsed as an ordinary bracketed pattern", () => {
  const { rules, problems } = parseCodeowners("[Backend]\n/packages/server/ @bestony\n");
  assert.deepEqual(problems, []);
  assert.equal(rules.length, 2);
  assert.equal(rules[0].pattern, "[Backend]");
  assert.deepEqual(rules[0].owners, []);
  assert.equal(matches("[Backend]", "[Backend]"), true);
  assert.equal(matches("[Backend]", "Backend"), false);
});

test("compilePattern rejects three consecutive asterisks", () => {
  assert.throws(() => compilePattern("/apps/***/file.ts"), TypeError);
  assert.throws(() => compilePattern("***"), TypeError);
  assert.throws(() => compilePattern(""), TypeError);
});

test("a bare slash matches nothing", () => {
  const regexp = compilePattern("/");
  assert.equal(regexp.test("LICENSE"), false);
  assert.equal(regexp.test("apps/web/src/main.tsx"), false);
});

test("parseCodeowners records patterns owners and line numbers", () => {
  const { rules, problems } = parseCodeowners("* @bestony @yuezengwu\n/LICENSE @bestony\n");
  assert.deepEqual(problems, []);
  assert.deepEqual(rules, [
    { pattern: "*", owners: ["@bestony", "@yuezengwu"], ownerless: false, line: 1 },
    { pattern: "/LICENSE", owners: ["@bestony"], ownerless: false, line: 2 },
  ]);
});

test("parseCodeowners ignores blank whitespace-only and comment lines", () => {
  const { rules, problems } = parseCodeowners("# owners\n\n   \n\t# indented comment\n* @bestony\n");
  assert.deepEqual(problems, []);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].line, 5);
});

test("parseCodeowners drops an inline comment but keeps an escaped hash in the pattern", () => {
  const { rules, problems } = parseCodeowners(
    "/LICENSE @bestony # the owner is on leave\n/docs/c\\#sharp.md @yuezengwu\n",
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(rules[0].owners, ["@bestony"]);
  assert.equal(rules[1].pattern, "/docs/c\\#sharp.md");
  assert.equal(matches(rules[1].pattern, "docs/c#sharp.md"), true);
});

test("parseCodeowners keeps an escaped space inside the pattern instead of splitting on it", () => {
  const { rules } = parseCodeowners("/docs/release\\ notes.md @bestony\n");
  assert.equal(rules[0].pattern, "/docs/release\\ notes.md");
  assert.deepEqual(rules[0].owners, ["@bestony"]);
  assert.equal(matches(rules[0].pattern, "docs/release notes.md"), true);
});

test("parseCodeowners reports an invalid pattern and leaves the line out of the rules", () => {
  const { rules, problems } = parseCodeowners("* @bestony\n/apps/***/file.ts @yuezengwu\n");
  assert.equal(rules.length, 1);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].line, 2);
  assert.equal(problems[0].text, "/apps/***/file.ts @yuezengwu");
  assert.match(problems[0].message, /three consecutive asterisks/);
});

test("parseCodeowners reports an invalid owner token but still keeps the rule matching", () => {
  const { rules, problems } = parseCodeowners("/LICENSE bestony\n");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].line, 1);
  assert.match(problems[0].message, /not a user, team or email address/);
  assert.deepEqual(rules, [{ pattern: "/LICENSE", owners: ["bestony"], ownerless: false, line: 1 }]);
  assert.equal(matchRule(rules, "LICENSE"), rules[0]);
});

test("parseCodeowners accepts users teams and email addresses as owners", () => {
  const { problems } = parseCodeowners("* @bestony @opentag/reviewers owner@example.com\n");
  assert.deepEqual(problems, []);
});

test("an ownerless rule resolves to an empty owner set without falling through", () => {
  const { rules, problems } = parseCodeowners("* @bestony\n/apps/web/\n");
  assert.deepEqual(problems, []);
  assert.equal(rules.length, 2);
  assert.equal(rules[1].ownerless, true);
  assert.deepEqual(rules[1].owners, []);

  const matched = matchRule(rules, "apps/web/src/main.tsx");
  assert.equal(matched, rules[1]);
  assert.deepEqual(matched.owners, []);
  assert.equal(matchRule(rules, "packages/server/src/index.ts"), rules[0]);
});

test("matchNaming skips a rule that reaches a path only through the implicit descendant suffix", () => {
  const rules = rulesFor("*", "*.md", "/apps/web/");
  const matcher = createMatcher(rules);

  // GitHub's reach is reproduced exactly...
  assert.equal(matcher.match("packages/notes.md/index.ts"), rules[1]);
  assert.equal(matcher.namesPath(rules[1], "packages/notes.md/index.ts"), false);
  // ...but the rule that NAMES the path is the repository-wide default.
  assert.equal(matcher.matchNaming("packages/notes.md/index.ts"), rules[0]);

  // A markdown file is named by the markdown rule, and a trailing-slash rule
  // names every descendant, so neither is affected.
  assert.equal(matcher.matchNaming("docs/guide.md"), rules[1]);
  assert.equal(matcher.namesPath(rules[1], "docs/guide.md"), true);
  assert.equal(matcher.matchNaming("apps/web/src/main.tsx"), rules[2]);
  assert.equal(matcher.namesPath(rules[2], "apps/web/src/main.tsx"), true);
});

test("last match wins even when an earlier rule would also have matched", () => {
  const rules = rulesFor("*", "*.md", "/apps/web/");
  const matcher = createMatcher(rules);
  assert.equal(matcher.match("docs/guide.md"), rules[1]);
  assert.equal(matcher.match("apps/web/README.md"), rules[2]);
  assert.equal(matcher.match("packages/server/src/index.ts"), rules[0]);
  // Every earlier rule here really does match; only the last one may be reported.
  assert.equal(compilePattern("*").test("apps/web/README.md"), true);
  assert.equal(compilePattern("*.md").test("apps/web/README.md"), true);
});

test("a non-matching rule has no effect on the result", () => {
  const withNoise = createMatcher(rulesFor("*", "/packages/server/", "/apps/cli/"));
  const withoutNoise = createMatcher(rulesFor("*"));
  assert.equal(withNoise.match("apps/web/src/main.tsx").pattern, withoutNoise.match("apps/web/src/main.tsx").pattern);
});

test("matchRule returns null when no rule matches", () => {
  assert.equal(matchRule(rulesFor("/apps/cli/"), "packages/server/src/index.ts"), null);
  assert.equal(matchRule([], "LICENSE"), null);
});

test("ownerLogin normalizes a user token and rejects teams and email addresses", () => {
  assert.equal(ownerLogin("@Bestony"), "bestony");
  assert.equal(ownerLogin("@yuezengwu"), "yuezengwu");
  assert.equal(ownerLogin("@Gandy2025"), "gandy2025");
  assert.equal(ownerLogin("@liuchao-001"), "liuchao-001");
  assert.equal(ownerLogin("@opentag/reviewers"), null);
  assert.equal(ownerLogin("@OpenTag/Reviewers"), null);
  assert.equal(ownerLogin("owner@example.com"), null);
  assert.equal(ownerLogin("bestony"), null);
  assert.equal(ownerLogin(""), null);
  assert.equal(ownerLogin(undefined), null);
});

test("collectOwners de-duplicates while preserving file order", () => {
  const { rules } = parseCodeowners(
    ["* @bestony @yuezengwu", "*.md @yuezengwu @Gandy2025", "/apps/web/", "/LICENSE @bestony team@example.com"].join(
      "\n",
    ),
  );
  assert.deepEqual(collectOwners(rules), ["@bestony", "@yuezengwu", "@Gandy2025", "team@example.com"]);
  assert.deepEqual(collectOwners([]), []);
});

test("createMatcher compiles each pattern once and reuses it across paths", () => {
  const rules = rulesFor("*", "/packages/server/drizzle/");
  const matcher = createMatcher(rules);
  assert.equal(matcher.match("packages/server/drizzle/0001_init.sql"), rules[1]);
  assert.equal(matcher.match("packages/server/drizzle/0002_next.sql"), rules[1]);
  assert.equal(matcher.match("packages/server/src/index.ts"), rules[0]);
});

test("the repository CODEOWNERS file parses without any reported problem", (t) => {
  const path = join(REPOSITORY_ROOT, ".github", "CODEOWNERS");
  if (!existsSync(path)) {
    t.skip(".github/CODEOWNERS does not exist yet");
    return;
  }
  const { rules, problems } = parseCodeowners(readFileSync(path, "utf8"));
  assert.deepEqual(problems, []);
  assert.ok(rules.length > 0, "expected at least one ownership rule");
});
