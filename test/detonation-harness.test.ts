import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("detonation harness privilege boundary", () => {
  test("spawns root-run binaries by absolute path, never through the package's PATH", () => {
    // A step's env PATH starts with `node_modules/.bin`, which the package
    // fills through its own `bin` entries; a bare `setpriv` or `strace` there
    // would run as root.
    const source = readFileSync(
      new URL("../containers/detonation/harness.mjs", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/["'](?:setpriv|strace)["']/);
    expect(source).toContain('"/usr/bin/setpriv"');
    expect(source).toContain('"/usr/bin/strace"');
  });
});
