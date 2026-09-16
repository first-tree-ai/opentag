import {
  type FieldNode,
  Kind,
  type NameNode,
  parse,
  print,
  type StringValueNode,
  valueFromASTUntyped,
  visit,
} from "graphql";
import { GitPublicationError } from "./git-packets.js";
import type { GitHubGraphqlRequest } from "./graphql-policy.js";

/** Constrains normal gh repository/PR queries to the configured knowledge branch. */
export function constrainTreeGraphql(input: { request: GitHubGraphqlRequest; branch: string; taskPrefix: string }): {
  request: GitHubGraphqlRequest;
  pullRequestNumbers: number[];
  nodeIds: string[];
} {
  const numbers = new Set<number>();
  const nodeIds = new Set<string>();
  const value = (text: string): StringValueNode => ({ kind: Kind.STRING, value: text });
  const name = (text: string): NameNode => ({ kind: Kind.NAME, value: text });
  const document = visit(parse(input.request.query, { maxTokens: 10000 }), {
    Field(field) {
      const args = Object.fromEntries(
        (field.arguments ?? []).map((argument) => [
          argument.name.value,
          valueFromASTUntyped(argument.value, input.request.variables),
        ]),
      );
      validateField(field, args, input, numbers, nodeIds);
      if (field.name.value === "defaultBranchRef")
        return {
          ...field,
          alias: field.alias ?? name("defaultBranchRef"),
          name: name("ref"),
          arguments: [{ kind: Kind.ARGUMENT, name: name("qualifiedName"), value: value(input.branch) }],
        };
      if (field.name.value === "pullRequests")
        return {
          ...field,
          arguments: [...(field.arguments ?? [])]
            .filter((arg) => arg.name.value !== "baseRefName")
            .concat([
              {
                kind: Kind.ARGUMENT,
                name: name("baseRefName"),
                value: value(input.branch.slice("refs/heads/".length)),
              },
            ]),
        };
      return undefined;
    },
  });
  return {
    request: { ...input.request, query: print(document) },
    pullRequestNumbers: [...numbers],
    nodeIds: [...nodeIds],
  };
}

function validateField(
  field: FieldNode,
  args: Record<string, unknown>,
  input: { branch: string; taskPrefix: string },
  numbers: Set<number>,
  nodeIds: Set<string>,
): void {
  if (field.name.value === "node" && args.id !== undefined) nodeIds.add(String(args.id));
  if (field.name.value === "refs") throw new GitPublicationError("scope_denied");
  if (field.name.value === "ref") {
    const ref = String(args.qualifiedName ?? "");
    if (ref !== input.branch && !ref.startsWith(input.taskPrefix)) throw new GitPublicationError("scope_denied");
  }
  if (field.name.value === "pullRequest") {
    if (typeof args.number !== "number" || !Number.isSafeInteger(args.number) || args.number < 1)
      throw new GitPublicationError("scope_denied");
    numbers.add(args.number);
  }
}
