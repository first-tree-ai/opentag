export type SkillPreview = {
  name: string;
  source: "OpenTag" | "Workspace";
  agentCount: number;
  status: "Demo";
  description: string;
};

export const skillPreviews: readonly SkillPreview[] = [
  {
    name: "Release notes writer",
    source: "Workspace",
    agentCount: 3,
    status: "Demo",
    description: "Turns merged changes into clear release notes",
  },
  {
    name: "Browser validation",
    source: "OpenTag",
    agentCount: 2,
    status: "Demo",
    description: "Checks key product flows and reports regressions",
  },
  {
    name: "Issue triage",
    source: "Workspace",
    agentCount: 5,
    status: "Demo",
    description: "Classifies incoming issues and recommends priority",
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
