export const CONTEXT_TREE_COMMAND_WORKER_SOURCE = `
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
const chunks = []; let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 65536) throw new Error('Context Tree request exceeded its limit');
  chunks.push(chunk);
}
const input = JSON.parse(Buffer.concat(chunks).toString());
const environment = Object.fromEntries(Object.entries(input.environment).filter(([, value]) => typeof value === 'string'));
const child = spawn(process.execPath, [input.cli, ...input.args], { cwd: input.cwd, env: { PATH: '/usr/local/bin:/opt/opentag/tools/bin:/usr/bin:/bin', LANG: 'C.UTF-8', ...environment }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
const output = []; const errors = []; let bytes = 0; let overflow = false; let stopped;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const procFields = pid => { const value = readFileSync('/proc/' + pid + '/stat', 'utf8'); return value.slice(value.lastIndexOf(') ') + 2).split(' '); };
const processTable = () => {
  if (process.platform !== 'linux') return execFileSync('/bin/ps', ['ax', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 300 }).trim().split('\\n').map(line => line.trim().split(/\\s+/).map(Number));
  return readdirSync('/proc').filter(name => /^\\d+$/.test(name)).flatMap(name => {
    try { return [[Number(name), Number(procFields(name)[1])]]; } catch { return []; }
  });
};
const alive = pid => {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') return procFields(pid)[0] !== 'Z';
    return true;
  } catch { return false; }
};
const signal = (pid, name) => {
  try { process.kill(-pid, name); } catch { try { process.kill(pid, name); } catch {} }
};
const waitGone = async pids => {
  const deadline = Date.now() + 750;
  while (pids.some(alive) && Date.now() < deadline) await pause(20);
};
const stop = () => {
  stopped ??= (async () => {
    const table = processTable(); const owned = new Set([child.pid]);
    for (const pid of owned) for (const [descendant, parent] of table) if (parent === pid) owned.add(descendant);
    const pids = [...owned].filter(pid => Number.isInteger(pid) && pid > 1).reverse();
    for (const pid of pids) signal(pid, 'SIGTERM');
    await waitGone(pids);
    for (const pid of pids.filter(alive)) signal(pid, 'SIGKILL');
    await waitGone(pids);
    if (pids.some(alive)) throw new Error('Context Tree process cleanup failed');
  })();
  return stopped;
};
const cancel = () => { void stop().catch(() => { process.exitCode = 1; }); };
process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
for (const [stream, destination] of [[child.stdout, output], [child.stderr, errors]]) stream.on('data', chunk => {
  bytes += chunk.length;
  if (bytes > 1048576) { overflow = true; cancel(); } else destination.push(chunk);
});
child.on('error', () => { console.log(JSON.stringify({ code: 1, stdout: '', stderr: 'Context Tree process could not start.' })); process.exitCode = 1; });
child.on('close', async code => {
  try {
    if (stopped) await stopped;
    console.log(JSON.stringify({ code: stopped || overflow ? 1 : code ?? 1, stdout: Buffer.concat(output).toString(), stderr: Buffer.concat(errors).toString() }));
  } catch {
    console.log(JSON.stringify({ code: 1, stdout: '', stderr: 'Context Tree process cleanup failed.' })); process.exitCode = 1;
  }
});
`;
