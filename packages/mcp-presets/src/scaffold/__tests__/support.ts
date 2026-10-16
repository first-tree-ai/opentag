/** A fake Streamable HTTP server: anonymous `initialize` plus an annotated `tools/list`. */
function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

export function anonymousFetch(calls: string[] = []): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string };
    calls.push(body.method);
    if (body.method === "initialize") {
      return jsonResponse(
        {
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2025-06-18", serverInfo: { name: "Acme MCP", version: "2.1" } },
        },
        { headers: { "mcp-session-id": "s1" } },
      );
    }
    if (body.method === "tools/list") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: {
          tools: [
            { name: "search_docs", description: "Search   docs.", annotations: { readOnlyHint: true } },
            { name: "delete_doc", annotations: { destructiveHint: true } },
            { name: "edit_doc" },
            { name: "edit_doc" },
            { name: "bad name" },
          ],
        },
      });
    }
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
}
