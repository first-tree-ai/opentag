import { expect, it } from "vitest";
import { normalizeNativeProjectRead } from "../services/github-proxy/cli-project-error.js";

const request = {
  query:
    'query PullRequestProjectItems {repository(owner:"team",name:"code"){pullRequest(number:1){projectItems(first:1){totalCount}}}}',
};
const denied = {
  type: "FORBIDDEN",
  path: ["repository", "pullRequest", "projectItems"],
  message: "Resource not accessible by integration",
};
it("keeps an explicit optional project denial using the scope vocabulary understood by older gh", () => {
  expect(normalizeNativeProjectRead(request, { errors: [denied] })).toMatchObject({
    errors: [{ type: "FORBIDDEN", message: expect.stringContaining("['read:project']") }],
  });
});
it.each([
  { errors: [{ ...denied, path: ["repository"] }] },
  { errors: [{ ...denied, type: "BAD_CREDENTIALS" }] },
  { errors: [denied, { type: "FORBIDDEN", path: ["repository"], message: "Forbidden" }] },
  { data: { repository: { pullRequest: { projectItems: { nodes: [] } } } } },
])("does not mask non-project, mixed, credential or successful responses", (value) => {
  expect(normalizeNativeProjectRead(request, value)).toBe(value);
});
it("does not rewrite arbitrary queries or write errors", () => {
  const value = { errors: [denied] };
  expect(normalizeNativeProjectRead({ query: 'query Other {repository(owner:"team",name:"code"){id}}' }, value)).toBe(
    value,
  );
});
