import { describe, expect, test } from "vitest";
import {
  buildBugReport,
  bugReportMailto,
  bugReportText,
  type BugReportInput,
} from "../src/features/error-report/bug-report";

const occurredAt = new Date("2026-09-26T10:00:00.000Z");
const userAgent = "Mozilla/5.0 (Test)";

function report(error: unknown, pathname = "/dashboard") {
  return bugReportText(buildBugReport({ error, pathname, userAgent, occurredAt }));
}

function mailtoBody(input: Partial<BugReportInput> & Pick<BugReportInput, "error">) {
  const href = bugReportMailto(
    buildBugReport({ pathname: "/diff", userAgent, occurredAt, ...input }),
  );
  return { href, body: new URL(href).searchParams.get("body")! };
}

function stackOf(count: number, frameChars: number) {
  return Array.from({ length: count }, (_, i) => `at frame${i} (${"%".repeat(frameChars)})`).join(
    "\n",
  );
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
    expect(mailtoBody({ error, pathname: `/reports/${token}` }).href).not.toContain(token);
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

    expect(report(error)).toContain("Error: Error: bad \uFFFD char");
    expect(() => mailtoBody({ error })).not.toThrow();
  });
});

describe("bugReportMailto", () => {
  test("sheds stack frames from the end first", () => {
    const error = new Error("boom");
    error.stack = stackOf(6, 150);

    const { href, body } = mailtoBody({ error });

    expect(href.length).toBeLessThanOrEqual(1900);
    expect(body).toContain("Browser: Mozilla/5.0 (Test)");
    expect(body).toContain("Error: Error: boom\nStack:\n  at frame0");
    expect(body).not.toContain("frame5");
    expect(body).toContain("(trimmed; use Copy details for the rest)");
  });

  test("drops the Stack header along with the last frame", () => {
    const error = new Error("é".repeat(200));
    error.stack = stackOf(6, 150);

    const { href, body } = mailtoBody({ error });

    expect(href.length).toBeLessThanOrEqual(1900);
    expect(body).not.toContain("Stack:");
    expect(body).toContain(
      `Browser: Mozilla/5.0 (Test)\nError: Error: ${"é".repeat(200)}\n(trimmed; use Copy details for the rest)`,
    );
  });

  test("keeps the error summary after the browser and stack are shed", () => {
    const error = new Error("é".repeat(400));
    error.stack = stackOf(6, 150);

    const { href, body } = mailtoBody({ error, userAgent: "ü".repeat(200) });

    expect(href.length).toBeLessThanOrEqual(1900);
    expect(body).toContain("Page: /diff\nTime: 2026-09-26T10:00:00.000Z\nError: Error: éé");
    expect(body).toMatch(/é…\n\(trimmed; use Copy details for the rest\)/);
    expect(body).not.toContain("Browser:");
    expect(body).not.toContain("Stack:");
  });

  test("keeps a short report whole", () => {
    const error = new Error("x");
    error.stack = "";

    expect(mailtoBody({ error }).body).not.toContain("trimmed");
  });

  test("addresses the contact inbox with an encoded subject and the report in the body", () => {
    const error = new Error("a & b");
    error.stack = "";
    const url = new URL(mailtoBody({ error }).href);

    expect(url.protocol).toBe("mailto:");
    expect(url.pathname).toBe("drydock@drydock.org");
    expect(url.searchParams.get("subject")).toBe("Drydock bug report");
    expect(url.searchParams.get("body")).toContain("Page: /diff\n");
    expect(url.searchParams.get("body")).toContain("Error: Error: a & b");
  });
});
