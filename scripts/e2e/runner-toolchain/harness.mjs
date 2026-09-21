import { spawnSync } from "node:child_process";
import { runProcess } from "../../runner/async-process.mjs";
import { registerCleanup } from "../../runner/cleanup.mjs";
import { runnerResourceLimits } from "../../runner/pins.mjs";

export const RUNNER_DOCKER_LIMITS = runnerResourceLimits();

const DEFAULT_DOCKER_TIMEOUT_MS = 15 * 60 * 1000;

/** Async, interruptible docker execution; SIGTERM/SIGINT kill the child before cleanup runs. */
export async function docker(args, options = {}) {
  const result = await runProcess("docker", args, { timeoutMs: options.timeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const removalBackstops = new Map();

function registerRemovalBackstop(name) {
  if (removalBackstops.has(name)) throw new Error(`container name is already registered: ${name}`);
  removalBackstops.set(
    name,
    registerCleanup(() => removeContainerQuietly(name)),
  );
}

function removeContainerQuietly(name) {
  // Best-effort backstop also used on the signal path; spawnSync is correct while exiting.
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 60_000 });
}

export async function inspectImage(tag) {
  const output = (
    await docker(["image", "inspect", "--format", "{{.Id}} {{.Architecture}} {{.Os}} {{.Size}}", tag])
  ).stdout
    .trim()
    .split(/\s+/);
  return { id: output[0], architecture: output[1], os: output[2], size: Number(output[3]) };
}

export async function inspectRunnerContainer(name) {
  const host = (
    await docker([
      "inspect",
      "--format",
      "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.Image}} {{.Config.User}}",
      name,
    ])
  ).stdout
    .trim()
    .split(/\s+/);
  const imageId = host[3];
  const image = await inspectImage(imageId);
  return {
    nanoCpus: Number(host[0]),
    memory: Number(host[1]),
    memorySwap: Number(host[2]),
    user: host[4],
    imageId: image.id,
    architecture: image.architecture,
    os: image.os,
    size: image.size,
  };
}

export function assertFixedResources(inspect) {
  // The image default user is root so the exact `opentag-runner serve` path can launch the native
  // sandbox; the entrypoint still drops every other command to uid/gid 10000.
  if (inspect.architecture !== "amd64" || inspect.os !== "linux" || inspect.user !== "root") {
    throw new Error("expected a Linux amd64 image whose default user is root for the native sandbox launcher");
  }
  const limits = RUNNER_DOCKER_LIMITS;
  if (inspect.nanoCpus !== limits.nanoCpus) {
    throw new Error(`expected ${limits.nanoCpus} nano CPUs, got ${inspect.nanoCpus}`);
  }
  if (inspect.memory !== limits.memoryBytes) {
    throw new Error(`expected ${limits.memoryBytes} bytes memory, got ${inspect.memory}`);
  }
  if (inspect.memorySwap !== limits.memoryBytes) {
    throw new Error(`expected memory-swap ${limits.memoryBytes}, got ${inspect.memorySwap}`);
  }
}

const LIMITED_ARGS = [
  "--platform",
  "linux/amd64",
  "--cpus",
  RUNNER_DOCKER_LIMITS.cpus,
  "--memory",
  RUNNER_DOCKER_LIMITS.memory,
  "--memory-swap",
  RUNNER_DOCKER_LIMITS.memorySwap,
];

export async function runLimitedContainer({
  image,
  name,
  args = [],
  extra = ["--network", "none"],
  allowFailure = false,
  timeoutMs,
}) {
  registerRemovalBackstop(name);
  return docker(["run", "--name", name, ...LIMITED_ARGS, ...extra, image, ...args], { allowFailure, timeoutMs });
}

export async function startGuardContainer({ image, name }) {
  registerRemovalBackstop(name);
  // Indefinite keepalive on the pinned Debian image: a bounded sleep could expire inside the
  // real-accept budget and kill the guard mid-acceptance. Docker --init owns PID 1 so orphaned
  // fixture children are reaped (a zombie is not a gone process). Removal stays with cleanup.
  await docker(["run", "--detach", "--init", "--name", name, ...LIMITED_ARGS, image, "sleep", "infinity"]);
}

/**
 * docker exec does not run the image entrypoint, so the caller must select the runtime user
 * explicitly. Default to the unprivileged runner uid 10000 to preserve the pre-root-image
 * behavior; callers that must write runner-owned paths pass `user` at the docker level (or use
 * a dedicated root exec) instead of silently running as root.
 */
export async function execInContainer(name, args, options = {}) {
  const user = options.user ?? "10000:10000";
  return docker(["exec", "-u", user, name, ...args], options);
}

/** Removal is proven, not assumed: `docker rm` succeeds, the container is verifiably gone. */
export async function removeContainer(name) {
  await docker(["rm", "-f", name]);
  await assertContainerRemoved(name);
  removalBackstops.get(name)?.();
  removalBackstops.delete(name);
}

/**
 * A container is only "removed" when the daemon says it does not exist. Any other error
 * (daemon unavailable, socket failure) is surfaced, never read as success.
 */
export async function assertContainerRemoved(name) {
  const inspect = await docker(["container", "inspect", name], { allowFailure: true });
  if (inspect.status === 0) throw new Error(`container ${name} still exists after cleanup`);
  const detail = `${inspect.stdout}${inspect.stderr}`;
  if (!/No such container|No such object/i.test(detail)) {
    throw new Error(`could not confirm removal of ${name}; docker inspect failed unexpectedly: ${detail.trim()}`);
  }
  return true;
}

export async function assertFreshContainerState(name) {
  const fresh = await execInContainer(
    name,
    [
      "sh",
      "-c",
      'test ! -e /tmp/pi-config && test ! -e /home/runner/.pi && test -z "$(ls -A /workspace)" && test -z "$(ls -A /tmp)"',
    ],
    { allowFailure: true },
  );
  if (fresh.status !== 0) {
    throw new Error(`fresh container already holds config or workspace residue:\n${fresh.stdout}\n${fresh.stderr}`);
  }
  return true;
}

export async function readMemoryPeak(name) {
  const result = await docker(
    [
      "exec",
      name,
      "sh",
      "-c",
      "cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null || true",
    ],
    { allowFailure: true },
  );
  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
}

/**
 * Scoped credential injection: only the pre-filtered staging directory is copied, never a whole
 * HOME. `docker cp` has no --chown flag, so ownership and the strict 0700/0600 modes are fixed
 * through a one-shot root exec; the runtime user (uid 10000) reads exactly this directory.
 */
export async function copyConfigIntoContainer(name, stagingDir) {
  await docker(["cp", `${stagingDir}/.`, `${name}:/tmp/pi-config`]);
  await docker([
    "exec",
    "-u",
    "0",
    name,
    "sh",
    "-c",
    "chown -R 10000:10000 /tmp/pi-config && chmod 0700 /tmp/pi-config && find /tmp/pi-config -type f -exec chmod 0600 {} +",
  ]);
}

/**
 * Times a fresh container running the Runner `identity` command: container create+start plus
 * Runner CLI startup, separate from probe/acceptance durations. Returns { startupMs, output }.
 */
export async function measureRunnerStartup({ image, name }) {
  const started = Date.now();
  const result = await runLimitedContainer({ image, name, args: ["opentag-runner", "identity", "--json"] });
  return { startupMs: Date.now() - started, output: result.stdout.trim() };
}
