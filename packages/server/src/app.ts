import { ServerHealthSchema } from "@opentag/shared";
import Fastify from "fastify";

export function createApp() {
  const app = Fastify({ logger: true });

  app.get("/healthz", async (_request, reply) => {
    const health = ServerHealthSchema.parse({
      status: "ok",
      service: "opentag-server",
    });

    return reply.code(200).send(health);
  });

  return app;
}
