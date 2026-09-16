import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("fixture Server survives harness process-group SIGINT until resource cleanup finishes", {
  timeout: 15_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "opentag-e3-signal-group-"));
  let child;
  try {
    const helper = pathToFileURL(join(process.cwd(), "scripts/e2e/cloud-computer/common.mjs")).href;
    const fixture = join(dir, "parent.mjs");
    await writeFile(
      fixture,
      `
      import {writeFileSync} from 'node:fs';
      import {spawnLogged,stopChild,waitFor} from ${JSON.stringify(helper)};
      const child=spawnLogged(process.execPath,['-e',
        "process.on('SIGINT',()=>process.exit(72));console.log('ready');setInterval(()=>{},1000)"],
        {logPath:${JSON.stringify(join(dir, "child.log"))}, detached:true});
      process.once('SIGINT',async()=>{
        await new Promise(r=>setTimeout(r,150));
        const survived=child.exitCode===null&&child.signalCode===null;
        await stopChild(child);
        writeFileSync(${JSON.stringify(join(dir, "result.json"))},JSON.stringify({survived,closed:child.exitCode!==null||child.signalCode!==null}));
      });
      child.stdout.once('data',()=>writeFileSync(${JSON.stringify(join(dir, "ready"))},'ready'));
    `,
    );
    child = spawn(process.execPath, [fixture], { detached: true, stdio: "ignore" });
    const exit = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    for (let i = 0; ; i++) {
      if (await readFile(join(dir, "ready"), "utf8").catch(() => "")) break;
      if (i > 100) throw new Error("fixture did not become ready");
      await new Promise((r) => setTimeout(r, 50));
    }
    process.kill(-child.pid, "SIGINT");
    assert.equal(await exit, 0);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "result.json"), "utf8")), { survived: true, closed: true });
  } finally {
    if (child?.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
