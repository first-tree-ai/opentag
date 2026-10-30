import type { FastifyInstance } from "fastify";

export function registerGitHubIntegrationsRoutes(app: FastifyInstance): void {
  const retired = async () => ({
    error: { code: "GITHUB_INTEGRATION_RETIRED", message: "Connect GitHub in this Agent's Connectors." },
  });
  for (const prefix of ["/api/v1/integrations/github", "/api/v2/integrations/github"]) {
    app.all(prefix, async (_request, reply) => reply.code(410).send(await retired()));
    app.all(`${prefix}/*`, async (_request, reply) => reply.code(410).send(await retired()));
  }
}
