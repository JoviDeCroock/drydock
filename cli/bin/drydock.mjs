#!/usr/bin/env node
// @ts-check
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { main } from "../src/main.mjs";
import { resolveNpmCommand } from "../src/npm-path.mjs";

const stdinIsTerminal = Boolean(process.stdin.isTTY);

/** @type {AsyncIterator<string> | null} */
let pipedLines = null;
/** @type {import("node:readline").Interface | null} */
let pipedReader = null;

/**
 * One line of input. On a terminal the interface is closed after every answer
 * so nothing is left reading stdin when npm takes the terminal over. A piped
 * stdin is read through one reader, since a reader per question would buffer
 * lines meant for the next one.
 * @param {string} question
 * @returns {Promise<string | null>} null on Ctrl-C, Ctrl-D, or the end of piped input
 */
async function prompt(question) {
  if (!stdinIsTerminal) {
    process.stderr.write(question);
    if (!pipedReader) {
      pipedReader = createInterface({ input: process.stdin, terminal: false });
      pipedLines = pipedReader[Symbol.asyncIterator]();
    }
    const next = await /** @type {AsyncIterator<string>} */ (pipedLines).next();
    process.stderr.write("\n");
    return next.done ? null : next.value;
  }
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
  pipedReader?.close();
  const npm = resolveNpmCommand({
    platform: process.platform,
    path: process.env.PATH ?? process.env.Path,
    cwd: process.cwd(),
    execPath: process.execPath,
    isFile: (path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
  });
  if (!npm) {
    return Promise.resolve({ code: null, signal: null, error: "no npm found on PATH" });
  }
  return new Promise((resolve) => {
    // Ctrl-C reaches npm through the shared terminal; this process stays to
    // report what npm did instead of exiting first.
    const ignoreInterrupt = () => {};
    process.on("SIGINT", ignoreInterrupt);
    const env = { ...process.env };
    delete env.DRYDOCK_API_KEY;
    const child = spawn(npm.command, [...npm.args, ...args], { stdio: "inherit", env });
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
  stdinIsTerminal,
  prompt,
  runNpm,
});
