FROM node:24-bookworm AS build

WORKDIR /src
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli/package.json apps/cli/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile --config.engine-strict=true

COPY tsconfig.json ./
COPY apps/cli apps/cli
COPY packages/client packages/client
COPY packages/shared packages/shared
RUN pnpm --filter @opentag/shared build \
  && pnpm --filter @opentag/client build \
  && pnpm --filter open-tag build

FROM node:24-bookworm AS systemd-runner

ENV container=docker
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends dbus dbus-user-session systemd systemd-sysv \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/apps/cli/dist /opt/opentag/apps/cli/dist
COPY scripts/e2e/doctor-docker/fault-server.mjs /opt/doctor-e2e/fault-server.mjs
COPY scripts/e2e/doctor-docker/scenario-runner.mjs /opt/doctor-e2e/scenario-runner.mjs

RUN chmod 0755 /opt/opentag/apps/cli/dist/cli/index.mjs \
  && ln -s /opt/opentag/apps/cli/dist/cli/index.mjs /usr/local/bin/opentag-dev \
  && mkdir -p /home/node/doctor-e2e \
  && chown -R node:node /home/node/doctor-e2e

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

FROM node:24-alpine AS minimal-runner

COPY --from=build /src/apps/cli/dist /opt/opentag/apps/cli/dist
COPY scripts/e2e/doctor-docker/scenario-runner.mjs /opt/doctor-e2e/scenario-runner.mjs

RUN chmod 0755 /opt/opentag/apps/cli/dist/cli/index.mjs \
  && ln -s /opt/opentag/apps/cli/dist/cli/index.mjs /usr/local/bin/opentag-dev

ENTRYPOINT ["node", "/opt/doctor-e2e/scenario-runner.mjs"]
