import { expect, it } from "vitest";
import { graphqlPullRequestIdentities } from "../services/github-proxy/graphql-identities.js";

it("records cold PR identity reads through aliases and fragments without requiring branch fields", () => {
  const query =
    'query { repository(owner:"team",name:"code"){p:pullRequest(number:1){...P} many:pullRequests(first:1){e:edges{n:node{...P}}}}} fragment P on PullRequest{id number state}';
  expect(
    graphqlPullRequestIdentities(
      { query },
      {
        data: {
          repository: {
            p: { id: "PR_one", number: 1, state: "OPEN" },
            many: { e: [{ n: { id: "PR_two", number: 2, state: "CLOSED" } }] },
          },
        },
      },
    ),
  ).toEqual([
    { id: "PR_one", number: 1 },
    { id: "PR_two", number: 2 },
  ]);
});
it("does not promote a milestone using the same alias as a PR selection", () => {
  const query =
    '{repository(owner:"team",name:"code"){p:pullRequest(number:1){id number p:milestone{id number state}}}}';
  expect(
    graphqlPullRequestIdentities(
      { query },
      { data: { repository: { p: { id: "PR_one", number: 1, p: { id: "M_one", number: 99, state: "OPEN" } } } } },
    ),
  ).toEqual([{ id: "PR_one", number: 1 }]);
});

it("uses selected scalar aliases when establishing a PR identity", () => {
  expect(
    graphqlPullRequestIdentities(
      { query: '{repository(owner:"team",name:"code"){p:pullRequest(number:1){i:id n:number}}}' },
      { data: { repository: { p: { i: "PR_alias", n: 1 } } } },
    ),
  ).toEqual([{ id: "PR_alias", number: 1 }]);
});
