#!/usr/bin/env node

import { runCli } from "../src/index.mjs";

process.exitCode = await runCli(process.argv.slice(2));
