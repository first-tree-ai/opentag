export const CONTEXT_TREE_COMMAND_WORKER_SOURCE = `
import { spawn } from 'node:child_process';
const chunks = []; let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 65536) throw new Error('Context Tree request exceeded its limit');
  chunks.push(chunk);
}
const input = JSON.parse(Buffer.concat(chunks).toString());
const environment = Object.fromEntries(Object.entries(input.environment).filter(([, value]) => typeof value === 'string'));
const child = spawn(process.execPath, [input.cli, ...input.args], { cwd: input.cwd, env: { PATH: '/usr/local/bin:/opt/opentag/tools/bin:/usr/bin:/bin', LANG: 'C.UTF-8', ...environment }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
const output = []; const errors = []; let bytes = 0;
const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000).unref(); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
for (const [stream, destination] of [[child.stdout, output], [child.stderr, errors]]) stream.on('data', chunk => { bytes += chunk.length; if (bytes > 1048576) stop(); else destination.push(chunk); });
child.on('error', () => { console.log(JSON.stringify({ code: 1, stdout: '', stderr: 'Context Tree process could not start.' })); process.exitCode = 1; });
child.on('exit', code => { console.log(JSON.stringify({ code: code ?? 1, stdout: Buffer.concat(output).toString(), stderr: Buffer.concat(errors).toString() })); });
`;
