import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createMatcher, parseCodeowners } from "../ownership-gate/codeowners.mjs";
import {
  DEFAULT_MODE,
  isUndeclaredPattern,
  MODE_EXEMPT,
  MODE_GATE,
  MODE_TERRITORY,
  ModeConfigError,
  modeForPattern,
  parseModeConfig,
} from "../ownership-gate/modes.mjs";
import {
  decideFile,
  decidePullRequest,
  groupBlocking,
  STATE_FAILURE,
  STATE_SUCCESS,
} from "../ownership-gate/policy.mjs";
import {
  MAX_DESCRIPTION_LENGTH,
  renderStatusDescription,
  renderSummary,
  truncateDescription,
} from "../ownership-gate/report.mjs";
import { buildConfig, DEFAULT_CONTEXT } from "../ownership-gate.mjs";

const repoRoot = join(import.meta.dirname, "..", "..");
const workflowPath = join(repoRoot, ".github", "workflows", "ownership-gate.yml");
const relayPath = join(repoRoot, ".github", "workflows", "ownership-gate-relay.yml");

const CODEOWNERS = [
  "*                           @bestony @yuezengwu",
  "/pnpm-lock.yaml             @bestony @yuezengwu",
  "*.md                        @yuezengwu @bestony @Gandy2025 @liuchao-001",
  "/packages/server/drizzle/   @bestony @yuezengwu",
  "/CONTRIBUTING.md            @yuezengwu @bestony",
  "/apps/web/",
].join("\n");

const MODE_PAYLOAD = {
  version: 1,
  rules: [
    { pattern: "*", mode: MODE_GATE },
    { pattern: "/pnpm-lock.yaml", mode: MODE_TERRITORY },
    { pattern: "*.md", mode: MODE_TERRITORY },
    { pattern: "/packages/server/drizzle/", mode: MODE_GATE },
    { pattern: "/CONTRIBUTING.md", mode: MODE_GATE },
    { pattern: "/apps/web/", mode: MODE_EXEMPT },
  ],
  pins: [{ pattern: "/packages/server/drizzle/", reason: "irreversible migrations stay mutually reviewed" }],
};

function policy() {
  const { rules, problems } = parseCodeowners(CODEOWNERS);
  assert.deepEqual(problems, [], "the fixture must parse cleanly");
  return { rules, matcher: createMatcher(rules), modeConfig: parseModeConfig(MODE_PAYLOAD) };
}

const OWNERS = ["bestony", "yuezengwu", "gandy2025", "liuchao-001"];

function decide({ files, author, approvals = [], hasWriteAccess = true }) {
  const { matcher, modeConfig } = policy();
  return decidePullRequest({
    files,
    matcher,
    modeConfig,
    author,
    hasWriteAccess,
    approvals: new Set(approvals),
    owners: OWNERS,
  });
}

test("the mode table rejects an unknown mode", () => {
  assert.throws(
    () => parseModeConfig({ rules: [{ pattern: "*", mode: "advisory" }] }),
    (error) => error instanceof ModeConfigError && /expected one of/.test(error.message),
  );
});

test("the mode table rejects a pattern declared twice", () => {
  assert.throws(
    () =>
      parseModeConfig({
        rules: [
          { pattern: "*", mode: MODE_GATE },
          { pattern: "*", mode: MODE_TERRITORY },
        ],
      }),
    (error) => error instanceof ModeConfigError && /more than once/.test(error.message),
  );
});

test("a pattern with no mode entry falls back to gate so an unreviewed edit fails safe", () => {
  const config = parseModeConfig(MODE_PAYLOAD);
  assert.equal(modeForPattern(config, "*.sql"), DEFAULT_MODE);
  assert.equal(DEFAULT_MODE, MODE_GATE);
  assert.equal(isUndeclaredPattern(config, "*.sql"), true);
  assert.equal(isUndeclaredPattern(config, "*.md"), false);
});

test("a pin must explain itself", () => {
  assert.throws(
    () => parseModeConfig({ rules: [], pins: [{ pattern: "/x/" }] }),
    (error) => error instanceof ModeConfigError && /reason/.test(error.message),
  );
});

test("gate mode never lets the author satisfy their own change", () => {
  const result = decide({ files: ["packages/server/src/app.ts"], author: "bestony", approvals: ["bestony"] });
  assert.equal(result.state, STATE_FAILURE);
  assert.deepEqual(result.blocking[0].eligible, ["yuezengwu"]);
});

test("gate mode is satisfied by the other owner", () => {
  const result = decide({ files: ["packages/server/src/app.ts"], author: "bestony", approvals: ["yuezengwu"] });
  assert.equal(result.state, STATE_SUCCESS);
  assert.match(result.files[0].reason, /approved by yuezengwu/);
});

test("gate mode applies to a root configuration file through the default rule", () => {
  const result = decide({ files: ["turbo.json"], author: "yuezengwu" });
  assert.equal(result.state, STATE_FAILURE);
  assert.equal(result.blocking[0].pattern, "*");
  assert.deepEqual(result.blocking[0].eligible, ["bestony"]);
});

test("territory mode lets an owner self-merge but not an outsider", () => {
  const owned = decide({ files: ["pnpm-lock.yaml"], author: "bestony" });
  assert.equal(owned.state, STATE_SUCCESS);
  assert.match(owned.files[0].reason, /owns this territory/);

  const outsider = decide({ files: ["pnpm-lock.yaml"], author: "gandy2025" });
  assert.equal(outsider.state, STATE_FAILURE);
  assert.deepEqual(outsider.blocking[0].eligible, ["bestony", "yuezengwu"]);
});

test("the markdown fast lane is territory for its wider owner pool", () => {
  const result = decide({ files: ["docs/releasing.md"], author: "liuchao-001" });
  assert.equal(result.state, STATE_SUCCESS);
  assert.equal(result.files[0].mode, MODE_TERRITORY);
});

test("the root policy carve-back pulls CONTRIBUTING.md back into mutual review", () => {
  const result = decide({ files: ["CONTRIBUTING.md"], author: "gandy2025" });
  assert.equal(result.state, STATE_FAILURE);
  assert.equal(result.blocking[0].pattern, "/CONTRIBUTING.md");
  assert.equal(result.blocking[0].mode, MODE_GATE);
});

test("the drizzle pin beats the markdown fast lane for its own README", () => {
  const result = decide({ files: ["packages/server/drizzle/README.md"], author: "liuchao-001" });
  assert.equal(result.state, STATE_FAILURE);
  assert.equal(result.blocking[0].pattern, "/packages/server/drizzle/");
});

test("an ownerless rule resolves as exempt instead of falling back to the default owners", () => {
  const result = decide({ files: ["apps/web/src/app.tsx", "apps/web/src/ui/KUMO.md"], author: "gandy2025" });
  assert.equal(result.state, STATE_SUCCESS);
  assert.equal(result.files[0].mode, MODE_EXEMPT);
  assert.equal(result.files[1].mode, MODE_EXEMPT, "the web carve-out also wins over *.md inside web");
});

test("a mixed pull request is judged by its most demanding file", () => {
  const result = decide({ files: ["apps/web/src/app.tsx", "packages/shared/src/index.ts"], author: "gandy2025" });
  assert.equal(result.state, STATE_FAILURE);
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0].path, "packages/shared/src/index.ts");
});

test("an author without write access needs an owner approval even for exempt files", () => {
  const blocked = decide({ files: ["apps/web/src/app.tsx"], author: "outsider", hasWriteAccess: false });
  assert.equal(blocked.state, STATE_FAILURE);
  assert.equal(blocked.blocking.length, 0, "no file blocks; the external-author floor does");
  assert.equal(blocked.externalAuthor.required, true);
  assert.deepEqual(blocked.requiredFrom, [...OWNERS].sort());

  const approved = decide({
    files: ["apps/web/src/app.tsx"],
    author: "outsider",
    hasWriteAccess: false,
    approvals: ["gandy2025"],
  });
  assert.equal(approved.state, STATE_SUCCESS);
});

test("the external-author floor does not apply to an author with write access", () => {
  const result = decide({ files: ["apps/web/src/app.tsx"], author: "gandy2025" });
  assert.equal(result.externalAuthor.required, false);
  assert.equal(result.state, STATE_SUCCESS);
});

test("approvals are matched case-insensitively", () => {
  const result = decide({ files: ["packages/server/src/app.ts"], author: "Bestony", approvals: ["YueZengWu"] });
  assert.equal(result.state, STATE_SUCCESS);
});

test("a path matching no rule blocks and falls back to any owner", () => {
  const decision = decideFile({
    path: "somewhere",
    rule: null,
    mode: undefined,
    author: "bestony",
    approvals: new Set(),
    fallbackOwners: ["yuezengwu"],
  });
  assert.equal(decision.satisfied, false);
  assert.deepEqual(decision.eligible, ["yuezengwu"]);
});

test("a rule whose owners cannot be resolved to reviewers blocks instead of passing", () => {
  const decision = decideFile({
    path: "packages/server/src/app.ts",
    rule: { pattern: "*", owners: ["@org/team"], ownerless: false, line: 1 },
    mode: MODE_GATE,
    author: "bestony",
    approvals: new Set(["yuezengwu"]),
    fallbackOwners: ["yuezengwu"],
  });
  assert.equal(decision.satisfied, false);
  assert.match(decision.reason, /no reviewable owner/);
});

test("a mode entry of exempt on a rule that has owners degrades to gate rather than opening a hole", () => {
  const decision = decideFile({
    path: "packages/server/src/app.ts",
    rule: { pattern: "*", owners: ["@bestony", "@yuezengwu"], ownerless: false, line: 1 },
    mode: MODE_EXEMPT,
    author: "bestony",
    approvals: new Set(),
    fallbackOwners: [],
  });
  assert.equal(decision.mode, MODE_GATE);
  assert.equal(decision.satisfied, false);
});

test("an ownerless rule stays exempt even when the mode table disagrees", () => {
  const decision = decideFile({
    path: "apps/web/src/app.tsx",
    rule: { pattern: "/apps/web/", owners: [], ownerless: true, line: 6 },
    mode: MODE_GATE,
    author: "gandy2025",
    approvals: new Set(),
    fallbackOwners: ["bestony"],
  });
  assert.equal(decision.mode, MODE_EXEMPT);
  assert.equal(decision.satisfied, true);
});

test("blocking files are grouped by the rule that blocked them", () => {
  const result = decide({
    files: ["packages/shared/src/a.ts", "packages/shared/src/b.ts", "CONTRIBUTING.md"],
    author: "gandy2025",
  });
  const groups = groupBlocking(result.blocking);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.pattern).sort(), ["*", "/CONTRIBUTING.md"]);
  assert.equal(groups.find((group) => group.pattern === "*").paths.length, 2);
});

test("the status description stays inside the commit-status limit", () => {
  const result = decide({
    files: Array.from({ length: 400 }, (_value, index) => `packages/server/src/file-${index}.ts`),
    author: "bestony",
  });
  const description = renderStatusDescription(result);
  assert.ok(description.length <= MAX_DESCRIPTION_LENGTH, `description was ${description.length} characters`);
  assert.match(description, /awaiting approval/);
});

test("truncateDescription marks the cut", () => {
  assert.equal(truncateDescription("abcdef", 4), "abc…");
  assert.equal(truncateDescription("abc", 4), "abc");
});

test("a green run says so in one line", () => {
  const result = decide({ files: ["apps/web/src/app.tsx"], author: "gandy2025" });
  assert.match(renderStatusDescription(result), /^Ownership satisfied for 1 changed file\.$/);
});

test("the summary names the rule, the mode and who can unblock it", () => {
  const result = decide({ files: ["packages/shared/src/index.ts"], author: "bestony" });
  const summary = renderSummary({
    repository: "first-tree-ai/opentag",
    pullRequest: { number: 7, url: "https://example.invalid/pull/7", headSha: "abc123", accessReason: "write access" },
    decision: result,
    codeownersPath: ".github/CODEOWNERS",
    modesPath: ".github/ownership-modes.json",
  });
  assert.match(summary, /## Ownership gate/);
  assert.match(summary, /packages\/shared\/src\/index\.ts/);
  assert.match(summary, /yuezengwu/);
  assert.match(summary, /never approves on anyone's behalf/);
  assert.match(summary, /not dismissed on a new push/);
});

test("every action in both workflows is pinned to a full commit SHA", async () => {
  for (const path of [workflowPath, relayPath]) {
    const workflow = await readFile(path, "utf8");
    // Anchor the filter: `statuses: write` contains "uses: " as a substring.
    for (const line of workflow.split(/\r?\n/).filter((candidate) => /^\s*uses:\s/.test(candidate))) {
      assert.match(line, /uses: [^@]+@[0-9a-f]{40} # v/, `unpinned action: ${line.trim()}`);
    }
  }
});

test("neither workflow interpolates an expression into a shell command", async () => {
  for (const path of [workflowPath, relayPath]) {
    const workflow = await readFile(path, "utf8");
    for (const line of workflow.split(/\r?\n/)) {
      if (/^\s*run:/.test(line)) {
        assert.doesNotMatch(line, /\$\{\{/, `script injection risk in ${path}: ${line.trim()}`);
      }
    }
  }
});

test("the privileged workflow only runs on triggers that load it from the default branch", async () => {
  // `pull_request` and `pull_request_review` load the workflow from the pull
  // request's own merge ref, so either one would let a pull request rewrite the
  // gate that judges it.
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /^ {2}pull_request_target:$/m);
  assert.match(workflow, /^ {2}workflow_run:$/m);
  assert.match(workflow, /workflows: \["Ownership Gate Relay"\]/);
  assert.doesNotMatch(workflow, /^ {2}pull_request_review:$/m, "the review trigger is not self-protecting");
  assert.doesNotMatch(workflow, /^ {2}pull_request:$/m, "the pull_request trigger is not self-protecting");
});

test("the privileged workflow checks out the default branch and never pull request code", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /pull_request\.head\.ref/, "checking out the head ref would run pull request code");
});

test("the relay holds nothing an attacker could use, because a pull request supplies its body", async () => {
  const relay = await readFile(relayPath, "utf8");
  assert.match(relay, /^ {2}pull_request_review:\n {4}types: \[submitted, dismissed, edited\]$/m);
  assert.match(relay, /^permissions: \{\}$/m, "the relay must hold no token scopes at all");
  assert.doesNotMatch(relay, /uses: actions\/checkout/, "the relay must not check anything out");
  assert.doesNotMatch(relay, /secrets\./);
  assert.doesNotMatch(relay, /statuses: write/);
});

test("the gate resolves the pull request from GitHub-supplied metadata, not from the relay", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /RELAY_HEAD_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.doesNotMatch(workflow, /download-artifact/, "an artifact would be pull-request-supplied input");
});

test("the job is not named after the status context it posts", async () => {
  // A required check name matches a commit status context AND a check run name.
  // Sharing the name would make both required, and the check-run half reports
  // success when the job is skipped.
  const workflow = await readFile(workflowPath, "utf8");
  assert.doesNotMatch(workflow, /name: ownership-gate/);
  assert.match(workflow, /^\s{4}name: Evaluate ownership$/m);
});

test("the privileged workflow asks for the narrowest permissions the gate needs", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /^permissions:\n {2}contents: read$/m, "the default must stay read-only");
  assert.match(workflow, /statuses: write/);
  assert.doesNotMatch(workflow, /contents: write/);
});

test("neither workflow carries a paths filter, which would wedge unrelated pull requests", async () => {
  // A workflow skipped by path filtering leaves its required check pending
  // forever rather than passing it.
  for (const path of [workflowPath, relayPath]) {
    const workflow = await readFile(path, "utf8");
    assert.doesNotMatch(workflow, /^\s*paths(-ignore)?:/m, `${path} must not filter by path`);
  }
});

test("the gate accepts either a pull request number or a relay head SHA", () => {
  assert.equal(buildConfig([], { PULL_REQUEST_NUMBER: "42" }).number, 42);
  const relayed = buildConfig([], { RELAY_HEAD_SHA: "a".repeat(40) });
  assert.equal(relayed.number, null);
  assert.equal(relayed.headSha, "a".repeat(40));
  assert.throws(() => buildConfig([], {}), /pull request number or a head SHA is required/);
  assert.throws(() => buildConfig([], { RELAY_HEAD_SHA: "nope" }), /40 hexadecimal characters/);
  assert.throws(() => buildConfig([], { PULL_REQUEST_NUMBER: "0" }), /positive integer/);
});

test("the gate posts under the context the ruleset requires", () => {
  assert.equal(DEFAULT_CONTEXT, "ownership-gate");
  assert.equal(buildConfig([], { PULL_REQUEST_NUMBER: "1" }).context, DEFAULT_CONTEXT);
});

test("the shipped policy files agree with each other", async () => {
  const codeowners = await readFile(join(repoRoot, ".github", "CODEOWNERS"), "utf8");
  const modes = JSON.parse(await readFile(join(repoRoot, ".github", "ownership-modes.json"), "utf8"));
  const { rules, problems } = parseCodeowners(codeowners);
  assert.deepEqual(problems, []);
  const config = parseModeConfig(modes);
  assert.equal(rules[0].pattern, "*", "the fail-safe default must be the first rule");
  assert.equal(modeForPattern(config, "*"), MODE_GATE);
  assert.equal(rules.at(-1).ownerless, true, "the web carve-out must stay last so it wins over *.md inside web");
  assert.equal(modeForPattern(config, rules.at(-1).pattern), MODE_EXEMPT);
});

test("the summary states the external-author floor when it applies", () => {
  const result = decide({ files: ["apps/web/src/app.tsx"], author: "outsider", hasWriteAccess: false });
  const summary = renderSummary({
    repository: "first-tree-ai/opentag",
    pullRequest: {
      number: 8,
      url: "https://example.invalid/pull/8",
      headSha: "def456",
      accessReason: "fork pull request",
    },
    decision: result,
    codeownersPath: ".github/CODEOWNERS",
    modesPath: ".github/ownership-modes.json",
  });
  assert.match(summary, /External-author floor: \*\*not satisfied\*\*/);
  assert.match(summary, /fork pull request/);
});
