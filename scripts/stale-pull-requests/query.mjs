const PULL_REQUESTS_PER_PAGE = 25;

/**
 * Timeline item types that count as somebody working on the pull request.
 * Merge/close/deploy events are deliberately absent: they are outcomes, not
 * signs that the pull request still has a human behind it.
 */
const ACTIVITY_ITEM_TYPES = [
  "PULL_REQUEST_COMMIT",
  "HEAD_REF_FORCE_PUSHED_EVENT",
  "ISSUE_COMMENT",
  "PULL_REQUEST_REVIEW",
  "READY_FOR_REVIEW_EVENT",
  "CONVERT_TO_DRAFT_EVENT",
  "REOPENED_EVENT",
  "RENAMED_TITLE_EVENT",
  "LABELED_EVENT",
  "UNLABELED_EVENT",
  "REVIEW_REQUESTED_EVENT",
  "REVIEW_REQUEST_REMOVED_EVENT",
  "ASSIGNED_EVENT",
  "UNASSIGNED_EVENT",
].join("\n            ");

/**
 * `timelineItems` is ordered oldest-first, so `last:` is what returns the newest
 * page -- `first:` would silently read ancient history on a busy pull request.
 * `totalCount` ignores the `itemTypes` filter and is therefore useless as a
 * truncation signal, so `pageInfo.hasPreviousPage` is queried instead.
 *
 * `reviewRequests` intentionally selects no `Team` subfields: GITHUB_TOKEN is
 * repository-scoped with no organization read, and asking for a team's name
 * fails the whole query.
 *
 * `reviewThreads` is queried separately rather than through the timeline: a
 * reply typed into an existing review thread frequently produces no
 * `PullRequestReview` timeline item at all, and `PULL_REQUEST_REVIEW_THREAD`
 * never materialises as a timeline node, so the timeline alone would miss the
 * one kind of activity that means a review is actively in progress.
 */
export const PULL_REQUESTS_QUERY = `query StalePullRequests($owner: String!, $name: String!, $cursor: String) {
  rateLimit {
    cost
    remaining
    resetAt
    nodeCount
  }
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${PULL_REQUESTS_PER_PAGE}, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        number
        title
        url
        createdAt
        isDraft
        author {
          __typename
          login
        }
        labels(first: 20) {
          nodes {
            name
          }
        }
        reviewRequests(first: 20) {
          nodes {
            requestedReviewer {
              __typename
              ... on User {
                login
              }
              ... on Bot {
                login
              }
              ... on Mannequin {
                login
              }
            }
          }
        }
        latestReviews(first: 20) {
          nodes {
            author {
              __typename
              login
            }
          }
        }
        comments(last: 30) {
          nodes {
            id
            createdAt
            body
            author {
              __typename
              login
            }
          }
        }
        reviewThreads(last: 100) {
          nodes {
            comments(last: 1) {
              nodes {
                createdAt
                author {
                  __typename
                  login
                }
              }
            }
          }
        }
        timelineItems(last: 100, itemTypes: [
            ${ACTIVITY_ITEM_TYPES}
        ]) {
          pageInfo {
            hasPreviousPage
          }
          nodes {
            __typename
            ... on PullRequestCommit {
              commit {
                committedDate
                authoredDate
                author {
                  user {
                    login
                  }
                }
                committer {
                  user {
                    login
                  }
                }
              }
            }
            ... on IssueComment {
              createdAt
              author {
                __typename
                login
              }
            }
            ... on PullRequestReview {
              createdAt
              submittedAt
              author {
                __typename
                login
              }
            }
            ... on HeadRefForcePushedEvent {
              createdAt
              actor {
                __typename
                login
              }
            }
            ... on ReadyForReviewEvent {
              createdAt
              actor {
                __typename
                login
              }
            }
            ... on ConvertToDraftEvent {
              createdAt
              actor {
                __typename
                login
              }
            }
            ... on ReopenedEvent {
              createdAt
              actor {
                __typename
                login
              }
            }
            ... on RenamedTitleEvent {
              createdAt
              actor {
                __typename
                login
              }
            }
            ... on LabeledEvent {
              createdAt
              actor {
                __typename
                login
              }
            }
            ... on UnlabeledEvent {
              createdAt
              actor {
                __typename
                login
              }
            }
            ... on ReviewRequestedEvent {
              createdAt
              actor {
                __typename
                login
              }
            }
            ... on ReviewRequestRemovedEvent {
              createdAt
              actor {
                __typename
                login
              }
            }
            ... on AssignedEvent {
              createdAt
              actor {
                __typename
                login
              }
            }
            ... on UnassignedEvent {
              createdAt
              actor {
                __typename
                login
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Walks every page of open pull requests. The page cap exists so a malformed
 * cursor response cannot spin forever inside a scheduled job.
 */
export async function fetchOpenPullRequests(client, { owner, name, logger, maxPages = 40 }) {
  const nodes = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page += 1) {
    const data = await client.graphql(PULL_REQUESTS_QUERY, { owner, name, cursor });
    const connection = data.repository?.pullRequests;
    if (!connection) {
      throw new Error(`Repository ${owner}/${name} returned no pull request connection`);
    }
    nodes.push(...(connection.nodes ?? []));
    logger.debug("Fetched pull request page", {
      page: page + 1,
      received: connection.nodes?.length ?? 0,
      rateLimit: data.rateLimit,
    });
    if (connection.pageInfo?.hasNextPage !== true) {
      return nodes;
    }
    cursor = connection.pageInfo.endCursor;
  }

  logger.warn("Stopped paginating open pull requests at the page cap", { maxPages, collected: nodes.length });
  return nodes;
}
