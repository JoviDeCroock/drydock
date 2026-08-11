import { describe, expect, test } from "vitest";
import { badgeMarkdown } from "../src/lib/badge-markdown";

const ORIGIN = "https://drydock.org";
const REPORT = "https://drydock.org/reports/tok_abc123";

function imageUrl(markdown: string): string {
  const match = /!\[Drydock review[^\]]*\]\(([^)]+)\)/.exec(markdown);
  if (!match) throw new Error(`no badge image in ${markdown}`);
  return match[1];
}

function targetUrl(markdown: string): string {
  const match = /\)\]\(([^)]+)\)$/.exec(markdown);
  if (!match) throw new Error(`no link target in ${markdown}`);
  return match[1];
}

describe("badgeMarkdown", () => {
  test("npm badge links the evergreen package-only diff page", () => {
    const md = badgeMarkdown({
      origin: ORIGIN,
      ecosystem: "npm",
      packageName: "left-pad",
      reportUrl: REPORT,
    });
    expect(targetUrl(md)).toBe("https://drydock.org/diff/left-pad");
    const image = imageUrl(md);
    expect(image.startsWith("https://img.shields.io/endpoint?url=")).toBe(true);
    const nested = decodeURIComponent(image.slice("https://img.shields.io/endpoint?url=".length));
    expect(nested).toBe("https://drydock.org/public/badge/npm/left-pad");
  });

  test("scoped npm names survive the nesting round-trip and diff-path encoding", () => {
    const md = badgeMarkdown({
      origin: ORIGIN,
      ecosystem: "npm",
      packageName: "@scope/pkg",
      reportUrl: REPORT,
    });
    expect(targetUrl(md)).toBe("https://drydock.org/diff/@scope/pkg");
    const nested = decodeURIComponent(
      imageUrl(md).slice("https://img.shields.io/endpoint?url=".length),
    );
    expect(nested).toBe("https://drydock.org/public/badge/npm/@scope/pkg");
    // The nested URL must be fully encoded from shields' point of view: the
    // raw image URL cannot contain an unencoded `/` or `?` after `url=`.
    const rawNested = imageUrl(md).slice("https://img.shields.io/endpoint?url=".length);
    expect(rawNested.includes("/")).toBe(false);
    expect(rawNested.includes("?")).toBe(false);
  });

  test("pypi badge links the copied report, not a diff page", () => {
    const md = badgeMarkdown({
      origin: ORIGIN,
      ecosystem: "pypi",
      packageName: "requests",
      reportUrl: REPORT,
    });
    expect(targetUrl(md)).toBe(REPORT);
    const nested = decodeURIComponent(
      imageUrl(md).slice("https://img.shields.io/endpoint?url=".length),
    );
    expect(nested).toBe("https://drydock.org/public/badge/pypi/requests");
  });

  test("vscode badge links the copied report", () => {
    const md = badgeMarkdown({
      origin: ORIGIN,
      ecosystem: "vscode",
      packageName: "publisher.extension",
      reportUrl: REPORT,
    });
    expect(targetUrl(md)).toBe(REPORT);
    const nested = decodeURIComponent(
      imageUrl(md).slice("https://img.shields.io/endpoint?url=".length),
    );
    expect(nested).toBe("https://drydock.org/public/badge/vscode/publisher.extension");
  });

  test("a prerelease scan's snippet carries its tag", () => {
    // The endpoint defaults to `latest`, so an untagged snippet copied from an
    // rc review would embed a badge that never shows that review.
    const md = badgeMarkdown({
      origin: ORIGIN,
      ecosystem: "npm",
      packageName: "preact",
      reportUrl: REPORT,
      tag: "rc",
    });
    const nested = decodeURIComponent(
      imageUrl(md).slice("https://img.shields.io/endpoint?url=".length),
    );
    expect(nested).toBe("https://drydock.org/public/badge/npm/preact?tag=rc");
    // Still fully encoded from shields' point of view — the `?` and `=` of the
    // nested query must not terminate shields' own `url=` parameter.
    const rawNested = imageUrl(md).slice("https://img.shields.io/endpoint?url=".length);
    expect(rawNested.includes("?")).toBe(false);
    expect(rawNested.includes("&")).toBe(false);
    // Two rows in one README need distinguishable alt text.
    expect(md.startsWith("[![Drydock review (rc)](")).toBe(true);
    // The link target stays evergreen: a README outlives the release.
    expect(targetUrl(md)).toBe("https://drydock.org/diff/preact");
  });

  test("latest and untagged scans keep the short untagged snippet", () => {
    // `?tag=latest` is the same request as the default, so the common case does
    // not carry redundant query noise into every README.
    for (const tag of ["latest", null, undefined]) {
      const md = badgeMarkdown({
        origin: ORIGIN,
        ecosystem: "npm",
        packageName: "left-pad",
        reportUrl: REPORT,
        tag,
      });
      const nested = decodeURIComponent(
        imageUrl(md).slice("https://img.shields.io/endpoint?url=".length),
      );
      expect(nested).toBe("https://drydock.org/public/badge/npm/left-pad");
      expect(md.startsWith("[![Drydock review](")).toBe(true);
    }
  });

  test("markdown shape is a single image link", () => {
    const md = badgeMarkdown({
      origin: ORIGIN,
      ecosystem: "npm",
      packageName: "left-pad",
      reportUrl: REPORT,
    });
    expect(md.startsWith("[![Drydock review](")).toBe(true);
    expect(md.endsWith(")")).toBe(true);
  });
});
