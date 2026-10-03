// @ts-check
import { CliError } from "./client.mjs";

// A small strict argument parser. `node:util`'s parseArgs would do, but the CLI
// core also runs inside the Workers runtime in its end-to-end test, which does
// not implement it.

/**
 * @typedef {{ type: "string" | "boolean"; short?: string }} OptionSpec
 */

/**
 * @param {string[]} argv
 * @param {Record<string, OptionSpec>} options
 * @returns {{ values: Record<string, string | boolean | undefined>; positionals: string[] }}
 */
export function parseArguments(argv, options) {
  /** @type {Record<string, string | boolean | undefined>} */
  const values = {};
  /** @type {string[]} */
  const positionals = [];
  /** @type {Record<string, string>} */
  const shorts = {};
  for (const [name, spec] of Object.entries(options)) {
    if (spec.short) shorts[spec.short] = name;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const long = arg.startsWith("--");
    const [flag, inline] = long ? splitInline(arg.slice(2)) : [arg.slice(1), undefined];
    const name = long ? flag : shorts[flag];
    const spec = name === undefined ? undefined : options[name];
    if (name === undefined || !spec) throw new CliError(`unknown option: ${arg}`, 2);
    if (spec.type === "boolean") {
      if (inline !== undefined) throw new CliError(`--${name} does not take a value`, 2);
      values[name] = true;
      continue;
    }
    const value = inline ?? argv[index + 1];
    if (value === undefined || (inline === undefined && value.startsWith("-"))) {
      throw new CliError(`--${name} needs a value`, 2);
    }
    if (inline === undefined) index += 1;
    values[name] = value;
  }
  return { values, positionals };
}

/**
 * @param {string} text
 * @returns {[string, string | undefined]}
 */
function splitInline(text) {
  const equals = text.indexOf("=");
  return equals === -1 ? [text, undefined] : [text.slice(0, equals), text.slice(equals + 1)];
}
