FROM node:24-alpine AS deps

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
RUN pnpm install --frozen-lockfile --config.engine-strict=true --filter @opentag/server...

FROM deps AS build

COPY tsconfig.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
RUN pnpm --filter @opentag/shared build
RUN pnpm --filter @opentag/server build

FROM node:24-alpine AS prod-deps

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
RUN pnpm install --frozen-lockfile --config.engine-strict=true --prod --filter @opentag/server...

FROM node:24-alpine AS runtime

WORKDIR /app
COPY --from=prod-deps /app ./
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY LICENSE /app/LICENSE

RUN addgroup -S opentag && adduser -S -G opentag opentag

ENV NODE_ENV=production
ENV OPENTAG_HOST=0.0.0.0
ENV OPENTAG_PORT=8000

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8000/healthz >/dev/null || exit 1

USER opentag

CMD ["node", "packages/server/dist/index.mjs"]
