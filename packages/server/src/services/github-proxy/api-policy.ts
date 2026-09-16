import { z } from "zod";
import { GitPublicationError } from "./git-packets.js";

const Text = z.string().max(65536);
export const CreatePullRequestBodySchema = z
  .object({
    title: z.string().min(1).max(256),
    body: Text.optional(),
    head: z.string().min(1).max(255),
    base: z.string().min(1).max(255),
    draft: z.boolean().optional(),
    maintainer_can_modify: z.boolean().optional(),
  })
  .strict();
export const UpdatePullRequestBodySchema = z
  .object({
    title: z.string().min(1).max(256).optional(),
    body: Text.optional(),
    base: z.string().min(1).max(255).optional(),
    state: z.enum(["open", "closed"]).optional(),
    maintainer_can_modify: z.boolean().optional(),
  })
  .strict();
export const PullRequestCommentBodySchema = z.object({ body: z.string().min(1).max(65536) }).strict();

export interface GitHubRestPlan {
  fullName: string;
  operation: "read" | "createPullRequest" | "updatePullRequest" | "addComment";
  pullRequestNumber?: number;
  codeOnly: boolean;
  extraPermission?: "checks" | "actions";
}
const READ_QUERY_KEYS = new Set([
  "page",
  "per_page",
  "state",
  "head",
  "base",
  "sort",
  "direction",
  "since",
  "until",
  "ref",
  "sha",
  "path",
  "status",
  "filter",
  "check_name",
  "actor",
  "branch",
  "event",
  "created",
  "exclude_pull_requests",
]);

/** Exact registered repository routes: no generic HTTP forwarding or Git-object write endpoints. */
export function planGitHubRest(method: string, url: URL): GitHubRestPlan {
  const match = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/.*)?$/.exec(url.pathname);
  if (!match) throw new GitPublicationError("scope_denied");
  const fullName = `${match[1]}/${match[2]}`;
  const suffix = match[3] ?? "";
  if (method === "GET") return planRead(fullName, suffix, url);
  if (url.search) throw new GitPublicationError("invalid_request");
  if (method === "POST" && suffix === "/pulls") return { fullName, operation: "createPullRequest", codeOnly: false };
  const update = /^\/pulls\/([1-9]\d{0,9})$/.exec(suffix);
  if (method === "PATCH" && update)
    return { fullName, operation: "updatePullRequest", pullRequestNumber: Number(update[1]), codeOnly: false };
  const comment = /^\/issues\/([1-9]\d{0,9})\/comments$/.exec(suffix);
  if (method === "POST" && comment)
    return { fullName, operation: "addComment", pullRequestNumber: Number(comment[1]), codeOnly: false };
  throw new GitPublicationError("scope_denied");
}

function planRead(fullName: string, suffix: string, url: URL): GitHubRestPlan {
  validateReadQuery(url);
  const normal =
    suffix === "" ||
    /^\/pulls(?:\/[1-9]\d{0,9}(?:\/(?:files|commits|comments|reviews))?)?$/.test(suffix) ||
    /^\/issues\/[1-9]\d{0,9}\/comments$/.test(suffix);
  // Branch names and commit refs may contain raw slashes (`/branches/feature/x`), which GitHub
  // resolves verbatim; the safeRequestUrl guards (no `..`, no encoded separators, no backslash)
  // still run first, so multi-segment captures cannot escape the registered route families.
  // Encoded `%2F` slashes remain rejected — refs must be sent raw.
  const code = /^\/(?:branches(?:\/.+)?|commits(?:\/.+)?|contents(?:\/.*)?)$/.test(suffix);
  const checks =
    /^\/commits\/.+\/(?:check-runs|check-suites)$/.test(suffix) ||
    /^\/(?:check-runs|check-suites)\/[1-9]\d{0,19}$/.test(suffix);
  const actions = /^\/actions\/(?:runs(?:\/[1-9]\d{0,19}(?:\/jobs)?)?|jobs\/[1-9]\d{0,19})$/.test(suffix);
  if (!normal && !code && !checks && !actions) throw new GitPublicationError("scope_denied");
  return {
    fullName,
    operation: "read",
    codeOnly: code || checks || actions,
    ...(checks ? { extraPermission: "checks" as const } : {}),
    ...(actions ? { extraPermission: "actions" as const } : {}),
  };
}

function validateReadQuery(url: URL): void {
  for (const [key, value] of url.searchParams) {
    if (!READ_QUERY_KEYS.has(key) || value.length > 512 || url.searchParams.getAll(key).length !== 1)
      throw new GitPublicationError("invalid_request");
    if (
      ["page", "per_page"].includes(key) &&
      (!/^\d{1,5}$/.test(value) || +value < 1 || (key === "per_page" && +value > 100))
    )
      throw new GitPublicationError("invalid_request");
  }
}
