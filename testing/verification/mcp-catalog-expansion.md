# MCP catalog expansion verification

Supports [MCP Server integration](../../docs/system/capabilities/mcp-server-integration.md).

## Scope and evidence boundary

51 approved additions bring the directory to 79 entries. The existing ten category IDs use the
agreed English/Chinese labels and fixed order. 43 additions use catalog defaults, seven ask for a
customer endpoint and a key, and PagerDuty formats its documented key prefix in the browser.
The connector expansion keeps existing API contracts, database schemas, and OAuth machinery.
The separately approved CI repair below also corrects one Server filesystem guard.

The provider documents and public unauthenticated discovery evidence establish the selected
authentication contracts and the absence of manual OpenTag app registration. They do not establish
successful customer consent, token exchange, account permissions, plan availability, or business tool
calls. In particular, the existing OAuth engine selects CIMD where supported before DCR. No provider
credential, DCR registration write, or production business action was used for this verification.

Selection and evidence: [authentication contracts](../research/mcp-no-backend-selection.json),
[issuer metadata](../research/no-backend-oauth-metadata.json),
[discovery chains](../research/no-backend-discovery-chains.json), and
[icon provenance](../research/mcp-icon-provenance.json).

## Provider contracts

| Product | Selected authentication | Endpoint setup | Official documentation |
| --- | --- | --- | --- |
| Miro | OAuth DCR + PKCE | Fixed endpoint | [Provider source](https://developers.miro.com/docs/miro-mcp-server-frequently-asked-questions) |
| Todoist | OAuth DCR + PKCE | Fixed endpoint | [Provider source](https://developer.todoist.com/api/v1/) |
| Fireflies | Authorization: Bearer <Fireflies API key> | Fixed endpoint | [Provider source](https://guide.fireflies.ai/articles/8272956938-learn-about-the-fireflies-mcp-server-model-context-protocol) |
| Intercom | Authorization: Bearer <Intercom API token> | Fixed endpoint | [Provider source](https://developers.intercom.com/docs/guides/mcp) |
| Dovetail | Authorization: Bearer <Dovetail API token> | Fixed endpoint | [Provider source](https://developers.dovetail.com/docs/mcp) |
| Superhuman Docs / Coda | Authorization: Bearer <MCP-enabled personal token> | Fixed endpoint | [Provider source](https://help.superhuman.com/hc/en-us/articles/46210076980365-Connect-to-the-Superhuman-Docs-MCP) |
| Webflow | OAuth DCR + PKCE | Fixed endpoint | [Provider source](https://developers.webflow.com/mcp/installing/claude-code) |
| WordPress.com | Automatic DCR; support public-client registration | Fixed endpoint | [Provider source](https://developer.wordpress.com/docs/mcp/connect-custom-mcp-client/) |
| Contentful | OAuth DCR + PKCE | Fixed endpoint | [Provider source](https://www.contentful.com/developers/docs/mcp/model-context-protocol-mcp-server/) |
| Sanity | OAuth DCR + PKCE | Fixed endpoint | [Provider source](https://www.sanity.io/docs/ai/mcp-server) |
| Klaviyo | Explicit hosted OAuth DCR + Streamable HTTP | Fixed endpoint | [Provider source](https://developers.klaviyo.com/en/docs/connect_to_the_klaviyo_mcp_server) |
| Brevo | Authorization: Bearer <MCP-specific token> | Fixed endpoint | [Provider source](https://developers.brevo.com/docs/mcp-protocol) |
| Similarweb | api-key: <Similarweb API key> | Fixed endpoint | [Provider source](https://developers.similarweb.com/docs/cursor-mcp-integration) |
| SE Ranking | X-Api-Key: <SE Ranking key> | Fixed endpoint | [Provider source](https://seranking.com/api/integrations/mcp/) |
| Clay | Explicit self-service DCR for hosted platforms; PKCE | Fixed endpoint | [Provider source](https://university.clay.com/docs/connect-to-clay-mcp) |
| Ashby | Explicit OAuth DCR + PKCE | Fixed endpoint | [Provider source](https://docs.ashbyhq.com/ashby-mcp-server-beta) |
| Airwallex AgentOS | OAuth DCR + PKCE | Fixed endpoint | [Provider source](https://www.airwallex.com/docs/developer-tools/ai/agentos) |
| Mercury | Explicit custom-client DCR + PKCE | Fixed endpoint | [Provider source](https://docs.mercury.com/docs/connecting-mercury-mcp) |
| HeyGen | OAuth DCR + PKCE | Fixed endpoint | [Provider source](https://developers.heygen.com/mcp/claude-code) |
| fal | OAuth DCR via current relay endpoint | Fixed endpoint | [Provider source](https://fal.ai/docs/documentation/setting-up/mcp/other-clients) |
| Ideogram | OAuth DCR + PKCE | Fixed endpoint | [Provider source](https://ideogram.ai/features/mcp/) |
| VEED | OAuth DCR + Streamable HTTP | Fixed endpoint | [Provider source](https://veedstudio.github.io/veed-fabric-mcp/authentication.html) |
| Hugging Face | Authorization: Bearer <HF_TOKEN> | Fixed endpoint | [Provider source](https://github.com/huggingface/hf-mcp-server) |
| Perplexity API | Authorization: Bearer <PERPLEXITY_API_KEY> | Fixed endpoint | [Provider source](https://docs.perplexity.ai/docs/getting-started/integrations/mcp-server) |
| Apify | Authorization: Bearer <APIFY_TOKEN> | Fixed endpoint | [Provider source](https://docs.apify.com/mcp) |
| GitLab | Explicit OAuth DCR; basic/post | Fixed endpoint | [Provider source](https://docs.gitlab.com/user/model_context_protocol/mcp_server/) |
| Postman | Authorization: Bearer <POSTMAN_API_KEY> | Fixed endpoint | [Provider source](https://learning.postman.com/docs/reference/postman-api/postman-mcp-server/postman-mcp-remote-server/) |
| Cloudflare | Authorization: Bearer <CLOUDFLARE_API_TOKEN> | Fixed endpoint | [Provider source](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/) |
| DigitalOcean | Authorization: Bearer <DIGITALOCEAN_API_TOKEN> | Fixed endpoint | [Provider source](https://docs.digitalocean.com/reference/mcp/configure-mcp/) |
| Netlify | OAuth DCR + PKCE | Fixed endpoint | [Provider source](https://docs.netlify.com/build/build-with-ai/agent-setup-guides/agent-setup-overview/) |
| Grafana Cloud | OAuth DCR; none/basic/post advertised | Fixed endpoint | [Provider source](https://grafana.com/docs/grafana-cloud/ai-tools/mcp-servers/cloud-mcp/) |
| New Relic | OAuth DCR; canonical issuer supports basic/post/none | Fixed endpoint | [Provider source](https://docs.newrelic.com/docs/agentic-ai/mcp/setup/) |
| Dynatrace | Authorization: Bearer <DYNATRACE_PLATFORM_TOKEN> | Customer URL | [Provider source](https://docs.dynatrace.com/docs/dynatrace-intelligence/dynatrace-mcp) |
| Elastic Agent Builder | Authorization: ApiKey <ELASTIC_API_KEY> | Customer URL | [Provider source](https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/mcp-server-api-keys) |
| Honeycomb | Authorization: Bearer <KEY_ID>:<SECRET_KEY> | Fixed endpoint | [Provider source](https://docs.honeycomb.io/integrations/mcp/configuration-guide) |
| PagerDuty | Authorization: Token token=<USER_API_KEY> | Fixed endpoint | [Provider source](https://docs.pagerduty.com/ai-automation/advance/pagerduty-mcp-server) |
| Snowflake | Authorization: Bearer <SNOWFLAKE_PAT> | Customer URL | [Provider source](https://www.snowflake.com/en/developers/guides/getting-started-with-snowflake-mcp-server/) |
| Databricks | Authorization: Bearer <DATABRICKS_PAT> | Customer URL | [Provider source](https://docs.databricks.com/aws/en/ai-gateway/coding-agent-codex) |
| dbt platform | Authorization: Token <PAT-or-service-token> | Customer URL | [Provider source](https://docs.getdbt.com/docs/dbt-ai/setup-remote-mcp) |
| Fivetran Agent Context | Authorization: Bearer <FIVETRAN_SYSTEM_KEY> | Fixed endpoint | [Provider source](https://fivetran.com/docs/context-layer/agent-context-mcp/setup-guide) |
| LangSmith | X-Api-Key: <LANGSMITH_API_KEY> | Fixed endpoint | [Provider source](https://docs.langchain.com/langsmith/langsmith-remote-mcp) |
| Make | Authorization: Bearer <MAKE_API_KEY> | Customer URL | [Provider source](https://developers.make.com/mcp-server/connect-using-api-key/usage-with-cursor.md) |
| n8n | Authorization: Bearer <N8N_MCP_TOKEN> | Customer URL | [Provider source](https://docs.n8n.io/connect/connect-to-n8n-mcp-server/mcp-client-examples.md) |
| Storyblok | Authorization: Bearer <Storyblok personal access token> | Fixed endpoint | [Provider source](https://www.storyblok.com/docs/tooling/mcp-server/setup) |
| lemlist | X-API-Key: <lemlist API key> | Fixed endpoint | [Provider source](https://help.lemlist.com/en/articles/13728466-set-up-the-lemlist-mcp-server-in-your-llm-client-oauth-or-api-key) |
| vidIQ | Authorization: Bearer <VIDIQ_API_KEY> | Fixed endpoint | [Provider source](https://vidiq.com/cursor/) |
| Close | Close-API-Key: <CLOSE_API_KEY>; Close-Scope: mcp.read | Fixed endpoint | [Provider source](https://help.close.com/integrations/close-mcp-server) |
| Pipedrive | Existing Basic DCR + PKCE | Fixed endpoint | [Provider source](https://www.pipedrive.com/en/features/mcp-server) |
| Granola | DCR supported; existing client currently chooses advertised CIMD | Fixed endpoint | [Provider source](https://docs.granola.ai/help-center/sharing/integrations/mcp) |
| Higgsfield | DCR supported; existing client currently chooses advertised CIMD | Fixed endpoint | [Provider source](https://higgsfield.ai/creator-hub/help-center/integrations/what-is-higgsfield-mcp) |
| Tally | Authorization: Bearer <Tally API key> | Fixed endpoint | [Provider source](https://developers.tally.so/api-reference/mcp) |

## Local checks

- `pnpm check`: formatting, generated catalog drift, repository policies, and Context Tree verification.
- `pnpm build` and `pnpm typecheck`: all workspace consumers, because the catalog adds a public setup type and helpers.
- Generator tests: 54 passed; catalog package tests: 99 passed.
- Public catalog API consumer tests: 40 passed. Their two assertions now account for setup-only entries and the existing 50-result search bound; no Server implementation changed.
- Discover component regressions: 35 passed, including eight customer setup cases added for unit/patch coverage after the complete Web run. They cover validation before writes, separate key payloads, retry, provisional mount/definition cleanup, incompatible auth/environment isolation, and the same-session cache regression. The earlier focused MCP run passed 40 tests.
- Browser coverage: all 71 distinct cases passed across the 20-case expansion suite and 51 existing MCP cases, including real local MCP/OAuth peers. Initial new-test failures were fixed by waiting for menu rendering and authorization requests, and by asserting the directory modal before opening management rows.
- Complete Web suite: 184 files, 2,339 tests passed, because the generator, catalog type, and add flow change.
- PostgreSQL integration and Agent Runtime coverage are left to CI: this implementation changes neither persistence behavior nor Agent Runtime code.

[Desktop and mobile UI evidence](../web-ui/mcp-catalog-expansion/README.md).

The Playwright expansion suite runs the production web build, real sign-in, Agent creation, and
navigation against an isolated local stack. MCP management responses are fixtures: this verifies
browser contracts, lifecycle, payloads, and rendering, not a live provider account connection.
The pre-existing MCP connection smoke suite separately exercises real local MCP/OAuth peers.

## Independent review

An independent agent reviewed the full implementation before commit. Findings covered duplicate
bearer methods, mixed-script product-name ranking, incompatible authorization reuse, and reuse of
an already-mounted cached definition after an override. Each finding is fixed with regression
coverage. Browser fixtures enforce duplicate-attach conflicts so that they cannot hide the cache bug.

The test-only follow-up received independent review; fixture cleanup removes definitions and waits
for pending authorization to settle before cancellation. Production behavior and the validated
browser build are unchanged.

## Approved CI repair: transient Git staging entries

The initial Server coverage measurement failed twice in existing Context Tree verification tests,
while ordinary tests passed. A diagnostic replay of the real Git/CLI suite increased budget-scan
frequency and delayed lock-file inspection. It reproduced five failures with ENOENT on Git's
transient config.lock and HEAD.lock. The directory-budget monitor treated disappearing entries as
fatal and aborted the verification. The diagnostic copy and logging were removed after replay.

The user approved a minimal Server filesystem exception to the original catalog/frontend scope.
The directory walker now ignores only ENOENT for previously discovered child entries; the requested
root remains required, and permission errors and size limits remain failures. No DB, API, or auth
logic changes. Two real filesystem race regressions failed before the correction, with four safety
checks passing. All six regression checks and adjacent real Git/CLI tests pass after the correction.
The same amplified real Git/CLI replay passes all 27 tests after the correction, and the four
adjacent suites pass all 43 tests. Independent review found no actionable issue in the helper or tests.

Final repair validation: Server build and typecheck pass; the six directory-budget cases cover all
15 executable lines and 16 branches. The 20-case connector expansion and three GitHub/Memory
browser smoke cases pass (23 total). `pnpm check` passes. No diagnostic source files or logging
remain in the repository.

## Non-blocking review follow-up

The public MCP catalog guide describes category-by-category enumeration with `limit: 50` and
explicit truncation detection; no pagination contract is added. Generation rejects anonymous or
OAuth defaults for customer endpoint recipes because the existing setup form supports bearer keys.
Header feedback and resolved connection settings share the same validation helper. Required values,
positive integers, and invalid header values have per-field messages, and header failures do not
mark a valid URL invalid. ARIA descriptions reference the rendered error or hint, including when
the shared Field replaces its hint with an error.

Validation: generator 56 tests, catalog package 100 tests, focused setup/directory 37 tests, and
the MCP Web module 32 files / 400 tests pass. The 24-case browser expansion suite passes; four
English/Chinese mobile/desktop cases check required/format feedback, live ARIA descriptions, Axe,
and overflow. Independent review found no actionable issue. Root build/typecheck and E2E typecheck
pass. The final complete Web suite passes 185 files / 2,349 tests, and the 40 public catalog
consumer tests pass. The final four field-feedback browser cases also pass after checking live
ARIA targets. `pnpm check` passes before commit.
