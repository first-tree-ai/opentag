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
 && node /src/scripts/runner/assemble-runtime.mjs \
 && cc -O2 -Wall -Wextra -Werror -o /out/usr/local/bin/opentag-init /src/scripts/runner/init.c

# Clean room for the native sandbox: the same runtime filesystem, assembled at IMAGE BUILD time
# as a self-contained rootfs. The Runner never copies the runtime host / at run time, and the
# default sandbox behavior (host root exposed read-only) is never used.
FROM ${NODE_IMAGE} AS runtime-rootfs

COPY --from=build /out/opt /opt
COPY --from=build /out/usr /usr
RUN mkdir -p /workspace /tmp \
 && chmod 1777 /tmp \
 && chmod 0755 /workspace \
 && chmod 0755 /usr/local/bin/runner-entrypoint /usr/local/bin/opentag-runner /usr/local/bin/opentag /usr/local/bin/opentag-init \
 && chmod -R a-w /opt/opentag /usr/local/bin \
 && chmod -R a+rX /opt/opentag /usr/local/bin

FROM ${NODE_IMAGE} AS runtime

# Keep the image default PATH (includes /usr/sbin) until the runner user exists.
# Git 2.39.5 is already in this digest-pinned Node bookworm image; do not re-open Debian.
RUN /usr/sbin/groupadd --gid 10000 runner \
 && /usr/sbin/useradd --uid 10000 --gid runner --home-dir /home/runner --create-home --shell /usr/sbin/nologin runner \
 && mkdir -p /workspace \
 && chown runner:runner /home/runner /workspace \
 && chmod 0700 /home/runner /workspace \
 && git --version | grep -F "git version 2.39.5"

# setpriv is supplied by util-linux in the digest-pinned base image; nothing is downloaded or
# installed here. Assert both its provenance and the exact drop the entrypoint performs.
RUN /usr/bin/setpriv --version | grep -F "setpriv from util-linux" \
 && test "$(/usr/bin/setpriv --reuid=10000 --regid=10000 --clear-groups -- id -u)" = "10000" \
 && test "$(/usr/bin/setpriv --reuid=10000 --regid=10000 --clear-groups -- id -G)" = "10000"

COPY --from=build /out/opt /opt
COPY --from=build /out/usr /usr
RUN chmod 0755 /usr/local/bin/runner-entrypoint /usr/local/bin/opentag-runner /usr/local/bin/opentag /usr/local/bin/opentag-init \
 && chmod -R a-w /opt/opentag /usr/local/bin \
 && chmod -R a+rX /opt/opentag /usr/local/bin

# Immutable, clean native-sandbox root filesystem: a build-time copy of the runtime-rootfs stage
# (which carries no user setup, no HOME, no workspace, no runtime state). Read-only to the runner
# user; the bootstrap token and parent state are not in it.
COPY --from=runtime-rootfs / /opt/sandbox-root
RUN touch /opt/sandbox-root/etc/resolv.conf \
 && chmod 0555 /opt/sandbox-root

ENV NODE_ENV=production \
    HOME=/home/runner \
    TMPDIR=/tmp \
    OPENTAG_WORKSPACE=/workspace \
    PATH=/usr/local/bin:/opt/opentag/tools/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin \
    PI_TELEMETRY=0

# The image default user is root because the Cloud Run native sandbox launcher requires the
# Instance parent process to run as root. runner-entrypoint immediately drops every non-serve
# command to uid/gid 10000 with supplementary groups cleared; only the exact
# `opentag-runner serve` invocation keeps root and runs under the source-owned opentag-init.
USER root
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/runner-entrypoint"]
CMD ["opentag-runner"]
