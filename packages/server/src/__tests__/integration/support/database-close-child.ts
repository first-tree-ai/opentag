import assert from "node:assert/strict";
import { createDatabaseClient } from "../../../db/client.js";

const url = process.env.OPENTAG_CLOSE_TEST_URL;
assert.ok(url);
const graceful = process.argv[2] === "withheld-fin";
const { sql } = createDatabaseClient(url, { max: 1 });
await sql`select 1`;
process.stdout.write("ready\n");
for await (const _ of process.stdin) break;
let callbackRan = false;
const query = graceful
  ? sql`select pg_sleep(0.15)`
  : sql.begin(async () => {
      callbackRan = true;
    });
const outcome = Promise.resolve(query).then(
  () => ({ error: undefined }),
  (error: unknown) => ({ error }),
);
await new Promise((resolve) => setTimeout(resolve, 20));
await sql.end({ timeout: graceful ? 0.5 : 0.1 });
const result = await outcome;
if (graceful) assert.equal(result.error, undefined);
else {
  assert.equal(callbackRan, false);
  assert.equal((result.error as { code?: string })?.code, "CONNECTION_DESTROYED");
}
process.stdout.write("closed\n");
