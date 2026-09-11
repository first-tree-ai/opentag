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
