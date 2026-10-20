# GitHub platform integration: verification and acceptance

Test and acceptance material for [GitHub platform integration](../../docs/system/capabilities/github-platform-integration.md).

## Acceptance boundaries

Local checks include protocol/authorization, PostgreSQL authority and refresh safety, real Git/gh through the Server and Client wire, cancellation and Sandbox-visible material. Live acceptance separately records Server/Local/Runner versions, user identity, private-repository permissions, native logs/artifacts and cleanup. Two users sharing an installation require independent identity and access evidence. Execution cleanup must leave the shared Account connection usable. Offline fixtures do not establish deployed OAuth, GitHub effects or real IM delivery; outbound IM tests require an authorized Bot and conversation.
