#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectOwners,
  compilePattern,
  createMatcher,
  ownerLogin,
  parseCodeowners,
} from "./ownership-gate/codeowners.mjs";
import { MODE_EXEMPT, ModeConfigError, modeForPattern, parseModeConfig } from "./ownership-gate/modes.mjs";

export const CODEOWNERS_PATH = ".github/CODEOWNERS";
export const MODES_PATH = ".github/ownership-modes.json";

/**
 * Offline validation of the ownership policy, wired into `pnpm check` so the two
 * halves of the policy can never land out of step.
 *
 * Mode lives outside CODEOWNERS, keyed by rule pattern, so the two files can
 * drift apart and the failure is quiet and in the wrong direction. This closes
 * both directions: a rule with no mode entry is rejected here (while the gate
 * itself still falls back to `gate` at runtime, so an unreviewed edit fails
 * safe), and a mode entry whose pattern no longer exists is rejected too --
 * that reverse drift is how an exemption list quietly grows back.
 *
 * It also enforces the pins, whose protection is order-dependent: a pin only
 * holds while no later rule wins for the paths beneath it.
 */

function listTrackedFiles(root) {
  const output = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return output.split("\0").filter((path) => path.length > 0);
}

function checkOwnerTokens(rules, failures) {
  for (const rule of rules) {
    for (const token of rule.owners) {
      if (ownerLogin(token) === null) {
        failures.push(
          `${CODEOWNERS_PATH}:${rule.line}: owner ${token} is a team or email owner; the ownership gate reads submitted reviews and cannot resolve one to a reviewer`,
        );
      }
    }
  }
}

function checkDuplicatePatterns(rules, failures) {
  const seen = new Map();
  for (const rule of rules) {
    const first = seen.get(rule.pattern);
    if (first !== undefined) {
      failures.push(
        `${CODEOWNERS_PATH}:${rule.line}: pattern ${rule.pattern} is already declared on line ${first}; only the last one takes effect and the mode table cannot tell them apart`,
      );
      continue;
    }
    seen.set(rule.pattern, rule.line);
  }
}

function checkModeCoverage(rules, config, failures) {
  const declared = new Set(config.byPattern.keys());
  for (const rule of rules) {
    if (!declared.has(rule.pattern)) {
      failures.push(
        `${MODES_PATH}: no mode declared for ${CODEOWNERS_PATH} pattern ${rule.pattern} (line ${rule.line}); it would fall back to gate at runtime, but the mode must be stated`,
      );
    }
  }
  const patterns = new Set(rules.map((rule) => rule.pattern));
  for (const pattern of declared) {
    if (!patterns.has(pattern)) {
      failures.push(
        `${MODES_PATH}: mode declared for pattern ${pattern}, which no longer exists in ${CODEOWNERS_PATH}`,
      );
    }
  }
}

function checkExemptConsistency(rules, config, failures) {
  for (const rule of rules) {
    const mode = modeForPattern(config, rule.pattern);
    if (rule.ownerless && mode !== MODE_EXEMPT) {
      failures.push(
        `${MODES_PATH}: pattern ${rule.pattern} lists no owners but is declared ${mode}; an ownerless rule always resolves as exempt, so declare it that way`,
      );
    }
    if (!rule.ownerless && mode === MODE_EXEMPT) {
      failures.push(
        `${MODES_PATH}: pattern ${rule.pattern} is declared exempt but names owners; exempt is expressed by omitting the owners in ${CODEOWNERS_PATH}`,
      );
    }
  }
}

function checkPins(config, matcher, files, failures) {
  for (const pin of config.pins) {
    const pattern = compilePattern(pin.pattern);
    const pinned = files.filter((path) => pattern.test(path));
    if (pinned.length === 0) {
      failures.push(`${MODES_PATH}: pin ${pin.pattern} matches no tracked file, so it protects nothing`);
      continue;
    }
    const overridden = pinned.filter((path) => matcher.match(path)?.pattern !== pin.pattern);
    if (overridden.length > 0) {
      failures.push(
        `${CODEOWNERS_PATH}: a later rule wins over the pin ${pin.pattern} for ${overridden.length} file(s), for example ${overridden[0]} -> ${matcher.match(overridden[0])?.pattern}; move the pin below the rule that overrides it`,
      );
    }
  }
}

function resolutionCounts(rules, matcher, files) {
  const counts = new Map(rules.map((rule) => [rule.pattern, 0]));
  let unmatched = 0;
  for (const path of files) {
    const rule = matcher.match(path);
    if (rule === null) {
      unmatched += 1;
      continue;
    }
    counts.set(rule.pattern, (counts.get(rule.pattern) ?? 0) + 1);
  }
  return { counts, unmatched };
}

function checkCoverage(unmatched, failures) {
  if (unmatched > 0) {
    failures.push(
      `${CODEOWNERS_PATH}: ${unmatched} tracked file(s) match no rule at all; the fail-safe default depends on every path matching something`,
    );
  }
}

/** Runs every validation and returns a report; never throws for policy problems. */
export function checkOwnershipPolicy({ repositoryRoot = process.cwd(), files } = {}) {
  const root = resolve(repositoryRoot);
  const failures = [];
  const codeownersText = readFileSync(join(root, CODEOWNERS_PATH), "utf8");
  const { rules, problems } = parseCodeowners(codeownersText);
  for (const problem of problems) {
    failures.push(`${CODEOWNERS_PATH}:${problem.line}: ${problem.message}`);
  }

  let config;
  try {
    config = parseModeConfig(JSON.parse(readFileSync(join(root, MODES_PATH), "utf8")));
  } catch (error) {
    const detail = error instanceof ModeConfigError ? error.message : String(error?.message ?? error);
    return { failures: [...failures, `${MODES_PATH}: ${detail}`], counts: new Map(), owners: [] };
  }

  checkDuplicatePatterns(rules, failures);
  checkOwnerTokens(rules, failures);
  checkModeCoverage(rules, config, failures);
  checkExemptConsistency(rules, config, failures);

  const matcher = createMatcher(rules);
  const tracked = files ?? listTrackedFiles(root);
  checkPins(config, matcher, tracked, failures);
  const { counts, unmatched } = resolutionCounts(rules, matcher, tracked);
  checkCoverage(unmatched, failures);

  return { failures, counts, owners: collectOwners(rules), rules, config, files: tracked.length };
}

function renderReport(result) {
  const lines = [`Ownership policy check: ${result.files} tracked file(s), ${result.rules.length} rule(s).`];
  for (const rule of result.rules) {
    const mode = modeForPattern(result.config, rule.pattern);
    lines.push(`  ${String(result.counts.get(rule.pattern) ?? 0).padStart(5)}  ${mode.padEnd(9)}  ${rule.pattern}`);
  }
  return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)) {
  const rootIndex = argv.indexOf("--root");
  const repositoryRoot = rootIndex === -1 ? process.cwd() : argv[rootIndex + 1];
  const result = checkOwnershipPolicy({ repositoryRoot });
  if (result.failures.length > 0) {
    process.stderr.write("Ownership policy check failed:\n");
    for (const failure of result.failures) {
      process.stderr.write(`- ${failure}\n`);
    }
    return 1;
  }
  process.stdout.write(renderReport(result));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
