import type { AgentUsageDetail } from "@opentag/shared/browser";

export type UsageVisualFixture = AgentUsageDetail & {
  name: string;
};

type UsageDay = AgentUsageDetail["daily"][number];

const START = new Date("2026-08-02T12:00:00.000Z");
const DAY_COUNT = 31;

function dateAt(index: number): string {
  return new Date(START.getTime() + index * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

function series(valueAt: (index: number) => Omit<UsageDay, "date" | "tokens">): UsageDay[] {
  return Array.from({ length: DAY_COUNT }, (_, index) => {
    const value = valueAt(index);
    return {
      ...value,
      date: dateAt(index),
      tokens: value.inputTokens + value.outputTokens,
    };
  });
}

function usage(name: string, daily: UsageDay[], failed = 0): UsageVisualFixture {
  return {
    name,
    windowDays: 30,
    startedAt: `${dateAt(0)}T00:00:00.000Z`,
    endedAt: `${dateAt(DAY_COUNT - 1)}T23:59:59.999Z`,
    tasks: daily.reduce((total, point) => total + point.tasks, 0),
    measuredTasks: daily.reduce((total, point) => total + point.measuredTasks, 0),
    failed,
    inputTokens: daily.reduce((total, point) => total + point.inputTokens, 0),
    cachedInputTokens: daily.reduce((total, point) => total + point.cachedInputTokens, 0),
    outputTokens: daily.reduce((total, point) => total + point.outputTokens, 0),
    tokens: daily.reduce((total, point) => total + point.tokens, 0),
    daily,
  };
}

const emptyDay = () => ({
  tasks: 0,
  measuredTasks: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
});

export const usageVisualFixtures = [
  usage("empty", series(emptyDay)),
  usage(
    "unreported-tasks",
    series((index) => ({
      ...emptyDay(),
      ...(index === DAY_COUNT - 1 ? { tasks: 4 } : {}),
    })),
  ),
  usage(
    "single-spike",
    series((index) =>
      index === DAY_COUNT - 1
        ? {
            tasks: 1,
            measuredTasks: 1,
            inputTokens: 166_300,
            cachedInputTokens: 151_900,
            outputTokens: 2_700,
          }
        : emptyDay(),
    ),
  ),
  usage(
    "steady-volume",
    series((index) => {
      const tasks = 1 + (index % 3);
      return {
        tasks,
        measuredTasks: tasks,
        inputTokens: 24_000 + index * 1_750,
        cachedInputTokens: 18_000 + (index % 5) * 3_200,
        outputTokens: 4_800 + (index % 4) * 900,
      };
    }),
    2,
  ),
  usage(
    "partial-coverage",
    series((index) => {
      const hasReport = index % 4 !== 0;
      return {
        tasks: 2,
        measuredTasks: hasReport ? 2 : 0,
        inputTokens: hasReport ? 31_000 + index * 600 : 0,
        cachedInputTokens: hasReport ? 22_000 : 0,
        outputTokens: hasReport ? 5_500 : 0,
      };
    }),
    3,
  ),
  usage(
    "cached-heavy",
    series((index) =>
      index === 20
        ? {
            tasks: 3,
            measuredTasks: 3,
            inputTokens: 12_000,
            cachedInputTokens: 900_000,
            outputTokens: 3_000,
          }
        : emptyDay(),
    ),
  ),
] as const;

export const usageVisualScreenshotEntries = [
  ...usageVisualFixtures.map((fixture) => ({
    file: `usage-${fixture.name}-desktop`,
    route: `/usage visual fixture: ${fixture.name} (1440px)`,
    heading: "Usage",
  })),
  { file: "usage-empty-mobile", route: "/usage visual fixture: empty (390px)", heading: "Usage" },
  { file: "usage-single-spike-mobile", route: "/usage visual fixture: single-spike (390px)", heading: "Usage" },
  {
    file: "usage-single-spike-mobile-breakdown",
    route: "/usage visual fixture: single-spike breakdown (390px)",
    heading: "Token breakdown",
  },
  { file: "usage-single-spike-narrow", route: "/usage visual fixture: single-spike (320px)", heading: "Usage" },
  { file: "usage-steady-volume-tablet", route: "/usage visual fixture: steady-volume (768px)", heading: "Usage" },
] as const;
