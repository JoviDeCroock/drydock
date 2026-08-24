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

  test("accepts manifest line comments without treating URL text as a comment", () => {
    const textSample = `{
      // Firefox permits line comments in extension manifests.
      "manifest_version": 3,
      "name": "Tab helper // reviewed",
      "version": "1.2.0",
      "homepage_url": "https://example.invalid/project"
    }`;
    const { manifest } = parseBrowserExtensionManifest([
      {
        path: "manifest.json",
        size: textSample.length,
        sha256: "12".repeat(32),
        flags: [],
        textSample,
      },
    ]);
    expect(manifest.name).toBe("Tab helper // reviewed");
    expect(manifest.version).toBe("1.2.0");
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

  test("follows scripts loaded by a manifest background page", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const review = createBrowserExtensionReview({
      manifest,
      artifact: {
        path,
        sha256: SHA,
        files: [
          manifestFile({
            manifest_version: 2,
            background: { page: "pages/background.html" },
          }),
          {
            path: "pages/background.html",
            size: 120,
            sha256: "45".repeat(32),
            flags: [],
            textSample:
              '<script src="../tests/background.js?build=1"></script><script src="https://example.invalid/remote.js"></script>',
          },
          {
            path: "tests/background.js",
            size: 14,
            sha256: "46".repeat(32),
            flags: [],
            textSample: "eval(payload);",
          },
        ],
      },
    });
    const finding = review.ruleFindings.find(
      (candidate) => candidate.ruleId === "code.dynamic-evaluation",
    );
    expect(finding).toMatchObject({ severity: "high", file: "tests/background.js" });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("treats scripts loaded by manifest-declared extension pages as consumer reachable", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const extensionPages = [
      ["tests/popup.html", "tests/popup.js"],
      ["tests/browser-popup.html", "tests/browser-popup.js"],
      ["tests/page-popup.html", "tests/page-popup.js"],
      ["tests/options.html", "tests/options.js"],
      ["tests/legacy-options.html", "tests/legacy-options.js"],
      ["tests/devtools.html", "tests/devtools.js"],
      ["tests/side-panel.html", "tests/side-panel.js"],
      ["tests/sidebar.html", "tests/sidebar.js"],
      ["tests/new-tab.html", "tests/new-tab.js"],
    ];
    const files = extensionPages.flatMap(([page, script], index) => [
      {
        path: page,
        size: 40,
        sha256: String(50 + index)
          .repeat(64)
          .slice(0, 64),
        flags: [],
        textSample: `<script src="${script.split("/").at(-1)}"></script>`,
      },
      {
        path: script,
        size: 14,
        sha256: String(60 + index)
          .repeat(64)
          .slice(0, 64),
        flags: [],
        textSample: "eval(payload);",
      },
    ]);
    const manifestRecord = manifestFile({
      action: { default_popup: "tests/popup.html" },
      browser_action: { default_popup: "tests/browser-popup.html" },
      page_action: { default_popup: "tests/page-popup.html" },
      options_ui: { page: "tests/options.html" },
      options_page: "tests/legacy-options.html",
      devtools_page: "tests/devtools.html",
      side_panel: { default_path: "tests/side-panel.html" },
      sidebar_action: { default_panel: "tests/sidebar.html" },
      chrome_url_overrides: { newtab: "tests/new-tab.html" },
    });
    const parsed = parseBrowserExtensionManifest([manifestRecord, ...files]).manifest;
    expect(parsed.extensionPageEntrypoints).toEqual(expect.arrayContaining(extensionPages.flat()));

    const review = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files: [manifestRecord, ...files] },
    });
    const findings = review.ruleFindings.filter(
      (candidate) => candidate.ruleId === "code.dynamic-evaluation",
    );
    expect(findings).toHaveLength(extensionPages.length);
    expect(findings.every((finding) => finding.severity === "high")).toBe(true);
    expect(findings.every((finding) => finding.testScoped !== true)).toBe(true);
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

  test.each(["*://*/", "https://*/", "http://*/"])(
    "flags slash-only scheme-wide match pattern %s",
    (matchPattern) => {
      const path = "dist/tab-helper.zip";
      const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
      const review = createBrowserExtensionReview({
        manifest,
        artifact: {
          path,
          sha256: SHA,
          files: [
            manifestFile({
              host_permissions: [matchPattern],
              content_scripts: [{ matches: [matchPattern], js: ["content.js"] }],
            }),
          ],
        },
      });
      expect(review.ruleFindings.map((finding) => finding.ruleId)).toEqual(
        expect.arrayContaining(["browser.broad-host-access", "browser.broad-content-script"]),
      );
    },
  );

  test.each([
    "bookmarks",
    "browserSettings",
    "browsingData",
    "certificateProvider",
    "clipboardRead",
    "clipboardWrite",
    "contentSettings",
    "contextualIdentities",
    "cookies",
    "debugger",
    "declarativeNetRequest",
    "declarativeNetRequestFeedback",
    "declarativeNetRequestWithHostAccess",
    "declarativeWebRequest",
    "desktopCapture",
    "dns",
    "documentScan",
    "downloads",
    "downloads.open",
    "downloads.ui",
    "enterprise.deviceAttributes",
    "enterprise.hardwarePlatform",
    "enterprise.networkingAttributes",
    "enterprise.platformKeys",
    "fileBrowserHandler",
    "fileSystemProvider",
    "geolocation",
    "history",
    "identity",
    "identity.email",
    "idle",
    "management",
    "nativeMessaging",
    "pageCapture",
    "pkcs11",
    "platformKeys",
    "privacy",
    "printerProvider",
    "printing",
    "printingMetrics",
    "processes",
    "proxy",
    "scripting",
    "search",
    "sessions",
    "system.cpu",
    "system.display",
    "system.memory",
    "system.storage",
    "tabCapture",
    "tabHide",
    "tabs",
    "topSites",
    "userScripts",
    "vpnProvider",
    "webAuthenticationProxy",
    "webNavigation",
    "webRequest",
    "webRequestAuthProvider",
    "webRequestBlocking",
    "webRequestFilterResponse",
    "webRequestFilterResponse.serviceWorkerScript",
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
    "script-src 'self'; script-src-elem https://cdn.example.invalid",
    "script-src 'self'; worker-src blob:",
    "script-src 'self'; child-src blob:",
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

  test("flags Manifest V2 optional host access on its declaring property", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const manifestRecord = manifestFile(
      { manifest_version: 2, optional_permissions: ["<all_urls>"] },
      true,
    );
    const review = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files: [manifestRecord] },
    });
    const finding = review.ruleFindings.find(
      (candidate) => candidate.ruleId === "browser.broad-host-access",
    );
    expect(finding?.line).toBe(
      manifestRecord.textSample
        .split("\n")
        .findIndex((line) => line.includes('"optional_permissions"')) + 1,
    );
  });
});
