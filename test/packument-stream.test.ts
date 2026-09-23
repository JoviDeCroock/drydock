import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  createPackumentExtractor,
  PackumentStreamError,
  type PackumentExtract,
  type PackumentVersion,
} from "../server/lib/ecosystems/npm/packument-stream";

type Limits = Parameters<typeof createPackumentExtractor>[0];

const encoder = new TextEncoder();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function ownString(object: Record<string, unknown>, key: string): string | null {
  const value = own(object, key);
  return typeof value === "string" ? value : null;
}

function stringEntries(value: unknown): [string, string][] {
  if (!isObject(value)) return [];
  return Object.entries(value).filter((entry): entry is [string, string] => {
    return typeof entry[1] === "string";
  });
}

const byKey = <T>(a: [string, T], b: [string, T]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/** The contract: `JSON.parse` followed by the projection the extractor keeps. */
function reference(text: string) {
  const doc: unknown = JSON.parse(text);
  if (!isObject(doc)) throw new Error("top-level value is not an object");
  const versions = own(doc, "versions");
  return {
    name: ownString(doc, "name"),
    versionsIsObject: isObject(versions),
    versions: (isObject(versions) ? Object.entries(versions) : [])
      .map(([version, entry]): [string, PackumentVersion | null] => {
        if (!isObject(entry)) return [version, null];
        const dist = own(entry, "dist");
        return [
          version,
          {
            name: ownString(entry, "name"),
            version: ownString(entry, "version"),
            tarball: isObject(dist) ? ownString(dist, "tarball") : null,
            shasum: isObject(dist) ? ownString(dist, "shasum") : null,
          },
        ];
      })
      .sort(byKey),
    time: stringEntries(own(doc, "time")).sort(byKey),
    distTags: stringEntries(own(doc, "dist-tags")).sort(byKey),
    distTagsTruncated: false,
    versionLimitExceeded: false,
    oversizedVersionKey: false,
  };
}

function normalize(extract: PackumentExtract) {
  return {
    name: extract.name,
    versionsIsObject: extract.versionsIsObject,
    versions: [...extract.versions].sort(byKey),
    time: [...extract.time].sort(byKey),
    distTags: [...extract.distTags].sort(byKey),
    distTagsTruncated: extract.distTagsTruncated,
    versionLimitExceeded: extract.versionLimitExceeded,
    oversizedVersionKey: extract.oversizedVersionKey,
  };
}

function extract(input: string | Uint8Array, cuts: readonly number[] = [], limits?: Limits) {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  const extractor = createPackumentExtractor(limits);
  let previous = 0;
  for (const cut of [...cuts, bytes.length]) {
    extractor.write(bytes.subarray(previous, cut));
    previous = cut;
  }
  return extractor.end();
}

function errorCode(input: string | Uint8Array, limits?: Limits): string | null {
  try {
    extract(input, [], limits);
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(PackumentStreamError);
    return (err as PackumentStreamError).code;
  }
}

// Hand-written so it carries what `JSON.stringify` never emits: duplicate keys,
// escaped key names, and every JSON literal and number form. `\u` escapes are
// substituted in because the formatter rewrites them inside `String.raw`.
const U = "\\u";
const realistic = String.raw`{
  "_id": "@scope/pkg", "_rev": "12-abc",
  "name": "@scope/pkg",
  "description": "quotes \" and backslashes \\ and \/ and ${U}00e9 and ${U}d83d${U}de00 and 😀",
  "dist-tags": { "latest": "2.0.0", "next": "3.0.0-rc.1", "legacy": 1, "beta": "2.0.0-beta.0" },
  "versions": {
    "1.0.0": {
      "name": "@scope/pkg", "version": "1.0.0",
      "scripts": { "test": "node -e \"process.exit(0)\"" },
      "dist": { "tarball": "https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz", "shasum": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "integrity": "sha512-xyz==", "signatures": [{ "keyid": "k", "sig": "s" }], "fileCount": 12, "unpackedSize": 3.5e+3 }
    },
    "2.0.0": {
      "${U}006eame": "@scope/pkg", "version": "2.0.0", "deprecated": false, "gitHead": null,
      "dist": { "tarball": "first", "shasum": 17 },
      "dist": { "tarball": "https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0.tgz" },
      "engines": { "node": ">=18" }, "weights": [-0.5e-10, 0, 12.25E2, -1, [], {}, [[{}]], true, null]
    },
    "2.0.0-beta.0": "not an object",
    "__proto__": { "version": "proto", "dist": [] },
    "constructor": { "version": 7, "name": "ctor" },
    "3.0.0-rc.1": { "name": "@scope/pkg", "version": "3.0.0-rc.1", "dist": { "tarball": "${U}0068ttps://example/${U}2028x", "shasum": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } },
    "1.0.0": { "name": "@scope/pkg", "version": "1.0.0", "dist": { "tarball": "replaced", "shasum": null } }
  },
  "time": {
    "created": "2020-01-01T00:00:00.000Z", "modified": "2026-09-20T00:00:00.000Z",
    "1.0.0": "2020-01-01T00:00:00.000Z", "2.0.0": "2026-09-19T00:00:00.000Z",
    "3.0.0-rc.1": "2026-09-20T00:00:00.000Z", "unpublished": { "time": "x", "versions": ["0.0.1"] },
    "__proto__": "proto-time", "2.0.0": "2026-09-19T12:00:00.000Z", "created": null
  },
  "readme": "# pkg\n\n\"fenced\"\\ \\\\\" }{ ][ \":\" ,",
  "maintainers": [{ "name": "a", "email": "a@example.com" }],
  "name": "@scope/pkg",
  "users": {}, "license": "MIT", "keywords": [], "homepage": "", "extra": [1, 2.5, -3e4, "s"]
}`;

describe("packument extraction equals JSON.parse and the projection", () => {
  test("a realistic packument, whole and in single-byte chunks", () => {
    const expected = reference(realistic);
    expect(expected.versions).toHaveLength(6);
    expect(normalize(extract(realistic))).toEqual(expected);
    const bytes = encoder.encode(realistic);
    const everyByte = Array.from({ length: bytes.length - 1 }, (_, index) => index + 1);
    expect(normalize(extract(bytes, everyByte))).toEqual(expected);
  });

  test("a realistic packument split into two chunks at every byte offset", () => {
    const expected = reference(realistic);
    const bytes = encoder.encode(realistic);
    for (let cut = 0; cut <= bytes.length; cut++) {
      expect(normalize(extract(bytes, [cut])), `cut at ${cut}`).toEqual(expected);
    }
  });

  test("keys like __proto__ and constructor stay data", () => {
    const result = extract(
      `{"versions":{"__proto__":{"version":"1"}},"time":{"constructor":"t"},"dist-tags":{"__proto__":"1"}}`,
    );
    expect(result.versions.get("__proto__")).toEqual({
      name: null,
      version: "1",
      tarball: null,
      shasum: null,
    });
    expect(result.time.get("constructor")).toBe("t");
    expect(result.distTags.get("__proto__")).toBe("1");
    expect(({} as Record<string, unknown>).version).toBeUndefined();
  });

  test("the last duplicate wins, replacing objects wholesale and erasing strings", () => {
    const result = extract(
      `{"name":"a","name":1,"versions":{"1.0.0":{"dist":{"tarball":"t"}}},"versions":{"2.0.0":{"version":"2.0.0"},"2.0.0":{"name":"n"}},"dist-tags":{"latest":"1","latest":["x"]}}`,
    );
    expect(result.name).toBeNull();
    expect([...result.versions]).toEqual([
      ["2.0.0", { name: "n", version: null, tarball: null, shasum: null }],
    ]);
    expect(result.distTags.size).toBe(0);
  });

  test("a non-object version value is recorded as null; a non-object versions is not an object", () => {
    const result = extract(`{"versions":{"1.0.0":"x","2.0.0":null,"3.0.0":[]}}`);
    expect([...result.versions]).toEqual([
      ["1.0.0", null],
      ["2.0.0", null],
      ["3.0.0", null],
    ]);
    expect(result.versionsIsObject).toBe(true);
    expect(extract(`{"versions":[{"1.0.0":{}}]}`)).toMatchObject({ versionsIsObject: false });
    expect(extract(`{}`)).toMatchObject({ versionsIsObject: false, name: null });
  });

  test("a match key too long to be a field name is skipped, not an error", () => {
    const result = extract(`{"${"k".repeat(10_000)}":{"name":"inner"},"name":"outer"}`);
    expect(result.name).toBe("outer");
  });

  test("property: generated documents with duplicates, noise and random chunking", () => {
    fc.assert(
      fc.property(documentText, fc.array(fc.nat(), { maxLength: 12 }), (text, rawCuts) => {
        const bytes = encoder.encode(text);
        const cuts = rawCuts.map((cut) => cut % (bytes.length + 1)).sort((a, b) => a - b);
        expect(normalize(extract(bytes, cuts))).toEqual(reference(text));
      }),
      { numRuns: 400 },
    );
  });

  test("property: every proper prefix of a document is incomplete", () => {
    fc.assert(
      fc.property(documentText, fc.nat(), (text, rawCut) => {
        const bytes = encoder.encode(text);
        const cut = rawCut % bytes.length;
        const extractor = createPackumentExtractor();
        expect(() => {
          extractor.write(bytes.subarray(0, cut));
          extractor.end();
        }).toThrow(PackumentStreamError);
      }),
      { numRuns: 200 },
    );
  });
});

describe("invalid and hostile documents", () => {
  test.each([
    ["truncated", `{"name":"a"`],
    ["trailing garbage", `{"name":"a"} x`],
    ["a second document", `{"a":1}{"b":2}`],
    ["a top-level array", `[]`],
    ["a top-level string", `"x"`],
    ["a top-level number", `1`],
    ["empty input", ``],
    ["a missing colon", `{"a" 1}`],
    ["a trailing comma in an object", `{"a":1,}`],
    ["an empty member", `{,}`],
    ["a tracked object closed by a bracket", `{"a":1]`],
    ["a version entry closed by a bracket", `{"versions":{"1.0.0":{"version":"1"]}}`],
    ["dist closed by a bracket", `{"versions":{"1.0.0":{"dist":{}]}}`],
    ["a skipped value closed by the wrong bracket, leaving the document open", `{"a":[1}`],
    ["a leading zero", `{"a":01}`],
    ["a bare fraction dot", `{"a":1.}`],
    ["a lone minus", `{"a":-}`],
    ["a bare exponent", `{"a":1e}`],
    ["a partial keyword", `{"a":tru}`],
    ["a keyword with extra letters", `{"a":truex}`],
    ["a single-quoted string", `{'a':1}`],
    ["an invalid escape in a captured string", String.raw`{"name":"\x"}`],
    ["a raw control character in a captured string", `{"name":"a\nb"}`],
    ["a byte-order mark", `${String.fromCharCode(0xfeff)}{}`],
  ])("%s is invalid", (_, text) => {
    expect(errorCode(text)).toBe("invalid");
  });

  test("invalid UTF-8 inside a captured string is invalid", () => {
    const bytes = Uint8Array.from([...encoder.encode(`{"name":"a`), 0xff, ...encoder.encode(`"}`)]);
    expect(errorCode(bytes)).toBe("invalid");
    const key = Uint8Array.from([
      ...encoder.encode(`{"time":{"`),
      0xc3,
      ...encoder.encode(`":"x"}}`),
    ]);
    expect(errorCode(key)).toBe("invalid");
  });

  test("an input error is sticky", () => {
    const extractor = createPackumentExtractor();
    expect(() => extractor.write(encoder.encode("]"))).toThrow(PackumentStreamError);
    expect(() => extractor.write(encoder.encode("{}"))).toThrow(PackumentStreamError);
    expect(() => extractor.end()).toThrow(PackumentStreamError);
  });

  test("a nesting bomb in a skipped value parses, and what follows it is captured", () => {
    const arrays = `${"[".repeat(100_000)}${"]".repeat(100_000)}`;
    const objects = `${'{"a":'.repeat(100_000)}1${"}".repeat(100_000)}`;
    for (const bomb of [arrays, objects]) {
      const text = `{"bomb":${bomb},"versions":{"1.0.0":{"name":"p","custom":${bomb},"version":"1.0.0","dist":{"extra":${bomb},"tarball":"t","shasum":"s"}},"2.0.0":{"version":"2.0.0"}},"time":{"1.0.0":"t1"},"name":"p"}`;
      const bytes = encoder.encode(text);
      const cuts = Array.from({ length: 64 }, (_, index) =>
        Math.floor((bytes.length * index) / 64),
      );
      const result = extract(bytes, cuts);
      expect(normalize(result)).toEqual(reference(text));
      expect(result.versions.get("1.0.0")).toEqual({
        name: "p",
        version: "1.0.0",
        tarball: "t",
        shasum: "s",
      });
      expect(result.versions.get("2.0.0")?.version).toBe("2.0.0");
      expect(result.time.get("1.0.0")).toBe("t1");
      expect(result.name).toBe("p");
    }
  });

  test("structure inside a skipped value is not validated, but strings in it are tracked", () => {
    // npm serves `JSON.stringify` output; the skip scanner only needs brackets
    // outside strings to balance, and nothing inside is captured.
    expect(extract(`{"a":[1,],"b":{"c" 1},"name":"n"}`).name).toBe("n");
    const text = String.raw`{"a":["x\"]",{"y":"}\\"},"[{"],"name":"n","versions":{"1":{"k":["]"],"version":"1"}}}`;
    expect(normalize(extract(text))).toEqual(reference(text));
    expect(extract(text).versions.get("1")?.version).toBe("1");
  });

  test("an overlong captured string loses only its own field", () => {
    const long = `"${"a".repeat(5_000)}"`;
    const result = extract(
      `{"name":${long},"versions":{"1.0.0":{"name":${long},"version":${long},"dist":{"tarball":${long},"shasum":${long}}},"2.0.0":{"version":"2.0.0","dist":{"tarball":"t2"}}},"time":{"1.0.0":"t","2.0.0":${long}},"dist-tags":{"latest":"2.0.0","next":${long}}}`,
    );
    expect(result.name).toBeNull();
    expect(result.versions.get("1.0.0")).toEqual({
      name: null,
      version: null,
      tarball: null,
      shasum: null,
    });
    expect(result.versions.get("2.0.0")).toEqual({
      name: null,
      version: "2.0.0",
      tarball: "t2",
      shasum: null,
    });
    expect([...result.time]).toEqual([["1.0.0", "t"]]);
    expect([...result.distTags]).toEqual([["latest", "2.0.0"]]);
    expect(result.distTagsTruncated).toBe(true);
    expect(result.oversizedVersionKey).toBe(false);
    // Uncaptured content of any length is skipped without being held.
    expect(extract(`{"readme":"${"a".repeat(100_000)}","name":"x"}`).name).toBe("x");
  });

  test("an overlong key drops its entry: time, dist-tags, versions", () => {
    const key = `"${"1".repeat(5_000)}"`;
    const result = extract(
      `{"versions":{"1.0.0":{"version":"1.0.0"},${key}:{"version":"x","custom":[[[]]]}},"time":{${key}:"t","1.0.0":"t1"},"dist-tags":{${key}:"1.0.0","latest":"1.0.0"}}`,
    );
    expect([...result.versions.keys()]).toEqual(["1.0.0"]);
    expect(result.oversizedVersionKey).toBe(true);
    expect([...result.time]).toEqual([["1.0.0", "t1"]]);
    expect([...result.distTags]).toEqual([["latest", "1.0.0"]]);
    expect(result.distTagsTruncated).toBe(true);
    // A later `versions` replaces the earlier one, including that flag.
    expect(extract(`{"versions":{${key}:{}},"versions":{"1.0.0":{}}}`).oversizedVersionKey).toBe(
      false,
    );
  });

  test("a later valid duplicate wins over an overlong capture", () => {
    const long = `"${"a".repeat(200)}"`;
    const result = extract(
      `{"versions":{"1.0.0":{"version":${long},"version":"1.0.0"}},"time":{"1.0.0":${long},"1.0.0":"t"},"dist-tags":{"latest":${long},"latest":"1.0.0"}}`,
      [],
      { maxCapturedBytes: 100 },
    );
    expect(result.versions.get("1.0.0")?.version).toBe("1.0.0");
    expect(result.time.get("1.0.0")).toBe("t");
    expect(result.distTags.get("latest")).toBe("1.0.0");
    // The earlier drop is still reported.
    expect(result.distTagsTruncated).toBe(true);
    const exact = `"${"a".repeat(98)}"`;
    expect(extract(`{"name":${exact}}`, [], { maxCapturedBytes: 100 }).name).toHaveLength(98);
    expect(extract(`{"name":"${"a".repeat(99)}"}`, [], { maxCapturedBytes: 100 }).name).toBeNull();
  });

  test("the dist-tag cap drops the excess and says so", () => {
    const result = extract(`{"dist-tags":{"a":"1","b":"2","c":"3","a":"4"}}`, [], {
      maxDistTags: 2,
    });
    expect([...result.distTags]).toEqual([
      ["a", "4"],
      ["b", "2"],
    ]);
    expect(result.distTagsTruncated).toBe(true);
    expect(extract(`{"dist-tags":{"a":"1","b":"2"}}`, [], { maxDistTags: 2 })).toMatchObject({
      distTagsTruncated: false,
    });
  });

  test("the version cap stops recording new versions and says so", () => {
    const result = extract(
      `{"versions":{"a":{},"b":{},"c":{"version":"c"},"d":"x","a":{"version":"a2"}}}`,
      [],
      { maxVersions: 2 },
    );
    expect([...result.versions.keys()]).toEqual(["a", "b"]);
    expect(result.versions.get("a")?.version).toBe("a2");
    expect(result.versionLimitExceeded).toBe(true);
    // A later `versions` replaces the earlier one, cap state included.
    expect(
      extract(`{"versions":{"a":{},"b":{},"c":{}},"versions":{"a":{}}}`, [], { maxVersions: 2 }),
    ).toMatchObject({ versionLimitExceeded: false });
  });
});

test("a ~40 MB packument with deep skipped subtrees streams fast and captures every version", () => {
  const readme = `${'lorem \\"ipsum\\" dolor \\u00e9 '.repeat(340)}`;
  const deep = `${"[".repeat(200_000)}"]["${"]".repeat(200_000)}`;
  const parts: string[] = [`{"name":"big","readme":"${readme}","deep":${deep},"versions":{`];
  const count = 4_000;
  for (let index = 0; index < count; index++) {
    parts.push(
      `${index ? "," : ""}"1.0.${index}":{"name":"big","version":"1.0.${index}","readme":"${readme}","custom":${index % 1_000 === 0 ? deep : "[]"},"dist":{"tarball":"https://registry.npmjs.org/big/-/big-1.0.${index}.tgz","shasum":"${"a".repeat(40)}"}}`,
    );
  }
  parts.push(`},"time":{`);
  for (let index = 0; index < count; index++) {
    parts.push(`${index ? "," : ""}"1.0.${index}":"2026-01-01T00:00:00.000Z"`);
  }
  parts.push(`},"dist-tags":{"latest":"1.0.${count - 1}"}}`);
  const bytes = encoder.encode(parts.join(""));
  expect(bytes.length).toBeGreaterThan(38 * 1024 * 1024);
  const extractor = createPackumentExtractor();
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
    extractor.write(bytes.subarray(offset, offset + 64 * 1024));
  }
  const result = extractor.end();
  expect(result.versions.size).toBe(count);
  expect(result.time.size).toBe(count);
  expect(result.versions.get(`1.0.${count - 1}`)?.tarball).toBe(
    `https://registry.npmjs.org/big/-/big-1.0.${count - 1}.tgz`,
  );
  expect(result.distTags.get("latest")).toBe(`1.0.${count - 1}`);
}, 60_000);

// ---- generated documents ----------------------------------------------------

type Json =
  | { kind: "object"; entries: [string, Json][] }
  | { kind: "array"; items: Json[] }
  | { kind: "string"; value: string; escapeAll: boolean }
  | { kind: "number"; text: string }
  | { kind: "literal"; text: "true" | "false" | "null" };

const whitespace = fc.constantFrom("", "", " ", "\n  ", "\t", "\r\n");

function serialize(node: Json, ws: string): string {
  switch (node.kind) {
    case "object":
      return `{${node.entries
        .map(([key, value]) => `${ws}${quote(key, false)}${ws}:${ws}${serialize(value, ws)}`)
        .join(",")}${ws}}`;
    case "array":
      return `[${node.items.map((item) => `${ws}${serialize(item, ws)}`).join(",")}${ws}]`;
    case "string":
      return quote(node.value, node.escapeAll);
    default:
      return node.text;
  }
}

function quote(value: string, escapeAll: boolean): string {
  if (!escapeAll) return JSON.stringify(value);
  let out = '"';
  for (let index = 0; index < value.length; index++) {
    out += `\\u${value.charCodeAt(index).toString(16).padStart(4, "0")}`;
  }
  return `${out}"`;
}

const anyText = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.string({ unit: "binary", maxLength: 8 }),
  fc.constantFrom("", "\\", '"', " ", "😀", "é"),
);
const stringNode = fc.record({
  kind: fc.constant("string" as const),
  value: anyText,
  escapeAll: fc.boolean(),
});
const numberNode = fc.oneof(
  fc.integer().map((value) => ({ kind: "number" as const, text: String(value) })),
  fc
    .double({ noNaN: true, noDefaultInfinity: true })
    .map((value) => ({ kind: "number" as const, text: JSON.stringify(value) })),
  fc
    .constantFrom("0", "-0", "1e5", "1E+5", "-12.5e-3", "0.0", "10.25E2")
    .map((text) => ({ kind: "number" as const, text })),
);
const literalNode = fc
  .constantFrom("true" as const, "false" as const, "null" as const)
  .map((text) => ({ kind: "literal" as const, text }));

const fieldKey = fc.oneof(
  fc.constantFrom(
    "name",
    "version",
    "versions",
    "time",
    "dist-tags",
    "dist",
    "tarball",
    "shasum",
    "__proto__",
    "constructor",
    "1.0.0",
    "latest",
  ),
  anyText,
);

const { noise } = fc.letrec<{ noise: Json; object: Json; array: Json }>((tie) => ({
  noise: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    stringNode,
    numberNode,
    literalNode,
    tie("object"),
    tie("array"),
  ),
  object: fc.record({
    kind: fc.constant("object" as const),
    entries: fc.array(fc.tuple(fieldKey, tie("noise")), { maxLength: 4 }),
  }),
  array: fc.record({
    kind: fc.constant("array" as const),
    items: fc.array(tie("noise"), { maxLength: 4 }),
  }),
}));

function objectOf(entry: fc.Arbitrary<[string, Json]>, maxLength = 6): fc.Arbitrary<Json> {
  return fc.array(entry, { maxLength }).map((entries) => ({ kind: "object" as const, entries }));
}

// Shaped mostly like a packument, so the captured paths are reached often;
// the noise branches keep duplicate keys and wrong-typed values in play.
const mostly = (shaped: fc.Arbitrary<Json>) =>
  fc.oneof({ arbitrary: shaped, weight: 4 }, { arbitrary: noise, weight: 1 });
const stringOrNoise = mostly(stringNode);
const dist = mostly(
  objectOf(
    fc.oneof(
      { arbitrary: fc.tuple(fc.constantFrom("tarball", "shasum"), stringOrNoise), weight: 3 },
      { arbitrary: fc.tuple(fieldKey, noise), weight: 1 },
    ),
    4,
  ),
);
const versionEntry = mostly(
  objectOf(
    fc.oneof(
      fc.tuple(fc.constantFrom("name", "version"), stringOrNoise),
      { arbitrary: fc.tuple(fc.constant("dist"), dist), weight: 2 },
      fc.tuple(fieldKey, noise),
    ),
    5,
  ),
);
const versionKey = fc.oneof(fc.constantFrom("1.0.0", "2.0.0", "__proto__", "constructor"), anyText);
const versions = mostly(objectOf(fc.tuple(versionKey, versionEntry), 8));
const stringMap = mostly(objectOf(fc.tuple(versionKey, stringOrNoise), 8));
const root = objectOf(
  fc.oneof(
    fc.tuple(fc.constant("name"), stringOrNoise),
    fc.tuple(fc.constant("versions"), versions),
    fc.tuple(fc.constant("time"), stringMap),
    fc.tuple(fc.constant("dist-tags"), stringMap),
    fc.tuple(fieldKey, noise),
  ),
  10,
);
const documentText = fc.tuple(root, whitespace).map(([node, ws]) => serialize(node, ws));
