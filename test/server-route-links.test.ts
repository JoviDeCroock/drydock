import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// `/public/*` and `/api/*` are Worker routes, not `preact-iso` routes. A plain
// same-origin anchor to one of them is intercepted by the router's click
// handler, which finds no matching `<Route>` and renders the SPA 404 instead of
// hitting the server — the link only works on a hard load or paste. The router
// skips links that carry a `target` or `download` attribute, so one of those is
// required. Reported from production: the attestation-key link on
// `/reports/:token` 404'd when clicked.
const srcDir = fileURLToPath(new URL("../src", import.meta.url));

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [full] : [];
  });
}

/** The JSX opening tag containing `index`, e.g. `<a href="/public/x" class="y">`. */
function enclosingTag(source: string, index: number): string {
  const start = source.lastIndexOf("<", index);
  const end = source.indexOf(">", index);
  return start === -1 || end === -1 ? "" : source.slice(start, end + 1);
}

describe("links to Worker routes", () => {
  // Only literal hrefs are checked; an href built from a variable is invisible
  // here, so this is a guard against the common shape, not a proof.
  const serverHref = /href=\{?[`"]\/(public|api)\//g;

  test("do not client-route into the SPA 404", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(srcDir)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(serverHref)) {
        const tag = enclosingTag(source, match.index);
        if (!/\btarget=/.test(tag) && !/\bdownload\b/.test(tag)) {
          offenders.push(`${file.slice(srcDir.length + 1)}: ${tag.replace(/\s+/g, " ")}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the guard recognises an unguarded link", () => {
    const sample = '<a href="/public/attestation-key" class="underline">key</a>';
    const tag = enclosingTag(sample, sample.search(serverHref));
    expect(tag).toBe('<a href="/public/attestation-key" class="underline">');
    expect(/\btarget=/.test(tag)).toBe(false);
  });
});
