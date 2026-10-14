import {
  type FieldNode,
  type FragmentDefinitionNode,
  Kind,
  parse,
  type SelectionNode,
  type SelectionSetNode,
} from "graphql";
import type { GitHubGraphqlRequest } from "./graphql-policy.js";

type Hint = "connection" | "edges" | undefined;
interface Identity {
  id: string;
  number: number;
}

/** Track cold gh prereads by their actual selection; aliases must never promote milestone/actor IDs to PR IDs. */
export function graphqlPullRequestIdentities(request: GitHubGraphqlRequest, response: unknown): Identity[] {
  const document = parse(request.query, { maxTokens: 10000 });
  const fragments = new Map(
    document.definitions
      .filter((item) => item.kind === Kind.FRAGMENT_DEFINITION)
      .map((item) => [item.name.value, item]),
  );
  const operations = document.definitions.filter((item) => item.kind === Kind.OPERATION_DEFINITION);
  const operation = request.operationName
    ? operations.find((item) => item.name?.value === request.operationName)
    : operations[0];
  const reader = new IdentityReader(fragments);
  if (operation && response && typeof response === "object")
    reader.walk(operation.selectionSet, (response as Record<string, unknown>).data, undefined, 0);
  return reader.identities;
}

class IdentityReader {
  readonly identities: Identity[] = [];
  constructor(readonly fragments: ReadonlyMap<string, FragmentDefinitionNode>) {}
  remember(value: unknown, selection?: SelectionSetNode): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const row = value as Record<string, unknown>;
    if (!selection) return;
    const fields = [...identityFields(selection, this.fragments, 0)];
    const key = (name: string) => {
      const field = fields.find((item) => item.name.value === name);
      return field?.alias?.value ?? name;
    };
    const id = row[key("id")],
      number = row[key("number")];
    if (typeof id === "string" && typeof number === "number" && Number.isSafeInteger(number) && number > 0)
      this.identities.push({ id, number });
  }
  walk(set: SelectionSetNode, value: unknown, hint: Hint, depth: number): void {
    if (depth > 16 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) this.walk(set, item, hint, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const selection of set.selections) this.selection(selection, value as Record<string, unknown>, hint, depth);
  }
  selection(selection: SelectionNode, row: Record<string, unknown>, hint: Hint, depth: number): void {
    switch (selection.kind) {
      case Kind.INLINE_FRAGMENT:
        this.walk(selection.selectionSet, row, hint, depth + 1);
        break;
      case Kind.FRAGMENT_SPREAD: {
        const fragment = this.fragments.get(selection.name.value);
        if (fragment) this.walk(fragment.selectionSet, row, hint, depth + 1);
        break;
      }
      case Kind.FIELD:
        this.field(selection, row, hint, depth);
        break;
    }
  }
  field(field: FieldNode, row: Record<string, unknown>, hint: Hint, depth: number): void {
    const name = field.name.value,
      child = row[field.alias?.value ?? name];
    if (name === "pullRequest" || (hint === "edges" && name === "node")) this.remember(child, field.selectionSet);
    if (hint === "connection" && name === "nodes" && Array.isArray(child))
      for (const item of child) this.remember(item, field.selectionSet);
    if (field.selectionSet) this.walk(field.selectionSet, child, childHint(name, hint), depth + 1);
  }
}
function childHint(name: string, hint: Hint): Hint {
  if (name === "pullRequests") return "connection";
  if (hint === "connection" && name === "edges") return "edges";
  return undefined;
}

function* identityFields(
  selection: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  depth: number,
): Iterable<FieldNode> {
  if (depth > 16) return;
  for (const item of selection.selections) {
    if (item.kind === Kind.FIELD) yield item;
    else if (item.kind === Kind.INLINE_FRAGMENT) yield* identityFields(item.selectionSet, fragments, depth + 1);
    else {
      const fragment = fragments.get(item.name.value);
      if (fragment) yield* identityFields(fragment.selectionSet, fragments, depth + 1);
    }
  }
}
