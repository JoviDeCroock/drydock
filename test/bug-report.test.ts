import { describe, expect, test } from "vitest";
import { buildBugReport, bugReportMailto } from "../src/features/error-report/bug-report";

const occurredAt = new Date("2026-09-26T10:00:00.000Z");
const userAgent = "Mozilla/5.0 (Test)";

function report(error: unknown, pathname = "/dashboard") {
  return buildBugReport({ error, pathname, userAgent, occurredAt });
}

describe("buildBugReport", () => {
  test("lists the page, time, browser, error, and stack frames without repeating the header", () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'risk')");
    error.stack = [
      "TypeError: Cannot read properties of undefined (reading 'risk')",
      "    at ScanDetail (https://drydock.org/assets/index-abc.js:1:2345)",
      "    at renderComponent (https://drydock.org/assets/index-abc.js:1:999)",
    ].join("\n");

    expect(report(error, "/dashboard/scans/scan_1")).toBe(
      [
        "Page: /dashboard/scans/scan_1",
        "Time: 2026-09-26T10:00:00.000Z",
        "Browser: Mozilla/5.0 (Test)",
        "Error: TypeError: Cannot read properties of undefined (reading 'risk')",
        "Stack:",
        "  at ScanDetail (https://drydock.org/assets/index-abc.js:1:2345)",
        "  at renderComponent (https://drydock.org/assets/index-abc.js:1:999)",
      ].join("\n"),
    );
  });

  test("keeps frames from engines whose stack carries no header", () => {
    const error = new Error("boom");
    error.stack = "ScanDetail@https://drydock.org/assets/index-abc.js:1:2345\n";

    expect(report(error)).toContain(
      "Stack:\n  ScanDetail@https://drydock.org/assets/index-abc.js:1:2345",
    );
  });

  test("redacts a public-report share token from the page and the error text", () => {
    const token = "shr_9f8e7d6c5b4a39281706f5e4d3c2b1a0";
    const error = new Error(`could not render report ${token}`);
    error.stack = `Error: could not render report ${token}\n    at load (https://drydock.org/reports/${token}:1:1)`;

    const text = report(error, `/reports/${token}`);

    expect(text).not.toContain(token);
    expect(text).toContain("Page: /reports/[redacted]");
    expect(text).toContain("Error: Error: could not render report [redacted]");
  });

  test("redacts a share token before truncation can split it", () => {
    const token = "shr_9f8e7d6c5b4a39281706f5e4d3c2b1a0";
    const error = new Error(`${"x".repeat(380)}${token}`);
    error.stack = "";

    expect(report(error, `/reports/${token}`)).not.toContain(token.slice(0, 10));
  });

  test("bounds the message and stack so the mailto link stays openable", () => {
    const error = new Error("m".repeat(5000));
    error.stack = Array.from({ length: 50 }, (_, i) => `at frame${i} (${"u".repeat(500)})`).join(
      "\n",
    );

    const text = report(error);
    const frames = text.split("Stack:\n")[1].split("\n");

    expect(frames).toHaveLength(6);
    expect(frames.every((frame) => frame.length <= 162)).toBe(true);
    expect(text.split("\n").find((line) => line.startsWith("Error: "))!.length).toBeLessThan(420);
  });

  test("describes a thrown non-Error value", () => {
    expect(report("plain string failure")).toContain("Error: plain string failure");
  });

  test("describes a thrown value that cannot be stringified", () => {
    expect(report(Object.create(null))).toContain(
      "Error: (the thrown value could not be described)",
    );
  });

  test("never splits an emoji at the truncation boundary", () => {
    // "Error: " plus 391 characters puts the emoji's high surrogate at the last kept code unit.
    const error = new Error(`${"x".repeat(391)}😀 and more`);
    error.stack = "";

    expect(report(error)).toContain("x😀…");
  });

  test("replaces a lone surrogate from the thrown message so the link can be encoded", () => {
    const error = new Error("bad \uD800 char");
    error.stack = "";

    const text = report(error);

    expect(text).toContain("Error: Error: bad \uFFFD char");
    expect(() => bugReportMailto(text)).not.toThrow();
  });
});

describe("bugReportMailto", () => {
  test("drops trailing stack lines until the encoded link fits Windows mail handlers", () => {
    const error = new Error("é".repeat(400));
    error.stack = Array.from({ length: 6 }, (_, i) => `at frame${i} (${"%".repeat(150)})`).join(
      "\n",
    );
    const text = buildBugReport({
      error,
      pathname: "/diff",
      userAgent: "ü".repeat(200),
      occurredAt,
    });

    const href = bugReportMailto(text);
    const body = new URL(href).searchParams.get("body")!;

    expect(href.length).toBeLessThanOrEqual(1900);
    expect(body).toContain("Page: /diff");
    expect(body).toContain("(trimmed; use Copy details for the rest)");
  });

  test("keeps a short report whole", () => {
    const body = new URL(bugReportMailto("Page: /diff\nError: Error: x")).searchParams.get("body")!;

    expect(body).not.toContain("trimmed");
  });

  test("addresses the contact inbox with an encoded subject and the report in the body", () => {
    const href = bugReportMailto("Page: /diff\nError: Error: a & b");
    const url = new URL(href);

    expect(url.protocol).toBe("mailto:");
    expect(url.pathname).toBe("drydock@drydock.org");
    expect(url.searchParams.get("subject")).toBe("Drydock bug report");
    expect(url.searchParams.get("body")).toContain("Page: /diff\nError: Error: a & b");
  });
});
