export type AgentIntegrationPreview = {
  readonly name: string;
  readonly identity: string;
  readonly purpose: string;
  readonly scope: string;
  readonly connection: "Connected" | "Needs attention";
  readonly availability: "Available" | "Unavailable";
};

export const agentIntegrationPreviews: readonly AgentIntegrationPreview[] = [
  {
    name: "GitHub",
    identity: "opentag-preview",
    purpose: "Read repository context and work with pull requests.",
    scope: "opentag/preview-repository · read and pull requests",
    connection: "Connected",
    availability: "Available",
  },
  {
    name: "Linear",
    identity: "OpenTag preview",
    purpose: "Read issue context while planning and reviewing work.",
    scope: "Shared catalog · read only",
    connection: "Needs attention",
    availability: "Unavailable",
  },
];

export type AgentSkillPreview = {
  readonly name: string;
  readonly description: string;
  readonly source: "OpenTag" | "Shared";
  readonly assignment: "Assigned" | "Assignment unavailable";
};

export const agentSkillPreviews: readonly AgentSkillPreview[] = [
  {
    name: "Release notes writer",
    description: "Turns merged changes into concise release notes for teammates and customers.",
    source: "Shared",
    assignment: "Assigned",
  },
  {
    name: "Browser validation",
    description: "Checks key product flows and reports reproducible regressions.",
    source: "OpenTag",
    assignment: "Assigned",
  },
  {
    name: "Issue triage",
    description: "Classifies incoming issues and recommends a priority.",
    source: "Shared",
    assignment: "Assignment unavailable",
  },
];
