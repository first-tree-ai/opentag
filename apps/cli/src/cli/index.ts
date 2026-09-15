#!/usr/bin/env node

import { runCli } from "./run.js";

const exitCode = await runCli({ argv: process.argv, env: process.env });
if (exitCode !== 0) process.exitCode = exitCode;
