# Docker doctor fault suite

This local-only black-box suite runs the built `opentag doctor` CLI across real
container process, filesystem, TCP, HTTP, PostgreSQL, OpenTag Server, and Linux
systemd boundaries.

Run it from the repository root:

```sh
pnpm test:e2e:doctor-docker
```

The suite builds two CLI runners and the production OpenTag Server image. It
then creates an isolated Docker network containing:

- an Alpine runner with no supported service manager;
- a privileged Debian runner booted with systemd as PID 1 and a real user
  manager for the unprivileged `node` account;
- a real PostgreSQL-backed OpenTag Server;
- independent fault-server containers for healthy, HTTP 503, invalid schema,
  hanging response, zero-request sentinel, and daemon connection scenarios.

The scenarios execute the built CLI entrypoint and assert the command's process
exit status, stdout/stderr contract, filesystem immutability, network request
counts, response redaction, wall-clock deadline, Runtime artifact rules, and
systemd service state. The systemd scenarios perform a real `daemon install`,
reach a fully passing P0 baseline, and then inject wrong-Home, drifted,
malformed, and stopped-service failures.

The systemd runner requires Docker's `--privileged` mode and a writable cgroup
mount. All created containers, networks, and tagged images are removed after
the run. Pass `--keep` directly to `scripts/e2e/doctor-docker.mjs` to preserve
them for debugging.

This suite proves the Linux behavior inside Docker Desktop's Linux VM. It does
not replace release QA on a separately installed physical or virtual Linux
host, and it does not cover deferred Runtime authentication, Integration CLI,
machine-token/WebSocket registration, or end-to-end Turn delivery.
