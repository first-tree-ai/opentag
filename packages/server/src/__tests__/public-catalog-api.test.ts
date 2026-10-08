import { MCP_CATALOG_CATEGORIES, MCP_CATALOG_ENTRIES } from "@opentag/mcp-presets";
import {
  PUBLIC_MCP_SERVERS_PATH,
  PUBLIC_SKILLS_PATH,
  PublicMcpCatalogResponseSchema,
  PublicSkillCatalogResponseSchema,
} from "@opentag/shared";
import { SKILL_PRESET_CATEGORIES, SKILL_PRESETS } from "@opentag/skill-presets";
import { afterEach, describe, expect, it } from "vitest";
import { registerPublicCatalogRoutes } from "../api/public-catalog.js";
import { OFFICIAL_PUBLIC_ORIGIN } from "../api/website-origins.js";
import { createApp } from "../app.js";

const OFFICIAL_ORIGINS = ["https://opentag.build", "https://www.opentag.build"] as const;
const CONFIGURED_ORIGIN = "https://website.example";
const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function registered(options: { publicOrigin: string | undefined; origins: readonly string[] }) {
  const app = createApp({});
  registerPublicCatalogRoutes(app, options);
  apps.push(app);
  return app;
}

describe("public catalog routes", () => {
  it("serves the built-in Skill catalog with display fields only", async () => {
    const app = registered({ publicOrigin: OFFICIAL_PUBLIC_ORIGIN, origins: [] });
    const response = await app.inject({
      method: "GET",
      url: PUBLIC_SKILLS_PATH,
      headers: { origin: OFFICIAL_ORIGINS[0] },
    });
    expect(response.statusCode).toBe(200);
    const body = PublicSkillCatalogResponseSchema.parse(response.json());
    expect(body.categories).toEqual(
      SKILL_PRESET_CATEGORIES.map((category) => ({ id: category.id, order: category.order })),
    );
    expect(body.presets).toEqual(
      SKILL_PRESETS.map((preset) => ({
        name: preset.name,
        description: preset.description,
        category: preset.category,
        order: preset.order,
      })),
    );
    for (const preset of body.presets) {
      expect(Object.keys(preset).sort()).toEqual(["category", "description", "name", "order"]);
    }
  });

  it("serves the built-in MCP catalog with localized copy and no connection configuration", async () => {
    const app = registered({ publicOrigin: OFFICIAL_PUBLIC_ORIGIN, origins: [] });
    const response = await app.inject({
      method: "GET",
      url: PUBLIC_MCP_SERVERS_PATH,
      headers: { origin: OFFICIAL_ORIGINS[1] },
    });
    expect(response.statusCode).toBe(200);
    const body = PublicMcpCatalogResponseSchema.parse(response.json());
    expect(body.categories).toEqual(
      MCP_CATALOG_CATEGORIES.map((category) => ({
        id: category.id,
        label: { ...category.label },
        order: category.order,
      })),
    );
    expect(body.servers).toEqual(
      MCP_CATALOG_ENTRIES.map((entry) => ({
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
    );
    for (const server of body.servers) {
      expect(Object.keys(server).sort()).toEqual([
        "category",
        "defaultAuthKind",
        "description",
        "iconUrl",
        "id",
        "name",
        "order",
        "title",
        "website",
      ]);
      expect(server.title.en.length).toBeGreaterThan(0);
      expect(server.title.zh.length).toBeGreaterThan(0);
    }
  });

  it("echoes only the effective allowlist and always varies on Origin", async () => {
    const app = registered({ publicOrigin: OFFICIAL_PUBLIC_ORIGIN, origins: [CONFIGURED_ORIGIN] });
    for (const origin of [...OFFICIAL_ORIGINS, CONFIGURED_ORIGIN]) {
      const response = await app.inject({ method: "GET", url: PUBLIC_SKILLS_PATH, headers: { origin } });
      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
      expect(response.headers.vary).toBe("Origin");
    }

    const denied = await app.inject({
      method: "GET",
      url: PUBLIC_SKILLS_PATH,
      headers: { origin: "https://unlisted.example" },
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    expect(denied.headers.vary).toBe("Origin");
  });

  it("serves requests without an Origin and emits no grant", async () => {
    const app = registered({ publicOrigin: OFFICIAL_PUBLIC_ORIGIN, origins: [] });
    const response = await app.inject({ method: "GET", url: PUBLIC_MCP_SERVERS_PATH });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers a GET preflight for an allowed origin", async () => {
    const app = registered({ publicOrigin: OFFICIAL_PUBLIC_ORIGIN, origins: [] });
    const response = await app.inject({
      method: "OPTIONS",
      url: PUBLIC_SKILLS_PATH,
      headers: { origin: OFFICIAL_ORIGINS[1], "access-control-request-method": "GET" },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(OFFICIAL_ORIGINS[1]);
    expect(response.headers["access-control-allow-methods"]).toBe("GET");
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(response.headers.vary).toBe("Origin");
  });

  it("refuses a preflight that asks for custom headers", async () => {
    const app = registered({ publicOrigin: OFFICIAL_PUBLIC_ORIGIN, origins: [] });
    const response = await app.inject({
      method: "OPTIONS",
      url: PUBLIC_SKILLS_PATH,
      headers: {
        origin: OFFICIAL_ORIGINS[0],
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-custom",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("marks catalog responses public and cacheable", async () => {
    const app = registered({ publicOrigin: OFFICIAL_PUBLIC_ORIGIN, origins: [] });
    for (const path of [PUBLIC_SKILLS_PATH, PUBLIC_MCP_SERVERS_PATH]) {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.headers["cache-control"]).toBe("public, max-age=300");
    }
  });

  it("does not register on a deployment with neither the official origin nor configured origins", async () => {
    const app = registered({ publicOrigin: "https://dev.opentag.build", origins: [] });
    for (const path of [PUBLIC_SKILLS_PATH, PUBLIC_MCP_SERVERS_PATH]) {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode).toBe(404);
    }
  });

  it("registers on another deployment once an origin is configured, keeping the built-ins", async () => {
    const app = registered({ publicOrigin: "https://dev.opentag.build", origins: [CONFIGURED_ORIGIN] });
    for (const origin of [...OFFICIAL_ORIGINS, CONFIGURED_ORIGIN]) {
      const response = await app.inject({
        method: "GET",
        url: PUBLIC_SKILLS_PATH,
        headers: { origin },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
    }
  });
});

describe("public catalog composition", () => {
  function composed(options: { publicOrigin?: string; origins?: readonly string[] }) {
    const app = createApp({
      ...(options.publicOrigin
        ? {
            browserAuth: {
              publicOrigin: options.publicOrigin,
              secureCookies: true,
              sessionTtlSeconds: 3600,
            },
          }
        : {}),
      ...(options.origins ? { publicCatalog: { origins: options.origins } } : {}),
    });
    apps.push(app);
    return app;
  }

  it("serves the official deployment without any catalog configuration", async () => {
    const app = composed({ publicOrigin: OFFICIAL_PUBLIC_ORIGIN });
    const cases = [
      [PUBLIC_SKILLS_PATH, OFFICIAL_ORIGINS[0]],
      [PUBLIC_MCP_SERVERS_PATH, OFFICIAL_ORIGINS[1]],
    ] as const;
    for (const [path, origin] of cases) {
      const response = await app.inject({ method: "GET", url: path, headers: { origin } });
      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
    }
  });

  it("stays absent on another deployment until an origin is configured", async () => {
    const hidden = composed({ publicOrigin: "https://dev.opentag.build" });
    for (const path of [PUBLIC_SKILLS_PATH, PUBLIC_MCP_SERVERS_PATH]) {
      expect((await hidden.inject({ method: "GET", url: path })).statusCode).toBe(404);
    }

    const configured = composed({ publicOrigin: "https://dev.opentag.build", origins: [CONFIGURED_ORIGIN] });
    for (const origin of [...OFFICIAL_ORIGINS, CONFIGURED_ORIGIN]) {
      const response = await configured.inject({
        method: "GET",
        url: PUBLIC_MCP_SERVERS_PATH,
        headers: { origin },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
    }
  });

  it("carries no credential into the anonymous read", async () => {
    const app = composed({ publicOrigin: OFFICIAL_PUBLIC_ORIGIN });
    const response = await app.inject({
      method: "GET",
      url: PUBLIC_SKILLS_PATH,
      headers: {
        origin: OFFICIAL_ORIGINS[0],
        cookie: "opentag.session=session",
        authorization: "Bearer token",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});
