import { SKILL_ERROR_CODES, type Skill } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { SkillsPage } from "./skills-page.js";

/**
 * W1 (P1): Agent-scoped transient state must not survive an Agent change.
 *
 * The reviewer reproduced this through the real router with mocked API calls: visit B's Skills,
 * navigate to A, upload into a name conflict, press the browser's Back to B, and click the still-open
 * confirmation — which sent `A/replace=false` then `B/replace=true`, overwriting a different Agent's
 * Skill. These tests mount the same route shape the application does (`/agents/$agentId/skills` reads
 * the param and hands it to `SkillsPage`), navigate with real history, and mock only the API.
 */

const AGENT_A = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const AGENT_B = "2b74b32f-a7d8-4585-92fb-5ecbf1677b35";
const SKILL_A = "9d4e1378-8ff2-4e41-a6dd-e8bf59ed775b";

function skill(agentId: string, overrides: Partial<Skill> = {}): Skill {
  return {
    id: SKILL_A,
    agentId,
    name: "Release notes writer",
    description: "Turns merged changes into clear release notes",
    enabled: true,
    source: "web_upload",
    archiveSha256: "a".repeat(64),
    archiveBytes: 2048,
    fileCount: 3,
    revision: 1,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

interface UploadCall {
  agentId: string;
  replace: boolean;
}

function stubApi(skillsByAgent: Record<string, Skill[]> = {}) {
  const calls: UploadCall[] = [];
  vi.spyOn(browserApi, "agentSkills").mockImplementation(async (agentId) => ({
    skills: skillsByAgent[agentId] ?? [],
    storage: "available",
  }));
  vi.spyOn(browserApi, "uploadAgentSkill").mockImplementation((async (agentId: string, input: { replace: boolean }) => {
    calls.push({ agentId, replace: input.replace });
    if (!input.replace) throw new ApiError(409, "conflict", SKILL_ERROR_CODES.NAME_CONFLICT);
    return {};
  }) as never);
  vi.spyOn(browserApi, "updateAgentSkill").mockResolvedValue({} as never);
  vi.spyOn(browserApi, "removeAgentSkill").mockResolvedValue(undefined);
  return { calls };
}

async function renderSkillsRoute(path: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const skillsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agents/$agentId/skills",
    component: () => {
      const { agentId } = skillsRoute.useParams();
      return <SkillsPage agentId={agentId} />;
    },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: rootRoute.addChildren([skillsRoute]),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );
  });
  return router;
}

async function navigateTo(router: Awaited<ReturnType<typeof renderSkillsRoute>>, agentId: string): Promise<void> {
  await act(async () => {
    await router.navigate({ to: "/agents/$agentId/skills" as never, params: { agentId } as never });
  });
  await act(async () => undefined);
}

async function goBack(router: Awaited<ReturnType<typeof renderSkillsRoute>>): Promise<void> {
  await act(async () => {
    router.history.back();
  });
  await act(async () => undefined);
}

async function flush(): Promise<void> {
  await act(async () => undefined);
}

function uploadInput(): HTMLInputElement {
  const input = document.querySelector('[data-ui="skill-upload-input"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("The upload input is not rendered");
  return input;
}

function archiveFile(name: string, contents: string): File {
  return new File([contents], name, { type: "application/octet-stream" });
}

async function chooseFile(file: File): Promise<void> {
  await act(async () => {
    fireEvent.change(uploadInput(), { target: { files: [file] } });
  });
  await flush();
}

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

afterEach(() => vi.restoreAllMocks());

describe("SkillsPage Agent changes", () => {
  it("drops a pending replacement when the Agent changes and browser Back returns", async () => {
    const { calls } = stubApi();
    const router = await renderSkillsRoute(`/agents/${AGENT_B}/skills`);
    await screen.findByText(/No Skills yet/);

    await navigateTo(router, AGENT_A);
    await waitFor(() => expect(browserApi.agentSkills).toHaveBeenCalledWith(AGENT_A));

    await chooseFile(archiveFile("notes.zip", "hello"));
    expect(await screen.findByText("Replace the existing Skill with notes.zip?")).toBeTruthy();
    expect(calls).toEqual([{ agentId: AGENT_A, replace: false }]);

    await goBack(router);
    await waitFor(() => expect(screen.getByText(/No Skills yet/)).toBeTruthy());
    await flush();

    expect(screen.queryByText(/Replace the existing Skill/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Replace Skill" })).toBeNull();
    expect(calls.some((call) => call.agentId === AGENT_B)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("issues no request when an archive's hash resolves after the Agent changed", async () => {
    const { calls } = stubApi();
    const router = await renderSkillsRoute(`/agents/${AGENT_A}/skills`);
    await screen.findByText(/No Skills yet/);

    const file = archiveFile("notes.zip", "hello");
    const hashGate = deferred<ArrayBuffer>();
    Object.defineProperty(file, "arrayBuffer", { value: () => hashGate.promise });
    await chooseFile(file);

    await navigateTo(router, AGENT_B);
    await flush();
    await act(async () => {
      hashGate.resolve(new TextEncoder().encode("hello").buffer);
    });
    await flush();

    expect(calls).toHaveLength(0);
    expect(browserApi.uploadAgentSkill).not.toHaveBeenCalled();
  });

  it("does not open the replace dialog when a conflict arrives after the Agent changed", async () => {
    const { calls } = stubApi();
    const router = await renderSkillsRoute(`/agents/${AGENT_A}/skills`);
    await screen.findByText(/No Skills yet/);

    const uploadGate = deferred<Skill>();
    vi.mocked(browserApi.uploadAgentSkill).mockImplementationOnce((async (
      agentId: string,
      input: { replace: boolean },
    ) => {
      calls.push({ agentId, replace: input.replace });
      return uploadGate.promise;
    }) as never);
    await chooseFile(archiveFile("notes.zip", "hello"));
    await waitFor(() => expect(calls).toHaveLength(1));

    await navigateTo(router, AGENT_B);
    await flush();
    await act(async () => {
      uploadGate.reject(new ApiError(409, "conflict", SKILL_ERROR_CODES.NAME_CONFLICT));
    });
    await flush();

    expect(screen.queryByText(/Replace the existing Skill/)).toBeNull();
  });

  it("closes the delete dialog when the Agent changes, confirming nothing", async () => {
    stubApi({ [AGENT_A]: [skill(AGENT_A)] });
    const router = await renderSkillsRoute(`/agents/${AGENT_A}/skills`);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Delete Release notes writer?")).toBeTruthy();

    await navigateTo(router, AGENT_B);
    await flush();

    expect(screen.queryByText("Delete Release notes writer?")).toBeNull();
    expect(browserApi.removeAgentSkill).not.toHaveBeenCalled();
  });
});
