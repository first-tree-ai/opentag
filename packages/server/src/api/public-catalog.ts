import { MCP_CATALOG_CATEGORIES, MCP_CATALOG_ENTRIES } from "@opentag/mcp-presets";
import {
  PUBLIC_MCP_SERVERS_PATH,
  PUBLIC_SKILLS_PATH,
  PublicMcpCatalogResponseSchema,
  PublicSkillCatalogResponseSchema,
} from "@opentag/shared";
import { SKILL_PRESET_CATEGORIES, SKILL_PRESETS } from "@opentag/skill-presets";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { OFFICIAL_PUBLIC_ORIGIN, OFFICIAL_WEBSITE_ORIGINS } from "./website-origins.js";

/**
 * Anonymous public catalog reads for the official website.
 *
 * Two display-only projections of the repo-shipped catalogs: the preset Skill catalog and the MCP
 * marketplace. No Account, session proof, or credential is consulted, and no archive identity,
 * per-Agent state, endpoint URL, or authorization prefill field is exposed.
 *
 * The routes exist only when the deployment is the official app origin or configured at least one
 * website origin through `OPENTAG_WEBSITE_ORIGINS`. Whenever they exist, the two official website
 * origins are always allowed and configured origins extend, never replace, them. CORS is manual
 * like `website-session.ts`: the grant is attached only for allowed origins, and any other origin is
 * served without one rather than rejected, because the data is public.
 */

export interface PublicCatalogRoutesOptions {
  /** The deployment's public origin; the official origin enables the routes by itself. */
  publicOrigin: string | undefined;
  /** Additional website origins parsed from `OPENTAG_WEBSITE_ORIGINS`. */
  origins: readonly string[];
}

/** Static per server revision; five minutes keeps a website within a deploy or two without per-view requests. */
const CACHE_CONTROL = "public, max-age=300";

export function registerPublicCatalogRoutes(app: FastifyInstance, options: PublicCatalogRoutesOptions): void {
  if (options.publicOrigin !== OFFICIAL_PUBLIC_ORIGIN && options.origins.length === 0) return;
  /* Once the surface is enabled, the official origins are always part of the allowlist. */
  const allowed = new Set<string>([...OFFICIAL_WEBSITE_ORIGINS, ...options.origins]);

  /*
   * Parsed once at registration: the catalogs are compile-time data, and a strict parse here means a
   * shape change in either package fails fast instead of serving a partial card.
   */
  const skillCatalog = PublicSkillCatalogResponseSchema.parse({
    categories: SKILL_PRESET_CATEGORIES.map((category) => ({ id: category.id, order: category.order })),
    presets: SKILL_PRESETS.map((preset) => ({
      name: preset.name,
      description: preset.description,
      category: preset.category,
      order: preset.order,
    })),
  });
  const mcpCatalog = PublicMcpCatalogResponseSchema.parse({
    categories: MCP_CATALOG_CATEGORIES.map((category) => ({
      id: category.id,
      label: { ...category.label },
      order: category.order,
    })),
    servers: MCP_CATALOG_ENTRIES.map((entry) => ({
      id: entry.id,
      name: entry.name,
      title: { ...entry.title },
      description: { ...entry.description },
      category: entry.category,
      website: entry.website,
      iconUrl: entry.iconUrl,
      order: entry.order,
      defaultAuthKind: entry.defaultAuthKind,
    })),
  });

  const cors = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.header("Vary", "Origin");
    const origin = request.headers.origin;
    if (origin && allowed.has(origin)) reply.header("Access-Control-Allow-Origin", origin);
  };

  const preflight = (request: FastifyRequest, reply: FastifyReply): FastifyReply => {
    reply.header("Vary", "Origin");
    const origin = request.headers.origin;
    if (
      !origin ||
      !allowed.has(origin) ||
      request.headers["access-control-request-method"] !== "GET" ||
      request.headers["access-control-request-headers"]
    ) {
      return reply.code(403).send();
    }
    return reply
      .header("Access-Control-Allow-Origin", origin)
      .header("Access-Control-Allow-Methods", "GET")
      .code(204)
      .send();
  };

  app.get(PUBLIC_SKILLS_PATH, { onRequest: cors }, async (_request, reply) => {
    return reply.header("Cache-Control", CACHE_CONTROL).code(200).send(skillCatalog);
  });
  app.get(PUBLIC_MCP_SERVERS_PATH, { onRequest: cors }, async (_request, reply) => {
    return reply.header("Cache-Control", CACHE_CONTROL).code(200).send(mcpCatalog);
  });
  app.options(PUBLIC_SKILLS_PATH, preflight);
  app.options(PUBLIC_MCP_SERVERS_PATH, preflight);
}
