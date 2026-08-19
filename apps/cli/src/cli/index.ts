#!/usr/bin/env node

import "../core/channel/environment.js";
import { createProgram } from "./program.js";

await createProgram().parseAsync(process.argv);
