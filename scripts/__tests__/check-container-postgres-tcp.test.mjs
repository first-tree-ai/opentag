import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkContainerPostgresTcp } from "../check-container-postgres-tcp.mjs";

const root = join(import.meta.dirname, "../..");
const script = join(root, "scripts/check-container-postgres-tcp.mjs");
const check = (source, path = "probe.ts") => checkContainerPostgresTcp(path, source);
const docker = (args) => `await execFileAsync("docker", ${JSON.stringify(args)});`;

test("rejects direct and compose container probes, including dynamic targets and credentials", () => {
  for (const command of ["psql", "pg_isready"]) {
    assert.equal(check(docker(["exec", "container", command, "-U", "opentag"])).length, 1);
    assert.equal(
      check(
        `await spawn("docker", ["compose", "-f", composeFile, "exec", "-T", "-e", \`PGPASSWORD=\${password}\`, "postgres", "${command}", "-U", username]);`,
      ).length,
      1,
    );
  }
});

test("accepts short, long, and attached TCP host options", () => {
  for (const host of [["-h", "127.0.0.1"], ["--host", "localhost"], ["--host=127.0.0.1"], ["-h127.0.0.1"]]) {
    for (const command of ["psql", "pg_isready"]) {
      assert.deepEqual(check(docker(["exec", "container", command, ...host, "-U", "opentag"])), []);
    }
  }
  assert.deepEqual(check(docker(["exec", "container", "psql", "-t", "-h", "127.0.0.1"])), []);
  assert.deepEqual(check(docker(["exec", "container", "pg_isready", "-t", "5", "--host=localhost"])), []);
});

test("does not count Docker host flags, SQL text, help text in SQL, or socket host paths", () => {
  for (const args of [
    ["--host", "tcp://docker:2375", "exec", "container", "psql"],
    ["exec", "container", "psql", "-c", "select '-h', '--host=localhost'"],
    ["exec", "container", "psql", "-c", "--help"],
    ["exec", "container", "psql", "--host", "/var/run/postgresql"],
    ["exec", "container", "psql", "-h", ""],
    ["exec", "container", "psql", "--host"],
    ["exec", "container", "pg_isready", "-t", "-hlocalhost"],
  ])
    assert.equal(check(docker(args)).length, 1, JSON.stringify(args));
});

test("preserves host invocations, non-connecting commands, and ordinary text", () => {
  for (const source of [
    'await execFileAsync("psql", [dsn, "-Atc", sql]);',
    'await execFileAsync("pg_isready", ["-d", url]);',
    '// docker exec postgres psql\nconst example = "docker exec postgres pg_isready";',
    'const args = ["exec", "postgres", "psql"]; log(args);',
    "await exec(\"echo 'docker exec postgres psql'\");",
    docker(["exec", "container", "echo", "psql"]),
    docker(["exec", "container", "psql", "-hlocalhost", "-c", "--health-cmd", "pg_isready"]),
    docker(["exec", "container", "psql", "--version"]),
    docker(["exec", "container", "pg_isready", "--help"]),
  ])
    assert.deepEqual(check(source), [], source);
  assert.deepEqual(check("psql -U postgres -c 'select 1'", "docker-entrypoint-initdb.d/init.sh"), []);
});

test("follows local Docker argv wrappers and wrapped health checks", () => {
  const wrapper = `function run(args) { return spawnSync("docker", args); }
function start(name, args) { run(["run", "--name", name, ...args]); }
`;
  assert.equal(check(`${wrapper}run(["exec", container, "psql", "-U", user]);`).length, 1);
  assert.equal(check(`${wrapper}start(name, ["--health-cmd", "pg_isready -U opentag", "postgres:17"]);`).length, 1);
  assert.deepEqual(check(`${wrapper}start(name, ["--health-cmd", "pg_isready --host=localhost", "postgres:17"]);`), []);
});

test("checks workflow commands while ignoring comments, echoes, and host probes", () => {
  const yaml = `jobs:
  test:
    steps:
      - run: |
          # docker exec postgres psql
          echo 'docker exec postgres psql'
          psql "$DATABASE_URL" -c 'select 1'
          if docker exec postgres pg_isready -U opentag; then exit 0; fi
      - run: >-
          docker compose -f docker-compose.yml exec -T postgres
          psql --host=localhost -c 'select 1'
`;
  const violations = check(yaml, ".github/workflows/test.yml");
  assert.equal(violations.length, 1);
  assert.match(violations[0], /container pg_isready/);
});

test("checks all compose healthcheck forms and Docker health command options", () => {
  for (const value of [
    '["CMD", "pg_isready", "-U", "opentag"]',
    '["CMD-SHELL", "pg_isready -U opentag"]',
    '"pg_isready -U opentag"',
  ])
    assert.equal(check(`services:\n  postgres:\n    healthcheck:\n      test: ${value}\n`, "compose.yml").length, 1);
  assert.equal(check(docker(["run", "--health-cmd=pg_isready -U opentag", "postgres:17"])).length, 1);
  assert.deepEqual(
    check(
      'services:\n  postgres:\n    healthcheck:\n      test: ["CMD", "pg_isready", "-h", "127.0.0.1"]\n',
      "compose.yml",
    ),
    [],
  );
});

test("checks workflow service health options without treating unrelated options as Docker commands", () => {
  const workflow = (host) => `jobs:
  test:
    services:
      postgres:
        image: postgres:17
        options: >-
          --shm-size 256m
          --health-cmd "pg_isready ${host} -U opentag"
          --health-interval 5s
`;
  assert.equal(check(workflow(""), ".github/workflows/test.yml").length, 1);
  assert.deepEqual(check(workflow("--host=localhost"), ".github/workflows/test.yml"), []);
  assert.deepEqual(check("options: '--health-cmd \"pg_isready -U opentag\"'\n", "settings.yml"), []);
});

test("parses TypeScript without JSX ambiguity and still supports JSX files", () => {
  for (const source of ["const id = <T>(x: T) => x; // psql", "const value = <number>input; // pg_isready"]) {
    assert.deepEqual(check(source), []);
    assert.equal(check(`${source}\n${docker(["exec", "postgres", "psql"])}`).length, 1);
  }
  assert.deepEqual(check("const view = <div>psql</div>;", "view.tsx"), []);
  assert.deepEqual(check("const view = <div>psql</div>;", "view.jsx"), []);
});

test("parser failures identify their source file", () => {
  assert.throws(() => check("const broken = ; // psql", "broken.ts"), /broken\.ts: .*Unexpected token/u);
  assert.throws(() => check("name: psql\n---\nname: other\n", "multiple.yml"), /multiple\.yml: .*multiple documents/u);
});

test("checks shell wrappers and multiline Docker commands without borrowing another command's host", () => {
  assert.equal(check(docker(["exec", "container", "sh", "-c", "psql -U opentag; pg_isready -h localhost"])).length, 1);
  assert.equal(
    check("if docker compose -f compose.yml exec -T postgres \\\n  psql -U opentag; then true; fi", "probe.sh").length,
    1,
  );
  assert.equal(check('await execSync("docker exec postgres pg_isready");').length, 1);
  assert.equal(check('await spawn("/usr/bin/docker", ["exec", "postgres", "psql"]);').length, 1);
});

test("detects the old repository invocations when their TCP options are removed", () => {
  for (const path of [
    "e2e/tests/fixtures.ts",
    "e2e/scripts/stack-server.mjs",
    "scripts/e2e/cloud-computer/postgres.mjs",
    "scripts/e2e/doctor-docker.mjs",
    "docker-compose.yml",
    ".github/workflows/ci.yml",
  ]) {
    const source = readFileSync(join(root, path), "utf8");
    assert.deepEqual(check(source, path), [], path);
    const old = source.replace(/"-h",\s*"127\.0\.0\.1",\s*/gu, "").replace(/(?:-h|--host) 127\.0\.0\.1\s*/gu, "");
    assert.notEqual(old, source, `${path} must exercise a TCP invocation`);
    assert.ok(check(old, path).length > 0, `${path} must fail without its host`);
  }
});

test("the repository CLI includes new files and returns actionable failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "opentag-postgres-tcp-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    writeFileSync(join(directory, "probe.ts"), docker(["exec", "postgres", "psql"]));
    const failed = spawnSync(process.execPath, [script], { cwd: directory, encoding: "utf8" });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /probe\.ts:1: container psql requires -h\/--host/);
    writeFileSync(join(directory, "probe.ts"), docker(["exec", "postgres", "psql", "-h", "localhost"]));
    const passed = spawnSync(process.execPath, [script], { cwd: directory, encoding: "utf8" });
    assert.equal(passed.status, 0, passed.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.ok(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.check.includes(
      "node scripts/check-container-postgres-tcp.mjs",
    ),
  );
});
