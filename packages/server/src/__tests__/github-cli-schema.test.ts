import { describe, expect, it } from "vitest";
import { githubCliSchemaResponse } from "../services/github-proxy/cli-schema.js";

describe("native gh public schema capabilities", () => {
  it("answers the bounded native probes without repository or token access", () => {
    expect(
      githubCliSchemaResponse({
        query:
          'query PullRequest_fields { PullRequest:__type(name:"PullRequest"){fields(includeDeprecated:true){name}} StatusCheckRollupContextConnection:__type(name:"StatusCheckRollupContextConnection"){fields(includeDeprecated:true){name}} }',
      }),
    ).toMatchObject({ data: { PullRequest: { fields: expect.arrayContaining([{ name: "statusCheckRollup" }]) } } });
    expect(
      githubCliSchemaResponse({
        query:
          'query PullRequest_fields2 { WorkflowRun:__type(name:"WorkflowRun"){fields(includeDeprecated:true){name}} }',
      }),
    ).toMatchObject({ data: { WorkflowRun: { fields: [{ name: "event" }, { name: "workflow" }] } } });
  });
  it.each([
    '{__type(name:"User"){fields{name}}}',
    '{__type(name:"PullRequest"){fields{type{name}}}}',
    '{__type(name:"PullRequest"){fields{name}} repository(owner:"foreign",name:"secret"){id}}',
    '{__type(name:"PullRequest"){fields{name}} __type(name:"WorkflowRun"){fields{name}}}',
    '{__type(name:"PullRequest"){fields(unbounded:true){name}}}',
    'mutation {__type(name:"PullRequest"){fields{name}}}',
    '{__type(name:"__proto__"){fields{name}}}',
    '{__type(name:"PullRequest"){fields{name @skip(if:false)}}}',
  ])("rejects wider introspection or mixed data queries: %s", (query) => {
    expect(() => githubCliSchemaResponse({ query })).toThrow(/policy/);
  });
  it("leaves normal repository data to the authorization planner", () => {
    expect(githubCliSchemaResponse({ query: '{repository(owner:"team",name:"code"){id}}' })).toBeUndefined();
  });
});
