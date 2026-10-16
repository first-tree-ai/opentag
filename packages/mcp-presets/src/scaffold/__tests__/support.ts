/** A fake Streamable HTTP server: anonymous `initialize` plus an annotated `tools/list`. */
function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** What a pre-modern server answers to `server/discover`: 404 with the generic method-not-found. */
export function legacyOnly(inner: typeof fetch): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string };
    if (body.method === "server/discover") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return inner(url, init);
  }) as unknown as typeof fetch;
}

export function anonymousFetch(calls: string[] = []): typeof fetch {
  return legacyOnly((async (_url: string, init: RequestInit) => {
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
          ],
        },
      });
    }
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch);
}

/** A server whose `tools/list` spans two pages; the later page holds the destructive tool. */
export function pagedFetch(headers: Array<Record<string, string>> = []): typeof fetch {
  return legacyOnly((async (_url: string, init: RequestInit) => {
    headers.push(init.headers as Record<string, string>);
    const body = JSON.parse(String(init.body)) as { id?: number; method: string; params?: { cursor?: string } };
    if (body.method === "initialize") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-06-18", serverInfo: { name: "paged" } },
      });
    }
    if (body.method === "tools/list") {
      const first = body.params?.cursor === undefined;
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: first
          ? { tools: [{ name: "read_one", annotations: { readOnlyHint: true } }], nextCursor: "page2" }
          : { tools: [{ name: "drop_all", annotations: { destructiveHint: true } }] },
      });
    }
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch);
}
