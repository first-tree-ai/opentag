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
