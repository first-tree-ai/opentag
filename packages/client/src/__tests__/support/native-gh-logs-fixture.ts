import { strToU8, zipSync } from "fflate";
import type { RuntimeProxyStreamResponse } from "../../runtime/runtime-proxy-data-client.js";

const LOG = "2026-10-16T00:00:01Z native-gh-cache-ok\n";
const ZIP = zipSync({ "build/1_Run test.txt": strToU8(LOG) });

/** Synthetic completed run consumed by the real gh CLI, including its ZIP cache path. */
export function nativeGhLogsResponse(path: string): RuntimeProxyStreamResponse | undefined {
  const pathname = new URL(path, "https://api.github.com").pathname;
  let content: Uint8Array;
  let contentType = "application/json";
  if (pathname.endsWith("/logs")) {
    content = pathname.includes("/jobs/") ? strToU8(LOG) : ZIP;
    contentType = pathname.includes("/jobs/") ? "text/plain" : "application/zip";
  } else if (pathname.endsWith("/actions/runs/7")) {
    content = strToU8(
      JSON.stringify({
        id: 7,
        name: "Fixture CI",
        run_number: 1,
        run_attempt: 1,
        workflow_id: 42,
        head_sha: "1".repeat(40),
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        event: "push",
        created_at: "2026-10-16T00:00:00Z",
        updated_at: "2026-10-16T00:01:00Z",
        jobs_url: "https://api.github.com/repos/team/fixture/actions/runs/7/jobs",
        html_url: "https://github.com/team/fixture/actions/runs/7",
        pull_requests: [],
      }),
    );
  } else if (pathname.endsWith("/actions/runs/7/jobs")) {
    content = strToU8(
      JSON.stringify({
        total_count: 1,
        jobs: [
          {
            id: 99,
            run_id: 7,
            name: "build",
            status: "completed",
            conclusion: "success",
            steps: [{ name: "Run test", number: 1, status: "completed", conclusion: "success" }],
          },
        ],
      }),
    );
  } else if (pathname.endsWith("/actions/workflows/42")) {
    content = strToU8(JSON.stringify({ id: 42, name: "Fixture CI", path: ".github/workflows/test.yml" }));
  } else return undefined;
  return {
    status: 200,
    headers: { "content-type": contentType },
    body: (async function* () {
      yield content;
    })(),
  };
}
