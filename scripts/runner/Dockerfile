# OpenTag Cloud Runner base image. linux/amd64 only. Not a Cloud Session.
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS build

ARG PNPM_VERSION
ARG RUNNER_CHANNEL=dev
ARG RUNNER_VERSION
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json LICENSE ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/server/package.json packages/server/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/web/package.json apps/web/package.json
COPY e2e/package.json e2e/package.json
RUN pnpm install --frozen-lockfile --config.engine-strict=true --ignore-scripts

COPY packages/shared packages/shared
COPY packages/client packages/client
COPY apps/cli apps/cli
COPY scripts scripts
COPY runner-identity.json runner-identity.json

RUN if [ "${RUNNER_CHANNEL}" != "dev" ]; then \
      node scripts/prepare-cli-release.mjs --channel "${RUNNER_CHANNEL}" --version "${RUNNER_VERSION}" \
        --manifest apps/cli/package.json --build-info apps/cli/src/build-info.ts; \
    fi \
 && pnpm --filter @opentag/shared build \
 && pnpm --filter @opentag/client build \
 && pnpm --filter ./apps/cli build \
 && mkdir -p /out \
 && node /src/scripts/runner/assemble-runtime.mjs

FROM ${NODE_IMAGE} AS runtime

# Keep the image default PATH (includes /usr/sbin) until the runner user exists.
# Git 2.39.5 is already in this digest-pinned Node bookworm image; do not re-open Debian.
RUN /usr/sbin/groupadd --gid 10000 runner \
 && /usr/sbin/useradd --uid 10000 --gid runner --home-dir /home/runner --create-home --shell /usr/sbin/nologin runner \
 && mkdir -p /workspace \
 && chown runner:runner /home/runner /workspace \
 && chmod 0700 /home/runner /workspace \
 && git --version | grep -F "git version 2.39.5"

COPY --from=build /out/opt /opt
COPY --from=build /out/usr /usr
RUN chmod 0755 /usr/local/bin/runner-entrypoint /usr/local/bin/opentag-runner /usr/local/bin/opentag \
 && chmod -R a-w /opt/opentag /usr/local/bin \
 && chmod -R a+rX /opt/opentag /usr/local/bin

ENV NODE_ENV=production \
    HOME=/home/runner \
    TMPDIR=/tmp \
    OPENTAG_WORKSPACE=/workspace \
    PATH=/usr/local/bin:/opt/opentag/tools/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin \
    PI_TELEMETRY=0

USER runner
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/runner-entrypoint"]
CMD ["opentag-runner"]
