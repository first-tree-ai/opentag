---
title: "Public MCP catalog endpoint"
description: "The anonymous Streamable HTTP MCP endpoint that serves the marketplace catalog to third-party MCP clients."
---

# Public MCP catalog endpoint

`POST /api/v1/public/mcp` is an anonymous Streamable HTTP MCP endpoint that serves the
[MCP marketplace catalog](mcp-server-integration.md#the-marketplace-catalog) as three read-only tools.
A user adds one HTTP MCP entry to their own Agent — Claude Code, Cursor, or any MCP client — and that
Agent searches the catalog and returns a configuration block that already works.

## Why it exists

Discover in the Web App only helps someone who is already in the Web App. The people who add MCP
Servers are inside an Agent, and what they need is the endpoint, the auth method, and a
configuration block. That is what `GET /api/v1/public/mcp-servers` must not expose: it is a
display-only projection for the official website and deliberately omits connection fields. This
endpoint serves the configuration view of the same public data, which is already public in
`packages/mcp-presets/mcp-catalog.yaml`.

## Endpoint contract

| Item | Value |
| --- | --- |
| Path | `POST /api/v1/public/mcp` |
| Authentication | None. No session, proof, or credential is read. |
| Availability | Always registered. Not gated on website origins — the callers are MCP clients, not browsers. |
| CORS | No CORS headers, so a browser cannot read the endpoint cross-origin. |
| Body limit | 64 KiB (`PUBLIC_MCP_CATALOG_REQUEST_MAX_BYTES`). |
| Caching | `Cache-Control: no-store` on every response. |
| Rate limit | 120 requests per 60 seconds per client IP, answered with `429` and a JSON-RPC error body. |
| Methods | `initialize`, `server/discover`, `ping`, `tools/list`, `tools/call`. Any other method is `404` with `-32601`. |
| Protocol revisions | The three legacy revisions. `initialize` echoes a requested one it speaks and otherwise answers `2025-11-25`; `server/discover` lists the same set. |
| Notifications | A request with no `id` is answered `202` with an empty body. |
| `GET`, `DELETE` | `405` with `Allow: POST`. No server-initiated stream and no session exist to open or end. |
| Server identity | `name: "opentag-catalog"`, `title: "OpenTag MCP Catalog"`, `version: "1"`. |

The protocol layer in `packages/server/src/services/mcp/mcp-inbound-protocol.ts` is shared with the
per-Agent [MCP gateway](mcp-server-integration.md#the-mcp-gateway). What differs between the two
endpoints is only the handlers: their tools, their instructions, the identity they report, and the
revisions they declare. Every reply is one JSON object; neither endpoint streams.

The modern revision is deliberately absent from that set. It requires per-request version metadata, mirrored
`MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` headers, and a `resultType` on every result.
Advertising a revision without implementing its transport contract strands a conforming client
mid-flow, which is worse than not offering it: with only the legacy revisions listed, a negotiating
client falls back to `initialize`, which this endpoint does implement. An endpoint declares its set
through its handlers, so the gateway's behaviour is its own decision, not a property of the protocol
module.

The request budget is enforced in an `onRequest` hook, before the body is parsed, so a caller over
budget costs no parse.

## Tools

Every tool answers with one `text` content block containing a JSON document, so a client parses one
thing on every path. There is no separate `outputSchema`.

A successful call returns its result object. A failure the model can act on returns `isError: true`
and `{ "error": { "code", "message", … } }`, where `code` is one of `invalid_arguments` (with the
rejected `issues`), `unknown_server` (with the `id`), or `unknown_tool` (with the `availableTools`).
That distinction is the point: a transport error ends the model's turn, while a result it can read
lets it retry with better arguments. A transport failure is the only failure that is not a text
block, and it is a JSON-RPC error.

| Tool | Arguments | Result |
| --- | --- | --- |
| `search_mcp_servers` | `query?`, `category?`, `locale?` (`en` or `zh`, default `en`), `limit?` (1–50, default 10, clamped rather than refused) | `{ total, results: Entry[] }`; an empty `query` lists every active Server in catalog order, and `total` is the match count before `limit` |
| `get_mcp_server` | `id` (required; `notion` and `mcp/notion` both resolve), `locale?` | one entry plus `prerequisites`, `platforms`, `remotes`, and `tools` |
| `list_mcp_categories` | none | `{ categories: [{ id, label, order, activeCount, installableCount }] }` |

## Entry shape

`id`, `name`, `title`, `description`, `whenToUse`, `category`, `capabilities`, `risk`, `status`,
`website`, `installable`, `url`, `auth`, `authHeader`, `authScheme`, `keyAuth`, `oauthScopes`,
`packages`, `config`, `installCommand`.

- Localized fields are resolved to the requested locale.
- `url` is present only for an installable Server, which is one with a streamable-http remote. `config`
  and `installCommand` are `null` when it is not, and `installable` says which case applies.
- `config` is `{ "mcpServers": { "<name>": { "type": "http", "url": "<url>" } } }`, plus `headers`
  when the entry declares static `role: extra` headers, and `installCommand` is
  `claude mcp add --transport http <name> <url>`, POSIX-shell quoted so a URL that carries a query
  string is safe to paste. A pasted config must work, so a connection field an entry carries is never
  dropped here.
- `authHeader` and `authScheme` name where a key goes and what prefix it takes. An empty `authScheme`
  is a fact — "send the key with no prefix" — not an absent field.
- `packages` carries identity only: registry type, identifier, version, runtime hint, transport, and
  environment variable **names**. An entry holds no credential, and no value is projected.

## Search and ordering

The index is built once at import from compile-time data: an inverted token index, an exact
name/alias table, and a name/alias prefix table. A query costs postings proportional to the entries
its terms actually hit rather than a scan of the catalog.

Ranking is three tiers, then catalog order, then id:

1. exact name, alias, or `mcp/<slug>` match;
2. name or alias prefix match;
3. number of matched terms.

Tiers rather than one weighted score, because a name the caller already knows must never lose to an
entry that merely shares its terms, and no numeric score can keep that promise as the catalog grows.
Sorting never depends on map iteration order, so the same query returns the same order.

Indexing covers English and Chinese copy, so one query matches either language. Latin runs are indexed
whole and split at hyphens, so `search-docs` is reachable as `search` or `docs`. CJK has no spaces, so
a run contributes its characters and character bigrams. Every word is split at script boundaries
first, because `notion笔记` is how a Chinese user names a product and a task at once: the query yields
both the token `notion` and the bigram `笔记`, and so does any copy that mixes the two scripts.

Only `status: active` entries are returned or resolved by name. A `deprecated`, `archived`, or
`removed` entry is invisible here, exactly as it is in Discover.

## Boundaries

- **Read-only catalog.** The endpoint describes Servers. It does not call or proxy them, and it holds
  no credential for them. Authorizing a real Server stays per-Agent work in the Web App.
- **No third-party OAuth.** Nothing here completes an authorization flow.
- **Not self-registered.** The endpoint is not an entry in `mcp-catalog.yaml`; listing itself would
  need an official origin and an icon.
- **Per-process budget.** The limiter counts per process, so a multi-replica deployment gives a caller
  one budget per replica. Bounding the fleet needs a shared store or a gateway in front.

## Adding it to a client

```bash
claude mcp add --transport http opentag-catalog https://<deployment>/api/v1/public/mcp
```

```json
{
  "mcpServers": {
    "opentag-catalog": { "type": "http", "url": "https://<deployment>/api/v1/public/mcp" }
  }
}
```

One tool call, as a raw client would send it:

```bash
curl -X POST https://<deployment>/api/v1/public/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_mcp_servers","arguments":{"query":"notion"}}}'
```
