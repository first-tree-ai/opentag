/**
 * A from-scratch CODEOWNERS parser and matcher.
 *
 * The semantics here are GitHub's, not gitignore's, and the two differ in ways
 * that silently mis-route review when conflated: square brackets are literal
 * characters rather than a character class, negation is unsupported, and a rule
 * with no owners is legal and means "unowned" rather than "skip this line".
 * The matching algorithm is modelled on hmarr/codeowners, which is validated
 * against live GitHub, so any behaviour that looks surprising below is
 * deliberate and pinned by a test.
 */

const GLOBSTAR = "**";

/** Characters that must be escaped to appear literally in a RegExp source. */
const REGEXP_METACHARACTERS = new Set([".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

const WHITESPACE = /\s/;

/** `@login`. GitHub logins are alphanumeric with interior hyphens. */
const USER_TOKEN = /^@[A-Za-z\d][A-Za-z\d-]*$/;
/** `@org/team`. */
const TEAM_TOKEN = /^@[A-Za-z\d][A-Za-z\d-]*\/[A-Za-z\d][A-Za-z\d._-]*$/;
/** A bare email address, the third and last owner form GitHub accepts. */
const EMAIL_TOKEN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function escapeRegExpChar(char) {
  return REGEXP_METACHARACTERS.has(char) ? `\\${char}` : char;
}

function wildcardSource(char) {
  if (char === "*") {
    return "[^/]*";
  }
  if (char === "?") {
    return "[^/]";
  }
  return null;
}

/**
 * Compiles one path segment. Unlike gitignore, `[` and `]` fall through to the
 * literal branch: `/apps/[param]/file.ts` names a directory literally called
 * `[param]`, which is exactly how TanStack route directories are spelled.
 */
function literalSegmentSource(segment) {
  let source = "";
  let escaped = false;
  for (const char of segment) {
    if (escaped) {
      escaped = false;
      source += escapeRegExpChar(char);
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    source += wildcardSource(char) ?? escapeRegExpChar(char);
  }
  return source;
}

/**
 * A globstar means something different in each position, and the asymmetry
 * between the trailing and middle forms is the one that bites: a trailing
 * globstar makes the separator mandatory, so `foo/bar` plus a trailing globstar
 * does not match `foo/bar` itself, whereas a middle globstar matches zero
 * segments and so `foo`, globstar, `bar` does match `foo/bar`.
 */
function globstarSource(index, lastIndex) {
  if (index === 0 && index === lastIndex) {
    return ".+";
  }
  if (index === 0) {
    return "(?:.+/)?";
  }
  if (index === lastIndex) {
    return "/.*";
  }
  return "(?:/.+)?";
}

/**
 * A trailing literal also matches its descendants, which is the whole reason
 * `/docs` is recursive while `/docs/*` is one level deep. A lone `*` is not a
 * literal and so does not get the suffix.
 */
function plainSegmentSource(segment, isLast) {
  if (segment === "*") {
    return "[^/]+";
  }
  const source = literalSegmentSource(segment);
  return isLast ? `${source}(?:/.*)?` : source;
}

function buildPatternSource(segments) {
  const lastIndex = segments.length - 1;
  let source = "";
  let needSlash = false;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === GLOBSTAR) {
      source += globstarSource(index, lastIndex);
      // Only a middle globstar leaves the separator to the following segment;
      // the leading form consumes it and the trailing form emits its own.
      needSlash = index !== 0 && index !== lastIndex;
      continue;
    }
    source += (needSlash ? "/" : "") + plainSegmentSource(segment, index === lastIndex);
    needSlash = true;
  }
  return source;
}

/** True for `foo` and `foo/`, the shapes that match at any depth. */
function isDepthAgnostic(segments) {
  const singleSegment = segments.length === 1 || (segments.length === 2 && segments[1] === "");
  return singleSegment && segments[0] !== GLOBSTAR;
}

function normalizeSegments(pattern) {
  const segments = pattern.split("/");
  if (segments[0] === "") {
    // A leading slash anchors the pattern to the repository root.
    segments.shift();
  } else if (isDepthAgnostic(segments)) {
    segments.unshift(GLOBSTAR);
  }
  if (segments.length > 1 && segments[segments.length - 1] === "") {
    // A trailing slash means "everything beneath", never the directory entry itself.
    segments[segments.length - 1] = GLOBSTAR;
  }
  return segments;
}

/**
 * Compiles a CODEOWNERS pattern into an anchored RegExp.
 *
 * The result carries no `i` flag on purpose: CODEOWNERS matching is case
 * sensitive unconditionally, so `/README.md` does not own `/readme.md`.
 *
 * @throws {TypeError} when the pattern is not a usable CODEOWNERS pattern.
 */
export function compilePattern(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new TypeError(`Pattern must be a non-empty string, received ${JSON.stringify(pattern)}`);
  }
  if (pattern.includes("***")) {
    throw new TypeError(`Pattern "${pattern}" cannot contain three consecutive asterisks`);
  }
  if (pattern === "/") {
    // GitHub treats a bare slash as matching nothing; repository-relative paths
    // are never empty, so an empty-string-only expression is that "nothing".
    return /^$/;
  }
  return new RegExp(`^${buildPatternSource(normalizeSegments(pattern))}$`);
}

/** True for the three owner spellings GitHub accepts: user, team, email. */
export function isOwnerToken(token) {
  return USER_TOKEN.test(token) || TEAM_TOKEN.test(token) || EMAIL_TOKEN.test(token);
}

/**
 * Normalizes an owner token for comparison against a GitHub login, lowercased
 * because logins are case insensitive. Teams and email addresses are not
 * logins and deliberately return null rather than a lookalike string, so a
 * caller cannot accidentally compare `@org/team` against a reviewer login.
 */
export function ownerLogin(token) {
  if (typeof token !== "string" || !USER_TOKEN.test(token)) {
    return null;
  }
  return token.slice(1).toLowerCase();
}

/** Every owner token anywhere in the rule list, de-duplicated, in file order. */
export function collectOwners(rules) {
  const seen = new Set();
  const owners = [];
  for (const rule of rules) {
    for (const owner of rule.owners) {
      if (seen.has(owner)) {
        continue;
      }
      seen.add(owner);
      owners.push(owner);
    }
  }
  return owners;
}

/**
 * Drops an inline comment. A backslash escapes the next character, so `\#` is
 * a literal hash inside a pattern rather than the start of a comment.
 */
function stripInlineComment(text) {
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "#") {
      return text.slice(0, index);
    }
  }
  return text;
}

/**
 * Splits a line into fields on unescaped whitespace, keeping the backslashes so
 * the pattern compiler still sees its own escapes. `docs/my\ file.md` is one
 * field, not two.
 */
function splitFields(text) {
  const fields = [];
  let current = "";
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      escaped = false;
      current += char;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      current += char;
      continue;
    }
    if (!WHITESPACE.test(char)) {
      current += char;
      continue;
    }
    if (current !== "") {
      fields.push(current);
    }
    current = "";
  }
  if (current !== "") {
    fields.push(current);
  }
  return fields;
}

function lineFields(text) {
  // A leading hash is a comment with no escape hatch, unlike gitignore.
  if (text.trimStart().startsWith("#")) {
    return [];
  }
  return splitFields(stripInlineComment(text));
}

function patternProblem(pattern) {
  try {
    compilePattern(pattern);
    return null;
  } catch (error) {
    return error.message;
  }
}

function readLine(text, line, rules, problems) {
  const fields = lineFields(text);
  if (fields.length === 0) {
    return;
  }
  const [pattern, ...owners] = fields;
  const invalidPattern = patternProblem(pattern);
  if (invalidPattern !== null) {
    problems.push({ line, text, message: invalidPattern });
    return;
  }
  for (const owner of owners) {
    if (!isOwnerToken(owner)) {
      problems.push({ line, text, message: `Owner token "${owner}" is not a user, team or email address` });
    }
  }
  // A bad owner token is reported but does not remove the rule: the rule still
  // matches, and a rule that matches with no owners means "unowned" rather than
  // "fall through to the previous rule".
  rules.push({ pattern, owners, ownerless: owners.length === 0, line });
}

/**
 * Parses a CODEOWNERS file. Never throws: everything questionable is reported
 * in `problems` so a caller can decide whether to fail the build, and only a
 * pattern that cannot be compiled keeps its line out of `rules`.
 */
export function parseCodeowners(text) {
  const rules = [];
  const problems = [];
  const lines = String(text ?? "").split(/\r?\n/);
  lines.forEach((line, index) => {
    readLine(line, index + 1, rules, problems);
  });
  return { rules, problems };
}

function normalizePath(path) {
  return String(path).replace(/^\.\//, "").replace(/^\//, "");
}

/**
 * Precompiles a rule list once so a whole changed-file set can be matched
 * without recompiling every pattern per file.
 *
 * @throws {TypeError} when a rule carries a pattern that cannot be compiled.
 */
export function createMatcher(rules) {
  const compiled = rules.map((rule) => ({ rule, regexp: compilePattern(rule.pattern) }));
  return {
    /** The last matching rule, or null. Owner sets are never unioned across rules. */
    match(path) {
      const candidate = normalizePath(path);
      for (let index = compiled.length - 1; index >= 0; index -= 1) {
        if (compiled[index].regexp.test(candidate)) {
          return compiled[index].rule;
        }
      }
      return null;
    },
  };
}

/** Convenience wrapper over {@link createMatcher} for a single path. */
export function matchRule(rules, path) {
  return createMatcher(rules).match(path);
}
