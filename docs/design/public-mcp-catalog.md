# Public MCP catalog endpoint

`POST /api/v1/public/mcp` is an anonymous Streamable HTTP MCP endpoint that serves the
repo-shipped MCP marketplace catalog (`@opentag/mcp-presets`). A user adds one HTTP MCP entry to
their own Agent — Claude Code, Cursor, or any MCP client — and that Agent can search the catalog and
paste back a working configuration.

## Why it exists

Discover in the Web App only helps a user who is already in the Web App. The people who add MCP
Servers are inside an Agent, and what they need is the endpoint URL, the auth method, and a
configuration block. That is exactly what `/api/v1/public/mcp-servers` must not expose: it is a
display projection for the official website, and it deliberately omits connection fields. This
endpoint serves the configuration view of the same public data.

Everything it returns is already public in `packages/mcp-presets/mcp-catalog.yaml`, which is in the
repository.

## Endpoint contract

| Item | Value |
| --- | --- |
| Path | `POST /api/v1/public/mcp` |
| Authentication | None. No session, proof, or credential is read. |
| Availability | Always registered. Not gated on website origins — the callers are MCP clients, not browsers. |
| CORS | No CORS headers. A browser cannot read this endpoint cross-origin. |
| Body limit | 64 KiB (`PUBLIC_MCP_CATALOG_REQUEST_MAX_BYTES`). |
| Caching | `Cache-Control: no-store` on every response. |
| Rate limit | 120 requests per 60 seconds per client IP, answered with `429` and a JSON-RPC error body. |
| Methods | `initialize`, `server/discover`, `ping`, `tools/list`, `tools/call`. Any other method is `404` with `-32601`. |
| Notifications | A request with no `id` is answered `202` with an empty body. |
| `GET`, `DELETE` | `405` with `Allow: POST`. No server-initiated stream and no session exist to open or end. |
| Server identity | `name: "opentag-catalog"`, `title: "OpenTag MCP Catalog"`, `version: "1"`. |

The protocol layer (`packages/server/src/services/mcp/mcp-inbound-protocol.ts`) is shared with the
per-Agent runtime gateway at `/api/v1/mcp`. What differs between the two endpoints is only the
handlers: their tools, their instructions, and the identity they report.

## Tools

Every tool answers with a single `text` content block containing JSON, so a client parses one
document. There is no separate `outputSchema`.

### `search_mcp_servers`

Arguments: `query?`, `category?`, `locale?` (`en` | `zh`, default `en`), `limit?` (1–50, default
10, clamped).

Returns `{ total, results: Entry[] }`. An empty `query` lists every active Server in catalog order.
`total` is the match count before `limit`.

### `get_mcp_server`

Arguments: `id` (required; `notion` and `mcp/notion` both resolve), `locale?`.

Returns one entry with the detail fields the search view omits: `prerequisites`, `platforms`,
`remotes`, and `tools`. An unknown id is a tool result with `isError: true`, not a JSON-RPC error —
a model can read it and retry.

### `list_mcp_categories`

Returns `{ categories: [{ id, label, order, activeCount, installableCount }] }`.

## Entry shape

`id`, `name`, `title`, `description`, `whenToUse`, `category`, `capabilities`, `risk`, `status`,
`website`, `installable`, `url`, `auth`, `keyAuth`, `oauthScopes`, `packages`, `config`,
`installCommand`.

- Localized fields are resolved to the requested locale.
- `url` is present only for an installable Server; `config` and `installCommand` are `null` when it
  is not, and `installable` says which case applies.
- `config` is `{ "mcpServers": { "<name>": { "type": "http", "url": "<url>" } } }`;
  `installCommand` is `claude mcp add --transport http <name> <url>`.
- `packages` carries identity only: registry type, identifier, version, runtime hint, transport, and
  environment variable **names**. A catalog entry holds no credential, and no value is projected.

## Search and ordering

The index is built once at import from compile-time data: an inverted token index, an exact
name/alias table, and a name/alias prefix table. A query costs postings proportional to the entries
its tokens actually hit rather than a scan of the catalog.

Ranking is three tiers, then catalog order, then id:

1. exact name, alias, or `mcp/<slug>` match;
2. name or alias prefix match;
3. number of matched tokens.

Tiers rather than one weighted score: a name the caller already knows must never lose to an entry
that merely shares its tokens, and no numeric score can guarantee that as the catalog grows. Sorting
never depends on map iteration order, so the same query returns the same order.

Indexing covers English and Chinese copy, so one query matches either language. Latin runs are
indexed whole and split at hyphens (`search-docs` is reachable as `search` or `docs`). CJK has no
spaces, so a run contributes characters and character bigrams.

Only `status === "active"` entries are ever returned or resolved by name.

## Boundaries

- **Read-only catalog.** This endpoint describes Servers. It does not call them, proxy them, or hold
  a credential for them. Authorizing a real Server remains per-Agent work in the Web App.
- **No OAuth.** Nothing here completes a third-party authorization flow.
- **Not self-registered.** The endpoint is not an entry in `mcp-catalog.yaml`; that needs an
  official origin and an icon, and is a separate change.
- **Per-process budget.** The rate limiter counts per process, so a multi-replica deployment gives a
  caller one budget per replica. Bounding the fleet needs a shared store or a gateway in front.

## Adding it to a client

```bash
claude mcp add --transport http opentag-catalog https://<deployment>/api/v1/public/mcp
```

A Cursor or generic client configuration:

```json
{
  "mcpServers": {
    "opentag-catalog": { "type": "http", "url": "https://<deployment>/api/v1/public/mcp" }
  }
}
```

Then ask the Agent to search the catalog. A tool call looks like:

```bash
curl -X POST https://<deployment>/api/v1/public/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_mcp_servers","arguments":{"query":"notion"}}}'
```

## Tests

- `packages/mcp-presets/src/__tests__/search.test.ts` — ranking, prefix and CJK matching, category
  filtering, clamping, catalog ordering, and the invariants that need a retired, aliased, or
  package-only entry (fixture-built).
- `packages/server/src/__tests__/public-mcp-catalog-api.test.ts` — the wire contract end to end via
  `app.inject`: handshake, both protocol eras, tool listing and calls, argument errors, `405`, the
  body bound, and the request budget.
- `packages/server/src/__tests__/mcp-inbound-protocol.test.ts` — the shared protocol layer, including
  that identity comes from the handlers rather than the module.

Neither suite uses the public network, an external provider, or PostgreSQL.
