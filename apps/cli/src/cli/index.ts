#!/usr/bin/env node

import "../core/channel-env.js";
import { createProgram } from "./program.js";

await createProgram().parseAsync(process.argv);
