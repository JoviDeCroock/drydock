import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const shellSource = readFileSync(
  new URL("../src/components/PageShell.tsx", import.meta.url),
  "utf8",
);
const routerSource = readFileSync(new URL("../src/index.tsx", import.meta.url), "utf8");

// Footer destinations live in FOOTER_GROUPS rather than in literal `href=`
// attributes, so neither a reviewer scanning JSX nor the Worker-route link
// guard in server-route-links.test.ts sees them.
const footerGroups = shellSource.slice(
  shellSource.indexOf("const FOOTER_GROUPS"),
  shellSource.indexOf("function SiteFooter"),
);
const footerHrefs = [...footerGroups.matchAll(/href: (?:"([^"]+)"|([A-Z_]+))/g)].map(
  (match) => match[1] ?? match[2],
);
const routerPaths = new Set(
  [...routerSource.matchAll(/<Route path="([^"]+)"/g)].map((match) => match[1]),
);

describe("site footer links", () => {
  test("are all read by this guard", () => {
    const declared = footerGroups.match(/href:/g)?.length ?? 0;
    expect(declared).toBeGreaterThan(0);
    expect(footerHrefs).toHaveLength(declared);
  });

  test("point at declared routes", () => {
    for (const href of footerHrefs.filter((href) => href.startsWith("/"))) {
      expect(routerPaths).toContain(href);
    }
  });

  test("never client-route into a Worker route", () => {
    for (const href of footerHrefs) {
      expect(href.startsWith("/api/")).toBe(false);
      expect(href.startsWith("/public/")).toBe(false);
    }
  });
});
