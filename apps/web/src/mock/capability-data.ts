export type SkillPreview = {
  name: string;
  source: "OpenTag" | "Workspace";
  agentCount: number;
  status: "Demo";
  description: string;
  instructions: string;
};

export const skillPreviews: readonly SkillPreview[] = [
  {
    name: "Release notes writer",
    source: "Workspace",
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
    source: "Workspace",
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
    description: "Find and reference workspace documents and folders.",
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

export const usageRanges = ["7 days", "30 days", "90 days"] as const;

export type UsageRange = (typeof usageRanges)[number];

export type UsageSnapshot = {
  metrics: {
    tasks: number;
    turns: number;
    activeAgents: number;
    providers: number;
  };
  trend: readonly number[];
  providers: readonly {
    name: string;
    turns: number;
    share: number;
  }[];
};

export const usageSnapshots: Record<UsageRange, UsageSnapshot> = {
  "7 days": {
    metrics: { tasks: 38, turns: 184, activeAgents: 6, providers: 3 },
    trend: [18, 27, 21, 34, 29, 31, 24],
    providers: [
      { name: "OpenAI", turns: 112, share: 61 },
      { name: "Anthropic", turns: 52, share: 28 },
      { name: "Local", turns: 20, share: 11 },
    ],
  },
  "30 days": {
    metrics: { tasks: 146, turns: 728, activeAgents: 9, providers: 3 },
    trend: [92, 118, 104, 133, 126, 155],
    providers: [
      { name: "OpenAI", turns: 451, share: 62 },
      { name: "Anthropic", turns: 204, share: 28 },
      { name: "Local", turns: 73, share: 10 },
    ],
  },
  "90 days": {
    metrics: { tasks: 411, turns: 2096, activeAgents: 12, providers: 3 },
    trend: [224, 286, 312, 295, 354, 387, 412],
    providers: [
      { name: "OpenAI", turns: 1314, share: 63 },
      { name: "Anthropic", turns: 572, share: 27 },
      { name: "Local", turns: 210, share: 10 },
    ],
  },
};
