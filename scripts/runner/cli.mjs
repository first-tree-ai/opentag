#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { parseRunnerScriptArgv } from "./args.mjs";
import { buildRunnerImage } from "./build-image.mjs";
import { runWithCleanup } from "./cleanup.mjs";

async function main(argv) {
  const parsed = parseRunnerScriptArgv(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exitCode = parsed.exitCode;
    return;
  }
  if (parsed.command !== "build") {
    console.error(`unknown command: ${parsed.command}`);
    process.exitCode = 2;
    return;
  }
  const channel = parsed.options.channel ?? "dev";
  const result = await runWithCleanup(() =>
    buildRunnerImage({
      channel,
      version: parsed.options.version,
      allowDirty: parsed.options["allow-dirty"] === "true",
      tag: parsed.options.tag ?? "opentag-runner:local",
    }),
  );
  console.log(
    JSON.stringify({
      tag: result.tag,
      imageId: result.imageId,
      architecture: result.architecture,
      size: result.size,
      identity: result.identity,
    }),
  );
}

const isProcessEntry = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isProcessEntry) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[runner] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
