import { removeContainer, runLimitedContainer } from "./harness.mjs";

// Exercise the image-owned subreaper without Docker --init. A background process that ignores
// TERM must be reaped before init returns the primary child's status.
const PROBE = String.raw`
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const childCode="process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)";
const mainCode="const c=require('node:child_process').spawn(process.execPath,['-e',"+JSON.stringify(childCode)+"],{stdio:['ignore','pipe','inherit']});console.log(c.pid);c.stdout.once('data',()=>process.exit(23));";
function invoke(args,onData){return new Promise((resolve,reject)=>{
 const child=spawn('/usr/local/bin/opentag-init',args,{stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',data=>{output+=data;onData?.(child);});
 child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal,output}));
});}
(async()=>{
 const result=await invoke([process.execPath,'-e',mainCode]);assert.equal(result.code,23);
 const pid=Number(result.output.trim());assert.ok(pid>1);assert.throws(()=>process.kill(pid,0));
 const signalled=await invoke([process.execPath,'-e',"console.log('ready');setInterval(()=>{},1000)"],child=>child.kill('SIGTERM'));
 assert.equal(signalled.code,143);console.log('init cleanup and signal forwarding passed');
})().catch(()=>{console.error('init process lifecycle probe failed');process.exitCode=1;});
`;
export async function runInitSmoke({ image, name }) {
  const result = await runLimitedContainer({
    image,
    name,
    args: ["node", "-e", PROBE],
    timeoutMs: 30_000,
    allowFailure: true,
  });
  await removeContainer(name);
  if (result.status !== 0) throw new Error("Image init failed process cleanup or signal forwarding");
  return { exitStatusPreserved: true, adoptedChildReaped: true, termForwarded: true };
}
