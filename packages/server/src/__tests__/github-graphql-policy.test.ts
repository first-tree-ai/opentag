import { describe, expect, it } from "vitest";
import { planGitHubGraphql } from "../services/github-proxy/graphql-policy.js";

const repositories = [
  { repositoryId: "123", fullName: "team/code", nodeId: "R_code" },
  { repositoryId: "456", fullName: "team/tree", nodeId: "R_tree" },
];
const node = (id: string) => (id === "PR_123" ? "123" : undefined);
const plan = (query: string, variables: Record<string, unknown> = {}) =>
  planGitHubGraphql({ query, variables }, repositories, node);

describe("GitHub GraphQL repository policy", () => {
  it("supports ordinary PR fields, pagination, aliases, fragments, and variables for an allowed repository", () => {
    const result = plan(
      `query ($owner:String!, $name:String!, $after:String) {
      selected:repository(owner:$owner,name:$name) { pullRequests(first:30, after:$after) { nodes { ...Details } pageInfo { hasNextPage endCursor } } }
    } fragment Details on PullRequest { id number title state url headRefName isDraft author { login } labels(first:20) { nodes { name } } }`,
      { owner: "team", name: "code", after: null },
    );
    expect(result).toMatchObject({ repository: repositories[0], operation: "read" });
  });
  it("selects a second approved checkout without relying on GH_REPO", () => {
    expect(plan('{ repository(owner:"team",name:"tree") { nameWithOwner } }').repository.repositoryId).toBe("456");
  });
  it("binds PR creation to the exact repository node ID and registered mutation", () => {
    const query =
      "mutation($input:CreatePullRequestInput!) { createPullRequest(input:$input) { pullRequest { id number url } } }";
    expect(
      plan(query, {
        input: { repositoryId: "R_code", title: "Change", headRefName: "opentag/task", baseRefName: "main" },
      }).operation,
    ).toBe("createPullRequest");
    expect(() => plan(query, { input: { repositoryId: "R_foreign", title: "Change" } })).toThrow(/policy/);
  });
  it("requires previously resolved repository ownership for node mutations", () => {
    const query =
      'mutation($id:ID!) { updatePullRequest(input:{pullRequestId:$id,title:"Change"}) { pullRequest { id } } }';
    expect(plan(query, { id: "PR_123" }).repository.repositoryId).toBe("123");
    expect(() => plan(query, { id: "PR_foreign" })).toThrow(/policy/);
  });
  it.each([
    '{ repository(owner:"foreign",name:"secret") { id } }',
    '{ a:repository(owner:"team",name:"code") { id } b:repository(owner:"team",name:"tree") { id } }',
    '{ repository(owner:"team",name:"code") { parent { object(expression:"main:secret") { id } } } }',
    '{ repository(owner:"team",name:"code") { pullRequests(first:1) { nodes { headRepository { object(expression:"main:secret") { id } } } } } }',
    'mutation { x:mergePullRequest(input:{pullRequestId:"PR_123"}) { pullRequest { id } } }',
    '{ repository(owner:"team",name:"code") { pullRequests(first:101) { nodes { id } } } }',
    '{ repository(owner:"team",name:"code") { pullRequests(first:100) { nodes { commits(first:100) { nodes { commit { comments(first:100) { nodes { id } } } } } } } } }',
    '{ repository(owner:"team",name:"code") { ...A } } fragment A on Repository { ...A }',
  ])("rejects cross-repository, unregistered or excessive operations: %s", (query) => {
    expect(() => plan(query)).toThrow(/policy/);
  });
});

it("accepts gh 2.100.0 PullRequestCreate and rejects a missing fixture repository identity", () => {
  // cli/cli v2.100.0 api/queries_pr.go:490-523; a native command carries the ID from its repository query.
  const query =
    "mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id url } } }";
  const input = {
    repositoryId: "R_code",
    title: "Acceptance",
    body: "fixture",
    headRefName: "opentag/session/code/topic",
    baseRefName: "main",
    draft: false,
    maintainerCanModify: true,
  };
  expect(plan(query, { input })).toMatchObject({ operation: "createPullRequest", repository: repositories[0] });
  expect(() => plan(query, { input: { ...input, repositoryId: "" } })).toThrow(/policy/);
});

/**
 * Primary source fixture: cli/cli v2.100.0 `api/queries_repo.go` GitHubRepo() (lines 360-390).
 * `gh pr create -R <owner>/<name>` sends exactly this RepositoryInfo preread before the
 * PullRequestCreate mutation; it must plan against the single authorized root repository.
 */
const NATIVE_REPOSITORY_INFO_QUERY = `
fragment repo on Repository {
  id
  databaseId
  name
  owner { login }
  hasIssuesEnabled
  description
  hasWikiEnabled
  viewerPermission
  defaultBranchRef {
    name
  }
}

query RepositoryInfo($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ...repo
    parent {
      ...repo
    }
    mergeCommitAllowed
    rebaseMergeAllowed
    squashMergeAllowed
  }
}`;

describe("GitHub GraphQL native repository preread compatibility", () => {
  it("accepts the exact gh 2.100.0 RepositoryInfo preread for the authorized repository", () => {
    const result = plan(NATIVE_REPOSITORY_INFO_QUERY, { owner: "team", name: "code" });
    expect(result).toMatchObject({ repository: { repositoryId: "123", fullName: "team/code" }, operation: "read" });
  });

  it("allows only the bounded parent metadata window (preread fields, owner login, default branch name)", () => {
    const result = plan(`{
      repository(owner: "team", name: "code") {
        id
        hasWikiEnabled
        mergeCommitAllowed
        rebaseMergeAllowed
        squashMergeAllowed
        parent {
          __typename
          id
          databaseId
          name
          description
          hasIssuesEnabled
          hasWikiEnabled
          viewerPermission
          owner { __typename login }
          defaultBranchRef { __typename name }
        }
      }
    }`);
    expect(result).toMatchObject({ repository: { repositoryId: "123" }, operation: "read" });
  });

  it("keeps parent metadata bound to the previously resolved repository node", () => {
    const query = `query($id: ID!) {
      node(id: $id) {
        ...repo
        parent { ...repo }
        mergeCommitAllowed
      }
    }
    fragment repo on Repository {
      id
      name
      owner { login }
      hasWikiEnabled
      viewerPermission
      defaultBranchRef { name }
    }`;
    const resolved = (id: string) => (id === "PR_123" ? "123" : id === "R_code" ? "123" : undefined);
    expect(planGitHubGraphql({ query, variables: { id: "R_code" } }, repositories, resolved)).toMatchObject({
      repository: { repositoryId: "123" },
      operation: "read",
    });
  });

  it("allows parent metadata through aliases and fragments without widening the window", () => {
    const query = `query {
      repository(owner: "team", name: "code") {
        forked: parent { ...ParentBits }
      }
    }
    fragment ParentBits on Repository {
      id
      name
      owner { login }
      defaultBranchRef { name }
    }`;
    expect(plan(query).repository.repositoryId).toBe("123");
  });

  it.each([
    // Parent content domains stay closed.
    '{ repository(owner:"team",name:"code") { parent { refs(first:10) { nodes { name } } } } }',
    '{ repository(owner:"team",name:"code") { parent { pullRequests(first:10) { nodes { id } } } } }',
    '{ repository(owner:"team",name:"code") { parent { issues(first:10) { nodes { id } } } } }',
    '{ repository(owner:"team",name:"code") { parent { object(expression:"main:secret") { id } } } }',
    '{ repository(owner:"team",name:"code") { parent { defaultBranchRef { target { ... on Commit { oid } } } } } }',
    // Nested parent traversal.
    '{ repository(owner:"team",name:"code") { parent { parent { id } } } }',
    // Aliases cannot hide the real field name.
    '{ repository(owner:"team",name:"code") { hidden: parent { stolen: refs(first:5) { nodes { name } } } } }',
    // Fragments cannot widen the parent window.
    '{ repository(owner:"team",name:"code") { parent { ...Extra } } } fragment Extra on Repository { refs(first:5) { nodes { name } } }',
    // Merge-policy scalars and the parent window are root-repository-only.
    '{ repository(owner:"team",name:"code") { parent { mergeCommitAllowed } } }',
    '{ repository(owner:"team",name:"code") { pullRequests(first:1) { nodes { ...P } } } } fragment P on PullRequest { parent { id } }',
    // Scalar metadata must not carry a crafted selection set.
    '{ repository(owner:"team",name:"code") { parent { name { id } } } }',
    // Owner/default-branch subtrees are scalar-only.
    '{ repository(owner:"team",name:"code") { parent { owner { repositories(first:10) { nodes { name } } } } } }',
    // The root merge-policy scalars are not part of the parent window.
    '{ repository(owner:"team",name:"code") { parent { rebaseMergeAllowed } } }',
    // Metadata outside the native preread window stays closed.
    '{ repository(owner:"team",name:"code") { parent { nameWithOwner } } }',
    '{ repository(owner:"team",name:"code") { parent { url } } }',
    '{ repository(owner:"team",name:"code") { parent { isPrivate isFork isArchived } } }',
    '{ repository(owner:"team",name:"code") { parent { owner { id } } } }',
    '{ repository(owner:"team",name:"code") { parent { defaultBranchRef { id } } } }',
  ])("rejects unsafe parent metadata access: %s", (query) => {
    expect(() => plan(query)).toThrow(/policy/);
  });
});

describe("GitHub GraphQL actor metadata boundary", () => {
  it("rejects the exact user-wide connection escape through an authorized repository owner", () => {
    const widgets = [{ repositoryId: "999", fullName: "acme/widgets", nodeId: "R_widgets" }];
    const escapeQuery = `query {
      repository(owner: "acme", name: "widgets") {
        owner { ... on User { pullRequests(first: 1) { nodes { id number title } } } }
      }
    }`;
    expect(() => planGitHubGraphql({ query: escapeQuery }, widgets, node)).toThrow(/policy/);
    // The same authorized root still accepts its honest repository/owner metadata.
    expect(
      planGitHubGraphql(
        { query: 'query { repository(owner: "acme", name: "widgets") { id name owner { login } } }' },
        widgets,
        node,
      ).repository.repositoryId,
    ).toBe("999");
  });

  it.each([
    // Owner/Organization subtrees cannot reach user-wide or organization-wide content.
    '{ repository(owner:"team",name:"code") { owner { ... on User { pullRequests(first:1){nodes{id}} } } } }',
    '{ repository(owner:"team",name:"code") { owner { ... on Organization { repositories(first:1){nodes{name}} } } } }',
    '{ repository(owner:"team",name:"code") { owner { gists(first:1){nodes{id}} } } }',
    // Aliases and inline/named fragments cannot hide the real field names.
    '{ repository(owner:"team",name:"code") { repositoryOwner: owner { ... on User { userPullRequests: pullRequests(first:1){nodes{id}} } } } }',
    '{ repository(owner:"team",name:"code") { owner { ...OwnerBits } } } fragment OwnerBits on User { pullRequests(first:1){nodes{id}} }',
    // PR/comment/review authors and commit-author GitActor.user are metadata windows only.
    '{ repository(owner:"team",name:"code") { pullRequests(first:1){nodes{ author { ... on User { pullRequests(first:1){nodes{id}} } } }} } }',
    '{ repository(owner:"team",name:"code") { pullRequests(first:1){nodes{ comments(first:1){nodes{ author { ... on User { pullRequests(first:1){nodes{id}} } } }} }} } }',
    '{ repository(owner:"team",name:"code") { pullRequests(first:1){nodes{ reviews(first:1){nodes{ author { ... on User { pullRequests(first:1){nodes{id}} } } }} }} } }',
    '{ repository(owner:"team",name:"code") { pullRequests(first:1){nodes{ commits(first:1){nodes{ commit { author { user { pullRequests(first:1){nodes{id}} } } } }} }} } }',
    '{ repository(owner:"team",name:"code") { pullRequests(first:1){nodes{ commits(first:1){nodes{ commit { authors(first:1){nodes{ user { repositories(first:1){nodes{name}} } }} } }} }} } }',
    // Actor connections expose identity nodes, never content.
    '{ repository(owner:"team",name:"code") { pullRequests(first:1){nodes{ assignees(first:1){nodes{ pullRequests(first:1){nodes{id}} } }} } } }',
    '{ repository(owner:"team",name:"code") { pullRequests(first:1){nodes{ participants(first:1){nodes{ pullRequests(first:1){nodes{id}} } }} } } }',
    '{ repository(owner:"team",name:"code") { pullRequests(first:1){nodes{ reactionGroups { users(first:1){nodes{ pullRequests(first:1){nodes{id}} } } } }} } }',
    '{ repository(owner:"team",name:"code") { pullRequests(first:1){nodes{ reviewRequests(first:1){nodes{ requestedReviewer { ... on User { pullRequests(first:1){nodes{id}} } } }} }} } }',
    '{ repository(owner:"team",name:"code") { pullRequests(first:1){nodes{ requestedReviewer { ... on Team { repositories(first:1){nodes{name}} } } }} } }',
    // Ref/commit/check-suite/merge-commit traversal reaches the same GitActor/actor references.
    '{ repository(owner:"team",name:"code") { refs(first:1){nodes{ target { ... on Commit { author { user { pullRequests(first:1){nodes{id}} } } } } }} } }',
    '{ repository(owner:"team",name:"code") { pullRequests(first:1){nodes{ mergeCommit { author { user { pullRequests(first:1){nodes{id}} } } } }} } }',
    '{ repository(owner:"team",name:"code") { pullRequests(first:1){nodes{ statusCheckRollup { contexts(first:1){nodes{ commit { author { user { pullRequests(first:1){nodes{id}} } } } }} } }} } }',
    // Cross-repository owner references stay bounded too.
    '{ repository(owner:"team",name:"code") { pullRequests(first:1){nodes{ headRepositoryOwner { ... on User { pullRequests(first:1){nodes{id}} } } }} } }',
    '{ repository(owner:"team",name:"code") { pullRequests(first:1){nodes{ headRepository { owner { ... on User { pullRequests(first:1){nodes{id}} } } } }} } }',
    // Project owners are actors, not content windows.
    '{ repository(owner:"team",name:"code") { pullRequests(first:1){nodes{ projectItems(first:1){nodes{ project { owner { ... on User { pullRequests(first:1){nodes{id}} } } } }} }} } }',
    // Selection sets that try to descend from identity fields stay inside the metadata window.
    '{ repository(owner:"team",name:"code") { owner { login { pullRequests(first:1){nodes{id}} } } } }',
    '{ repository(owner:"team",name:"code") { pullRequests(first:1){nodes{ author { login { user { repositories(first:1){nodes{name}} } } } }} } }',
  ])("rejects actor-scope escape or content traversal: %s", (query) => {
    expect(() => plan(query)).toThrow(/policy/);
  });

  it("accepts native gh PR list/view identity, reviewer, reaction, and commit-author fields", () => {
    const result = plan(`query {
      repository(owner: "team", name: "code") {
        pullRequests(first: 30) {
          nodes {
            id
            number
            title
            author { __typename id databaseId login name email avatarUrl url }
            assignees(first: 10) { totalCount nodes { id login name } }
            participants(first: 10) { nodes { login name } }
            reviewRequests(first: 10) {
              totalCount
              nodes { requestedReviewer { __typename ... on User { login name email } ... on Team { name slug } } }
              pageInfo { hasNextPage endCursor }
            }
            latestReviews(first: 5) { nodes { author { login name } state } }
            reviews(first: 5) { nodes { author { login } comments(first: 5) { nodes { author { login } } } } }
            comments(first: 10) { nodes { author { login name } } }
            commits(first: 10) {
              nodes {
                commit {
                  oid
                  messageHeadline
                  authors(first: 5) { nodes { name email user { login name } } }
                  author { name email date user { login } }
                }
              }
            }
            reactionGroups { content users(first: 5) { nodes { login name } } }
            mergeCommit { oid author { name email user { login } } }
          }
        }
      }
    }`);
    expect(result).toMatchObject({ repository: { repositoryId: "123" }, operation: "read" });
  });

  it("applies the same actor window through edges and rejects content there", () => {
    expect(
      plan(`{ repository(owner:"team",name:"code") {
        pullRequests(first:1) { nodes { commits(first:1) { nodes { commit {
          authors(first:5) { edges { cursor node { name email user { login name } } } }
        } } } } }
      } }`).repository.repositoryId,
    ).toBe("123");
    expect(() =>
      plan(`{ repository(owner:"team",name:"code") {
        pullRequests(first:1) { nodes { commits(first:1) { nodes { commit {
          authors(first:5) { edges { node { user { pullRequests(first:1){nodes{id}} } } } }
        } } } } }
      } }`),
    ).toThrow(/policy/);
  });

  it("keeps metadata-connection pagination bounded and permits pageInfo edges", () => {
    expect(
      plan(`{ repository(owner:"team",name:"code") {
        pullRequests(first:1) { nodes {
          assignees(first:100) { edges { cursor node { login } } pageInfo { hasNextPage startCursor } }
        } }
      } }`).repository.repositoryId,
    ).toBe("123");
    expect(() =>
      plan(`{ repository(owner:"team",name:"code") {
        pullRequests(first:1) { nodes { assignees(first:101) { nodes { login } } } }
      } }`),
    ).toThrow(/policy/);
    expect(() =>
      plan(`{ repository(owner:"team",name:"code") {
        pullRequests(first:1) { nodes { assignees(first:1) { edges { node { pullRequests(first:1){nodes{id}} } } } } }
      } }`),
    ).toThrow(/policy/);
  });
});

describe("GitHub GraphQL operation variable defaults", () => {
  const widgets = [{ repositoryId: "999", fullName: "acme/widgets", nodeId: "R_widgets" }];
  const widgetsPlan = (query: string, variables?: Record<string, unknown>) =>
    planGitHubGraphql(variables === undefined ? { query } : { query, variables }, widgets, node);

  it("rejects the exact pagination bypass through an omitted default of 101", () => {
    expect(() =>
      widgetsPlan(
        'query($count:Int=101){repository(owner:"acme",name:"widgets"){pullRequests(first:$count){nodes{id}}}}',
      ),
    ).toThrow(/policy/);
  });

  it("accepts a bounded default and a provided value overriding an oversized default", () => {
    expect(
      widgetsPlan(
        'query($count:Int=30){repository(owner:"acme",name:"widgets"){pullRequests(first:$count){nodes{id}}}}',
      ).repository.repositoryId,
    ).toBe("999");
    expect(
      widgetsPlan(
        'query($count:Int=101){repository(owner:"acme",name:"widgets"){pullRequests(first:$count){nodes{id}}}}',
        { count: 50 },
      ).repository.repositoryId,
    ).toBe("999");
  });

  it("binds omitted repository owner/name defaults to the authorized root only", () => {
    expect(
      widgetsPlan('query($owner:String="acme",$name:String="widgets"){repository(owner:$owner,name:$name){id}}')
        .repository.repositoryId,
    ).toBe("999");
    expect(() =>
      widgetsPlan('query($owner:String="acme",$name:String="secret"){repository(owner:$owner,name:$name){id}}'),
    ).toThrow(/policy/);
  });

  it("does not replace an explicitly provided null with a variable default", () => {
    // A valid default of 30 would be accepted; an explicit null must stay null and fail closed.
    expect(() =>
      widgetsPlan(
        'query($count:Int=30){repository(owner:"acme",name:"widgets"){pullRequests(first:$count){nodes{id}}}}',
        { count: null },
      ),
    ).toThrow(/policy/);
    expect(() =>
      widgetsPlan('query($owner:String="acme",$name:String="widgets"){repository(owner:$owner,name:$name){id}}', {
        owner: null,
      }),
    ).toThrow(/policy/);
  });

  it("rejects ambiguous duplicate variable definitions", () => {
    expect(() =>
      widgetsPlan(
        'query($count:Int=1,$count:Int=2){repository(owner:"acme",name:"widgets"){pullRequests(first:$count){nodes{id}}}}',
      ),
    ).toThrow(/policy/);
  });

  it("applies default-expanded nested cost beyond the weighted cap", () => {
    expect(() =>
      widgetsPlan(`query($a:Int=100,$b:Int=100,$c:Int=100){repository(owner:"acme",name:"widgets"){
        pullRequests(first:$a){nodes{commits(first:$b){nodes{commit{comments(first:$c){nodes{id}}}}}}}
      }}`),
    ).toThrow(/policy/);
  });
});
