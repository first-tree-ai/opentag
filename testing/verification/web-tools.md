# Web tools: verification and acceptance

Test and acceptance material for [Web tools](../../docs/system/capabilities/web-tools.md).

## Verification and limits

Unit tests cover the gateway, trusted Server client, execution web dispatch, native bridge, relay bearer fetch, Cloud
turn wiring (grant/no-grant, dispatch, successor execution), the Server route (bearer and machine auth), the Server
fence, the token stores, and the Pi extension against **local stub transport** only. Tests make no vendor call.

Cloud web tools have **not** been exercised end to end against a real staging deployment (real Router, real Cloud
Runner, real Sandbox) in this change. Treat the Cloud path as implemented and unit-verified, not production-proven,
until that run exists. Local proxy mode keeps its previous behavior; MCP is unchanged.
