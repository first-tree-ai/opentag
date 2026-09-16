import {
  assertFixedResources,
  docker,
  inspectImage,
  inspectRunnerContainer,
  measureRunnerStartup,
  removeContainer,
  runLimitedContainer,
} from "./harness.mjs";

function requireZero(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed:\n${result.stdout}\n${result.stderr}`);
}

function requireNonZero(result, label) {
  if (result.status === 0) throw new Error(`${label} unexpectedly succeeded:\n${result.stdout}`);
}

function parseMarker(stdout, name) {
  const match = new RegExp(`__${name}__=(.+)`).exec(stdout);
  return match?.[1]?.trim();
}

export async function runOfflineSmoke({ image, prefix }) {
  const imageInfo = await inspectImage(image);

  // Fresh container + Runner CLI startup, measured separately from the full probe/acceptance.
  const startup = await measureRunnerStartup({ image, name: `${prefix}-startup` });
  await removeContainer(`${prefix}-startup`);

  const probeName = `${prefix}-probe`;
  const probeStarted = Date.now();
  const probe = await runLimitedContainer({
    image,
    name: probeName,
    args: [
      "sh",
      "-c",
      "opentag-runner probe --json; status=$?; echo __MEMORY_PEAK__=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null || true); exit $status",
    ],
  });
  const probeMs = Date.now() - probeStarted;
  requireZero(probe, "offline probe");
  const inspect = await inspectRunnerContainer(probeName);
  assertFixedResources(inspect);
  const memoryPeak = parseMarker(probe.stdout, "MEMORY_PEAK");
  if (!memoryPeak) {
    throw new Error(`memory.peak was not captured inside the probe container:\n${probe.stdout}`);
  }
  await removeContainer(probeName);

  const skillsStarted = Date.now();
  const skills = await runLimitedContainer({
    image,
    name: `${prefix}-skills`,
    args: ["opentag-runner", "skills", "--json"],
  });
  const skillsMs = Date.now() - skillsStarted;
  requireZero(skills, "skills");
  await removeContainer(`${prefix}-skills`);

  const acceptStarted = Date.now();
  const accept = await runLimitedContainer({
    image,
    name: `${prefix}-accept`,
    args: ["opentag-runner", "accept", "--json"],
  });
  const acceptMs = Date.now() - acceptStarted;
  requireZero(accept, "offline accept");
  const acceptLines = accept.stdout
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("{"));
  const acceptJson = JSON.parse(acceptLines.at(-1) ?? "{}");
  if (acceptJson.model !== "skipped") throw new Error("offline accept must report model skipped");
  if (acceptJson.offline !== "passed") throw new Error("offline accept must pass offline checks");
  await removeContainer(`${prefix}-accept`);

  const invalid = await runLimitedContainer({
    image,
    name: `${prefix}-invalid`,
    args: ["opentag-runner"],
    allowFailure: true,
  });
  requireNonZero(invalid, "missing command");
  await removeContainer(`${prefix}-invalid`);

  const first = await runLimitedContainer({
    image,
    name: `${prefix}-residue-a`,
    args: [
      "sh",
      "-c",
      "echo leftover > /workspace/stale.txt && mkdir -p /home/runner/.pi && echo cfg > /home/runner/.pi/auth.json",
    ],
  });
  requireZero(first, "residue seed");
  await removeContainer(`${prefix}-residue-a`);
  const second = await runLimitedContainer({
    image,
    name: `${prefix}-residue-b`,
    args: ["sh", "-c", "test ! -e /workspace/stale.txt && test ! -e /home/runner/.pi && test ! -e /tmp/stale.txt"],
  });
  requireZero(second, "fresh container residue");
  await removeContainer(`${prefix}-residue-b`);

  const daemonArch = (await docker(["version", "--format", "{{.Server.Arch}}"])).stdout.trim();
  return {
    inspect,
    image: imageInfo,
    startupMs: startup.startupMs,
    durations: { probeMs, skillsMs, acceptMs },
    memoryPeak,
    daemonArch,
    emulation:
      daemonArch !== "amd64"
        ? "docker daemon is not amd64; linux/amd64 ran under emulation and does not prove native Cloud Run/Sandbox"
        : "linux/amd64 native on this docker daemon; still does not prove Cloud Run, Sandbox, or IM",
    offline: { probe: probe.stdout, skills: skills.stdout, accept: acceptJson },
    cleanup: { containersRemoved: true },
  };
}
