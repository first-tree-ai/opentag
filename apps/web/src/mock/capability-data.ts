export type SkillPreview = {
  name: string;
  source: "OpenTag" | "Shared";
  agentCount: number;
  status: "Demo";
  description: string;
  instructions: string;
};

export const skillPreviews: readonly SkillPreview[] = [
  {
    name: "Release notes writer",
    source: "Shared",
    agentCount: 3,
    status: "Demo",
    description: "Turns merged changes into clear release notes",
    instructions: "Review merged changes, group them by user impact, and write a concise summary for each group.",
  },
  {
    name: "Browser validation",
    source: "OpenTag",
    agentCount: 2,
    status: "Demo",
    description: "Checks key product flows and reports regressions",
    instructions:
      "Open each defined product flow, verify the expected outcome, and report any reproducible regression.",
  },
  {
    name: "Issue triage",
    source: "Shared",
    agentCount: 5,
    status: "Demo",
    description: "Classifies incoming issues and recommends priority",
    instructions:
      "Read the issue, identify the affected area and urgency, then recommend a priority with a short rationale.",
  },
];

export type IntegrationCategory = "Developer tools" | "Knowledge" | "Productivity";

export type IntegrationPreview = {
  id: string;
  name: string;
  abbreviation: string;
  category: IntegrationCategory;
  description: string;
};

export const integrationPreviews: readonly IntegrationPreview[] = [
  {
    id: "github",
    name: "GitHub",
    abbreviation: "GH",
    category: "Developer tools",
    description: "Read repositories, issues, pull requests, and checks.",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    abbreviation: "GD",
    category: "Knowledge",
    description: "Find and reference shared documents and folders.",
  },
  {
    id: "linear",
    name: "Linear",
    abbreviation: "LI",
    category: "Productivity",
    description: "Search issues, update status, and create project work.",
  },
  {
    id: "notion",
    name: "Notion",
    abbreviation: "NO",
    category: "Knowledge",
    description: "Use selected pages and databases as Agent context.",
  },
  {
    id: "sentry",
    name: "Sentry",
    abbreviation: "SE",
    category: "Developer tools",
    description: "Inspect errors, releases, and application health signals.",
  },
  {
    id: "figma",
    name: "Figma",
    abbreviation: "FI",
    category: "Productivity",
    description: "Reference files, components, and design comments.",
  },
];
