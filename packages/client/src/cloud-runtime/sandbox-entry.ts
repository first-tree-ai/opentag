/** Trusted mount point for the read-only, per-execution public material directory. */
export const CLOUD_EXECUTION_MOUNT = "/run/opentag-execution";

/** Loopback CONNECT proxy the Sandbox CLI subprocesses use inside the container. */
export const CLOUD_CONNECT_PROXY_PORT = 18_080;

/** Loopback HTTPS endpoint the Slack launcher pins through `--apihost` inside the container. */
export const CLOUD_SLACK_API_PORT = 18_443;

/** Public CA certificate file name inside the read-only per-execution mount. */
export const CLOUD_SANDBOX_CA_FILE = "ca.pem";

/**
 * Sandbox-owned CA copy location. The mounted public CA is root-owned, and native CLIs such as
 * `lark-cli` refuse a CA that is not owned by the current Sandbox uid, so the entry program copies
 * the public certificate into its own 0700 tmpfs home as a 0600 file and rewrites every CA
 * environment path to that copy. Only the public certificate is copied; the CA private key never
 * leaves the trusted Runner.
 */
export const CLOUD_SANDBOX_CA_DESTINATION = "/home/runner/.opentag/ca.pem";

/** Environment variables that may point at the mounted CA and must follow the Sandbox copy. */
export const CLOUD_SANDBOX_CA_ENVIRONMENT_KEYS = [
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "LARKSUITE_CLI_CA_PATH",
  "NODE_EXTRA_CA_CERTS",
  "OPENTAG_PROVIDER_CA_PATH",
  "SSL_CERT_FILE",
] as const;

/**
 * Generated ESM helper published next to `entry.mjs`. It runs as the Sandbox uid, so the copy is
 * owned by that uid and accepted by native CLIs; the read-only public mount is never mutated.
 */
export const CLOUD_SANDBOX_CA_PROGRAM = `
import {chmodSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
export const SANDBOX_CA_ENVIRONMENT_KEYS=${JSON.stringify(CLOUD_SANDBOX_CA_ENVIRONMENT_KEYS)};
export function prepareSandboxCa({destination, environment, mount}) {
  const source = mount + '/${CLOUD_SANDBOX_CA_FILE}';
  const directory = dirname(destination);
  mkdirSync(directory, {recursive: true, mode: 0o700});
  chmodSync(directory, 0o700);
  // Flag 'wx' never follows a pre-existing path, and the explicit chmod fixes the mode under any umask.
  writeFileSync(destination, readFileSync(source), {flag: 'wx', mode: 0o600});
  chmodSync(destination, 0o600);
  const rewritten = {...environment};
  for (const key of SANDBOX_CA_ENVIRONMENT_KEYS) {
    if (rewritten[key] === source) rewritten[key] = destination;
  }
  return {destination, environment: rewritten};
}
`;

/**
 * This program runs inside the untrusted container. It receives only local handles and public
 * CA material, forwards the two loopback endpoints to the per-execution Unix sockets mounted
 * from the trusted Runner, and executes exactly one native command with inherited stdio.
 */
export const CLOUD_SANDBOX_ENTRY_PROGRAM = `
import {createServer, connect} from 'node:net';
import {readFileSync, mkdirSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {prepareSandboxCa} from './sandbox-ca.mjs';
const root='${CLOUD_EXECUTION_MOUNT}';
const manifest=JSON.parse(readFileSync(root+'/environment.json','utf8'));
const sockets=new Set();
const servers=[];
for(const [name,port] of [['connect',${CLOUD_CONNECT_PROXY_PORT}],['slack',${CLOUD_SLACK_API_PORT}]]) {
  const server=createServer(client=>{
    const upstream=connect(root+'/'+name+'.sock');
    sockets.add(client);sockets.add(upstream);
    const close=()=>{client.destroy();upstream.destroy();sockets.delete(client);sockets.delete(upstream);};
    client.on('error',close);upstream.on('error',close);client.on('close',close);upstream.on('close',close);
    client.pipe(upstream);upstream.pipe(client);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  servers.push(server);
}
mkdirSync('/tmp/opentag/lark',{recursive:true,mode:0o700});
mkdirSync('/tmp/opentag/slack',{recursive:true,mode:0o700});
const base={PATH:'${CLOUD_EXECUTION_MOUNT}/bin:/usr/local/bin:/opt/opentag/tools/bin:/usr/bin:/bin',HOME:'/home/runner',TMPDIR:'/tmp',LANG:'C.UTF-8',...manifest.environment};
const environment=prepareSandboxCa({destination:'${CLOUD_SANDBOX_CA_DESTINATION}',environment:base,mount:root}).environment;
const [command,...args]=process.argv.slice(2);
if(!command)throw Error('A sandbox command is required');
const child=spawn(command,args,{env:environment,stdio:'inherit'});
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>child.kill(signal));
const code=await new Promise(resolve=>{child.once('error',()=>resolve(127));child.once('exit',code=>resolve(code??1));});
for(const socket of sockets)socket.destroy();
for(const server of servers)await new Promise(resolve=>server.close(resolve));
process.exitCode=code;
`;
