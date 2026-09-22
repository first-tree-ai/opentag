#!/usr/bin/env node

import { runCli } from "./run.js";

/*
 * The CLI ships as one bundle, so an untranslated stack names `dist/cli/index.mjs` and a line number
 * in it, which tells a reader of an error report nothing about the source it came from. Source maps
 * are consulted when a stack is captured, so asking for them here covers everything this process can
 * go on to throw. `--enable-source-maps` would do the same, but a `#!/usr/bin/env node` shebang
 * cannot portably carry a flag.
 */
process.setSourceMapsEnabled(true);

const exitCode = await runCli({ argv: process.argv, env: process.env });
if (exitCode !== 0) process.exitCode = exitCode;
