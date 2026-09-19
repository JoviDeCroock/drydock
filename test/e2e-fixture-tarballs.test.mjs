// @ts-nocheck
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  hostMetadataTarEntries,
  tarEntryNames,
  tarballEntryNames,
} from "./e2e/tarball-entries.mjs";
import { buildTar } from "./helpers/archive-fixtures.mjs";

describe("tarEntryNames", () => {
  test("lists packed members in archive order", () => {
    const tar = buildTar([
      { name: "package/", type: "5" },
      { name: "package/package.json", body: "{}" },
      { name: "package/index.js", body: "export const a = 1;\n" },
    ]);

    expect(tarEntryNames(tar)).toEqual(["package/", "package/package.json", "package/index.js"]);
  });

  test("skips pax and GNU header records, which describe the member after them", () => {
    const tar = buildTar([
      { name: "PaxHeader/package", type: "x", body: "30 mtime=1700000000.0000\n" },
      { name: "package/", type: "5" },
      { name: "././@LongLink", type: "L", body: "package/index.js\0" },
      { name: "package/index.js", body: "export const a = 1;\n" },
    ]);

    expect(tarEntryNames(tar)).toEqual(["package/", "package/index.js"]);
  });

  test("joins the ustar prefix field onto the name", () => {
    const tar = buildTar([{ name: "index.js", prefix: "package/nested", body: "1\n" }]);

    expect(tarEntryNames(tar)).toEqual(["package/nested/index.js"]);
  });

  test("reads a gzipped tarball", () => {
    const tar = buildTar([{ name: "package/package.json", body: "{}" }]);

    expect(tarballEntryNames(gzipSync(Buffer.from(tar)))).toEqual(["package/package.json"]);
  });
});

describe("hostMetadataTarEntries", () => {
  // The shape that made the invalid-package-json scenario grade `high` locally
  // and `medium` on CI: macOS tar wrote the extracted files' extended
  // attributes back as AppleDouble members, and a bare `._package` has no
  // directory component for npm's `strip: 1` to remove.
  test("reports AppleDouble sidecars, __MACOSX, and Finder state", () => {
    expect(
      hostMetadataTarEntries([
        "._package",
        "package/",
        "package/._index.js",
        "package/index.js",
        "__MACOSX/package/index.js",
        "package/.DS_Store",
      ]),
    ).toEqual([
      "._package",
      "package/._index.js",
      "__MACOSX/package/index.js",
      "package/.DS_Store",
    ]);
  });

  test("passes a package whose own files merely start with a dot", () => {
    expect(
      hostMetadataTarEntries([
        "package/",
        "package/.npmignore",
        "package/.bin/cli.js",
        "package/_private.js",
      ]),
    ).toEqual([]);
  });
});
