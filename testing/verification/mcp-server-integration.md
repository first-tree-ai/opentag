# MCP Server integration: verification and acceptance

Test and acceptance material for [MCP Server integration](../../docs/system/capabilities/mcp-server-integration.md).

## Verification

Unit tests (no network, no database):

| Area | What is asserted |
| --- | --- |
| Transport headers | Every required header; the version in header and `_meta`; the name header only when there is one; the Base64 sentinel boundary in both directions; a legacy call carrying none of the modern envelope |
| Response parsing | JSON, request-scoped SSE with notifications and foreign ids, `202` with no body, JSON-RPC errors that keep their code, a non-2xx JSON body failing rather than reading as an empty result |
| Era detection | A modern error body means retry, not downgrade; a non-modern `404` means downgrade; a generic `-32601` is not a modern signal; only protocol-class failures invalidate a cached era |
| URL policy | Every non-public IPv4 and IPv6 range decided by leading bits (including the 5+-group and IPv4-mapped spellings), a hostname resolving to any private address, the `.localhost` tree and trailing-dot loopback spellings, non-HTTPS, credentials, fragments, redirects refused with no request made, the loopback opt-in, and the concurrency and size bounds |
| Outbound gate | The transport, OAuth, probe, and OAuth-flow modules contain no `fetch(` call, so the gate cannot be bypassed by a later edit |
| Header construction | OAuth always uses `Authorization`; an empty scheme sends verbatim; `none` sends no authorization header; extra headers apply to all three kinds; a collision is refused case-insensitively; the reserved names are refused |
| Header validation | The RFC 9110 token set, CR/LF in a name or value, the count and size bounds, and each reserved name |
| AAD | The literal format; a different Agent, a different authorization server, and the other envelope's domain all fail to open; a kind change is openable because the context never names the kind |
| Discovery | The exact well-known order; a mismatched issuer propagates; multi-issuer ordering; the registration choice in all four cases; CIMD self-naming and same-host redirects; PKCE; the protected-resource identity matrix (strict equality, an origin advertised for a `/mcp` endpoint, a path identity with the endpoint's query ignored, cross-origin, same-origin sibling, fragment, userinfo, non-HTTP, and a non-well-known challenge location); the accepted resource recorded on the flow and sent verbatim on both requests; `resource` on both requests; the four `iss` rows; scope priority; the refresh lead; the refresh guard for a recorded resource that no longer matches the endpoint |
| Probing | Two pages merged into one snapshot on both eras; the cursor sent only on later pages; each per-tool bound skipping the tool (in bytes, proven with multi-byte text), a nameless entry and a non-object entry skipped, a page whose every tool is skipped still succeeding, pagination continuing past a skipped tool, the `warn` line naming the bound; the cap, the budget, and a skipped tool all setting `tools_truncated`; an error page still failing the probe; a malformed page (non-object result, missing or non-array `tools`, non-string or empty cursor) failing both eras while a null cursor ends the list; SSE discovery; the era paths |
| Config import | Every documented dialect (OpenCode `mcp`, `mcpServers`, `servers`, their YAML spellings, TOML `[mcp_servers.*]` with `headers`, `http_headers`, and `env_http_headers`, `claude`/`codex` command lines, and JSON with comments and trailing commas); a `command` entry whose arguments carry an HTTPS URL read as local; the multi-server list and each "no importable Server" outcome; name normalization, the host fallback, and de-duplication; the paste bound; the credential-name vocabulary read from the shared redactor's own source, matched for `X-PrivateKey` as well as `x-private-key`, with its two deliberate differences from the redactor pinned — narrower for structural names such as `payload`, wider for separatorless spellings such as `x-privatekey` — and no `client-secret`, `credential`, `passwd`, or `*key` name reaching the shared extra headers; the accumulated extra-header count and size bounds refused by name; an environment-backed header refused rather than shared as an empty value, including when a literal header declares the same name and when that name is credential-shaped; a rejected URL's userinfo dropped from the stored value; an edited paste discarding its previous list and any read still running; a token reaching the authorization write only, and never a message |

PostgreSQL integration tests (`mcp-management.test.ts`, Docker + testcontainers) drive a loopback
fixture Server that is also its own authorization server:

| Path | What it proves |
| --- | --- |
| P2 — management plane | One Server holds `kind='bearer'` for one Agent and `kind='oauth'` for another; a disable keeps the credential and re-enabling needs no reauthorization; two Agents see different Server sets; the aggregate counts and `lastProbedAt`; an Agent-level override re-probes only that Agent while a shared edit re-probes every mount |
| P3 — OAuth round trip | The flow reaches `active` with the state cleared, the probe reports the modern era and both pages' tools, a restart invalidates the old state, `invalid_grant` revokes, a refresh rotates without re-probing, a provider-shaped identity (origin advertised for a `/mcp` endpoint) is accepted and repeated on the exchange and refresh, a pre-change row derives the endpoint resource, and a Bearer row is left alone by the refresh pass |
| P3 — flow security | A callback presented by a browser holding no flow secret, or a different one, is refused and stores nothing (session fixation); the callback redeems the code under the registration `start` recorded, leaving exactly one registration per `(Account, issuer)` pair and the row still pointing at it |
| P4 — outbound gate | A challenge naming a link-local document, a Protected Resource Metadata document naming a private issuer, and an AS document naming a private token endpoint are each refused with `MCP_URL_BLOCKED`, and the fixture's request log shows nothing was sent |
| P5 — lifecycle | A soft-deleted Agent drops `boundAgentCount` to 0 so the definition can be deleted; an onboarding reset leaves no mount behind; detaching releases the credential; a client registration survives its Server's deletion |
| Constraints | The one-row-per-pair unique index, the anonymous row created on mount, mounting before authorizing, `MCP_SERVER_IN_USE`, the datastore-level header-name rules, the case-insensitive Server name, and the Account snapshot bound failing one Agent's write without disturbing another's |

Runtime unit tests cover gateway authorization and revocation, Pi's explicit extension loading,
Cloud's ephemeral handoff and journal exclusion. A production acceptance claim still requires a
real Computer and Provider Turn that calls an MCP tool, and for Cloud a pinned Runner image and
observed end-to-end reply. Those observations are recorded separately from source and test gates.

### Authenticated provider smoke test (manual)

The suites above prove the client, not the providers. For each preset enabled by the
protected-resource identity work — Atlassian, Airtable, and Amplitude — a maintainer with a real
account records, in the pull request:

1. **Discovery and consent**: the authorization screen appears and completes, and the row reaches
   `active`.
2. **Tool discovery**: the probe stores a tool snapshot and the tools appear on the Agent's page.
3. **One tool call**: a read-only call succeeds through the gateway.
4. **One refresh**: after forcing the access token's expiry, a refresh pass rotates the credential
   without re-probing.

Amplitude's authorization is expected to stop at client registration until token-endpoint
authentication methods (`client_secret_post` or a public client) are supported; record that outcome
as the evidence for the follow-up rather than treating the preset as verified. Credential-free
probes remain the only automated evidence, and no source gate claims end-to-end support.

## UI evidence

UI validation captures use an isolated local MCP/OAuth fixture deployment: [desktop](../assets/mcp-discover/desktop.png),
[320px](../assets/mcp-discover/mobile-320.png), [390px](../assets/mcp-discover/mobile-390.png), and
[768px](../assets/mcp-discover/tablet-768.png). They show the shipped directory layout with disposable
test connections, rather than third-party account data.


Current connector component evidence is recorded in [Connector UI polish](../web-ui/connector-polish/README.md).
