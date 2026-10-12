FROM node:24-alpine AS deps

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY packages/shared/package.json packages/shared/package.json
COPY packages/skill-presets/package.json packages/skill-presets/package.json
COPY packages/mcp-presets/package.json packages/mcp-presets/package.json
COPY packages/server/package.json packages/server/package.json
COPY apps/web/package.json apps/web/package.json
# Only install inputs are copied here, so lifecycle scripts are skipped: the root `prepare` installs
# local Git hooks from `scripts/`, which the image neither ships nor needs.
RUN pnpm install --frozen-lockfile --config.engine-strict=true --ignore-scripts --filter @opentag/server... --filter @opentag/web...

FROM deps AS build

# The release identity the Web App stamps into error reports: the image workflows pass the commit SHA,
# and a self-built image should pass its own tag or SHA. Empty falls back to the manifest version.
ARG OPENTAG_WEB_VERSION=""
ENV OPENTAG_WEB_VERSION=${OPENTAG_WEB_VERSION}

COPY tsconfig.json ./
COPY packages/shared packages/shared
COPY packages/skill-presets packages/skill-presets
COPY packages/mcp-presets packages/mcp-presets
COPY packages/server packages/server
COPY apps/web apps/web
RUN pnpm --filter @opentag/shared build
RUN pnpm --filter @opentag/skill-presets build
RUN pnpm --filter @opentag/mcp-presets build
RUN pnpm --filter @opentag/web build
RUN pnpm --filter @opentag/server build

FROM node:24-alpine AS prod-deps

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY packages/shared/package.json packages/shared/package.json
COPY packages/skill-presets/package.json packages/skill-presets/package.json
COPY packages/mcp-presets/package.json packages/mcp-presets/package.json
COPY packages/server/package.json packages/server/package.json
RUN pnpm install --frozen-lockfile --config.engine-strict=true --ignore-scripts --prod --filter @opentag/server...

FROM node:24-alpine AS application

ARG OPENTAG_BUILD_REVISION
ENV OPENTAG_BUILD_REVISION=${OPENTAG_BUILD_REVISION}

WORKDIR /app
COPY --from=prod-deps /app ./
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/skill-presets/dist packages/skill-presets/dist
COPY --from=build /app/packages/mcp-presets/dist packages/mcp-presets/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/server/drizzle packages/server/drizzle
COPY --from=build /app/apps/web/dist apps/web/dist
COPY LICENSE /app/LICENSE

RUN apk add --no-cache git openssh-client ca-certificates \
  && addgroup -S opentag && adduser -S -G opentag opentag

ENV NODE_ENV=production
ENV OPENTAG_ENV=prod
ENV OPENTAG_HOST=0.0.0.0
ENV OPENTAG_PORT=8000

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8000/healthz >/dev/null || exit 1

USER opentag

CMD ["node", "packages/server/dist/index.mjs"]

# Only the trusted commit-image workflow supplies the private named build context.
FROM node:24-alpine AS billing-deps
WORKDIR /module
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
COPY --from=billing package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM billing-deps AS billing-build
COPY --from=build /app /app
COPY --from=billing tsconfig.json biome.json vitest.config.ts ./
COPY --from=billing scripts/build.mjs scripts/link-application.mjs scripts/
COPY --from=billing src src
COPY --from=billing test test
RUN node scripts/link-application.mjs /app \
  && pnpm lint \
  && pnpm typecheck && pnpm test && pnpm build

FROM billing-deps AS billing-prod-deps
RUN pnpm prune --prod

FROM application AS cloud
ARG OPENTAG_BILLING_REVISION
ENV OPENTAG_BILLING_REVISION=${OPENTAG_BILLING_REVISION}
LABEL org.opentag.billing.revision=${OPENTAG_BILLING_REVISION}
USER root
COPY --from=billing-prod-deps /module/node_modules /opt/opentag-cloud-billing/node_modules
COPY --from=billing-build /module/dist/src /opt/opentag-cloud-billing/dist/src
COPY --from=billing package.json /opt/opentag-cloud-billing/package.json
RUN mkdir -p /opt/opentag-cloud-billing/node_modules/@opentag \
  && ln -s /app/packages/shared /opt/opentag-cloud-billing/node_modules/@opentag/shared \
  && ln -s /app/packages/server /opt/opentag-cloud-billing/node_modules/@opentag/server \
  && ln -s /opt/opentag-cloud-billing /app/packages/server/node_modules/@opentag/cloud-billing
USER opentag

# The default image and pull-request builds remain independent of private source and credentials.
FROM application AS runtime
