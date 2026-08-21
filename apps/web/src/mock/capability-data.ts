export const resourceTypes = ["Repositories", "Skills", "Tools", "Prompts"] as const;

export type ResourceType = (typeof resourceTypes)[number];
export type ResourceFilter = "All" | ResourceType;

export type ResourcePreview = {
  name: string;
  type: ResourceType;
  agentCount: number;
  description: string;
};

export const resourcePreviews: readonly ResourcePreview[] = [
  {
    name: "OpenTag workspace",
    type: "Repositories",
    agentCount: 4,
    description: "Product and runtime source",
  },
  {
    name: "Support playbook",
    type: "Repositories",
    agentCount: 2,
    description: "Response guidelines and examples",
  },
  {
    name: "Release notes writer",
    type: "Skills",
    agentCount: 3,
    description: "Turns merged changes into clear release notes",
  },
  {
    name: "Browser runner",
    type: "Tools",
    agentCount: 2,
    description: "Checks product flows in a browser",
  },
  {
    name: "Issue triage",
    type: "Prompts",
    agentCount: 5,
    description: "Shared intake and prioritization guidance",
  },
];

export type IntegrationPreview = {
  name: string;
  category: string;
  status: "Connected" | "Available";
  agentCount: number;
  mark: string;
};

export const integrationPreviews: readonly IntegrationPreview[] = [
  { name: "GitHub", category: "Source control", status: "Connected", agentCount: 4, mark: "GH" },
  { name: "Slack", category: "Messaging", status: "Connected", agentCount: 2, mark: "SL" },
  { name: "Linear", category: "Issue tracking", status: "Available", agentCount: 0, mark: "LI" },
  { name: "Notion", category: "Knowledge", status: "Available", agentCount: 0, mark: "NO" },
  { name: "Google Drive", category: "Files", status: "Available", agentCount: 0, mark: "GD" },
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
