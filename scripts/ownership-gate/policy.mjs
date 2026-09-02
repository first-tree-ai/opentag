import { ownerLogin } from "./codeowners.mjs";
import { MODE_EXEMPT, MODE_GATE, MODE_TERRITORY, modeForPattern } from "./modes.mjs";

export const STATE_SUCCESS = "success";
export const STATE_FAILURE = "failure";

const NO_RULE_PATTERN = "(no matching rule)";

function normalize(login) {
  return String(login ?? "")
    .trim()
    .toLowerCase();
}

/**
 * Owner tokens that name a person. Teams and bare email addresses resolve to
 * null: this check reads submitted reviews and cannot expand a team without
 * another API call, so a rule owned only by a team would silently become
 * unsatisfiable. `check-ownership-policy.mjs` rejects such rules offline; the
 * runtime still refuses to guess (see `resolveOwners`).
 */
function ownerLogins(rule) {
  const logins = [];
  for (const token of rule.owners) {
    const login = ownerLogin(token);
    if (login !== null && !logins.includes(login)) {
      logins.push(login);
    }
  }
  return logins;
}

function satisfiedBy(candidates, approvals) {
  return candidates.filter((login) => approvals.has(login));
}

/**
 * These two are unsatisfiable on purpose: no approval clears them, because the
 * rule that matched cannot name a reviewer, or nothing matched at all. Their
 * `eligible` list is therefore empty rather than the owner list -- naming people
 * would tell an operator to do the one thing that cannot help. The remedy is a
 * reviewed edit to CODEOWNERS, and the reason says so.
 * `check-ownership-policy.mjs` rejects both shapes offline, so reaching one at
 * runtime means the policy on the default branch is already broken.
 */
function unresolvableDecision(path, rule) {
  return {
    path,
    pattern: rule.pattern,
    line: rule.line,
    mode: MODE_GATE,
    owners: [],
    eligible: [],
    satisfied: false,
    reason: "the matching rule names no reviewable owner; fix .github/CODEOWNERS to name one",
  };
}

function unmatchedDecision(path) {
  return {
    path,
    pattern: NO_RULE_PATTERN,
    line: null,
    mode: MODE_GATE,
    owners: [],
    eligible: [],
    satisfied: false,
    reason: "no CODEOWNERS rule matched this path; fix .github/CODEOWNERS to cover it",
  };
}

function exemptDecision(path, rule) {
  return {
    path,
    pattern: rule.pattern,
    line: rule.line,
    mode: MODE_EXEMPT,
    owners: [],
    eligible: [],
    satisfied: true,
    reason: "the matching rule deliberately has no owners",
  };
}

function gateDecision({ path, rule, owners, author, approvals }) {
  // Gate mode has no author self-exemption: the author is removed from the
  // eligible set even when they own the path. That is the whole point of the
  // mutual-review gate, and it is also what GitHub does natively -- an author
  // can never satisfy a code-owner requirement with their own approval.
  const eligible = owners.filter((login) => login !== author);
  const approvers = satisfiedBy(eligible, approvals);
  return {
    path,
    pattern: rule.pattern,
    line: rule.line,
    mode: MODE_GATE,
    owners,
    eligible,
    satisfied: approvers.length > 0,
    reason:
      approvers.length > 0
        ? `approved by ${approvers.join(", ")}`
        : "mutual review: needs an owner other than the author",
  };
}

function territoryDecision({ path, rule, owners, author, approvals }) {
  if (owners.includes(author)) {
    return {
      path,
      pattern: rule.pattern,
      line: rule.line,
      mode: MODE_TERRITORY,
      owners,
      eligible: [],
      satisfied: true,
      reason: "the author owns this territory",
    };
  }
  const approvers = satisfiedBy(owners, approvals);
  return {
    path,
    pattern: rule.pattern,
    line: rule.line,
    mode: MODE_TERRITORY,
    owners,
    eligible: owners,
    satisfied: approvers.length > 0,
    reason:
      approvers.length > 0 ? `approved by ${approvers.join(", ")}` : "needs an approval from any owner of this path",
  };
}

/**
 * Resolves the mode actually applied to a file.
 *
 * A relaxation only applies to the paths its rule NAMES. CODEOWNERS gives every
 * pattern an implicit reach over descendants, so `*.md` owns not just markdown
 * files but every file inside any directory whose name ends in `.md` -- and a
 * territory rule reaching that far would hand its owners a self-merge lane over
 * arbitrary code in a directory anyone can create. Reached-by-descent therefore
 * falls back to `gate`, which is the same fail-safe direction as an undeclared
 * mode. The matcher still reproduces GitHub's reach exactly; only the authority
 * attached to it is narrowed.
 *
 * A rule that lists no owners is otherwise exempt whatever the mode table says:
 * GitHub resolves an ownerless rule as "matched, zero owners required", and a
 * naive implementation that instead fell through to the previous match -- or to
 * the `*` fallback -- would silently re-impose the gate on the paths the policy
 * deliberately released. The inverse mismatch (mode `exempt` on a rule that does
 * have owners) falls back to `gate`, so a typo cannot open a hole.
 */
function effectiveMode(rule, declared, namesPath) {
  if (!namesPath) {
    return MODE_GATE;
  }
  if (rule.ownerless) {
    return MODE_EXEMPT;
  }
  return declared === MODE_EXEMPT ? MODE_GATE : declared;
}

/** Decides one changed file against the rule that matched it. */
export function decideFile({ path, rule, mode, author, approvals, namesPath = true }) {
  if (rule === null) {
    return unmatchedDecision(path);
  }
  const resolved = effectiveMode(rule, mode, namesPath);
  if (resolved === MODE_EXEMPT) {
    return exemptDecision(path, rule);
  }
  const owners = ownerLogins(rule);
  if (owners.length === 0) {
    return unresolvableDecision(path, rule);
  }
  const context = { path, rule, owners, author, approvals };
  return resolved === MODE_TERRITORY ? territoryDecision(context) : gateDecision(context);
}

/**
 * The floor for untrusted authors (design item 6): a pull request whose author
 * cannot push to this repository -- an outside contributor, a fork, or a bot --
 * needs an approval from at least one owner named anywhere in CODEOWNERS, no
 * matter which files it touches. Without it, an external pull request that only
 * touched the deliberately unowned `apps/web` would have green CI as its sole
 * gate.
 */
function decideExternalAuthor({ hasWriteAccess, ownerLogins: owners, author, approvals }) {
  if (hasWriteAccess) {
    return { required: false, satisfied: true, eligible: [] };
  }
  const eligible = owners.filter((login) => login !== author);
  return { required: true, satisfied: satisfiedBy(eligible, approvals).length > 0, eligible };
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

/**
 * Decides the whole pull request. Pure by design: every question the gate
 * answers ("would this pull request merge today?") is answerable from a file
 * list, a rule set and an approval set, with no network.
 */
export function decidePullRequest({ files, matcher, modeConfig, author, hasWriteAccess, approvals, owners }) {
  const normalizedAuthor = normalize(author);
  const approvalSet = new Set([...approvals].map(normalize));

  const decisions = files.map((path) => {
    // Authority comes from the rule that NAMES the path, not from one that
    // merely reaches it: otherwise a contributor choosing a directory name
    // (`packages/notes.md/`) decides which rule owns the code inside it.
    const rule = matcher.matchNaming(path);
    const named = rule !== null && rule === matcher.match(path);
    const mode = rule === null ? undefined : modeForPattern(modeConfig, rule.pattern);
    return decideFile({
      path,
      rule,
      mode,
      author: normalizedAuthor,
      approvals: approvalSet,
      namesPath: named,
    });
  });

  const blocking = decisions.filter((decision) => !decision.satisfied);
  const externalAuthor = decideExternalAuthor({
    hasWriteAccess,
    ownerLogins: owners,
    author: normalizedAuthor,
    approvals: approvalSet,
  });

  const requiredFrom = uniqueSorted([
    ...blocking.flatMap((decision) => decision.eligible),
    ...(externalAuthor.satisfied ? [] : externalAuthor.eligible),
  ]);

  return {
    state: blocking.length === 0 && externalAuthor.satisfied ? STATE_SUCCESS : STATE_FAILURE,
    author: normalizedAuthor,
    hasWriteAccess,
    approvals: [...approvalSet].sort(),
    files: decisions,
    blocking,
    externalAuthor,
    requiredFrom,
  };
}

/** Groups the blocking files by the rule that blocked them, for the summary. */
export function groupBlocking(blocking) {
  const groups = new Map();
  for (const decision of blocking) {
    const key = `${decision.pattern} ${decision.reason}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        pattern: decision.pattern,
        mode: decision.mode,
        reason: decision.reason,
        eligible: decision.eligible,
        paths: [decision.path],
      });
      continue;
    }
    group.paths.push(decision.path);
  }
  return [...groups.values()];
}
