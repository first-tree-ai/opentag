/**
 * The deployment workflows this alert watches, keyed by workflow file path.
 *
 * `workflow_run` matches workflows by their `name:`, so the alert workflow lists those names and
 * this table keeps the per-workflow knowledge: which environment a run targets and which deploy
 * phase a failed step belongs to. Step names are copied verbatim from the workflow files; the
 * workflow test fails when one of them drifts.
 */

export const ENVIRONMENTS = {
  production: { label: "生产", template: "red" },
  staging: { label: "预发", template: "orange" },
  unknown: { label: "未知环境", template: "grey" },
};

/** Docker builds the Server image that Deploy Staging waits for; its failures surface there. */
export const DOCKER_WORKFLOW_PATH = ".github/workflows/docker.yml";

function npmPublishEnvironment({ run, job }) {
  if (job?.name === "Publish CLI Production") return "production";
  if (job?.name === "Publish CLI Staging") return "staging";
  // Without a job (startup failure), the trigger still decides: only release tags publish production.
  return run.event === "push" ? "production" : "staging";
}

// Deploy Runner sets `run-name: Deploy Runner · <channel> · <version> · <mode>`.
const DEPLOY_RUNNER_TITLE = /·\s*(staging|prod)\s*·.*·\s*(check|apply)\s*$/;

function deployRunnerEnvironment({ run }) {
  const match = DEPLOY_RUNNER_TITLE.exec(run.display_title ?? "");
  if (!match) return "unknown";
  return match[1] === "prod" ? "production" : "staging";
}

function deployRunnerNotes({ run }) {
  const match = DEPLOY_RUNNER_TITLE.exec(run.display_title ?? "");
  return match?.[2] === "check" ? ["检查模式（mode=check）：线上未发生变更。"] : [];
}

export const DEPLOY_WORKFLOWS = [
  {
    path: ".github/workflows/publish-npm-package.yml",
    name: "npm Publish",
    resolveEnvironment: npmPublishEnvironment,
    notes: () => [],
    defaultPhase: "发布前校验",
    phases: [
      { phase: "npm 发布", steps: ["Publish staging package", "Publish production package"] },
      { phase: "Runner 镜像发布", steps: ["Publish and verify the CLI-matched Runner"] },
      {
        phase: "Portable 包发布",
        steps: [
          "Preflight portable staging release",
          "Preflight portable production release",
          "Publish portable staging release",
          "Publish portable production release",
        ],
      },
      { phase: "发布记录", steps: ["Record the completed Runner release"] },
    ],
  },
  {
    path: ".github/workflows/deploy-staging.yml",
    name: "Deploy Staging",
    resolveEnvironment: () => "staging",
    notes: () => [],
    defaultPhase: "部署前校验",
    phases: [
      { phase: "CapRover 部署", steps: ["Deploy the commit image to CapRover"] },
      { phase: "Runner 激活", steps: ["Activate the matching Runner for new Instances"] },
      { phase: "等待 Server 镜像", steps: ["Wait for the commit image"], awaitsServerImage: true },
    ],
  },
  {
    path: ".github/workflows/deploy-runner.yml",
    name: "Deploy Runner",
    resolveEnvironment: deployRunnerEnvironment,
    notes: deployRunnerNotes,
    defaultPhase: "部署前校验",
    phases: [{ phase: "Runner 激活", steps: ["Check or activate the Runner target"] }],
  },
];

const PROFILES_BY_PATH = new Map(DEPLOY_WORKFLOWS.map((profile) => [profile.path, profile]));

/** `run.path` may carry a `@ref` suffix; the profile is keyed by the bare file path. */
export function findProfile(runPath) {
  const path = String(runPath ?? "").split("@")[0];
  return PROFILES_BY_PATH.get(path) ?? null;
}

/** Maps a failed step name to its deploy phase; unknown or absent steps fall back to the default. */
export function resolvePhase(profile, stepName) {
  const entry = profile.phases.find((candidate) => candidate.steps.includes(stepName));
  return entry
    ? { name: entry.phase, awaitsServerImage: entry.awaitsServerImage === true }
    : { name: profile.defaultPhase, awaitsServerImage: false };
}
