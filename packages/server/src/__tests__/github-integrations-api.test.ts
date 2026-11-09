import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerGitHubIntegrationsRoutes } from "../api/github-integrations.js";

describe("retired Account GitHub integration", () => {
  it.each(["v1", "v2"])("returns 410 for every %s management and OAuth entry", async (version) => {
    const app = Fastify();
    registerGitHubIntegrationsRoutes(app);
    try {
      for (const path of [
        "",
        "/authorization",
        "/repositories",
        "/disconnect",
        "/bindings",
        "/oauth/callback?code=unused&state=unused",
      ]) {
        const response = await app.inject({
          method: path === "/authorization" || path === "/disconnect" ? "POST" : "GET",
          url: `/api/${version}/integrations/github${path}`,
        });
        expect(response.statusCode).toBe(410);
        expect(response.json()).toEqual({
          error: { code: "GITHUB_INTEGRATION_RETIRED", message: "Connect GitHub in this Agent's Connectors." },
        });
      }
    } finally {
      await app.close();
    }
  });
});
