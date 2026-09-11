export type AgentIntegrationPreview = {
  readonly name: string;
  readonly identity: string;
  readonly purpose: string;
  readonly scope: string;
  readonly connection: "Connected" | "Connection error";
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
    connection: "Connection error",
    availability: "Unavailable",
  },
];
