import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { detectPiAdmission } from "./admission.mjs";
import { fixtureSlackBindingSql } from "./binding.mjs";
import { createStepper, execFileAsync, processExists, sleep, stopChild, waitFor } from "./common.mjs";
import { readPiEvidence, waitProcessesGone, waitRecordedTurn } from "./evidence.mjs";
import { createLocalPiFixture } from "./fixture.mjs";
import { SLACK_FIXTURE } from "./im-stub.mjs";
import { agentWorkspaceRoot, fileSnapshot, piPidsForDaemon, readExactLines, readSessionBinding } from "./observe.mjs";

const execFileCb = promisify(execFile);

function safeFailure(fixture, error, stack = false) {
  const value = stack ? (error?.stack ?? error) : (error?.message ?? error);
  return fixture ? fixture.redact(value) : String(value);
}

function gitState(repositoryRoot) {
  const run = (args) =>
    execFileCb("git", ["-C", repositoryRoot, ...args], { encoding: "utf8" })
      .then((result) => result.stdout.trim())
      .catch(() => "");
  return Promise.all([run(["rev-parse", "HEAD"]), run(["status", "--porcelain"])]).then(([sha, dirty]) => ({
    gitSha: sha || "unknown",
    gitDirty: dirty.length > 0,
  }));
}

function piVersion() {
  return execFileCb("pi", ["--version"], { encoding: "utf8" })
    .then((result) => result.stdout.trim().split(/\s+/)[0] ?? result.stdout.trim())
    .catch((error) => {
      throw new Error(`Real Pi CLI is required on PATH: ${error.message}`);
    });
}

function clientVersion(repositoryRoot) {
  return readFile(join(repositoryRoot, "apps/cli/package.json"), "utf8").then((text) => JSON.parse(text).version);
}

function syntheticEvent({ text, suffix }) {
  const stamp = Date.now();
  return {
    providerEventId: `e1-${suffix}-${stamp}`,
    externalAppId: SLACK_FIXTURE.appId,
    externalTeamId: SLACK_FIXTURE.teamId,
    providerContext: { provider: "slack", channelType: "im" },
    conversation: {
      externalId: "D0E1LOCALPI",
      kind: "dm",
      displayName: "E1 Local Pi DM",
    },
    message: {
      externalId: `e1-msg-${suffix}-${stamp}`,
      revisionKey: `e1-rev-${suffix}-${stamp}`,
      operation: "created",
      author: {
        externalId: "U0E1HUMAN",
        kind: "human",
        displayName: "E1 Human",
        isSelf: false,
      },
      occurredAt: new Date().toISOString(),
      content: {
        version: 1,
        fallbackText: text,
        blocks: [{ type: "text", text }],
        truncated: false,
      },
      resources: [],
    },
    mentions: [],
  };
}

async function ingestEvent({ repositoryRoot, databaseUrl, bindingId, event, artifactDirectory, name }) {
  const eventPath = join(artifactDirectory, `${name}.event.json`);
  await writeFile(eventPath, `${JSON.stringify(event, null, 2)}\n`);
  const tsxLoader = join(repositoryRoot, "node_modules", "tsx", "dist", "loader.mjs");
  const ingress = join(repositoryRoot, "scripts", "e2e", "cloud-computer", "ingress.ts");
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      pathToFileURL(tsxLoader).href,
      ingress,
      "--binding-id",
      bindingId,
      "--generation",
      "1",
      "--event-file",
      eventPath,
    ],
    { maxBuffer: 2 * 1024 * 1024, env: { ...process.env, OPENTAG_DATABASE_URL: databaseUrl }, timeout: 30_000 },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
}

async function currentInstanceId(postgres) {
  const value = await postgres.psql("select current_instance_id from computers order by created_at, id limit 1");
  return value && value !== "" ? value : undefined;
}

async function waitOnlineComputer(api) {
  return waitFor(
    "the Computer to register as online with provider readiness",
    async () => {
      const listed = await api.get("/api/v1/computers", { headers: { "x-opentag-provider-readiness": "1" } });
      const computer = listed.computers?.[0];
      if (computer?.connectionStatus !== "online") return false;
      return computer;
    },
    { timeoutMs: 90_000, intervalMs: 500 },
  );
}

async function waitPiReady(api) {
  return waitFor(
    "Pi provider readiness on the live Computer",
    async () => {
      const listed = await api.get("/api/v1/computers", { headers: { "x-opentag-provider-readiness": "1" } });
      const computer = listed.computers?.[0];
      const pi = computer?.providerReadiness?.find((entry) => entry.provider === "pi");
      if (pi?.status === "ready") return { computer, pi };
      return false;
    },
    { timeoutMs: 90_000, intervalMs: 1_000 },
  );
}

export async function runLocalPi({ repositoryRoot }) {
  const startedAt = Date.now();
  let fixture;
  const { step, steps } = createStepper((text) => (fixture ? fixture.redact(text) : String(text)));
  const substitutions = [
    {
      name: "synthetic-im-ingress",
      scope: "E1 only",
      detail:
        "NormalizedInboundImEvent persisted through ImMessageInbox.ingest; Server ImDeliveryWorker delivers. Real Slack/Feishu webhooks deferred to E4.",
    },
    {
      name: "fixture-slack-binding",
      scope: "E1 only",
      detail:
        "SQL-inserted Slack installation + IM binding with dummy encrypted credentials. Grant still uses production ImBindingService. No OAuth, no Slack HTTP.",
    },
    {
      name: "local-slack-cli-substitute",
      scope: "E1 only",
      detail:
        "PATH stub answers slack version / api --help / auth.test identity. Pi, WebSocket, custody, and RuntimeConnection are not substituted.",
    },
  ];
  const assertions = [];
  const durations = {};
  let exitCode = 1;
  const recordedTurns = [];
  let stopEvidence;
  let summary = {
    command: "local-pi",
    status: "failed",
    phase: "startup",
    substitutions,
  };

  const artifactDirectory = resolve(
    process.env.OPENTAG_E1_ARTIFACTS ?? join(tmpdir(), `opentag-e1-local-pi-${process.pid}`),
  );
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const port = Number(process.env.OPENTAG_E1_PORT ?? 8131);
  const nonce = `e1${randomBytes(6).toString("hex")}`;
  const outputName = "e1-output.txt";
  const longName = "e1-long.txt";

  const writeSummary = async (extra = {}) => {
    summary = {
      ...summary,
      ...extra,
      assertions,
      substitutions,
      durations,
      recordedTurns,
      stopEvidence,
      steps,
      artifactDirectory,
      elapsedMs: Date.now() - startedAt,
    };
    await writeFile(join(artifactDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  };

  try {
    const [git, version, cliVersion, admission] = await Promise.all([
      gitState(repositoryRoot),
      piVersion(),
      clientVersion(repositoryRoot),
      detectPiAdmission(repositoryRoot),
    ]);
    summary = {
      ...summary,
      ...git,
      clientVersion: cliVersion,
      piVersion: version,
      providerModel: "pi-default",
      admission,
    };
    await writeSummary({ phase: "prerequisites" });

    await step("check Pi product admission", async () => {
      if (!admission.admitted) {
        const pending = admission.pending.join("; ");
        throw new Error(`Pi is not admitted on the product path yet: ${pending}`);
      }
      return "built Shared admits Pi; live Server and Client checks follow";
    });

    fixture = await step("start disposable Postgres, Server, isolated homes", async () => {
      const created = await createLocalPiFixture({ repositoryRoot, artifactDirectory, port });
      durations.fixtureMs = Date.now() - startedAt;
      return Object.assign(created, {
        detail: `postgres ${created.postgres.name} server ${created.baseUrl} (pi config files copied: ${created.piConfigFiles})`,
      });
    });

    await step("issue Computer connect code and exchange with the real CLI", async () => {
      const connectCodeId = await fixture.connectComputer();
      return `connectCodeId ${connectCodeId}`;
    });

    await step("start the Client daemon (production createClientRuntime)", async () => {
      const daemon = await fixture.startDaemon();
      fixture.setDaemon(daemon);
      if (!daemon.pid) throw new Error("Daemon did not spawn");
      return `pid ${daemon.pid}`;
    });

    const computer = await step("wait for a registered live Computer", async () => {
      const online = await waitOnlineComputer(fixture.api);
      return { ...online, detail: `${online.computerId} ${online.connectionStatus}` };
    });

    await step("optional Codex/Claude API admission regression", async () => {
      const created = [];
      for (const runtimeProvider of ["codex", "claude-code"]) {
        const agent = await fixture.api.post("/api/v1/agents", {
          name: `e1-admit-${runtimeProvider}`,
          displayName: `E1 admit ${runtimeProvider}`,
          runtimeProvider,
        });
        created.push(agent.id);
        await fixture.api.post(`/api/v1/agents/${agent.id}/suspend`);
        await fixture.api.delete(`/api/v1/agents/${agent.id}`);
      }
      return `created and deleted ${created.length} agents without provider calls`;
    });

    const agent = await step("create and configure a Pi Agent through the Account API", async () => {
      const created = await fixture.api.post("/api/v1/agents", {
        name: "e1-local-pi",
        displayName: "E1 Local Pi",
        runtimeProvider: "pi",
        computerId: computer.computerId,
        runtimeConfig: {
          instructions:
            "You run an OpenTag E1 acceptance fixture. Follow file-write instructions exactly. Use tools. Do not call external network APIs. Do not mention secrets.",
        },
      });
      const patched = await fixture.api.patch(`/api/v1/agents/${created.id}`, {
        expectedRevision: created.revision,
        runtimeConfig: {
          instructions:
            "You run an OpenTag E1 acceptance fixture. Follow file-write instructions exactly. Prefer the write/edit tools over prose. Never call Slack or other external APIs.",
        },
      });
      assertions.push({
        name: "agent-created-as-pi",
        ok: patched.runtimeProvider === "pi",
        detail: patched.runtimeProvider,
      });
      if (patched.runtimeProvider !== "pi") throw new Error(`Agent provider is ${patched.runtimeProvider}`);
      return { ...patched, detail: `${patched.id} revision ${patched.revision}` };
    });

    const ready = await step("wait for registered live Client Pi readiness", async () => {
      const observed = await waitPiReady(fixture.api);
      assertions.push({
        name: "pi-provider-ready",
        ok: observed.pi.status === "ready",
        detail: observed.pi.status,
      });
      const instanceId = await currentInstanceId(fixture.postgres);
      if (!instanceId) throw new Error("Computer is ready without a current instance id");
      return {
        ...observed,
        instanceId,
        detail: `computer ${observed.computer.computerId} instance ${instanceId} pi=${observed.pi.status}`,
      };
    });
    const firstInstanceId = ready.instanceId;
    const firstDaemonPid = fixture.daemon.pid;

    const binding = await step("insert fixture Slack IM binding", async () => {
      const inserted = fixtureSlackBindingSql({ agentId: agent.id, encryptionKey: fixture.encryptionKey });
      await fixture.postgres.psql(inserted.sql);
      return { ...inserted, detail: inserted.bindingId };
    });

    const workspaceRoot = agentWorkspaceRoot(fixture.openTagHome, agent.id);
    const outputPath = join(workspaceRoot, outputName);
    const longPath = join(workspaceRoot, longName);
    const inputPath = join(fixture.workspace, "e1-input.txt");
    await writeFile(inputPath, `${nonce}\n`, { mode: 0o600 });

    const first = await step("random fixture input: Pi writes expected file via tools", async () => {
      const text = [
        `OpenTag E1 first turn.`,
        `Read the nonce from ${inputPath} using the read tool. Remember it in this conversation.`,
        `Create ${outputPath} using the write tool containing exactly two lines:`,
        `NONCE=<the nonce you read from the file>`,
        `WRITTEN=1`,
        `No other lines. Final response must be exactly ACK. Never include the nonce in your final response or send to IM.`,
      ].join(" ");
      const ingest = await ingestEvent({
        repositoryRoot,
        databaseUrl: fixture.postgres.databaseUrl,
        bindingId: binding.bindingId,
        event: syntheticEvent({ text, suffix: "first" }),
        artifactDirectory,
        name: "01-first",
      });
      if (!ingest.deliveryIds?.[0]) throw new Error(`Ingest produced no delivery: ${JSON.stringify(ingest)}`);
      const sessionId = await waitFor(
        "session id for the first delivery",
        async () => {
          const value = await fixture.postgres.psql(
            `select session_id from im_message_deliveries where id = '${ingest.deliveryIds[0]}'`,
          );
          return value || false;
        },
        { timeoutMs: 30_000 },
      );
      await waitFor(
        `${outputName} to be written with the nonce`,
        async () => {
          if (!existsSync(outputPath)) return false;
          const lines = await readExactLines(outputPath);
          return lines[0] === `NONCE=${nonce}` && lines[1] === "WRITTEN=1" ? lines : false;
        },
        { timeoutMs: 180_000, intervalMs: 1_000 },
      );
      const recorded = await waitRecordedTurn(fixture.postgres, ingest.deliveryIds[0], sessionId);
      recordedTurns.push(recorded);
      const snapshot = await fileSnapshot(outputPath);
      const sessionBinding = await readSessionBinding(fixture.openTagHome, agent.id, sessionId);
      if (!sessionBinding?.piSessionId || !sessionBinding.sessionFileHash) {
        throw new Error("Pi session binding did not materialize sessionId/sessionFileHash");
      }
      const evidence = await readPiEvidence(fixture.piConfigDir, sessionBinding.piSessionId);
      if (!evidence.tools.includes("read") || !evidence.tools.includes("write"))
        throw new Error("Pi did not use read and write tools");
      await rm(inputPath);
      await rm(outputPath);
      assertions.push({
        name: "first-turn-file-write",
        ok: true,
        detail: `${outputName} ${snapshot.bytes} bytes sha256=${snapshot.sha256.slice(0, 12)}`,
      });
      assertions.push({
        name: "pi-session-binding",
        ok: true,
        detail: `sessionFileHash=${sessionBinding.sessionFileHash.slice(0, 12)}`,
      });
      return {
        sessionId,
        deliveryId: ingest.deliveryIds[0],
        snapshot,
        toolCount: evidence.tools.length,
        sessionBinding,
        detail: `session ${sessionId} file ${snapshot.bytes}B`,
      };
    });

    let lastToolCount = first.toolCount;
    await step("follow-up same Session recalls nonce absent from the prompt", async () => {
      const text = [
        `OpenTag E1 follow-up.`,
        `The nonce is not in this message.`,
        `The input and previous output files have been removed. From conversation memory only, create ${outputPath} containing exactly RECALL=<the nonce from the previous turn>.`,
        `Use only the write tool. Do not inspect other files, sessions, or logs. Final response must be exactly ACK.`,
      ].join(" ");
      const ingest = await ingestEvent({
        repositoryRoot,
        databaseUrl: fixture.postgres.databaseUrl,
        bindingId: binding.bindingId,
        event: syntheticEvent({ text, suffix: "followup" }),
        artifactDirectory,
        name: "02-followup",
      });
      await waitFor(
        "follow-up to append RECALL with the original nonce",
        async () => {
          if (!existsSync(outputPath)) return false;
          const lines = await readExactLines(outputPath);
          return lines.includes(`RECALL=${nonce}`) ? lines : false;
        },
        { timeoutMs: 180_000, intervalMs: 1_000 },
      );
      recordedTurns.push(await waitRecordedTurn(fixture.postgres, ingest.deliveryIds[0], first.sessionId));
      const evidence = await readPiEvidence(fixture.piConfigDir, first.sessionBinding.piSessionId);
      if (evidence.tools.slice(lastToolCount).some((name) => name !== "write"))
        throw new Error("Recall used tools other than write, so memory continuity is unproven");
      lastToolCount = evidence.tools.length;
      const sessionBinding = await readSessionBinding(fixture.openTagHome, agent.id, first.sessionId);
      const bindingUnchanged =
        sessionBinding?.piSessionId === first.sessionBinding.piSessionId &&
        sessionBinding?.sessionFileHash === first.sessionBinding.sessionFileHash;
      assertions.push({ name: "followup-recall-nonce", ok: true, detail: "RECALL line matches nonce" });
      assertions.push({
        name: "followup-binding-unchanged",
        ok: Boolean(bindingUnchanged),
        detail: bindingUnchanged ? "pi session-id and sessionFileHash unchanged" : "binding changed",
      });
      if (!bindingUnchanged) throw new Error("Pi binding changed during the in-process follow-up");
      await rm(outputPath);
      return { deliveryId: ingest.deliveryIds?.[0], sessionBinding, detail: "nonce recalled; binding unchanged" };
    });

    const restart = await step("stop Client process and start a fresh runtime on the same home", async () => {
      const oldPid = fixture.daemon.pid;
      await fixture.daemon.kill("SIGTERM");
      await waitFor("the previous daemon process to exit", async () => !(await processExists(oldPid)), {
        timeoutMs: 20_000,
        intervalMs: 200,
      });
      if (await processExists(oldPid)) throw new Error(`Previous daemon pid ${oldPid} is still alive`);
      const next = await fixture.startDaemon();
      fixture.setDaemon(next);
      if (!next.pid) throw new Error("Replacement daemon did not spawn");
      if (next.pid === oldPid) throw new Error("Replacement daemon reused the previous PID");
      const online = await waitFor(
        "a new Computer instance after restart",
        async () => {
          const listed = await fixture.api.get("/api/v1/computers", {
            headers: { "x-opentag-provider-readiness": "1" },
          });
          const current = listed.computers?.[0];
          if (current?.connectionStatus !== "online") return false;
          const instanceId = await currentInstanceId(fixture.postgres);
          if (!instanceId || instanceId === firstInstanceId) return false;
          const pi = current.providerReadiness?.find((entry) => entry.provider === "pi");
          return pi?.status === "ready" ? { computer: current, instanceId } : false;
        },
        { timeoutMs: 90_000, intervalMs: 500 },
      );
      assertions.push({
        name: "runtime-restart-new-pid",
        ok: next.pid !== oldPid,
        detail: `oldPid=${oldPid} newPid=${next.pid}`,
      });
      assertions.push({
        name: "runtime-restart-new-instance",
        ok: online.instanceId !== firstInstanceId,
        detail: `oldInstance=${firstInstanceId} newInstance=${online.instanceId}`,
      });
      return {
        oldPid,
        newPid: next.pid,
        oldInstanceId: firstInstanceId,
        newInstanceId: online.instanceId,
        detail: `pid ${oldPid}->${next.pid} instance ${firstInstanceId}->${online.instanceId}`,
      };
    });

    await step("restarted runtime recalls nonce from Pi persisted history and updates the file", async () => {
      const before = await fileSnapshot(outputPath);
      const text = [
        `OpenTag E1 post-restart follow-up.`,
        `The nonce is not in this message.`,
        `The previous output file has been removed. From conversation memory only, create ${outputPath} containing exactly RESTART=<the nonce from this conversation>.`,
        `Use only the write tool. Do not inspect other files, sessions, or logs. Final response must be exactly ACK.`,
      ].join(" ");
      const ingest = await ingestEvent({
        repositoryRoot,
        databaseUrl: fixture.postgres.databaseUrl,
        bindingId: binding.bindingId,
        event: syntheticEvent({ text, suffix: "restart" }),
        artifactDirectory,
        name: "03-restart",
      });
      await waitFor(
        "post-restart recall line",
        async () => {
          if (!existsSync(outputPath)) return false;
          const lines = await readExactLines(outputPath);
          return lines.includes(`RESTART=${nonce}`) ? lines : false;
        },
        { timeoutMs: 180_000, intervalMs: 1_000 },
      );
      recordedTurns.push(await waitRecordedTurn(fixture.postgres, ingest.deliveryIds[0], first.sessionId));
      const evidence = await readPiEvidence(fixture.piConfigDir, first.sessionBinding.piSessionId);
      if (evidence.tools.slice(lastToolCount).some((name) => name !== "write"))
        throw new Error("Recall used tools other than write, so memory continuity is unproven");
      lastToolCount = evidence.tools.length;
      const sessionBinding = await readSessionBinding(fixture.openTagHome, agent.id, first.sessionId);
      const sameSession =
        sessionBinding?.piSessionId === first.sessionBinding.piSessionId &&
        sessionBinding?.sessionFileHash === first.sessionBinding.sessionFileHash;
      assertions.push({ name: "restart-recall-nonce", ok: true, detail: "RESTART line matches nonce" });
      assertions.push({
        name: "restart-binding-retained",
        ok: Boolean(sameSession),
        detail: sameSession ? "pi session-id and sessionFileHash retained" : "binding lost across restart",
      });
      if (!sameSession) throw new Error("Pi session binding was not retained across Client restart");
      const after = await fileSnapshot(outputPath);
      if (after.sha256 === before.sha256) throw new Error("Output file did not change after the restart follow-up");
      return "nonce recalled from Pi persisted history";
    });

    const stopped = await step("active long task then Client runtime shutdown", async () => {
      const markerPath = join(fixture.workspace, "task.pid");
      const scriptPath = join(fixture.workspace, "long-task.mjs");
      await writeFile(
        scriptPath,
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(markerPath)}, String(process.pid));
setTimeout(() => writeFileSync(${JSON.stringify(longPath)}, "LATE"), 15_000);
`,
      );
      const text = `Run ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} using bash in the foreground and wait until it exits. Do not background, nohup, or edit the program. Do not write ${longName} yourself.`;
      const ingest = await ingestEvent({
        repositoryRoot,
        databaseUrl: fixture.postgres.databaseUrl,
        bindingId: binding.bindingId,
        event: syntheticEvent({ text, suffix: "long" }),
        artifactDirectory,
        name: "04-long",
      });
      const taskPid = await waitFor(
        "foreground task child PID",
        async () => {
          if (!existsSync(markerPath)) return false;
          const pid = Number((await readFile(markerPath, "utf8")).trim());
          return Number.isInteger(pid) && (await processExists(pid)) ? pid : false;
        },
        { timeoutMs: 180_000, intervalMs: 100 },
      );
      const piBefore = await piPidsForDaemon(fixture.daemon.pid);
      if (!piBefore.length) throw new Error("No live Pi process observed for active task");
      if (existsSync(longPath)) throw new Error("Task finished before runtime shutdown");
      const preStop = await fixture.postgres.psql(
        `select coalesce(reported_at::text, '') || '|' || state from im_message_deliveries where id = '${ingest.deliveryIds[0]}'`,
      );
      const reportedAt = (preStop ?? "|").split("|")[0];
      if (reportedAt) throw new Error(`Long task already reported before runtime shutdown (${preStop})`);
      const daemonPid = fixture.daemon.pid;
      // Agent suspend refuses active Turns. E1 verifies the normal Client shutdown path.
      stopEvidence = {
        taskPid,
        piBefore,
        daemonPid,
        deliveryId: ingest.deliveryIds[0],
        shutdownRequestedAt: new Date().toISOString(),
      };
      await stopChild(fixture.daemon, { name: "active Client daemon", graceMs: 10_000 });
      await waitProcessesGone([...piBefore, taskPid, daemonPid]);
      stopEvidence.processesGoneAt = new Date().toISOString();
      stopEvidence.terminationMs = Date.now() - Date.parse(stopEvidence.shutdownRequestedAt);
      await sleep(Math.max(0, 16_000 - stopEvidence.terminationMs));
      stopEvidence.lateMarkerObserved = existsSync(longPath);
      stopEvidence.checkedAt = new Date().toISOString();
      if (stopEvidence.lateMarkerObserved) throw new Error("Stopped runtime produced a late filesystem side effect");
      if (stopEvidence.terminationMs >= 10_000)
        throw new Error("Runtime shutdown did not stop the active task promptly");
      const replacement = await fixture.startDaemon();
      fixture.setDaemon(replacement);
      stopEvidence.replacementDaemonPid = replacement.pid;
      await waitPiReady(fixture.api);
      const stoppedTurn = await waitRecordedTurn(fixture.postgres, ingest.deliveryIds[0], first.sessionId, null);
      recordedTurns.push(stoppedTurn);
      if (stoppedTurn.outcome !== "cancelled" || stoppedTurn.errorReason !== "client_shutdown")
        throw new Error(`Stopped Turn outcome ${stoppedTurn.outcome}: ${stoppedTurn.errorReason}`);
      assertions.push({
        name: "pi-and-task-child-terminated",
        ok: true,
        detail: `Pi PIDs ${piBefore.join(", ")}; child PID ${taskPid}`,
      });
      assertions.push({
        name: "no-late-output-after-cancel",
        ok: true,
        detail: "No late marker after original task deadline",
      });
      return {
        piBefore,
        taskPid,
        detail: "Client shutdown stopped Pi and child; no late output; cancelled report recorded",
      };
    });

    const piEvidence = await readPiEvidence(fixture.piConfigDir, first.sessionBinding.piSessionId);
    durations.totalMs = Date.now() - startedAt;
    await writeSummary({
      status: "passed",
      phase: "complete",
      noncePresentInSummary: false,
      providerModel: piEvidence.models,
      piEvidence,
      recordedTurns,
      providerToolUsage: {
        fileWriteObserved: true,
        outputFile: outputName,
        outputBytes: (await fileSnapshot(outputPath)).bytes ?? 0,
      },
      runtime: {
        oldPid: restart.oldPid,
        newPid: restart.newPid,
        oldInstanceId: restart.oldInstanceId,
        newInstanceId: restart.newInstanceId,
        firstDaemonPid,
        sessionId: first.sessionId,
        piSessionId: first.sessionBinding.piSessionId,
        sessionFileHash: first.sessionBinding.sessionFileHash,
      },
      stop: {
        method: "CLI daemon SIGTERM -> ComposedClientRuntime.stop -> runner client_shutdown",
        piPidsBefore: stopped.piBefore,
        taskPid: stopped.taskPid,
      },
      followUp: { bindingUnchanged: true },
    });
    exitCode = 0;
  } catch (error) {
    const failed = steps.filter((entry) => !entry.ok);
    const phase = failed.at(-1)?.label ?? steps.at(-1)?.label ?? summary.phase;
    await writeSummary({
      status: "failed",
      phase,
      error: safeFailure(fixture, error),
    });
    process.stderr.write(`${safeFailure(fixture, error, true)}\n`);
    process.stdout.write(`\nE1 local-pi FAILED at ${phase}\nArtifacts: ${artifactDirectory}\n`);
    if (summary.admission && summary.admission.admitted === false) {
      process.stdout.write(`Pending Pi product admission:\n- ${summary.admission.pending.join("\n- ")}\n`);
      process.stdout.write("Do not treat E1 as complete until a real run against admitted Pi succeeds.\n");
    }
    exitCode = 1;
  } finally {
    if (fixture) {
      const cleanupFailures = (await fixture.stopAll()).map((text) => fixture.redact(text));
      if (cleanupFailures.length > 0) {
        process.stdout.write(`FAIL cleanup — ${cleanupFailures.join("; ")}\n`);
        exitCode = 1;
        await writeSummary({ status: "failed", phase: "cleanup", cleanupFailures });
      } else {
        await writeSummary({
          cleanup: {
            status: "passed",
            privateWorkspaceRemoved: !existsSync(fixture.workspace),
            postgresContainerKept: fixture.keep,
          },
        });
      }
    }
    const failed = steps.filter((entry) => !entry.ok);
    process.stdout.write(`${steps.length - failed.length}/${steps.length} steps passed\n`);
  }
  if (exitCode === 0) process.stdout.write(`E1 local-pi PASSED including cleanup\nArtifacts: ${artifactDirectory}\n`);
  return exitCode;
}
