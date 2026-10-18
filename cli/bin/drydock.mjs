#!/usr/bin/env node
// @ts-check
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { main } from "../src/main.mjs";

/**
 * One line from the terminal. The interface is closed after every answer so
 * nothing is left reading stdin when npm takes the terminal over.
 * @param {string} question
 * @returns {Promise<string | null>} null on Ctrl-C or Ctrl-D
 */
function prompt(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let answered = false;
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => {
      if (answered) return;
      process.stderr.write("\n");
      resolve(null);
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Runs the user's own npm on this terminal: npm prompts for and reads the
 * one-time password itself, and none of its input or output passes through
 * this process. The Drydock key is removed from npm's environment.
 * @param {string[]} args validated by the caller (stage id and registry URL shapes)
 * @returns {Promise<import("../src/approve.mjs").NpmResult>}
 */
function runNpm(args) {
  return new Promise((resolve) => {
    // Ctrl-C reaches npm through the shared terminal; this process stays to
    // report what npm did instead of exiting first.
    const ignoreInterrupt = () => {};
    process.on("SIGINT", ignoreInterrupt);
    const env = { ...process.env };
    delete env.DRYDOCK_API_KEY;
    // npm is a .cmd shim on Windows, which only a shell can start.
    const windows = process.platform === "win32";
    const child = spawn(windows ? "npm.cmd" : "npm", args, {
      stdio: "inherit",
      env,
      shell: windows,
    });
    /** @param {import("../src/approve.mjs").NpmResult} result */
    const done = (result) => {
      process.off("SIGINT", ignoreInterrupt);
      resolve(result);
    };
    child.on("error", (err) => done({ code: null, signal: null, error: err.message }));
    child.on("exit", (code, signal) => done({ code, signal }));
  });
}

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  fetch: globalThis.fetch,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  writeFile: (path, data) => writeFile(path, data, { mode: 0o644 }),
  sleep: (ms) => sleep(ms),
  now: () => Date.now(),
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  prompt,
  runNpm,
});
