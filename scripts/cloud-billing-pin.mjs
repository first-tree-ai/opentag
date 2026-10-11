import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertFullSha } from "./runner/release-record.mjs";

/** Read the application revision's dependency pin, including during a deliberate rollback. */
export function readBillingRevision({ repositoryRoot = process.cwd(), serverRevision } = {}) {
  if (serverRevision !== undefined) assertFullSha(serverRevision, "server revision");
  const content =
    serverRevision === undefined
      ? readFileSync(resolve(repositoryRoot, "cloud-billing.json"), "utf8")
      : execFileSync("git", ["show", `${serverRevision}:cloud-billing.json`], {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
  const pin = JSON.parse(content);
  if (!pin || Object.keys(pin).length !== 1) throw new Error("Invalid cloud billing pin");
  assertFullSha(pin.revision, "billing revision");
  return pin.revision;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length > 3) throw new Error("usage: cloud-billing-pin.mjs [application SHA]");
    console.log(readBillingRevision({ serverRevision: process.argv[2] }));
  } catch {
    console.error("Could not read a full billing commit SHA from the selected application's cloud-billing.json");
    process.exitCode = 1;
  }
}
