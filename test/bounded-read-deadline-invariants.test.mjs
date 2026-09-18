// @ts-nocheck
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { sanitizeJsSource } from "./helpers/sanitized-source.mjs";

const SERVER_DIR = fileURLToPath(new URL("../server", import.meta.url));

// The helper's own module defines the readers and documents the byte-only mode.
const DEFINITION_SITE = "lib/platform/bounded-body.ts";

// A byte cap alone leaves a body that trickles under `maxBytes` unbounded in
// time: the fetch helpers clear their abort timer once headers arrive, so
// nothing else is watching the clock. Every remote read therefore names a
// `deadlineMs`. Recording an exception here is a deliberate decision about a
// host whose availability is already the caller's problem — not a default.
const BYTES_ONLY_ALLOWED = [];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Extract the source of each `readBoundedText|Json(...)` call's arguments. */
function boundedReadCalls(source) {
  const calls = [];
  for (const match of source.matchAll(/\breadBounded(?:Text|Json)\s*(?:<[^(]*>)?\s*\(/g)) {
    let depth = 0;
    let end = -1;
    for (let i = match.index + match[0].length - 1; i < source.length; i++) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    // An unbalanced call means the scan is broken, not that the code is fine.
    expect(end, `unterminated readBounded call at offset ${match.index}`).toBeGreaterThan(-1);
    calls.push({
      index: match.index,
      args: source.slice(match.index + match[0].length, end),
    });
  }
  return calls;
}

describe("bounded-read deadline invariants", () => {
  test("every remote bounded read is bounded in time as well as bytes", () => {
    const offenders = [];
    let scanned = 0;

    for (const file of walk(SERVER_DIR)) {
      const relative = path.relative(SERVER_DIR, file).split(path.sep).join("/");
      if (relative === DEFINITION_SITE) continue;
      const source = sanitizeJsSource(readFileSync(file, "utf8"));
      for (const call of boundedReadCalls(source)) {
        scanned++;
        if (call.args.includes("deadlineMs")) continue;
        const line = source.slice(0, call.index).split("\n").length;
        if (BYTES_ONLY_ALLOWED.includes(`${relative}:${line}`)) continue;
        offenders.push(`${relative}:${line}`);
      }
    }

    // Guard the scan itself: a rename that stops matching would otherwise make
    // this test pass by finding nothing at all.
    expect(scanned).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });
});
