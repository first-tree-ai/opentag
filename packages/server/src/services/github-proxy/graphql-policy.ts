import {
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  Kind,
  type OperationDefinitionNode,
  parse,
  type SelectionSetNode,
  valueFromASTUntyped,
} from "graphql";
import {
  ConnectionFields,
  EdgeFields,
  MetadataConnectionNodes,
  metadataChildSet,
  PageInfoFields,
  ParentDefaultBranchRefMetadata,
  ParentOwnerMetadata,
  ParentRepositoryMetadata,
} from "./graphql-metadata-policy.js";

export class GitHubGraphqlPolicyError extends Error {
  constructor() {
    super("The GraphQL request is outside this execution's repository policy");
    this.name = "GitHubGraphqlPolicyError";
  }
}
export interface GitHubGraphqlRepository {
  repositoryId: string;
  fullName: string;
  nodeId: string;
}
export interface GitHubGraphqlPlan {
  repository: GitHubGraphqlRepository;
  operation: "read" | "createPullRequest" | "updatePullRequest" | "addComment";
  input?: Record<string, unknown>;
}
export interface GitHubGraphqlRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

const ReadFields = new Set([
  "id",
  "databaseId",
  "__typename",
  "name",
  "nameWithOwner",
  "login",
  "url",
  "avatarUrl",
  "description",
  "isPrivate",
  "isFork",
  "isArchived",
  "hasIssuesEnabled",
  "hasWikiEnabled",
  "viewerPermission",
  "viewerCanUpdate",
  "viewerCanSubscribe",
  "viewerDidAuthor",
  "viewerSubscription",
  "defaultBranchRef",
  "pullRequest",
  "pullRequests",
  "number",
  "title",
  "body",
  "bodyText",
  "state",
  "isDraft",
  "isCrossRepository",
  "createdAt",
  "updatedAt",
  "closedAt",
  "mergedAt",
  "author",
  "assignees",
  "participants",
  "labels",
  "milestone",
  "dueOn",
  "reviewRequests",
  "requestedReviewer",
  "reviews",
  "latestReviews",
  "latestOpinionatedReviews",
  "reviewDecision",
  "mergeable",
  "mergeStateStatus",
  "maintainerCanModify",
  "headRefName",
  "baseRefName",
  "headRefOid",
  "baseRefOid",
  "headRepository",
  "headRepositoryOwner",
  "commits",
  "commit",
  "oid",
  "abbreviatedOid",
  "message",
  "messageHeadline",
  "messageBody",
  "committedDate",
  "authoredDate",
  "authors",
  "email",
  "user",
  "comments",
  "totalCount",
  "nodes",
  "edges",
  "node",
  "cursor",
  "pageInfo",
  "hasNextPage",
  "hasPreviousPage",
  "endCursor",
  "startCursor",
  "files",
  "path",
  "additions",
  "deletions",
  "changedFiles",
  "totalAdditions",
  "totalDeletions",
  "changeType",
  "additionsCount",
  "deletionsCount",
  "statusCheckRollup",
  "contexts",
  "context",
  "status",
  "checkSuites",
  "checkRuns",
  "conclusion",
  "detailsUrl",
  "targetUrl",
  "startedAt",
  "completedAt",
  "workflowRun",
  "statusContext",
  "requiredApprovingReviewCount",
  "reviewDismissals",
  "submittedAt",
  "publishedAt",
  "reactionGroups",
  "content",
  "users",
  "viewerHasReacted",
  "projectItems",
  "project",
  "owner",
  "target",
  "resourcePath",
  "isEmpty",
  "ref",
  "refs",
  "prefix",
  "branchProtectionRule",
  "isRequired",
  "mergeCommit",
  "mergeCommitAllowed",
  "rebaseMergeAllowed",
  "squashMergeAllowed",
]);
/**
 * Bounded metadata a forked repository's `parent` may expose for the native gh repository preread.
 * Parent identity/name/description/wiki/permission/default-branch-name only: no refs, objects,
 * commits, issues, pull requests, or nested parents. Aliases and fragments cannot widen this set
 * because validation uses the resolved field names after fragment expansion.
 */
const MutationInputs: Record<string, ReadonlySet<string>> = {
  createPullRequest: new Set([
    "repositoryId",
    "baseRefName",
    "headRefName",
    "title",
    "body",
    "draft",
    "maintainerCanModify",
    "clientMutationId",
  ]),
  updatePullRequest: new Set([
    "pullRequestId",
    "title",
    "body",
    "baseRefName",
    "state",
    "maintainerCanModify",
    "clientMutationId",
  ]),
  addComment: new Set(["subjectId", "body", "clientMutationId"]),
};

interface PolicyWalk {
  fragments: Map<string, FragmentDefinitionNode>;
  variables: Record<string, unknown>;
  fields: number;
  cost: number;
}

/** Mature GraphQL AST parsing plus domain/target checks; aliases and fragments never bypass field policy. */
export function planGitHubGraphql(
  request: GitHubGraphqlRequest,
  repositories: readonly GitHubGraphqlRepository[],
  resolveNode: (id: string) => string | undefined,
): GitHubGraphqlPlan {
  if (Buffer.byteLength(JSON.stringify(request)) > 262144) throw new GitHubGraphqlPolicyError();
  let document: DocumentNode;
  try {
    document = parse(request.query, { maxTokens: 10000 });
  } catch {
    throw new GitHubGraphqlPolicyError();
  }
  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION,
  );
  const operation = request.operationName
    ? operations.find((item) => item.name?.value === request.operationName)
    : operations.length === 1
      ? operations[0]
      : undefined;
  if (!operation || operation.operation === "subscription") throw new GitHubGraphqlPolicyError();
  const fragments = new Map(
    document.definitions
      .filter((definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION)
      .map((fragment) => [fragment.name.value, fragment]),
  );
  const walk: PolicyWalk = {
    fragments,
    variables: resolveOperationVariables(operation, request.variables),
    fields: 0,
    cost: 0,
  };
  const fields = expandedFields(operation.selectionSet, walk, new Set(), 0);
  const targets = fields.filter((field) => field.name.value !== "rateLimit");
  if (targets.length !== 1) throw new GitHubGraphqlPolicyError();
  const target = targets[0];
  if (!target) throw new GitHubGraphqlPolicyError();
  if (operation.operation === "mutation") return mutationPlan(target, repositories, resolveNode, walk);
  if (target.name.value !== "repository" && target.name.value !== "node") throw new GitHubGraphqlPolicyError();
  const args = argumentsOf(target, walk.variables);
  const repository =
    target.name.value === "repository"
      ? repositories.find((item) => item.fullName.toLowerCase() === `${args.owner}/${args.name}`.toLowerCase())
      : repositories.find((item) => item.repositoryId === resolveNode(String(args.id)));
  if (!repository) throw new GitHubGraphqlPolicyError();
  validateSelection(target.selectionSet, walk, 0, ReadFields, 1, true);
  return { repository, operation: "read" };
}

function mutationPlan(
  field: FieldNode,
  repositories: readonly GitHubGraphqlRepository[],
  resolveNode: (id: string) => string | undefined,
  walk: PolicyWalk,
): GitHubGraphqlPlan {
  const name = field.name.value;
  const allowed = Object.hasOwn(MutationInputs, name) ? MutationInputs[name] : undefined;
  const input = argumentsOf(field, walk.variables).input;
  if (!allowed || typeof input !== "object" || input === null || Array.isArray(input))
    throw new GitHubGraphqlPolicyError();
  const values = input as Record<string, unknown>;
  if (Object.keys(values).some((key) => !allowed.has(key))) throw new GitHubGraphqlPolicyError();
  const repository =
    name === "createPullRequest"
      ? repositories.find((item) => item.nodeId === values.repositoryId)
      : repositories.find(
          (item) => item.repositoryId === resolveNode(String(values.pullRequestId ?? values.subjectId)),
        );
  if (!repository) throw new GitHubGraphqlPolicyError();
  validateSelection(
    field.selectionSet,
    walk,
    0,
    new Set([...ReadFields, "pullRequest", "commentEdge", "clientMutationId", "subject"]),
  );
  return { repository, operation: name as GitHubGraphqlPlan["operation"], input: values };
}

function argumentsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = Object.create(null);
  for (const argument of field.arguments ?? []) {
    if (Object.hasOwn(values, argument.name.value)) throw new GitHubGraphqlPolicyError();
    values[argument.name.value] = valueFromASTUntyped(argument.value, variables);
  }
  return values;
}

/**
 * GraphQL executes operation variable defaults, so the policy must evaluate them too. Provided
 * values win — including an explicit null, which does not trigger the default — and the map is
 * null-prototype with own-property lookups so unknown variable names cannot reach Object.prototype.
 * Duplicate definitions are spec-invalid and fail closed.
 */
function resolveOperationVariables(
  operation: OperationDefinitionNode,
  provided: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const variables: Record<string, unknown> = Object.create(null);
  for (const name of Object.keys(provided ?? {})) variables[name] = provided?.[name];
  const defined = new Set<string>();
  for (const definition of operation.variableDefinitions ?? []) {
    const name = definition.variable.name.value;
    if (defined.has(name)) throw new GitHubGraphqlPolicyError();
    defined.add(name);
    if (Object.hasOwn(variables, name)) continue;
    if (definition.defaultValue !== undefined) variables[name] = valueFromASTUntyped(definition.defaultValue);
  }
  return variables;
}

function expandedFields(
  selection: SelectionSetNode,
  walk: PolicyWalk,
  active: Set<string>,
  depth: number,
): FieldNode[] {
  if (depth > 16) throw new GitHubGraphqlPolicyError();
  const fields: FieldNode[] = [];
  for (const item of selection.selections) {
    if (item.directives?.some((directive) => !["include", "skip"].includes(directive.name.value)))
      throw new GitHubGraphqlPolicyError();
    if (item.kind === Kind.FIELD) fields.push(item);
    else if (item.kind === Kind.INLINE_FRAGMENT)
      fields.push(...expandedFields(item.selectionSet, walk, active, depth + 1));
    else {
      const fragment = walk.fragments.get(item.name.value);
      if (!fragment || active.has(item.name.value)) throw new GitHubGraphqlPolicyError();
      fields.push(...expandedFields(fragment.selectionSet, walk, new Set([...active, item.name.value]), depth + 1));
    }
  }
  walk.fields += fields.length;
  if (walk.fields > 500) throw new GitHubGraphqlPolicyError();
  return fields;
}

function validateSelection(
  selection: SelectionSetNode | undefined,
  walk: PolicyWalk,
  depth: number,
  allowed: ReadonlySet<string>,
  multiplier = 1,
  allowParent = false,
): void {
  if (!selection) return;
  if (depth > 16) throw new GitHubGraphqlPolicyError();
  for (const field of expandedFields(selection, walk, new Set(), depth)) {
    validateReadField(field, walk, depth, allowed, multiplier, allowParent);
  }
}

function validateReadField(
  field: FieldNode,
  walk: PolicyWalk,
  depth: number,
  allowed: ReadonlySet<string>,
  multiplier: number,
  allowParent: boolean,
): void {
  const name = field.name.value;
  const width = connectionWidth(argumentsOf(field, walk.variables));
  walk.cost += multiplier * width;
  if (walk.cost > 100_000) throw new GitHubGraphqlPolicyError();
  if (name === "parent") {
    // `parent` is a one-level, root-only metadata window; it never widens the allowed set.
    if (!allowParent) throw new GitHubGraphqlPolicyError();
    validateRestrictedSelection(field.selectionSet, walk, depth + 1, ParentRepositoryMetadata, multiplier * width, {
      owner: ParentOwnerMetadata,
      defaultBranchRef: ParentDefaultBranchRefMetadata,
    });
    return;
  }
  if (!allowed.has(name)) throw new GitHubGraphqlPolicyError();
  const connectionNodes = Object.hasOwn(MetadataConnectionNodes, name) ? MetadataConnectionNodes[name] : undefined;
  if (connectionNodes) {
    validateMetadataConnection(field.selectionSet, walk, depth + 1, connectionNodes, multiplier * width);
    return;
  }
  validateSelection(field.selectionSet, walk, depth + 1, metadataChildSet(name) ?? allowed, multiplier * width);
}

/**
 * A user/actor/reviewer connection may expose pagination and identity nodes only. Nodes are
 * validated against the metadata set, so no `pullRequests`/`repositories` content can be reached
 * through an assignee, participant, reaction user, commit author, or requested reviewer.
 */
function validateMetadataConnection(
  selection: SelectionSetNode | undefined,
  walk: PolicyWalk,
  depth: number,
  nodeMetadata: ReadonlySet<string>,
  multiplier: number,
): void {
  if (!selection) return;
  if (depth > 16) throw new GitHubGraphqlPolicyError();
  for (const field of expandedFields(selection, walk, new Set(), depth)) {
    const name = field.name.value;
    if (!ConnectionFields.has(name)) throw new GitHubGraphqlPolicyError();
    const width = connectionWidth(argumentsOf(field, walk.variables));
    walk.cost += multiplier * width;
    if (walk.cost > 100_000) throw new GitHubGraphqlPolicyError();
    if (name === "nodes") {
      validateSelection(field.selectionSet, walk, depth + 1, nodeMetadata, multiplier * width);
    } else if (name === "edges") {
      validateRestrictedSelection(
        field.selectionSet,
        walk,
        depth + 1,
        EdgeFields,
        multiplier * width,
        {
          node: nodeMetadata,
        },
        true,
      );
    } else if (name === "pageInfo") {
      validateRestrictedSelection(field.selectionSet, walk, depth + 1, PageInfoFields, multiplier * width, {});
    } else if (field.selectionSet) {
      throw new GitHubGraphqlPolicyError();
    }
  }
}

/** Strict scalar/object selection with no widening: object children are exactly the provided sets. */
/** Restricted child policy: exact children win, then mapped metadata fields when allowed. */
function restrictedChild(
  name: string,
  children: Readonly<Record<string, ReadonlySet<string>>>,
  mapMetadataChildren: boolean,
): ReadonlySet<string> | undefined {
  if (Object.hasOwn(children, name)) return children[name];
  return mapMetadataChildren ? metadataChildSet(name) : undefined;
}

function validateRestrictedSelection(
  selection: SelectionSetNode | undefined,
  walk: PolicyWalk,
  depth: number,
  allowed: ReadonlySet<string>,
  multiplier: number,
  children: Readonly<Record<string, ReadonlySet<string>>>,
  mapMetadataChildren = false,
): void {
  if (!selection) return;
  if (depth > 16) throw new GitHubGraphqlPolicyError();
  for (const field of expandedFields(selection, walk, new Set(), depth)) {
    const name = field.name.value;
    if (!allowed.has(name)) throw new GitHubGraphqlPolicyError();
    const args = argumentsOf(field, walk.variables);
    const width = connectionWidth(args);
    walk.cost += multiplier * width;
    if (walk.cost > 100_000) throw new GitHubGraphqlPolicyError();
    const child = restrictedChild(name, children, mapMetadataChildren);
    if (child) {
      validateRestrictedSelection(
        field.selectionSet,
        walk,
        depth + 1,
        child,
        multiplier * width,
        {},
        mapMetadataChildren,
      );
      continue;
    }
    // Every other metadata field is a scalar: a crafted selection set is rejected.
    if (field.selectionSet) throw new GitHubGraphqlPolicyError();
  }
}

function connectionWidth(args: Record<string, unknown>): number {
  for (const count of [args.first, args.last]) {
    if (count !== undefined && (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 100)) {
      throw new GitHubGraphqlPolicyError();
    }
  }
  return Math.max(Number(args.first ?? 1), Number(args.last ?? 1));
}
