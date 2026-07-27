import { describe, expect, test } from "vitest";
import {
  CHANNEL_TEMPLATES,
  CHANNELS,
  checkVersionsSurvive,
  diffUrl,
  fetchPublishedVersions,
  main,
  measure,
  renderPost,
  TEMPLATES,
} from "../scripts/incident-post.mjs";
import { packageDiffPath } from "../src/lib/package-diff-path";

// The script duplicates the diff-path encoding so it can run under bare `node`.
// These tests are what make that duplication safe.
describe("diffUrl", () => {
  test("agrees with the app's own path builder", () => {
    const cases = [
      ["npm", "tape", "5.7.0", "5.7.1"],
      ["npm", "@apollo/client", "3.11.8", "3.11.9"],
      ["npm", "pkg", "1.0.0+build.1", "1.0.1"],
      ["pypi", "requests", "2.31.0", "2.32.0"],
    ];
    for (const [ecosystem, name, from, to] of cases) {
      expect(diffUrl({ ecosystem, packageName: name, fromVersion: from, toVersion: to })).toBe(
        `https://drydock.org${packageDiffPath(ecosystem, name, from, to)}`,
      );
    }
  });

  test("honors a custom origin for staging checks", () => {
    expect(
      diffUrl({
        packageName: "tape",
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
        origin: "http://localhost:5173",
      }),
    ).toBe("http://localhost:5173/diff/tape/1.0.0/1.0.1");
  });
});

describe("checkVersionsSurvive", () => {
  test("passes when both sides are still published", () => {
    const check = checkVersionsSurvive({
      published: ["1.0.0", "1.0.1", "1.0.2"],
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
    });
    expect(check.ok).toBe(true);
    expect(check.missing).toEqual([]);
  });

  test("names the unpublished side", () => {
    // The compromised version is the one the registry pulls, and it is the one
    // the post is about — so this is the common case, not the edge case.
    const check = checkVersionsSurvive({
      published: ["1.0.0", "1.0.2"],
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
    });
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual(["1.0.1"]);
    expect(check.nearest).toContain("1.0.2");
  });

  test("reports both sides when the package was fully pulled", () => {
    const check = checkVersionsSurvive({
      published: [],
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
    });
    expect(check.missing).toEqual(["1.0.0", "1.0.1"]);
  });
});

describe("fetchPublishedVersions", () => {
  test("reads the npm versions map", async () => {
    const fetchImpl = async (url) => {
      expect(url).toBe("https://registry.npmjs.org/tape");
      return new Response(JSON.stringify({ versions: { "5.7.0": {}, "5.7.1": {} } }));
    };
    expect(await fetchPublishedVersions({ packageName: "tape", fetchImpl })).toEqual([
      "5.7.0",
      "5.7.1",
    ]);
  });

  test("keeps the scope readable in the npm metadata URL", async () => {
    let seen;
    const fetchImpl = async (url) => {
      seen = url;
      return new Response(JSON.stringify({ versions: {} }));
    };
    await fetchPublishedVersions({ packageName: "@apollo/client", fetchImpl });
    expect(seen).toBe("https://registry.npmjs.org/@apollo%2Fclient");
  });

  test("reads the PyPI releases map", async () => {
    const fetchImpl = async (url) => {
      expect(url).toBe("https://pypi.org/pypi/requests/json");
      return new Response(JSON.stringify({ releases: { "2.31.0": [], "2.32.0": [] } }));
    };
    expect(
      await fetchPublishedVersions({ ecosystem: "pypi", packageName: "requests", fetchImpl }),
    ).toEqual(["2.31.0", "2.32.0"]);
  });

  test("surfaces a registry error rather than returning an empty list", async () => {
    const fetchImpl = async () => new Response("nope", { status: 404 });
    await expect(fetchPublishedVersions({ packageName: "ghost", fetchImpl })).rejects.toThrow(
      "returned 404",
    );
  });
});

describe("templates", () => {
  const fields = {
    packageName: "chalk",
    fromVersion: "5.6.0",
    toVersion: "5.6.1",
    safeVersion: "5.6.0",
    badVersion: "5.6.1",
    vector: "a postinstall script that posts environment variables to a remote host",
    consequence: "Anything the build host could reach should be treated as exposed.",
    attestation: "valid npm provenance",
    claim: "the payload ran on install",
    correction: "it only ran during packaging",
    url: "https://drydock.org/diff/chalk/5.6.0/5.6.1",
  };

  test("every channel maps to templates that exist", () => {
    for (const channel of CHANNELS) {
      expect(CHANNEL_TEMPLATES[channel], channel).toBeDefined();
      for (const name of CHANNEL_TEMPLATES[channel]) {
        expect(TEMPLATES[name], `${channel} -> ${name}`).toBeTypeOf("function");
      }
    }
  });

  test("every template renders and carries the diff link", () => {
    for (const name of Object.keys(TEMPLATES)) {
      const text = renderPost(name, fields);
      expect(text, name).toContain(fields.url);
      expect(text.length, name).toBeGreaterThan(40);
    }
  });

  test("refuses to render with a missing field instead of emitting 'undefined'", () => {
    // A post that reads "shipped undefined" is worse than no post.
    expect(() => renderPost("breaking", { ...fields, vector: undefined })).toThrow(
      "missing required field: vector",
    );
    expect(() => renderPost("breaking", { ...fields, vector: "  " })).toThrow("vector");
  });

  test("the short-form posts fit their channel limits", () => {
    for (const channel of ["bluesky", "x"]) {
      for (const name of CHANNEL_TEMPLATES[channel]) {
        const { overflow, length, limit } = measure(renderPost(name, fields), channel);
        expect(overflow, `${channel}/${name} is ${length}/${limit}`).toBe(0);
      }
    }
  });

  test("states what the diff shows, not what it implies about intent", () => {
    // The diff proves bytes changed. It does not prove who, or why, and the
    // playbook's hard rules say we never claim otherwise.
    const forbidden = /\b(hacker|attacker|malicious actor|deliberately|on purpose|stole)\b/i;
    for (const name of Object.keys(TEMPLATES)) {
      expect(renderPost(name, fields), name).not.toMatch(forbidden);
    }
  });

  test("names the package, never a person", () => {
    for (const name of Object.keys(TEMPLATES)) {
      expect(renderPost(name, fields), name).not.toMatch(/\bmaintainer('s)? (fault|error)\b/i);
    }
  });

  test("the unpublished template explains the gap without linking a dead version", () => {
    const text = renderPost("unpublished", { ...fields, badVersion: "5.6.1" });
    expect(text).toContain("unpublished");
    expect(text).toContain(fields.url);
  });

  test("the correction template does not delete history", () => {
    expect(renderPost("correction", fields)).toContain("Leaving the original up");
  });
});

describe("main", () => {
  const baseArgs = [
    "--package",
    "chalk",
    "--from",
    "5.6.0",
    "--to",
    "5.6.1",
    "--vector",
    "a postinstall script that posts environment variables to a remote host",
  ];

  function capture() {
    const lines = [];
    return {
      lines,
      log: (line = "") => lines.push(String(line)),
      warn: (line = "") => lines.push(String(line)),
    };
  }

  test("prints per-channel copy when both versions resolve", async () => {
    const out = capture();
    const fetchImpl = async () =>
      new Response(JSON.stringify({ versions: { "5.6.0": {}, "5.6.1": {} } }));
    const code = await main(baseArgs, { fetchImpl, ...out });

    expect(code).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toContain("both versions resolve");
    expect(text).toContain("── bluesky");
    expect(text).toContain("── linkedin");
    expect(text).toContain("https://drydock.org/diff/chalk/5.6.0/5.6.1");
  });

  test("refuses to print a post when the registry has pulled a version", async () => {
    // The failure this whole script exists to prevent.
    const out = capture();
    const fetchImpl = async () => new Response(JSON.stringify({ versions: { "5.6.0": {} } }));
    const code = await main(baseArgs, { fetchImpl, ...out });

    expect(code).toBe(2);
    const text = out.lines.join("\n");
    expect(text).toContain("Do not post this");
    expect(text).not.toContain("── bluesky");
  });

  test("still prints, marked unverified, when the registry is unreachable", async () => {
    const out = capture();
    const fetchImpl = async () => {
      throw new Error("network down");
    };
    const code = await main(baseArgs, { fetchImpl, ...out });

    expect(code).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toContain("UNVERIFIED");
    expect(text).toContain("Check the link by hand");
  });

  test("--no-verify skips the registry entirely", async () => {
    const out = capture();
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return new Response("{}");
    };
    const code = await main([...baseArgs, "--no-verify"], { fetchImpl, ...out });

    expect(code).toBe(0);
    expect(called).toBe(false);
    expect(out.lines.join("\n")).toContain("UNVERIFIED");
  });

  test("prints usage and fails when required arguments are missing", async () => {
    const out = capture();
    const code = await main(["--package", "chalk"], {
      fetchImpl: async () => new Response("{}"),
      ...out,
    });
    expect(code).toBe(1);
    expect(out.lines.join("\n")).toContain("Usage:");
  });
});
