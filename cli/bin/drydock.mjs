#!/usr/bin/env node
// @ts-check
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { main } from "../src/main.mjs";

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  fetch: globalThis.fetch,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  writeFile: (path, data) => writeFile(path, data, { mode: 0o644 }),
  sleep: (ms) => sleep(ms),
  now: () => Date.now(),
});
