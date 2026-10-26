type HeaderParameterType = "string" | "integer" | "boolean";

export interface McpHeaderParameter {
  name: string;
  path: readonly string[];
  type: HeaderParameterType;
}

interface SchemaNode {
  schema: unknown;
  path?: readonly string[];
}

type ParameterHeaders = { valid: true; parameters: McpHeaderParameter[] } | { valid: false; reason: string };

const LITERAL_KEYWORDS = new Set(["const", "enum", "default", "examples", "example", "dependentRequired"]);
const SCHEMA_MAP_KEYWORDS = new Set(["$defs", "definitions", "patternProperties", "dependentSchemas", "dependencies"]);

export function parseMcpParameterHeaders(inputSchema: unknown): ParameterHeaders {
  const names = new Set<string>();
  const parameters: McpHeaderParameter[] = [];
  const pending: SchemaNode[] = [{ schema: inputSchema, path: [] }];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) break;
    if (isRecord(node.schema) && Object.hasOwn(node.schema, "x-mcp-header")) {
      const parameter = parseHeaderParameter(node.schema, node.path, names);
      if (typeof parameter === "string") return { valid: false, reason: parameter };
      parameters.push(parameter);
    }
    for (const child of schemaChildren(node)) pending.push(child);
  }
  return { valid: true, parameters };
}

function parseHeaderParameter(
  schema: Record<string, unknown>,
  path: readonly string[] | undefined,
  names: Set<string>,
): McpHeaderParameter | string {
  if (!path?.length) return "annotations must follow only properties paths";
  const name = schema["x-mcp-header"];
  if (typeof name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return "invalid header name";
  const type = schema.type;
  if (type !== "string" && type !== "integer" && type !== "boolean")
    return "header parameters must have primitive types";
  if (names.has(name.toLowerCase())) return "header names must be unique ignoring case";
  names.add(name.toLowerCase());
  return { name, path, type };
}

function schemaChildren(node: SchemaNode): SchemaNode[] {
  if (Array.isArray(node.schema)) return node.schema.map((schema) => ({ schema }));
  if (!isRecord(node.schema)) return [];
  return Object.entries(node.schema).flatMap(([key, value]): SchemaNode[] => {
    if (LITERAL_KEYWORDS.has(key)) return [];
    if (key === "properties" && isRecord(value)) {
      return Object.entries(value).map(([name, schema]) => ({
        schema,
        ...(node.path ? { path: [...node.path, name] } : {}),
      }));
    }
    if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) return Object.values(value).map((schema) => ({ schema }));
    return [{ schema: value }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
