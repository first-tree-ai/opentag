/**
 * E1 synthetic ingress helper.
 *
 * Loads Server source (harness-only) so the same ImMessageInbox that production
 * uses persists a NormalizedInboundImEvent. The Server child process's
 * ImDeliveryWorker then claims the row. This is not a public API.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

const databaseUrl = process.env.OPENTAG_DATABASE_URL;
const bindingId = argValue("--binding-id");
const generationText = argValue("--generation") ?? "1";
const eventPath = argValue("--event-file");

if (!databaseUrl || !bindingId || !eventPath) {
  process.stderr.write(
    "usage: OPENTAG_DATABASE_URL=<url> tsx ingress.ts --binding-id <uuid> --generation <n> --event-file <path>\n",
  );
  process.exit(2);
}

const [{ createDatabaseClient }, { ImMessageInbox }] = await Promise.all([
  import(resolve(repositoryRoot, "packages/server/src/db/client.ts")),
  import(resolve(repositoryRoot, "packages/server/src/services/im/im-message-inbox.ts")),
]);

const event = JSON.parse(await readFile(eventPath, "utf8"));
const { database, sql } = createDatabaseClient(databaseUrl, { max: 2 });
try {
  const inbox = new ImMessageInbox(database);
  const result = await inbox.ingest(bindingId, Number(generationText), event, undefined, { provider: "slack" });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await sql.end({ timeout: 5 });
}
