import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CLOUD_EXECUTION_MOUNT, CLOUD_SANDBOX_CA_DESTINATION } from "../../cloud-runtime/sandbox-entry.js";

function replaceRequired(source: string, before: string, after: string): string {
  if (!source.includes(before)) throw Error(`Cloud fixture remapping target is missing: ${before}`);
  return source.replace(before, after);
}

/** Remap the generated container entry into a host test namespace without reserving fixed ports.
 * Each listener keeps its OS-assigned port open; no find-free-port/close/rebind race is introduced.
 * Only fixture routing is overridden. Published config stays read-only and production is unchanged. */
export async function cloudEntryFixture(published: string, root: string): Promise<string> {
  let entry = (await readFile(join(published, "entry.mjs"), "utf8"))
    .replaceAll(CLOUD_EXECUTION_MOUNT, published)
    .replaceAll(CLOUD_SANDBOX_CA_DESTINATION, join(root, "sandbox-home", "ca.pem"))
    .replaceAll("/tmp/opentag", join(root, "cli"))
    .replaceAll("/home/runner", join(root, "sandbox-home"));
  entry = replaceRequired(entry, "server.listen(port,'127.0.0.1',resolve)", "server.listen(0,'127.0.0.1',resolve)");
  entry = replaceRequired(
    entry,
    "servers.push(server);",
    `servers.push(server);
  const actualPort=server.address().port;
  for(const [key,value] of Object.entries(manifest.environment)) {
    if(typeof value==='string') manifest.environment[key]=value.replaceAll('127.0.0.1:'+port,'127.0.0.1:'+actualPort);
  }`,
  );
  // The generated Git config has the container's fixed CONNECT address. Override only that
  // route in this fixture process, keeping its execution CA/helper and the read-only file intact.
  return replaceRequired(
    entry,
    "const [command,...args]=process.argv.slice(2);",
    `const fixtureGitConfigIndex=Number(environment.GIT_CONFIG_COUNT??'0');
environment.GIT_CONFIG_COUNT=String(fixtureGitConfigIndex+1);
environment['GIT_CONFIG_KEY_'+fixtureGitConfigIndex]='http.https://github.com.proxy';
environment['GIT_CONFIG_VALUE_'+fixtureGitConfigIndex]=environment.OPENTAG_PROVIDER_PROXY_URL;
const [command,...args]=process.argv.slice(2);`,
  );
}
