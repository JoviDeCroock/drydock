import { describe, expect, test } from "vitest";
import {
  browserAdapter,
  browserExtensionCandidateName,
  buildBrowserReleaseManifest,
  createBrowserExtensionReview,
  inferBrowserArtifactKind,
  parseBrowserExtensionManifest,
} from "../server/lib/ecosystems/browser";
import { computeDiff, runDeterministicFindings } from "../server/lib/scan/pipeline-phases";

const SHA = "ab".repeat(32);

function manifestFile(overrides = {}, pretty = false) {
  const manifest = {
    manifest_version: 3,
    name: "Tab helper",
    version: "1.2.0",
    background: { service_worker: "background.js" },
    permissions: ["storage"],
    ...overrides,
  };
  return {
    path: "manifest.json",
    size: JSON.stringify(manifest, null, pretty ? 2 : undefined).length,
    sha256: "11".repeat(32),
    flags: [],
    textSample: JSON.stringify(manifest, null, pretty ? 2 : undefined),
  };
}

describe("browser extension review adapter", () => {
  test("recognizes ZIP and XPI release artifacts", () => {
    expect(inferBrowserArtifactKind("dist/addon.zip")).toBe("zip");
    expect(inferBrowserArtifactKind("dist/addon.XPI")).toBe("xpi");
    expect(inferBrowserArtifactKind("dist/addon.crx")).toBeNull();
  });

  test("derives Firefox identity and WebExtension capabilities from manifest.json", () => {
    const { manifest } = parseBrowserExtensionManifest([
      manifestFile({
        browser_specific_settings: { gecko: { id: "tab-helper@example.invalid" } },
        host_permissions: ["https://example.invalid/*"],
        content_scripts: [{ matches: ["https://example.invalid/*"], js: ["content.js"] }],
      }),
    ]);
    expect(browserExtensionCandidateName(manifest)).toBe("tab-helper@example.invalid");
    expect(manifest.backgroundEntrypoints).toEqual(["background.js"]);
    expect(manifest.contentScriptEntrypoints).toEqual(["content.js"]);
    expect(manifest.hostPermissions).toEqual(["https://example.invalid/*"]);
    expect(manifest.contentScriptMatches).toEqual(["https://example.invalid/*"]);
  });

  test("uses only an embedded stable ID for cross-scan history", async () => {
    const path = "dist/tab-helper.zip";
    const chromeInput = browserAdapter.parseInput({
      manifest: buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]),
      artifact: { path, sha256: SHA, files: [manifestFile()] },
    });
    const chrome = await browserAdapter.acquireStaged({}, chromeInput, { dispose() {} });
    expect(browserAdapter.historyPackageName?.({ details: chrome.details })).toBeNull();

    const geckoId = "tab-helper@example.invalid";
    const firefoxInput = browserAdapter.parseInput({
      manifest: buildBrowserReleaseManifest(geckoId, "1.2.0", [{ path, sha256: SHA }]),
      artifact: {
        path,
        sha256: SHA,
        files: [manifestFile({ browser_specific_settings: { gecko: { id: geckoId } } })],
      },
    });
    const firefox = await browserAdapter.acquireStaged({}, firefoxInput, { dispose() {} });
    expect(browserAdapter.historyPackageName?.({ details: firefox.details })).toBe(geckoId);
  });

  test("fails closed without a root extension manifest", () => {
    expect(() =>
      parseBrowserExtensionManifest([
        {
          path: "nested/manifest.json",
          size: 2,
          sha256: "22".repeat(32),
          flags: [],
          textSample: "{}",
        },
      ]),
    ).toThrow(/root manifest\.json/);
  });

  test("records exact archive provenance and no invented public baseline", async () => {
    const path = "dist/tab-helper.zip";
    const release = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const input = browserAdapter.parseInput({
      manifest: release,
      artifact: {
        path,
        sha256: SHA,
        files: [manifestFile({ permissions: ["nativeMessaging"] })],
      },
    });
    const staged = await browserAdapter.acquireStaged({}, input, { dispose() {} });
    const baseline = await browserAdapter.acquireBaseline({}, input, { dispose() {} }, staged);
    expect(baseline).toMatchObject({
      artifact: null,
      baseline: {
        source: "none",
        reason: "no-store-identity-for-public-baseline",
        comparisonSkipped: "baseline-unavailable",
      },
    });
    const diff = computeDiff({ staged, baseline });
    const findings = runDeterministicFindings(browserAdapter, { staged, baseline }, diff);
    expect(findings.annotatedFindings.length).toBeGreaterThan(0);
    expect(findings.annotatedFindings).toEqual(
      findings.annotatedFindings.map((finding) => ({
        ...finding,
        diffStatus: "unknown",
        releaseDelta: false,
      })),
    );
    expect(browserAdapter.summarizeDetails(staged.details)).toMatchObject({
      publicPackageIdentity: null,
      provenance: {
        ecosystem: "browser",
        mode: "workflow_gate",
        artifacts: [{ path, kind: "zip", sha256: SHA }],
      },
    });
  });

  test("treats manifest-loaded scripts under test directories as consumer reachable", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const review = createBrowserExtensionReview({
      manifest,
      artifact: {
        path,
        sha256: SHA,
        files: [
          manifestFile({
            background: { service_worker: "tests/background.js" },
            content_scripts: [{ matches: ["https://example.invalid/*"], js: ["tests/content.js"] }],
          }),
          {
            path: "tests/background.js",
            size: 14,
            sha256: "33".repeat(32),
            flags: [],
            textSample: "eval(payload);",
          },
          {
            path: "tests/content.js",
            size: 42,
            sha256: "44".repeat(32),
            flags: [],
            textSample: 'fetch("https://example.invalid/payload");',
          },
        ],
      },
    });
    const capabilities = review.ruleFindings.filter((finding) =>
      ["code.dynamic-evaluation", "code.network-access"].includes(finding.ruleId),
    );
    expect(capabilities).toHaveLength(2);
    expect(capabilities.map(({ ruleId, severity }) => ({ ruleId, severity }))).toEqual(
      expect.arrayContaining([
        { ruleId: "code.dynamic-evaluation", severity: "high" },
        { ruleId: "code.network-access", severity: "medium" },
      ]),
    );
    expect(capabilities.every((finding) => finding.testScoped !== true)).toBe(true);
    expect(review.risk).toBe("high");
  });

  test("rejects adapter inputs that are not bound to the declared archive", () => {
    const release = buildBrowserReleaseManifest("Tab helper", "1.2.0", [
      { path: "dist/tab-helper.zip", sha256: SHA },
    ]);
    expect(() =>
      browserAdapter.parseInput({
        manifest: release,
        artifact: { path: "dist/other.xpi", sha256: SHA, files: [manifestFile()] },
      }),
    ).toThrow(/artifact path/);
    expect(() =>
      browserAdapter.parseInput({
        manifest: release,
        artifact: {
          path: "dist/tab-helper.zip",
          sha256: "cd".repeat(32),
          files: [manifestFile()],
        },
      }),
    ).toThrow(/artifact digest/);
  });

  test("flags privileged and all-sites extension capabilities", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const review = createBrowserExtensionReview({
      manifest,
      artifact: {
        path,
        sha256: SHA,
        files: [
          manifestFile({
            permissions: ["nativeMessaging"],
            host_permissions: ["<all_urls>"],
            content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
            externally_connectable: { matches: ["https://*/*"] },
            content_security_policy: "script-src 'self' 'unsafe-eval'; object-src 'self'",
          }),
        ],
      },
    });
    expect(review.ruleFindings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining([
        "browser.privileged-permission",
        "browser.broad-host-access",
        "browser.broad-content-script",
        "browser.externally-connectable",
        "browser.unsafe-extension-csp",
      ]),
    );
    expect(review.risk).toBe("high");
  });

  test.each([
    "bookmarks",
    "clipboardRead",
    "clipboardWrite",
    "cookies",
    "debugger",
    "downloads",
    "geolocation",
    "history",
    "identity",
    "identity.email",
    "management",
    "nativeMessaging",
    "privacy",
    "proxy",
    "sessions",
    "tabs",
    "topSites",
    "webNavigation",
    "webRequest",
    "webRequestBlocking",
  ])("flags sensitive browser permission %s", (permission) => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [
      {
        path,
        sha256: SHA,
      },
    ]);
    const review = createBrowserExtensionReview({
      manifest,
      artifact: {
        path,
        sha256: SHA,
        files: [manifestFile({ permissions: [permission] })],
      },
    });
    expect(review.ruleFindings.map((finding) => finding.ruleId)).toContain(
      "browser.privileged-permission",
    );
  });

  test.each([
    "default-src 'self' cdn.example.invalid",
    "script-src 'self' cdn.example.invalid; object-src 'self'",
  ])("flags effective non-package script sources in CSP: %s", (contentSecurityPolicy) => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const review = createBrowserExtensionReview({
      manifest,
      artifact: {
        path,
        sha256: SHA,
        files: [manifestFile({ content_security_policy: contentSecurityPolicy })],
      },
    });
    expect(review.ruleFindings.map((finding) => finding.ruleId)).toContain(
      "browser.unsafe-extension-csp",
    );
  });

  test("anchors optional permissions to the manifest property that supplied them", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const manifestRecord = manifestFile(
      {
        optional_permissions: ["nativeMessaging"],
        host_permissions: ["https://example.invalid/*"],
        optional_host_permissions: ["<all_urls>"],
      },
      true,
    );
    const review = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files: [manifestRecord] },
    });
    const lines = manifestRecord.textSample.split("\n");
    expect(
      review.ruleFindings.find((finding) => finding.ruleId === "browser.privileged-permission")
        ?.line,
    ).toBe(lines.findIndex((line) => line.includes('"optional_permissions"')) + 1);
    expect(
      review.ruleFindings.find((finding) => finding.ruleId === "browser.broad-host-access")?.line,
    ).toBe(lines.findIndex((line) => line.includes('"optional_host_permissions"')) + 1);
  });
});
