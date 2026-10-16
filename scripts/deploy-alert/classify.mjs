import { ENVIRONMENTS, resolvePhase } from "./profiles.mjs";

/** Run conclusions that mean the deployment did not happen. `cancelled` is a deliberate stop. */
export const ALERT_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

// A job that hits `timeout-minutes` reports `cancelled` while the run reports `failure`.
const FAILED_UNIT_CONCLUSIONS = ["failure", "timed_out", "cancelled"];
const COMMIT_TITLE_LIMIT = 120;

/**
 * Decides whether a completed run deserves an alert. Pull request runs never deploy, and a run
 * from another repository must never reach the webhook.
 */
export function shouldAlert(run, repository) {
  if (!ALERT_CONCLUSIONS.has(run.conclusion)) {
    return { alert: false, reason: `conclusion is ${run.conclusion ?? "unknown"}` };
  }
  if (run.event === "pull_request") {
    return { alert: false, reason: "pull request runs do not deploy" };
  }
  if (run.head_repository?.full_name !== repository) {
    return { alert: false, reason: "run belongs to another repository" };
  }
  return { alert: true, reason: null };
}

function firstFailed(units) {
  for (const conclusion of FAILED_UNIT_CONCLUSIONS) {
    const unit = units.find((candidate) => candidate.conclusion === conclusion);
    if (unit) return unit;
  }
  return null;
}

/** Finds the first failed job and, inside it, the first failed step. Either may be absent. */
export function findFailure(jobs) {
  const job = firstFailed(jobs ?? []);
  const step = job ? firstFailed(job.steps ?? []) : null;
  return { job, step };
}

function commitTitle(run) {
  const message = run.head_commit?.message ?? run.display_title ?? "";
  const title = message.split("\n")[0].trim();
  return title.length > COMMIT_TITLE_LIMIT ? `${title.slice(0, COMMIT_TITLE_LIMIT - 1)}…` : title;
}

/** Turns a run, its jobs and its workflow profile into the facts one alert reports. */
export function buildAlert({ run, jobs, profile, rehearsal = false }) {
  const { job, step } = findFailure(jobs);
  const environmentKey = profile.resolveEnvironment({ run, job }) ?? "unknown";
  return {
    rehearsal,
    workflow: profile.name,
    environment: { key: environmentKey, ...(ENVIRONMENTS[environmentKey] ?? ENVIRONMENTS.unknown) },
    phase: resolvePhase(profile, step?.name),
    conclusion: run.conclusion ?? "unknown",
    jobName: job?.name ?? null,
    stepName: step?.name ?? null,
    jobUrl: job?.html_url ?? null,
    runUrl: run.html_url,
    attempt: run.run_attempt ?? 1,
    event: run.event,
    ref: run.head_branch ?? null,
    sha: run.head_sha,
    commitTitle: commitTitle(run),
    actor: run.triggering_actor?.login ?? run.actor?.login ?? null,
    notes: profile.notes({ run, job }),
    rootCause: null,
  };
}
