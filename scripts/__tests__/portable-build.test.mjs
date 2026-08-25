import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CHANNEL_CONFIG } from "../channel-config.mjs";
import {
  APP_ENTRY,
  artifactDownloadUrl,
  artifactFileName,
  assertBundledCliHasNoRuntimeDependencies,
  buildPortableReleaseMetadata,
  DEFAULT_DOWNLOAD_BASE_URL,
  getPortableChannelConfig,
  hostPlatform,
  manifestDownloadUrl,
  normalizeDownloadBaseUrl,
  normalizeGeneratedAt,
  normalizeNodeVersion,
  PORTABLE_PLATFORMS,
  parsePlatform,
  portableAppPackageJson,
  portableArtifactShim,
  portableTarCreateArgs,
  readDefaultNodeVersion,
  renderInstallerForChannel,
  tarOwnershipArgs,
  validateChannelVersion,
} from "../portable/build-portable.mjs";

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const portableDir = join(scriptsDir, "portable");

test("portable coordinates follow the published npm channel identities", () => {
  assert.deepEqual(getPortableChannelConfig("prod"), CHANNEL_CONFIG.prod);
  assert.deepEqual(getPortableChannelConfig("staging"), CHANNEL_CONFIG.staging);
  assert.throws(() => getPortableChannelConfig("dev"), /--channel must be one of/);

  validateChannelVersion("prod", "1.2.3");
  validateChannelVersion("staging", "0.0.2-staging.4.1");
  assert.throws(() => validateChannelVersion("prod", "0.0.2-staging.4.1"), /stable semantic version/);
  assert.throws(() => validateChannelVersion("staging", "1.2.3"), /staging semantic version/);
});

test("artifact names and download URLs stay derivable from the release coordinates", () => {
  assert.equal(
    artifactFileName({ packageName: "open-tag", platform: "linux-x64", version: "1.2.3" }),
    "open-tag-1.2.3-linux-x64.tar.gz",
  );
  assert.throws(
    () => artifactFileName({ packageName: "open-tag", platform: "windows-x64", version: "1.2.3" }),
    /unsupported portable platform/,
  );
  assert.deepEqual(parsePlatform("darwin-arm64"), { arch: "arm64", os: "darwin" });
  assert.equal(hostPlatform("darwin", "arm64"), "darwin-arm64");
  assert.equal(hostPlatform("win32", "x64"), null);

  assert.equal(
    artifactDownloadUrl({
      channel: "prod",
      downloadBaseUrl: `${DEFAULT_DOWNLOAD_BASE_URL}/`,
      fileName: "open-tag-1.2.3-linux-x64.tar.gz",
      version: "1.2.3",
    }),
    "https://download.opentag.build/releases/prod/1.2.3/open-tag-1.2.3-linux-x64.tar.gz",
  );
  assert.equal(
    manifestDownloadUrl({
      channel: "staging",
      downloadBaseUrl: DEFAULT_DOWNLOAD_BASE_URL,
      version: "0.0.2-staging.4.1",
    }),
    "https://download.opentag.build/releases/staging/0.0.2-staging.4.1/manifest.json",
  );
});

test("download base URLs reject inputs that would publish to the wrong prefix", () => {
  assert.equal(
    normalizeDownloadBaseUrl("https://download.opentag.build/releases//"),
    "https://download.opentag.build/releases",
  );
  assert.throws(
    () => normalizeDownloadBaseUrl("https://download.opentag.build/releases/prod"),
    /must not include the channel segment/,
  );
  assert.throws(() => normalizeDownloadBaseUrl("http://download.opentag.build/releases"), /must use https/);
  assert.throws(() => normalizeDownloadBaseUrl(""), /is required/);
  // Local endpoints stay usable so an installer can be exercised without a public bucket.
  assert.equal(normalizeDownloadBaseUrl("http://127.0.0.1:8799"), "http://127.0.0.1:8799");
});

test("release metadata pins the version manifest the channel pointer resolves to", () => {
  const assets = [
    {
      platform: "linux-x64",
      fileName: "open-tag-1.2.3-linux-x64.tar.gz",
      url: "https://download.opentag.build/releases/prod/1.2.3/open-tag-1.2.3-linux-x64.tar.gz",
      sha256: "a".repeat(64),
      size: 42,
    },
  ];
  const { latest, manifest } = buildPortableReleaseMetadata({
    assets,
    channel: "prod",
    channelConfig: CHANNEL_CONFIG.prod,
    downloadBaseUrl: DEFAULT_DOWNLOAD_BASE_URL,
    generatedAt: "2026-08-25T00:00:00Z",
    gitSha: "b".repeat(40),
    nodeVersion: "v24.19.0",
    version: "1.2.3",
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.binName, "opentag");
  assert.equal(manifest.packageName, "open-tag");
  assert.equal(manifest.generatedAt, "2026-08-25T00:00:00.000Z");
  assert.deepEqual(manifest.assets, assets);
  assert.equal(manifest.manifestUrl, undefined);
  assert.equal(latest.manifestUrl, "https://download.opentag.build/releases/prod/1.2.3/manifest.json");
});

test("normalizers fail closed on inexact release inputs", () => {
  assert.equal(normalizeNodeVersion("24.19.0"), "v24.19.0");
  assert.equal(normalizeNodeVersion(" v24.19.0\n"), "v24.19.0");
  assert.throws(() => normalizeNodeVersion("24"), /exact Node\.js version/);
  assert.throws(() => normalizeNodeVersion("lts/*"), /exact Node\.js version/);
  assert.equal(readDefaultNodeVersion(), normalizeNodeVersion(readDefaultNodeVersion()));

  assert.equal(normalizeGeneratedAt("2026-08-25T00:00:00Z"), "2026-08-25T00:00:00.000Z");
  assert.throws(() => normalizeGeneratedAt("not-a-date"), /valid timestamp/);
  assert.throws(() => normalizeGeneratedAt(""), /requires a timestamp value/);
});

test("the portable app manifest exposes exactly one channel binary and no runtime dependencies", () => {
  const sourcePackage = {
    description: "OpenTag command-line interface",
    engines: { node: "^24.0.0" },
    license: "Apache-2.0",
    repository: { type: "git", url: "git+https://github.com/first-tree-ai/opentag.git" },
  };
  const appPackage = portableAppPackageJson({ channelConfig: CHANNEL_CONFIG.prod, sourcePackage, version: "1.2.3" });
  assert.equal(appPackage.name, "open-tag");
  assert.equal(appPackage.version, "1.2.3");
  assert.deepEqual(appPackage.bin, { opentag: "./cli/index.mjs" });
  assert.equal(appPackage.dependencies, undefined);

  assertBundledCliHasNoRuntimeDependencies(sourcePackage);
  assert.throws(
    () => assertBundledCliHasNoRuntimeDependencies({ dependencies: { commander: "^13.1.0" } }),
    /ships without node_modules/,
  );
  assert.throws(
    () => assertBundledCliHasNoRuntimeDependencies({ optionalDependencies: { bufferutil: "^4.0.0" } }),
    /ships without node_modules/,
  );
});

test("tar arguments erase build-machine identity for byte-reproducible retries", () => {
  assert.deepEqual(tarOwnershipArgs("gnu"), ["--owner=0", "--group=0", "--numeric-owner"]);
  assert.deepEqual(tarOwnershipArgs("bsd"), ["--uid", "0", "--gid", "0", "--uname", "", "--gname", ""]);
  assert.throws(() => tarOwnershipArgs("pax"), /unsupported tar flavor/);

  const args = portableTarCreateArgs({
    fileListPath: "/tmp/files.txt",
    sourceDir: "/tmp/artifact",
    tarballPath: "/tmp/payload.tar",
    tarFlavor: "gnu",
  });
  assert.deepEqual(args, [
    "--no-recursion",
    "--no-xattrs",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "-cf",
    "/tmp/payload.tar",
    "-C",
    "/tmp/artifact",
    "-T",
    "/tmp/files.txt",
  ]);
});

test("the artifact shim runs the embedded runtime through relative paths only", () => {
  const shim = portableArtifactShim();
  assert.match(shim, /^#!\/bin\/sh\n/);
  assert.match(shim, /export OPENTAG_INSTALL_MODE=portable/);
  assert.match(shim, new RegExp(`exec "\\$root/node/bin/node" "\\$root/${APP_ENTRY}" "\\$@"`));
  assert.doesNotMatch(shim, /\/(Users|home|tmp)\//, "the shim must not embed a build machine path");
});

test("rendered installers pin the channel and base URL they were released with", async () => {
  const template = await readFile(join(portableDir, "install.sh"), "utf8");
  const rendered = renderInstallerForChannel("staging", "https://download.opentag.build/releases", template);
  assert.match(rendered, /PORTABLE_CHANNEL="\$\{OPENTAG_PORTABLE_CHANNEL:-staging\}"/);
  assert.match(
    rendered,
    /DOWNLOAD_BASE_URL="\$\{OPENTAG_PORTABLE_DOWNLOAD_BASE_URL:-https:\/\/download\.opentag\.build\/releases\}"/,
  );
  assert.throws(
    () => renderInstallerForChannel("dev", DEFAULT_DOWNLOAD_BASE_URL, template),
    /unsupported installer channel/,
  );
  assert.throws(
    () => renderInstallerForChannel("prod", DEFAULT_DOWNLOAD_BASE_URL, "#!/bin/sh\n"),
    /missing the portable channel fallback/,
  );
});

test("the installer only commits a release after it verifies and smoke-tests the payload", async () => {
  const source = await readFile(join(portableDir, "install.sh"), "utf8");
  await access(join(portableDir, "install.sh"), constants.X_OK);

  const checksumIndex = source.indexOf('die "checksum mismatch for portable payload');
  const smokeIndex = source.indexOf("portable payload failed the pre-commit runtime smoke check");
  const shimIndex = source.indexOf('write_shim "$BIN_DIR/$BIN_NAME"');
  const commitIndex = source.indexOf('atomic_replace_current_link "$NEW_LINK" "$CURRENT_LINK"');
  assert.ok(
    checksumIndex > 0 && smokeIndex > checksumIndex,
    "the payload checksum must be verified before it is executed",
  );
  assert.ok(shimIndex > smokeIndex, "the stable shim must only be written after the smoke check passes");
  assert.ok(commitIndex > shimIndex, "the current symlink is the final commit point");

  // The smoke check must run on the extracted payload, before an existing install is replaced.
  const swapIndex = source.indexOf('mv "$TEMP_VERSION_DIR" "$FINAL_VERSION_DIR"');
  assert.ok(swapIndex > smokeIndex, "an existing install must not be replaced before the new runtime is proven");
  assert.match(source, /"\$VALIDATION_DIR\/node\/bin\/node" "\$VALIDATION_DIR\/\$INSTALL_ENTRY" --version/);

  // The up-to-date short-circuit must decide before the payload download, or it saves nothing.
  const shortCircuitIndex = source.indexOf("already installed and up to date");
  const payloadDownloadIndex = source.indexOf('download_to "$ASSET_URL" "$TARBALL"');
  assert.ok(shortCircuitIndex > 0 && shortCircuitIndex < payloadDownloadIndex);
  assert.match(source, /if \[ "\$FORCE" -eq 0 \] && portable_install_is_current "\$VERSION" "\$BIN_NAME"; then/);
});

test("the installer help documents the supported options", () => {
  const result = spawnSync("sh", [join(portableDir, "install.sh"), "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  for (const flag of ["--version", "--prefix", "--bin-dir", "--force", "--no-path-edit", "--path-mode"]) {
    assert.ok(result.stdout.includes(flag), `install.sh --help must document ${flag}`);
  }

  const rejected = spawnSync("sh", [join(portableDir, "install.sh"), "--nope"], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /unknown option: --nope/);
});

test("the uploader refuses to accept an immutable object it cannot content-check", async () => {
  const source = await readFile(join(portableDir, "upload-gcs.sh"), "utf8");
  const check = source.slice(
    source.indexOf("check_remote_object_matches() {"),
    source.indexOf("check_remote_immutable_prefix() {"),
  );
  assert.ok(check.length > 0);
  // md5Hash describes the stored bytes; size and the sha256 custom metadata do not, on their own.
  assert.match(check, /typeof described\.md5Hash !== "string"/);
  assert.doesNotMatch(
    check,
    /typeof described\.md5Hash === "string" &&/,
    "a missing md5Hash must fail closed rather than skip the content comparison",
  );
  // Composite objects carry no md5Hash at all, so they must never be produced in the first place.
  assert.match(source, /CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED=False/);
});

test("the public gate hashes every asset and installs the release before pointers move", async () => {
  const source = await readFile(join(portableDir, "upload-gcs.sh"), "utf8");
  const verify = source.slice(
    source.indexOf("verify_remote_versioned_release() {"),
    source.indexOf("verify_public_installable() {"),
  );
  assert.ok(verify.length > 0);
  assert.match(verify, /file_digest "\$tmp_dir\/asset\.bin" sha256/, "assets must be downloaded and hashed");
  assert.doesNotMatch(verify, /curl -fsSI/, "a HEAD request does not prove the served bytes");
  assert.doesNotMatch(verify, /-r 0-0/, "a one-byte range request does not prove the served bytes");

  // The install check is pinned to the immutable version, so it never depends on a channel pointer.
  assert.match(source, /sh "\$INSTALLER_PATH" \\\n\s+--version "\$VERSION"/);

  const installCheckIndex = source.indexOf("verify_public_installable\n");
  const pointerIndex = source.indexOf('upload_mutable_object "install.sh"');
  assert.ok(installCheckIndex > 0 && pointerIndex > installCheckIndex);
});

test("channel pointers are single-writer, monotonic, and ordered installer-first", async () => {
  const source = await readFile(join(portableDir, "upload-gcs.sh"), "utf8");

  // latest.json is the commit point, so it is a compare-and-swap against the observed generation.
  assert.match(source, /args\+=\(--if-generation-match="\$generation"\)/);
  assert.match(source, /upload_mutable_object "latest\.json" [\s\S]*?"\$REMOTE_LATEST_GENERATION"/);
  assert.match(source, /read_remote_channel_pointer\n/);
  assert.match(source, /if channel_pointer_would_regress; then/);

  const installerIndex = source.indexOf('upload_mutable_object "install.sh"');
  const latestIndex = source.indexOf('upload_mutable_object "latest.json" "$LATEST_PATH"');
  assert.ok(
    installerIndex > 0 && latestIndex > installerIndex,
    "install.sh must be written before latest.json so a partial publish cannot advertise a version through an older installer",
  );

  // Losing the race must converge rather than fail: re-read the pointer and decide again.
  assert.match(source, /COMMIT_ATTEMPTS=/);
  assert.match(source, /grep -qiE "precondition\|412"/);
  assert.match(source, /the channel pointer moved while committing/);

  const workflow = await readFile(join(scriptsDir, "..", ".github", "workflows", "publish-npm-package.yml"), "utf8");
  for (const group of ["npm-publish-staging", "npm-publish-production"]) {
    // `queue: max` preserves every pending run in FIFO order; the default `single` would cancel a
    // pending run, silently dropping that release.
    assert.match(workflow, new RegExp(`group: ${group}\\n\\s+queue: max`));
  }
  assert.doesNotMatch(workflow, /cancel-in-progress/, "a cancelled release run can stop between the two channel heads");

  // Both channel heads advance under the same monotonic rule, or they can drift apart. Inspect the
  // commands themselves rather than the file, so prose about the rule cannot satisfy the check.
  const publishCommands = workflow
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("run: npm publish"));
  assert.equal(publishCommands.length, 2, "staging and production each publish exactly once");
  for (const command of publishCommands) {
    assert.match(command, /--tag "\$\{\{ steps\.dist_tag\.outputs\.tag \}\}"/);
    assert.doesNotMatch(command, /--tag latest/);
  }
  assert.match(workflow, /node scripts\/resolve-npm-dist-tag\.mjs/);
});

test("the uploader treats the version prefix as immutable and flips channel pointers last", async () => {
  const source = await readFile(join(portableDir, "upload-gcs.sh"), "utf8");
  await access(join(portableDir, "upload-gcs.sh"), constants.X_OK);

  assert.match(source, /--if-generation-match=0/, "immutable objects must be uploaded create-only");
  assert.match(source, /--content-md5=/, "uploads must be integrity-checked by Cloud Storage");
  assert.match(source, /IMMUTABLE_CACHE_CONTROL="public, max-age=31536000, immutable"/);
  assert.match(source, /MUTABLE_CACHE_CONTROL="no-cache/);

  // The pointer write is conditioned on the generation this run observed, not created blindly and
  // not restricted to create-only: it has to be able to replace an existing pointer, exactly once.
  const mutableUpload = source.slice(
    source.indexOf("upload_mutable_object() {"),
    source.indexOf("compare_portable_versions() {"),
  );
  assert.ok(mutableUpload.length > 0);
  assert.doesNotMatch(mutableUpload, /--if-generation-match=0/);
  assert.match(mutableUpload, /--if-generation-match="\$generation"/);

  const verifyIndex = source.indexOf("verify_remote_versioned_release\n");
  const installerIndex = source.indexOf('upload_mutable_object "install.sh"');
  const pointerVerifyIndex = source.indexOf("verify_remote_channel_pointers\n");
  assert.ok(
    verifyIndex > 0 && installerIndex > verifyIndex,
    "channel pointers must not move before the release is public",
  );
  assert.ok(pointerVerifyIndex > installerIndex);
});

test("shell helpers import release modules without tripping their CLI entry point", async () => {
  // A module handed its own path as process.argv[1] decides it is the process entry point and runs
  // its CLI main(), which fails on the helper's arguments and poisons an otherwise correct answer.
  for (const name of ["upload-gcs.sh", "release-gcs.sh"]) {
    const source = await readFile(join(portableDir, name), "utf8");
    for (const match of source.matchAll(/import\(pathToFileURL\(([^)]+)\)/g)) {
      assert.match(match[1], /^process\.env\./, `${name} must pass the module path through the environment, not argv`);
    }
  }

  // Exercise the comparator exactly as upload-gcs.sh invokes it, including the exit status.
  const helper = [
    'const { pathToFileURL } = require("node:url");',
    "import(pathToFileURL(process.env.OPENTAG_RELEASE_VERSIONS_MODULE).href)",
    "  .then((module) => process.stdout.write(String(module.compareReleaseVersions(process.argv[1], process.argv[2]))))",
    "  .catch((error) => { console.error(error.message); process.exit(1); });",
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", helper, "1.3.0", "1.2.0"], {
    encoding: "utf8",
    env: { ...process.env, OPENTAG_RELEASE_VERSIONS_MODULE: join(scriptsDir, "release-versions.mjs") },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout, "1");
  assert.equal(result.stderr, "");
});

test("the release scripts default to the OpenTag Cloud Storage coordinates", async () => {
  const upload = await readFile(join(portableDir, "upload-gcs.sh"), "utf8");
  assert.match(upload, /DEFAULT_BUCKET="opentag-release"/);
  assert.match(upload, /DEFAULT_PREFIX="releases"/);

  for (const name of ["build-release.sh", "release-gcs.sh"]) {
    const source = await readFile(join(portableDir, name), "utf8");
    await access(join(portableDir, name), constants.X_OK);
    assert.match(source, /DEFAULT_DOWNLOAD_BASE_URL="https:\/\/download\.opentag\.build\/releases"/);
  }
  assert.equal(DEFAULT_DOWNLOAD_BASE_URL, "https://download.opentag.build/releases");
});

test("forwarded option arrays survive the bash 3.2 that ships with macOS", async () => {
  const source = await readFile(join(portableDir, "release-gcs.sh"), "utf8");
  for (const name of ["BUILD_ARGS", "UPLOAD_ARGS"]) {
    assert.ok(
      source.includes(`\${${name}[@]+"\${${name}[@]}"}`),
      `${name} must be expanded defensively; bash 3.2 rejects "\${${name}[@]}" on an empty array under set -u`,
    );
    assert.ok(!source.includes(`"\${${name}[@]}"\n`), `${name} must not be expanded bare`);
  }
});

test("every supported platform is a Node.js distribution target", () => {
  assert.deepEqual(PORTABLE_PLATFORMS, ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
  for (const platform of PORTABLE_PLATFORMS) {
    const { arch, os } = parsePlatform(platform);
    assert.ok(["darwin", "linux"].includes(os));
    assert.ok(["arm64", "x64"].includes(arch));
  }
});
