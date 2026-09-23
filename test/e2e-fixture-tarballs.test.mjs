// @ts-nocheck
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  hostMetadataTarEntries,
  tarEntryNames,
  tarballEntryNames,
} from "./e2e/tarball-entries.mjs";
import { TAR_BLOCK, buildTar, concatBytes, tarEntriesOnly } from "./helpers/archive-fixtures";

describe("tarEntryNames", () => {
  test("lists packed members in archive order", () => {
    const tar = buildTar([
      { name: "package/", type: "5" },
      { name: "package/package.json", body: "{}" },
      { name: "package/index.js", body: "export const a = 1;\n" },
    ]);

    expect(tarEntryNames(tar)).toEqual(["package/", "package/package.json", "package/index.js"]);
  });

  test("skips header records that only carry metadata for the member after them", () => {
    const tar = buildTar([
      { name: "PaxHeader/package", type: "x", body: "30 mtime=1700000000.0000\n" },
      { name: "package/", type: "5" },
      { name: "././@LongLink", type: "K", body: "package/target.js\0" },
      { name: "package/index.js", body: "export const a = 1;\n" },
    ]);

    expect(tarEntryNames(tar)).toEqual(["package/", "package/index.js"]);
  });

  // A long-name or pax record renames the member that follows it, so reading
  // only the 100-byte name field would report a truncated path — and miss the
  // `._` segment this check exists to catch.
  test("resolves a GNU long-name record onto the member it renames", () => {
    const longName = `package/${"d".repeat(110)}/._secret`;
    const tar = buildTar([
      { name: "././@LongLink", type: "L", body: `${longName}\0` },
      { name: longName.slice(0, 100), body: "payload\n" },
      { name: "package/index.js", body: "export const a = 1;\n" },
    ]);

    expect(tarEntryNames(tar)).toEqual([longName, "package/index.js"]);
    expect(hostMetadataTarEntries(tarEntryNames(tar))).toEqual([longName]);
  });

  test("resolves a pax path override onto the member it renames", () => {
    const paxPath = "package/nested/._secret";
    const tar = buildTar([
      { name: "PaxHeader/index.js", type: "x", body: paxRecords({ path: paxPath }) },
      { name: "package/index.js", body: "payload\n" },
    ]);

    expect(tarEntryNames(tar)).toEqual([paxPath]);
  });

  // npm's reader (node-tar) ends an archive on the second consecutive zero
  // block, so stopping at the first would report a clean entry list for an
  // archive npm still unpacks members from.
  test("reads past a single zero block, the way npm's reader does", () => {
    const tar = concatBytes([
      tarEntriesOnly(buildTar([{ name: "package/index.js", body: "export const a = 1;\n" }])),
      new Uint8Array(TAR_BLOCK),
      buildTar([{ name: "._package", body: "payload\n" }]),
    ]);

    expect(tarEntryNames(tar)).toEqual(["package/index.js", "._package"]);
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

// A pax record is `<length> <key>=<value>\n`, where the length counts its own
// digits — so it takes a fixed point to write.
function paxRecords(fields) {
  return Object.entries(fields)
    .map(([key, value]) => {
      const payload = ` ${key}=${value}\n`;
      let length = payload.length + 1;
      while (String(length).length + payload.length !== length) {
        length = String(length).length + payload.length;
      }
      return `${length}${payload}`;
    })
    .join("");
}

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
