import { type DocumentNode, type FieldNode, Kind, parse, type SelectionNode, valueFromASTUntyped } from "graphql";
import { GitHubGraphqlPolicyError, type GitHubGraphqlRequest } from "./graphql-policy.js";

/**
 * Public capabilities of this gateway, not an unbounded upstream introspection proxy.
 * Native gh probes these types before reading checks. Returning a small local schema
 * keeps repository data behind the normal planner and requires no user token mint.
 */
const CLI_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  PullRequest: ["id", "number", "statusCheckRollup", "assignedActors"],
  StatusCheckRollupContextConnection: [
    "nodes",
    "pageInfo",
    "checkRunCount",
    "checkRunCountsByState",
    "statusContextCount",
    "statusContextCountsByState",
  ],
  WorkflowRun: ["event", "workflow"],
};

export function githubCliSchemaResponse(request: GitHubGraphqlRequest): { data: Record<string, unknown> } | undefined {
  let document: DocumentNode;
  try {
    document = parse(request.query, { maxTokens: 10000 });
  } catch {
    throw new GitHubGraphqlPolicyError();
  }
  const operations = document.definitions.filter((item) => item.kind === Kind.OPERATION_DEFINITION);
  const operation = request.operationName
    ? operations.find((item) => item.name?.value === request.operationName)
    : operations.length === 1
      ? operations[0]
      : undefined;
  if (!operation) return undefined;
  const roots = operation.selectionSet.selections;
  if (!roots.some((item) => item.kind === Kind.FIELD && item.name.value === "__type")) return undefined;
  if (
    operation.operation !== "query" ||
    roots.length > 3 ||
    document.definitions.length !== 1 ||
    operation.directives?.length
  )
    throw new GitHubGraphqlPolicyError();
  const data: Record<string, unknown> = Object.create(null);
  for (const root of roots) {
    const fieldRoot = schemaRoot(root, request.variables);
    const { name } = fieldRoot;
    const key = fieldRoot.root.alias?.value ?? "__type";
    if (Object.hasOwn(data, key)) throw new GitHubGraphqlPolicyError();
    data[key] = { fields: CLI_SCHEMA[name]?.map((fieldName) => ({ name: fieldName })) };
  }
  return { data };
}

function schemaRoot(
  root: SelectionNode,
  variables: GitHubGraphqlRequest["variables"],
): { root: FieldNode; name: string } {
  if (
    root.kind !== Kind.FIELD ||
    root.name.value !== "__type" ||
    root.directives?.length ||
    root.arguments?.length !== 1
  )
    throw new GitHubGraphqlPolicyError();
  const argument = root.arguments[0];
  const name = argument && valueFromASTUntyped(argument.value, variables);
  if (argument?.name.value !== "name" || typeof name !== "string" || !Object.hasOwn(CLI_SCHEMA, name))
    throw new GitHubGraphqlPolicyError();
  const children = root.selectionSet?.selections;
  const field = children?.[0];
  if (
    children?.length !== 1 ||
    field?.kind !== Kind.FIELD ||
    field.name.value !== "fields" ||
    field.alias ||
    field.directives?.length
  )
    throw new GitHubGraphqlPolicyError();
  if (
    field.arguments?.some(
      (arg) => arg.name.value !== "includeDeprecated" || typeof valueFromASTUntyped(arg.value, variables) !== "boolean",
    )
  )
    throw new GitHubGraphqlPolicyError();
  const scalar = field.selectionSet?.selections[0];
  if (
    field.selectionSet?.selections.length !== 1 ||
    scalar?.kind !== Kind.FIELD ||
    scalar.name.value !== "name" ||
    scalar.alias ||
    scalar.selectionSet ||
    scalar.arguments?.length ||
    scalar.directives?.length
  )
    throw new GitHubGraphqlPolicyError();
  return { root, name };
}
