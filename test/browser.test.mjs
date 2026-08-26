import { describe, expect, test } from "vitest";
import {
  browserAdapter,
  browserExtensionCandidateName,
  buildBrowserReleaseManifest,
  createBrowserExtensionReview,
  inferBrowserArtifactKind,
  parseBrowserExtensionManifest,
} from "../server/lib/ecosystems/browser";
import { createBrowserHtmlConsumerDependencyResolver } from "../server/lib/ecosystems/browser/manifest";
import { scanPublicPackageIdentity } from "../server/lib/public-feed";
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

  test.each(["1", "0.2", "2.10.2", "3.1.2.456789012"])(
    "accepts the common WebExtension version format: %s",
    (version) => {
      expect(parseBrowserExtensionManifest([manifestFile({ version })]).manifest.version).toBe(
        version,
      );
      expect(
        buildBrowserReleaseManifest("Tab helper", version, [
          { path: "dist/tab-helper.zip", sha256: SHA },
        ]).version,
      ).toBe(version);
    },
  );

  test.each(["1.0-beta", "01.2", "1.2.3.4.5", "1.1234567890", " 1.2.0 "])(
    "rejects a browser-store-incompatible version: %s",
    (version) => {
      expect(() => parseBrowserExtensionManifest([manifestFile({ version })])).toThrow(/version/);
      expect(() =>
        buildBrowserReleaseManifest("Tab helper", version, [
          { path: "dist/tab-helper.zip", sha256: SHA },
        ]),
      ).toThrow(/version/);
    },
  );

  test("derives Firefox identity and WebExtension capabilities from manifest.json", () => {
    const { manifest } = parseBrowserExtensionManifest([
      manifestFile({
        browser_specific_settings: { gecko: { id: "tab-helper@example.invalid" } },
        host_permissions: ["https://example.invalid/*"],
        content_scripts: [{ matches: ["https://example.invalid/*"], js: ["content.js"] }],
        externally_connectable: {
          matches: ["https://example.invalid/*"],
          ids: ["companion@example.invalid"],
        },
      }),
    ]);
    expect(browserExtensionCandidateName(manifest)).toBe("tab-helper@example.invalid");
    expect(manifest.backgroundEntrypoints).toEqual(["background.js"]);
    expect(manifest.contentScriptEntrypoints).toEqual(["content.js"]);
    expect(manifest.hostPermissions).toEqual(["https://example.invalid/*"]);
    expect(manifest.contentScriptMatches).toEqual(["https://example.invalid/*"]);
    expect(manifest.externallyConnectableMatches).toEqual(["https://example.invalid/*"]);
    expect(manifest.externallyConnectableIds).toEqual(["companion@example.invalid"]);
  });

  test("uses Gecko identity fields according to the manifest version", () => {
    const legacyId = "legacy-helper@example.invalid";
    const manifestV2 = parseBrowserExtensionManifest([
      manifestFile({
        manifest_version: 2,
        browser_specific_settings: { safari: { strict_min_version: "16" } },
        applications: { gecko: { id: legacyId } },
      }),
    ]).manifest;
    expect(manifestV2.extensionId).toBe(legacyId);

    const manifestV3 = parseBrowserExtensionManifest([
      manifestFile({
        manifest_version: 3,
        applications: { gecko: { id: "ignored-legacy@example.invalid" } },
      }),
    ]).manifest;
    expect(manifestV3.extensionId).toBeNull();
    expect(browserExtensionCandidateName(manifestV3)).toBe("Tab helper");
  });

  test.each([
    ["valid email-style id", "tab-helper@example.invalid", "tab-helper@example.invalid"],
    [
      "valid GUID id",
      "{12345678-1234-1234-1234-123456789abc}",
      "{12345678-1234-1234-1234-123456789abc}",
    ],
    ["display text", "Tab helper", null],
    ["surrounding whitespace", " tab-helper@example.invalid ", null],
    ["overlong email-style id", `${"a".repeat(65)}@example.invalid`, null],
    ["malformed GUID id", "{12345678-1234-1234-1234-invalid}", null],
  ])("validates Gecko stable identity: %s", (_label, extensionId, expected) => {
    const { manifest } = parseBrowserExtensionManifest([
      manifestFile({ browser_specific_settings: { gecko: { id: extensionId } } }),
    ]);
    expect(manifest.extensionId).toBe(expected);
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

  test("resolves a localized manifest name from the declared default locale", () => {
    const { manifest } = parseBrowserExtensionManifest([
      manifestFile({ name: "__MSG_extensionName__", default_locale: "en_US" }),
      {
        path: "_locales/en_US/messages.json",
        size: 64,
        sha256: "13".repeat(32),
        flags: [],
        textSample: JSON.stringify({ ExtensionName: { message: "Localized tab helper" } }),
      },
    ]);
    expect(manifest.name).toBe("Localized tab helper");
    expect(browserExtensionCandidateName(manifest)).toBe("Localized tab helper");
  });

  test("fails closed when localized manifest-name evidence is missing or malformed", () => {
    const localizedManifest = manifestFile({
      name: "__MSG_extensionName__",
      default_locale: "en",
    });
    expect(() => parseBrowserExtensionManifest([localizedManifest])).toThrow(
      /_locales\/en\/messages\.json/,
    );
    expect(() =>
      parseBrowserExtensionManifest([
        localizedManifest,
        {
          path: "_locales/en/messages.json",
          size: 2,
          sha256: "14".repeat(32),
          flags: [],
          textSample: JSON.stringify({ otherName: { message: "Other helper" } }),
        },
      ]),
    ).toThrow(/does not define localized name extensionName/);
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

  test("preserves a token-shaped stable ID only in the designated public identity field", async () => {
    const path = "dist/tab-helper.xpi";
    const geckoId = `ghp_${"a".repeat(20)}@example.invalid`;
    const input = browserAdapter.parseInput({
      manifest: buildBrowserReleaseManifest(geckoId, "1.2.0", [{ path, sha256: SHA }]),
      artifact: {
        path,
        sha256: SHA,
        files: [manifestFile({ browser_specific_settings: { gecko: { id: geckoId } } })],
      },
    });
    const staged = await browserAdapter.acquireStaged({}, input, { dispose() {} });
    const baseline = await browserAdapter.acquireBaseline({}, input, { dispose() {} }, staged);
    const resolved = { staged, baseline };
    const findings = runDeterministicFindings(browserAdapter, resolved, computeDiff(resolved));

    expect(findings.redactedDetails).toMatchObject({
      artifact: { extensionId: "[REDACTED_GITHUB_TOKEN]@example.invalid" },
      publicPackageIdentity: geckoId,
    });
    expect(
      scanPublicPackageIdentity(
        "workflow_gate",
        { stagedPublish: findings.redactedDetails },
        "Tab helper",
      ),
    ).toBe(geckoId);
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

  test("normalizes root-relative content script paths before reachability analysis", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const manifestRecord = manifestFile({
      content_scripts: [{ matches: ["https://example.invalid/*"], js: ["/tests/content.js"] }],
    });
    expect(
      parseBrowserExtensionManifest([manifestRecord]).manifest.contentScriptEntrypoints,
    ).toEqual(["tests/content.js"]);

    const review = createBrowserExtensionReview({
      manifest,
      artifact: {
        path,
        sha256: SHA,
        files: [
          manifestRecord,
          {
            path: "tests/content.js",
            size: 14,
            sha256: "47".repeat(32),
            flags: [],
            textSample: "eval(payload);",
          },
        ],
      },
    });
    const finding = review.ruleFindings.find(
      (candidate) => candidate.ruleId === "code.dynamic-evaluation",
    );
    expect(finding).toMatchObject({ severity: "high", file: "tests/content.js" });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("normalizes manifest-relative dot segments before reachability analysis", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const manifestRecord = manifestFile({
      background: { service_worker: "./scripts/background.js" },
      content_scripts: [{ matches: ["https://example.invalid/*"], js: ["./tests/content.js"] }],
      action: { default_popup: "./tests/popup.html" },
    });
    const parsed = parseBrowserExtensionManifest([manifestRecord]).manifest;
    expect(parsed.backgroundEntrypoints).toContain("scripts/background.js");
    expect(parsed.contentScriptEntrypoints).toEqual(["tests/content.js"]);
    expect(parsed.extensionPageEntrypoints).toContain("tests/popup.html");

    const review = createBrowserExtensionReview({
      manifest,
      artifact: {
        path,
        sha256: SHA,
        files: [
          manifestRecord,
          {
            path: "tests/content.js",
            size: 14,
            sha256: "48".repeat(32),
            flags: [],
            textSample: "eval(payload);",
          },
        ],
      },
    });
    const finding = review.ruleFindings.find(
      (candidate) => candidate.ruleId === "code.dynamic-evaluation",
    );
    expect(finding).toMatchObject({ severity: "high", file: "tests/content.js" });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("follows a root-relative background module and its root-relative import", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const manifestRecord = manifestFile({
      background: { service_worker: "/scripts/background.js", type: "module" },
    });
    expect(parseBrowserExtensionManifest([manifestRecord]).manifest.backgroundEntrypoints).toEqual([
      "scripts/background.js",
    ]);

    const review = createBrowserExtensionReview({
      manifest,
      artifact: {
        path,
        sha256: SHA,
        files: [
          manifestRecord,
          {
            path: "scripts/background.js",
            size: 42,
            sha256: "5a".repeat(32),
            flags: [],
            textSample: 'import "/tests/payload.js?build=1#worker";',
          },
          {
            path: "tests/payload.js",
            size: 14,
            sha256: "5b".repeat(32),
            flags: [],
            textSample: "eval(payload);",
          },
        ],
      },
    });
    const finding = review.ruleFindings.find(
      (candidate) => candidate.ruleId === "code.dynamic-evaluation",
    );
    expect(finding).toMatchObject({ severity: "high", file: "tests/payload.js" });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("follows a query- and fragment-qualified relative module import", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const review = createBrowserExtensionReview({
      manifest,
      artifact: {
        path,
        sha256: SHA,
        files: [
          manifestFile({ background: { service_worker: "scripts/background.js", type: "module" } }),
          {
            path: "scripts/background.js",
            size: 40,
            sha256: "6a".repeat(32),
            flags: [],
            textSample: 'import "../tests/payload.js?v=1#worker";',
          },
          {
            path: "tests/payload.js",
            size: 14,
            sha256: "6b".repeat(32),
            flags: [],
            textSample: "eval(payload);",
          },
        ],
      },
    });
    const finding = review.ruleFindings.find(
      (candidate) => candidate.ruleId === "code.dynamic-evaluation",
    );
    expect(finding).toMatchObject({ severity: "high", file: "tests/payload.js" });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("decodes URL escapes in browser module imports", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const review = createBrowserExtensionReview({
      manifest,
      artifact: {
        path,
        sha256: SHA,
        files: [
          manifestFile({ background: { service_worker: "scripts/background.js", type: "module" } }),
          {
            path: "scripts/background.js",
            size: 43,
            sha256: "6e".repeat(32),
            flags: [],
            textSample: 'import "../tests/payload%20file.js";',
          },
          {
            path: "tests/payload file.js",
            size: 14,
            sha256: "6f".repeat(32),
            flags: [],
            textSample: "eval(payload);",
          },
        ],
      },
    });
    const finding = review.ruleFindings.find(
      (candidate) => candidate.ruleId === "code.dynamic-evaluation",
    );
    expect(finding).toMatchObject({ severity: "high", file: "tests/payload file.js" });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("treats Manifest V2 user_scripts api_script as consumer reachable", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const manifestRecord = manifestFile({
      manifest_version: 2,
      user_scripts: { api_script: "tests/user-api.js" },
    });
    expect(parseBrowserExtensionManifest([manifestRecord]).manifest.userScriptEntrypoints).toEqual([
      "tests/user-api.js",
    ]);

    const review = createBrowserExtensionReview({
      manifest,
      artifact: {
        path,
        sha256: SHA,
        files: [
          manifestRecord,
          {
            path: "tests/user-api.js",
            size: 14,
            sha256: "48".repeat(32),
            flags: [],
            textSample: "eval(payload);",
          },
        ],
      },
    });
    const finding = review.ruleFindings.find(
      (candidate) => candidate.ruleId === "code.dynamic-evaluation",
    );
    expect(finding).toMatchObject({ severity: "high", file: "tests/user-api.js" });
    expect(finding?.testScoped).not.toBe(true);
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
            background: { page: "/pages/background.html" },
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

  test("decodes HTML character references before resolving packaged script paths", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const review = createBrowserExtensionReview({
      manifest,
      artifact: {
        path,
        sha256: SHA,
        files: [
          manifestFile({ manifest_version: 2, background: { page: "pages/background.html" } }),
          {
            path: "pages/background.html",
            size: 70,
            sha256: "49".repeat(32),
            flags: [],
            textSample: '<script src="../tests&#x2f;payload&#46;js"></script>',
          },
          {
            path: "tests/payload.js",
            size: 14,
            sha256: "4a".repeat(32),
            flags: [],
            textSample: "eval(payload);",
          },
        ],
      },
    });
    const finding = review.ruleFindings.find(
      (candidate) => candidate.ruleId === "code.dynamic-evaluation",
    );
    expect(finding).toMatchObject({ severity: "high", file: "tests/payload.js" });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("decodes URL escapes before matching packaged script paths", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const review = createBrowserExtensionReview({
      manifest,
      artifact: {
        path,
        sha256: SHA,
        files: [
          manifestFile({ manifest_version: 2, background: { page: "pages/background.html" } }),
          {
            path: "pages/background.html",
            size: 60,
            sha256: "6c".repeat(32),
            flags: [],
            textSample: '<script src="../tests/payload%20file.js"></script>',
          },
          {
            path: "tests/payload file.js",
            size: 14,
            sha256: "6d".repeat(32),
            flags: [],
            textSample: "eval(payload);",
          },
        ],
      },
    });
    const finding = review.ruleFindings.find(
      (candidate) => candidate.ruleId === "code.dynamic-evaluation",
    );
    expect(finding).toMatchObject({ severity: "high", file: "tests/payload file.js" });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("preserves encoded URL delimiters while resolving extension-page scripts", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({ action: { default_popup: "pages%23review/popup.html" } }),
      {
        path: "pages#review/popup.html",
        size: 48,
        sha256: "6e".repeat(32),
        flags: [],
        textSample: '<script src="./tests/payload.js"></script>',
      },
      {
        path: "pages#review/tests/payload.js",
        size: 14,
        sha256: "6f".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
    ];

    const parsed = parseBrowserExtensionManifest(files).manifest;
    expect(parsed.extensionPageEntrypoints).toEqual(
      expect.arrayContaining(["pages#review/popup.html", "pages#review/tests/payload.js"]),
    );
    const review = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    });
    const finding = review.ruleFindings.find(
      (candidate) => candidate.ruleId === "code.dynamic-evaluation",
    );
    expect(finding).toMatchObject({
      severity: "high",
      file: "pages#review/tests/payload.js",
    });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("honors an extension-local base URL when resolving page scripts", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const review = createBrowserExtensionReview({
      manifest,
      artifact: {
        path,
        sha256: SHA,
        files: [
          manifestFile({ manifest_version: 2, background: { page: "pages/background.html" } }),
          {
            path: "pages/background.html",
            size: 70,
            sha256: "4f".repeat(32),
            flags: [],
            textSample:
              "<script>const decoy = '<base href=\"https://example.invalid/\">';</script>" +
              '<base href="../tests/"><script src="payload.js"></script>',
          },
          {
            path: "tests/payload.js",
            size: 14,
            sha256: "5f".repeat(32),
            flags: [],
            textSample: "eval(payload);",
          },
        ],
      },
    });
    const finding = review.ruleFindings.find(
      (candidate) => candidate.ruleId === "code.dynamic-evaluation",
    );
    expect(finding).toMatchObject({ severity: "high", file: "tests/payload.js" });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("keeps tag-shaped ordinary attribute text out of the HTML consumer graph", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({ action: { default_popup: "popup.html" } }),
      {
        path: "popup.html",
        size: 96,
        sha256: "6a".repeat(32),
        flags: [],
        textSample:
          '<div data-markup="<base href=/decoy/>"></div><script src="tests/live.js"></script>',
      },
      {
        path: "tests/live.js",
        size: 14,
        sha256: "6b".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
      {
        path: "decoy/tests/live.js",
        size: 14,
        sha256: "6c".repeat(32),
        flags: [],
        textSample: "eval(decoy);",
      },
    ];

    const parsed = parseBrowserExtensionManifest(files).manifest;
    expect(parsed.extensionPageEntrypoints).toEqual(["popup.html", "tests/live.js"]);
    const findings = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.filter((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "high", file: "tests/live.js" }),
        expect.objectContaining({
          severity: "medium",
          file: "decoy/tests/live.js",
          testScoped: true,
        }),
      ]),
    );
  });

  test("follows packaged HTML navigations, including download and inert-control lookalikes", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({ action: { default_popup: "popup.html" } }),
      {
        path: "popup.html",
        size: 112,
        sha256: "6d".repeat(32),
        flags: [],
        textSample:
          '<a href="tests/helper.html">Open helper</a>' +
          '<area href="tests/area.html">' +
          '<form action="tests/form.html"></form>' +
          '<button formaction="tests/button.html">Open button helper</button>' +
          '<input type="submit" formaction="tests/input.html">' +
          '<a download href="tests/download.html">Download source</a>' +
          '<area download href="tests/area-download.html">' +
          '<button type="button" formaction="tests/inert-button.html">No navigation</button>' +
          '<input formaction="tests/inert-input.html">',
      },
      {
        path: "tests/helper.html",
        size: 40,
        sha256: "6e".repeat(32),
        flags: [],
        textSample: '<script src="payload.js"></script>',
      },
      {
        path: "tests/payload.js",
        size: 14,
        sha256: "6f".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
      ...["area", "form", "button", "input"].flatMap((name, index) => [
        {
          path: `tests/${name}.html`,
          size: 40,
          sha256: String(75 + index).repeat(32),
          flags: [],
          textSample: `<script src="${name}.js"></script>`,
        },
        {
          path: `tests/${name}.js`,
          size: 14,
          sha256: String(79 + index).repeat(32),
          flags: [],
          textSample: "eval(payload);",
        },
      ]),
      {
        path: "tests/download.html",
        size: 41,
        sha256: "73".repeat(32),
        flags: [],
        textSample: '<script src="download.js"></script>',
      },
      {
        path: "tests/download.js",
        size: 14,
        sha256: "74".repeat(32),
        flags: [],
        textSample: "eval(download);",
      },
      ...["area-download", "inert-button", "inert-input"].flatMap((name, index) => [
        {
          path: `tests/${name}.html`,
          size: 40,
          sha256: String(83 + index).repeat(32),
          flags: [],
          textSample: `<script src="${name}.js"></script>`,
        },
        {
          path: `tests/${name}.js`,
          size: 14,
          sha256: String(86 + index).repeat(32),
          flags: [],
          textSample: "eval(inert);",
        },
      ]),
    ];

    const parsed = parseBrowserExtensionManifest(files).manifest;
    expect(parsed.extensionPageEntrypoints).toEqual(
      expect.arrayContaining([
        "popup.html",
        "tests/helper.html",
        "tests/payload.js",
        ...["area", "form", "button", "input"].flatMap((name) => [
          `tests/${name}.html`,
          `tests/${name}.js`,
        ]),
      ]),
    );
    // Conservative over-approximation: download links and inert-looking form
    // controls still reference packaged documents, so their subtrees keep
    // full severity.
    expect(parsed.extensionPageEntrypoints).toEqual(
      expect.arrayContaining([
        "tests/download.html",
        "tests/area-download.html",
        "tests/inert-button.html",
        "tests/inert-input.html",
      ]),
    );
    const findings = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.filter((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "high", file: "tests/payload.js" }),
        ...["area", "form", "button", "input"].map((name) =>
          expect.objectContaining({ severity: "high", file: `tests/${name}.js` }),
        ),
        expect.objectContaining({ severity: "high", file: "tests/download.js" }),
        ...["area-download", "inert-button", "inert-input"].map((name) =>
          expect.objectContaining({ severity: "high", file: `tests/${name}.js` }),
        ),
      ]),
    );
    expect(findings).toHaveLength(9);
  });

  test.each(["0.5; url=tests/helper.html", "0; tests/helper.html"])(
    "follows browser-supported refresh syntax %s",
    (content) => {
      const path = "dist/tab-helper.zip";
      const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
      const files = [
        manifestFile({ action: { default_popup: "popup.html" } }),
        {
          path: "popup.html",
          size: 64,
          sha256: "70".repeat(32),
          flags: [],
          textSample: `<meta http-equiv="refresh" content="${content}">`,
        },
        {
          path: "tests/helper.html",
          size: 40,
          sha256: "71".repeat(32),
          flags: [],
          textSample: '<script src="payload.js"></script>',
        },
        {
          path: "tests/payload.js",
          size: 14,
          sha256: "72".repeat(32),
          flags: [],
          textSample: "eval(payload);",
        },
      ];

      const finding = createBrowserExtensionReview({
        manifest,
        artifact: { path, sha256: SHA, files },
      }).ruleFindings.find((candidate) => candidate.ruleId === "code.dynamic-evaluation");
      expect(finding).toMatchObject({ severity: "high", file: "tests/payload.js" });
      expect(finding?.testScoped).not.toBe(true);
    },
  );

  test("follows template and noscript content as reachable (conservative over-approximation)", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({ action: { default_popup: "popup.html" } }),
      {
        path: "popup.html",
        size: 170,
        sha256: "70".repeat(32),
        flags: [],
        textSample:
          '<template><base href="/decoy/"><script src="/tests/template.js"></script></template>' +
          '<noscript><base href="/other-decoy/"><script src="/tests/noscript.js"></script></noscript>' +
          '<script src="/tests/live.js"></script>',
      },
      ...["template", "noscript"].map((name, offset) => ({
        path: `tests/${name}.js`,
        size: 14,
        sha256: String(71 + offset).repeat(32),
        flags: [],
        textSample: "eval(payload);",
      })),
      {
        path: "tests/live.js",
        size: 14,
        sha256: "73".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
    ];

    const parsed = parseBrowserExtensionManifest(files).manifest;
    // Whether a browser instantiates template/noscript content depends on
    // exact tree construction and scripting state; the scanner deliberately
    // does not model that, so these subtrees keep full severity.
    expect(parsed.extensionPageEntrypoints).toEqual(
      expect.arrayContaining([
        "popup.html",
        "tests/template.js",
        "tests/noscript.js",
        "tests/live.js",
      ]),
    );
    const findings = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.filter((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "high", file: "tests/template.js" }),
        expect.objectContaining({ severity: "high", file: "tests/noscript.js" }),
        expect.objectContaining({ severity: "high", file: "tests/live.js" }),
      ]),
    );
    expect(findings).toHaveLength(3);
  });

  test("follows href and xlink:href scripts in inline SVG", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({ action: { default_popup: "popup.html" } }),
      {
        path: "popup.html",
        size: 120,
        sha256: "74".repeat(32),
        flags: [],
        textSample:
          '<script href="/tests/html-href.js"></script>' +
          '<svg><script href="/tests/href.js"></script>' +
          '<script xlink:href="/tests/xlink.js"></script>' +
          '<foreignObject><script href="/tests/foreign.js"></script></foreignObject></svg>',
      },
      ...["href", "xlink", "html-href", "foreign"].map((name, offset) => ({
        path: `tests/${name}.js`,
        size: 14,
        sha256: String(75 + offset).repeat(32),
        flags: [],
        textSample: "eval(payload);",
      })),
    ];

    const parsed = parseBrowserExtensionManifest(files).manifest;
    // Namespace context is not modeled: script href/xlink:href count wherever
    // they appear, so HTML-namespace lookalikes also keep full severity.
    expect(parsed.extensionPageEntrypoints).toEqual(
      expect.arrayContaining([
        "popup.html",
        "tests/href.js",
        "tests/xlink.js",
        "tests/html-href.js",
        "tests/foreign.js",
      ]),
    );
    const findings = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.filter((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(findings).toEqual(
      expect.arrayContaining(
        ["href", "xlink", "html-href", "foreign"].map((name) =>
          expect.objectContaining({ severity: "high", file: `tests/${name}.js` }),
        ),
      ),
    );
    expect(findings).toHaveLength(4);
  });

  test("parses script src attributes without losing quoted greater-than characters", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const review = createBrowserExtensionReview({
      manifest,
      artifact: {
        path,
        sha256: SHA,
        files: [
          manifestFile({ manifest_version: 2, background: { page: "pages/background.html" } }),
          {
            path: "pages/background.html",
            size: 180,
            sha256: "4b".repeat(32),
            flags: [],
            textSample:
              '<script data-description=">" src="../tests/payload.js"></script>' +
              "<script src='../tests/single-quoted.js'></script>" +
              "<script src=../tests/unquoted.js></script>",
          },
          {
            path: "tests/payload.js",
            size: 14,
            sha256: "4c".repeat(32),
            flags: [],
            textSample: "eval(payload);",
          },
          {
            path: "tests/single-quoted.js",
            size: 14,
            sha256: "4d".repeat(32),
            flags: [],
            textSample: "eval(payload);",
          },
          {
            path: "tests/unquoted.js",
            size: 14,
            sha256: "4e".repeat(32),
            flags: [],
            textSample: "eval(payload);",
          },
        ],
      },
    });
    const findings = review.ruleFindings.filter(
      (candidate) => candidate.ruleId === "code.dynamic-evaluation",
    );
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "high", file: "tests/payload.js" }),
        expect.objectContaining({ severity: "high", file: "tests/single-quoted.js" }),
        expect.objectContaining({ severity: "high", file: "tests/unquoted.js" }),
      ]),
    );
    expect(findings).toHaveLength(3);
    expect(findings.every((finding) => finding.testScoped !== true)).toBe(true);
  });

  test("uses the document URL when an extension page has an invalid base href", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const manifestRecord = manifestFile({ action: { default_popup: "popup.html" } });
    const files = [
      manifestRecord,
      {
        path: "popup.html",
        size: 68,
        sha256: "74".repeat(32),
        flags: [],
        textSample: '<base href="http://["><script src="/tests/payload.js"></script>',
      },
      {
        path: "tests/payload.js",
        size: 14,
        sha256: "75".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
    ];

    const parsed = parseBrowserExtensionManifest(files).manifest;
    expect(parsed.extensionPageEntrypoints).toEqual(
      expect.arrayContaining(["popup.html", "tests/payload.js"]),
    );
    const finding = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.find((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(finding).toMatchObject({ severity: "high", file: "tests/payload.js" });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("treats tag-shaped raw text as reachable (conservative over-approximation)", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const manifestRecord = manifestFile({ action: { default_popup: "popup.html" } });
    const files = [
      manifestRecord,
      {
        path: "popup.html",
        size: 220,
        sha256: "76".repeat(32),
        flags: [],
        textSample:
          '<style>.example { content: "<script src=tests/style.js>"; }</style>' +
          '<iframe><script src="tests/iframe.js"></script></iframe>' +
          '<noembed><script src="tests/noembed.js"></script></noembed>' +
          '<noframes><script src="tests/noframes.js"></script></noframes>' +
          '<textarea><script src="tests/textarea.js"></script></textarea>' +
          '<title><script src="tests/title.js"></script></title>' +
          '<xmp><script src="tests/xmp.js"></script></xmp>' +
          '<script src="tests/live.js"></script>',
      },
      ...["style", "iframe", "noembed", "noframes", "textarea", "title", "xmp", "live"].map(
        (name, index) => ({
          path: `tests/${name}.js`,
          size: 14,
          sha256: String(77 + index).repeat(32),
          flags: [],
          textSample: "eval(payload);",
        }),
      ),
    ];

    const parsed = parseBrowserExtensionManifest(files).manifest;
    // Raw-text element boundaries are exactly the kind of engine parsing
    // detail the scanner refuses to model: a tag-shaped reference in raw text
    // still marks its target reachable, so nothing here is demoted.
    expect(parsed.extensionPageEntrypoints).toEqual(
      expect.arrayContaining(
        ["style", "iframe", "noembed", "noframes", "textarea", "title", "xmp", "live"].map(
          (name) => `tests/${name}.js`,
        ),
      ),
    );
    const findings = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.filter((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(findings).toEqual(
      expect.arrayContaining(
        ["style", "iframe", "noembed", "noframes", "textarea", "title", "xmp", "live"].map((name) =>
          expect.objectContaining({ severity: "high", file: `tests/${name}.js` }),
        ),
      ),
    );
    expect(findings).toHaveLength(8);
  });

  test("follows scripts regardless of trailing-solidus or self-closing syntax", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({ action: { default_popup: "popup.html" } }),
      {
        path: "popup.html",
        size: 320,
        sha256: "85".repeat(32),
        flags: [],
        textSample:
          '<script src="tests/live.js" /><script src="tests/script-decoy.js"></script></script>' +
          '<template><template/></template><script src="tests/template-decoy.js"></script></template>' +
          '<svg><script href="tests/svg.js"/></svg>' +
          '<script src="tests/after.js"></script>',
      },
      ...["live", "script-decoy", "template-decoy", "svg", "after"].map((name, index) => ({
        path: `tests/${name}.js`,
        size: 14,
        sha256: String(86 + index).repeat(32),
        flags: [],
        textSample: "eval(payload);",
      })),
    ];

    const parsed = parseBrowserExtensionManifest(files).manifest;
    // Whether a trailing solidus closes an element differs between HTML and
    // XML parsing; the scanner ignores the distinction and follows every
    // referenced script.
    expect(parsed.extensionPageEntrypoints).toEqual(
      expect.arrayContaining(
        ["live", "script-decoy", "template-decoy", "svg", "after"].map(
          (name) => `tests/${name}.js`,
        ),
      ),
    );
    const findings = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.filter((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(findings).toEqual(
      expect.arrayContaining(
        ["live", "script-decoy", "template-decoy", "svg", "after"].map((name) =>
          expect.objectContaining({ severity: "high", file: `tests/${name}.js` }),
        ),
      ),
    );
    expect(findings).toHaveLength(5);
  });

  test("follows scripts loaded by a reachable offscreen document", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({
        permissions: ["offscreen"],
        background: { service_worker: "background.js" },
      }),
      {
        path: "background.js",
        size: 120,
        sha256: "81".repeat(32),
        flags: [],
        textSample:
          'chrome.offscreen.createDocument({ url: "/tests/offscreen.html", reasons: ["DOM_PARSER"], justification: "parse" });',
      },
      {
        path: "tests/offscreen.html",
        size: 39,
        sha256: "82".repeat(32),
        flags: [],
        textSample: '<script src="payload.js"></script>',
      },
      {
        path: "tests/payload.js",
        size: 14,
        sha256: "83".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
    ];

    const finding = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.find((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(finding).toMatchObject({ severity: "high", file: "tests/payload.js" });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("follows extension pages selected by reachable WebExtension APIs", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const pageNames = [
      "action",
      "browser-action",
      "page-action",
      "sidebar-action",
      "side-panel",
      "devtools-panel",
      "tab-create",
      "window-create",
    ];
    const files = [
      manifestFile({
        background: { service_worker: "background.js" },
        devtools_page: "devtools.html",
      }),
      {
        path: "background.js",
        size: 320,
        sha256: "84".repeat(32),
        flags: [],
        textSample: [
          'chrome.action.setPopup({ popup: "/tests/action.html" });',
          'browser["browserAction"].setPopup({ popup: "tests/browser-action.html" });',
          'globalThis.chrome.pageAction.setPopup({ popup: "tests/page-action.html" });',
          'browser.sidebarAction.setPanel({ panel: browser.runtime.getURL("tests/sidebar-action.html") });',
          'chrome.sidePanel.setOptions({ path: "/tests/side-panel.html", enabled: true });',
          'chrome.tabs.create({ url: "/tests/tab-create.html" });',
          'chrome.windows.create({ url: ["/tests/window-create.html"] });',
          'tool.action.setPopup({ popup: "/tests/decoy.html" });',
        ].join("\n"),
      },
      {
        path: "devtools.html",
        size: 43,
        sha256: "85".repeat(32),
        flags: [],
        textSample: '<script src="devtools.js"></script>',
      },
      {
        path: "devtools.js",
        size: 100,
        sha256: "86".repeat(32),
        flags: [],
        textSample:
          'chrome.devtools.panels.create("Example", "icon.png", "/tests/devtools-panel.html");',
      },
      ...pageNames.flatMap((name, index) => [
        {
          path: `tests/${name}.html`,
          size: 40,
          sha256: String(87 + index)
            .repeat(64)
            .slice(0, 64),
          flags: [],
          textSample: `<script src="${name}.js"></script>`,
        },
        {
          path: `tests/${name}.js`,
          size: 14,
          sha256: String(92 + index)
            .repeat(64)
            .slice(0, 64),
          flags: [],
          textSample: "eval(payload);",
        },
      ]),
      {
        path: "tests/decoy.html",
        size: 38,
        sha256: "97".repeat(32),
        flags: [],
        textSample: '<script src="decoy.js"></script>',
      },
      {
        path: "tests/decoy.js",
        size: 14,
        sha256: "98".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
    ];

    const findings = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.filter((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(findings).toEqual(
      expect.arrayContaining([
        ...pageNames.map((name) =>
          expect.objectContaining({ severity: "high", file: `tests/${name}.js` }),
        ),
        expect.objectContaining({
          severity: "medium",
          file: "tests/decoy.js",
          testScoped: true,
        }),
      ]),
    );
    expect(findings).toHaveLength(pageNames.length + 1);
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
      ["tests/sandbox.html", "tests/sandbox.js"],
      ["tests/protocol-handler.xhtml", "tests/protocol-handler.js"],
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
      action: { default_popup: "/tests/popup.html" },
      browser_action: { default_popup: "tests/browser-popup.html" },
      page_action: { default_popup: "tests/page-popup.html" },
      options_ui: { page: "tests/options.html" },
      options_page: "tests/legacy-options.html",
      devtools_page: "tests/devtools.html",
      side_panel: { default_path: "tests/side-panel.html" },
      sidebar_action: { default_panel: "tests/sidebar.html" },
      chrome_url_overrides: { newtab: "tests/new-tab.html" },
      sandbox: { pages: ["tests/sandbox.html"] },
      protocol_handlers: [
        {
          protocol: "ext+drydock",
          name: "Drydock handler",
          uriTemplate: "/tests/protocol-handler.xhtml?url=%s",
        },
      ],
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

  test.each([
    [2, ["tests/exposed.html", "tests/direct.js", "assets/*.js"]],
    [
      3,
      [
        {
          resources: ["tests/exposed.html", "tests/direct.js", "assets/*.js"],
          matches: ["https://example.invalid/*"],
        },
      ],
    ],
  ])(
    "treats Manifest V%s web-accessible resources as consumer reachable",
    (manifestVersion, webAccessibleResources) => {
      const path = "dist/tab-helper.zip";
      const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
      const files = [
        manifestFile({
          manifest_version: manifestVersion,
          background: undefined,
          web_accessible_resources: webAccessibleResources,
        }),
        {
          path: "tests/exposed.html",
          size: 40,
          sha256: "81".repeat(32),
          flags: [],
          textSample: '<script src="nested.js"></script>',
        },
        {
          path: "tests/nested.js",
          size: 14,
          sha256: "82".repeat(32),
          flags: [],
          textSample: "eval(payload);",
        },
        {
          path: "tests/direct.js",
          size: 14,
          sha256: "83".repeat(32),
          flags: [],
          textSample: "eval(payload);",
        },
        {
          path: "assets/exposed.js",
          size: 14,
          sha256: "84".repeat(32),
          flags: [],
          textSample: "eval(payload);",
        },
        {
          path: "tests/decoy.js",
          size: 14,
          sha256: "85".repeat(32),
          flags: [],
          textSample: "eval(payload);",
        },
      ];

      const parsed = parseBrowserExtensionManifest(files).manifest;
      expect(parsed.extensionPageEntrypoints).toEqual(
        expect.arrayContaining([
          "tests/exposed.html",
          "tests/nested.js",
          "tests/direct.js",
          "assets/exposed.js",
        ]),
      );
      const findings = createBrowserExtensionReview({
        manifest,
        artifact: { path, sha256: SHA, files },
      }).ruleFindings.filter((candidate) => candidate.ruleId === "code.dynamic-evaluation");
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ file: "tests/nested.js", severity: "high" }),
          expect.objectContaining({ file: "tests/direct.js", severity: "high" }),
          expect.objectContaining({ file: "assets/exposed.js", severity: "high" }),
          expect.objectContaining({
            file: "tests/decoy.js",
            severity: "medium",
            testScoped: true,
          }),
        ]),
      );
      expect(findings).toHaveLength(4);
    },
  );

  test("bounds web-accessible resource declarations and wildcard matching work", () => {
    expect(() =>
      parseBrowserExtensionManifest([
        manifestFile({
          web_accessible_resources: Array.from(
            { length: 10_001 },
            (_, index) => `assets/${index}.js`,
          ),
        }),
      ]),
    ).toThrow(/too many web-accessible resources/);

    const wildcardResources = Array.from({ length: 400 }, (_, index) => `assets/${index}/*.js`);
    const files = [
      manifestFile({ web_accessible_resources: wildcardResources }),
      ...Array.from({ length: 2_500 }, (_, index) => ({
        path: `assets/${index}/payload.js`,
        size: 1,
        sha256: String(index).padStart(64, "0").slice(-64),
        flags: [],
        textSample: "x",
      })),
    ];
    expect(() => parseBrowserExtensionManifest(files)).toThrow(/review work budget/);
  });

  test("returns direct document dependencies for graph traversal", () => {
    const dependencies = createBrowserHtmlConsumerDependencyResolver([
      {
        path: "root.html",
        size: 1,
        sha256: "81".repeat(32),
        flags: [],
        textSample: '<iframe src="nested/page.html"></iframe><script src="root.js"></script>',
      },
      {
        path: "nested/page.html",
        size: 1,
        sha256: "82".repeat(32),
        flags: [],
        textSample: '<script src="payload.js"></script>',
      },
    ]);

    expect(dependencies("root.html")).toEqual(
      expect.arrayContaining([
        { path: "nested/page.html" },
        { path: "root.js", documentBaseUrl: "drydock-extension://artifact/root.html" },
      ]),
    );
    expect(dependencies("root.html")).toHaveLength(2);
    expect(dependencies("nested/page.html")).toEqual([
      {
        path: "nested/payload.js",
        documentBaseUrl: "drydock-extension://artifact/nested/page.html",
      },
    ]);
  });

  test("follows scripts regardless of XML syntax or foreign-content context", () => {
    const dependencies = createBrowserHtmlConsumerDependencyResolver([
      {
        path: "page.xhtml",
        size: 1,
        sha256: "97".repeat(32),
        flags: [],
        textSample: '<script src="first.js"/><script src="second.js"/>',
      },
      {
        path: "page.html",
        size: 1,
        sha256: "98".repeat(32),
        flags: [],
        textSample:
          '<svg><title><script src="title.js"></script></title>' +
          '<desc><script src="desc.js"></script></desc>' +
          '<![CDATA[<script href="cdata-decoy.js"/>]]></svg>' +
          '<math><annotation-xml><svg><script href="math-svg.js"/></svg></annotation-xml></math>',
      },
    ]);

    expect(dependencies("page.xhtml")).toEqual(
      expect.arrayContaining([
        { path: "first.js", documentBaseUrl: "drydock-extension://artifact/page.xhtml" },
        { path: "second.js", documentBaseUrl: "drydock-extension://artifact/page.xhtml" },
      ]),
    );
    expect(dependencies("page.xhtml")).toHaveLength(2);
    // CDATA and foreign-content boundaries are not modeled; the CDATA decoy
    // is followed by design.
    expect(dependencies("page.html")).toEqual(
      expect.arrayContaining([
        { path: "title.js", documentBaseUrl: "drydock-extension://artifact/page.html" },
        { path: "desc.js", documentBaseUrl: "drydock-extension://artifact/page.html" },
        { path: "cdata-decoy.js", documentBaseUrl: "drydock-extension://artifact/page.html" },
        { path: "math-svg.js", documentBaseUrl: "drydock-extension://artifact/page.html" },
      ]),
    );
    expect(dependencies("page.html")).toHaveLength(4);
  });

  test("follows commented-out and XML-prefixed script references", () => {
    const dependencies = createBrowserHtmlConsumerDependencyResolver([
      {
        path: "page.html",
        size: 1,
        sha256: "99".repeat(32),
        flags: [],
        textSample: '<!-- <script src="commented.js"></script> -->',
      },
      {
        path: "page.xhtml",
        size: 1,
        sha256: "9a".repeat(32),
        flags: [],
        textSample:
          '<h:script xmlns:h="http://www.w3.org/1999/xhtml" src="prefixed.js"/>' +
          '<_svg:script xmlns:_svg="http://www.w3.org/2000/svg" href="underscored.js"/>' +
          '<s.vg:script xmlns:s.vg="http://www.w3.org/2000/svg" href="dotted.js"/>' +
          '<π:script xmlns:π="http://www.w3.org/2000/svg" href="unicode.js"/>',
      },
    ]);

    // Comment boundaries are engine parsing detail the scanner does not
    // model; a commented-out reference still counts.
    expect(dependencies("page.html")).toEqual([
      { path: "commented.js", documentBaseUrl: "drydock-extension://artifact/page.html" },
    ]);
    // Tag and attribute names match on their local name, so namespace
    // prefixes cannot hide a script.
    expect(dependencies("page.xhtml")).toEqual(
      expect.arrayContaining([
        { path: "prefixed.js", documentBaseUrl: "drydock-extension://artifact/page.xhtml" },
        { path: "underscored.js", documentBaseUrl: "drydock-extension://artifact/page.xhtml" },
        { path: "dotted.js", documentBaseUrl: "drydock-extension://artifact/page.xhtml" },
        { path: "unicode.js", documentBaseUrl: "drydock-extension://artifact/page.xhtml" },
      ]),
    );
    expect(dependencies("page.xhtml")).toHaveLength(4);
  });

  test("follows XML scripts hidden behind internal general entities", () => {
    const dependencies = createBrowserHtmlConsumerDependencyResolver([
      {
        path: "page.svg",
        size: 1,
        sha256: "9e".repeat(32),
        flags: [],
        textSample:
          '<!DOCTYPE svg [<!ENTITY dir "tests"><!ENTITY payload "&dir;&#x2F;payload.js">]>' +
          '<svg xmlns="http://www.w3.org/2000/svg"><script href="&payload;"/></svg>',
      },
    ]);

    expect(dependencies("page.svg")).toEqual(
      expect.arrayContaining([
        {
          path: "tests/payload.js",
          documentBaseUrl: "drydock-extension://artifact/page.svg",
        },
      ]),
    );
  });

  test("resolves XML scripts against inherited xml:base values", () => {
    const dependencies = createBrowserHtmlConsumerDependencyResolver([
      {
        path: "page.svg",
        size: 1,
        sha256: "a3".repeat(32),
        flags: [],
        textSample:
          '<svg xmlns="http://www.w3.org/2000/svg" xml:base="tests/">' +
          '<g xml:base="nested/"><script href="../payload.js"/></g></svg>',
      },
    ]);

    expect(dependencies("page.svg")).toEqual(
      expect.arrayContaining([
        {
          path: "tests/payload.js",
          documentBaseUrl: "drydock-extension://artifact/tests/nested/",
        },
      ]),
    );
  });

  test("follows scripts from linked packaged XML documents", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({ action: { default_popup: "popup.html" } }),
      {
        path: "popup.html",
        size: 1,
        sha256: "a4".repeat(32),
        flags: [],
        textSample: '<a href="tests/payload.xml">Open XML helper</a>',
      },
      {
        path: "tests/payload.xml",
        size: 1,
        sha256: "a5".repeat(32),
        flags: [],
        textSample:
          '<root xmlns:h="http://www.w3.org/1999/xhtml"><h:script src="payload.js"/></root>',
      },
      {
        path: "tests/payload.js",
        size: 14,
        sha256: "a6".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
    ];

    const finding = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.find((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(finding).toMatchObject({ severity: "high", file: "tests/payload.js" });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("follows scripts from a manifest-declared page without a document extension", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({ action: { default_popup: "popup" } }),
      {
        path: "popup",
        size: 1,
        sha256: "9c".repeat(32),
        flags: [],
        textSample: '<script src="tests/payload.js"></script>',
      },
      {
        path: "tests/payload.js",
        size: 14,
        sha256: "9d".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
    ];

    const parsed = parseBrowserExtensionManifest(files).manifest;
    expect(parsed.extensionPageEntrypoints).toEqual(
      expect.arrayContaining(["popup", "tests/payload.js"]),
    );
    const finding = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.find((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(finding).toMatchObject({ severity: "high", file: "tests/payload.js" });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("follows scripts from a runtime-opened page without a document extension", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({ background: { service_worker: "background.js" } }),
      {
        path: "background.js",
        size: 1,
        sha256: "9f".repeat(32),
        flags: [],
        textSample: 'chrome.tabs.create({ url: "tests/popup" });',
      },
      {
        path: "tests/popup",
        size: 1,
        sha256: "a0".repeat(32),
        flags: [],
        textSample: '<script src="payload.js"></script>',
      },
      {
        path: "tests/payload.js",
        size: 14,
        sha256: "a1".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
    ];

    const finding = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.find((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(finding).toMatchObject({ severity: "high", file: "tests/payload.js" });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("fails loudly on recursive XML general entities", () => {
    const dependencies = createBrowserHtmlConsumerDependencyResolver([
      {
        path: "page.svg",
        size: 1,
        sha256: "a2".repeat(32),
        flags: [],
        textSample:
          '<!DOCTYPE svg [<!ENTITY first "&second;"><!ENTITY second "&first;">]>' +
          '<svg xmlns="http://www.w3.org/2000/svg"><script href="&first;"/></svg>',
      },
    ]);

    expect(() => dependencies("page.svg")).toThrow(/entity .* recursive/);
  });

  test("fails loudly when a document declares too many distinct base candidates", () => {
    const bases = Array.from({ length: 17 }, (_, index) => `<base href="/base-${index}/">`).join(
      "",
    );
    const dependencies = createBrowserHtmlConsumerDependencyResolver([
      {
        path: "page.html",
        size: 1,
        sha256: "9b".repeat(32),
        flags: [],
        textSample: `${bases}<script src="payload.js"></script>`,
      },
    ]);

    expect(() => dependencies("page.html")).toThrow(/too many distinct base URL candidates/);
  });

  test("fails loudly when a document exceeds the consumer resolution work budget", () => {
    const bases = Array.from({ length: 15 }, (_, index) => `<base href="/base-${index}/">`).join(
      "",
    );
    const sources = Array.from(
      { length: 70_000 },
      (_, index) => `<script src="s${index}.js"></script>`,
    ).join("");
    const dependencies = createBrowserHtmlConsumerDependencyResolver([
      {
        path: "page.html",
        size: 1,
        sha256: "9e".repeat(32),
        flags: [],
        textSample: bases + sources,
      },
    ]);

    expect(() => dependencies("page.html")).toThrow(/consumer resolution work budget/);
  });

  test("follows scripts regardless of declared type or markup namespace", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({ action: { default_popup: "popup.html" } }),
      {
        path: "popup.html",
        size: 1,
        sha256: "83".repeat(32),
        flags: [],
        textSample:
          '<script type="application/json" src="tests/data-decoy.js"></script>' +
          '<math><script src="tests/math-decoy.js"></script>' +
          '<annotation-xml encoding="text/html"><script src="tests/math-live.js"></script></annotation-xml></math>' +
          '<svg><iframe src="tests/svg-frame.html"></iframe>' +
          '<a xlink:href="tests/svg-linked.html">Open</a></svg>',
      },
      {
        path: "tests/svg-linked.html",
        size: 1,
        sha256: "84".repeat(32),
        flags: [],
        textSample: '<script src="linked.js"></script>',
      },
      {
        path: "tests/svg-frame.html",
        size: 1,
        sha256: "85".repeat(32),
        flags: [],
        textSample: '<script src="frame-decoy.js"></script>',
      },
      ...["data-decoy", "math-decoy", "math-live", "linked", "frame-decoy"].map((name, index) => ({
        path: `tests/${name}.js`,
        size: 1,
        sha256: String(86 + index).repeat(32),
        flags: [],
        textSample: "eval(payload);",
      })),
    ];

    const parsed = parseBrowserExtensionManifest(files).manifest;
    // Script type attributes and HTML/SVG/MathML namespace context are not
    // modeled — every referenced script and document keeps full severity.
    expect(parsed.extensionPageEntrypoints).toEqual(
      expect.arrayContaining([
        "tests/math-live.js",
        "tests/svg-linked.html",
        "tests/linked.js",
        "tests/data-decoy.js",
        "tests/math-decoy.js",
        "tests/svg-frame.html",
        "tests/frame-decoy.js",
      ]),
    );
    const findings = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.filter((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(findings).toEqual(
      expect.arrayContaining(
        ["math-live", "linked", "data-decoy", "math-decoy", "frame-decoy"].map((name) =>
          expect.objectContaining({ file: `tests/${name}.js`, severity: "high" }),
        ),
      ),
    );
    expect(findings).toHaveLength(5);
  });

  test("follows unqualified open calls into XHTML and standalone SVG documents", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({ action: { default_popup: "popup.html" } }),
      {
        path: "popup.html",
        size: 1,
        sha256: "91".repeat(32),
        flags: [],
        textSample: '<script src="popup.js"></script>',
      },
      {
        path: "popup.js",
        size: 1,
        sha256: "92".repeat(32),
        flags: [],
        textSample: 'open("tests/runtime.xhtml"); location.assign("tests/runtime.svg");',
      },
      {
        path: "tests/runtime.xhtml",
        size: 1,
        sha256: "93".repeat(32),
        flags: [],
        textSample: '<script src="xhtml.js"></script>',
      },
      {
        path: "tests/runtime.svg",
        size: 1,
        sha256: "94".repeat(32),
        flags: [],
        textSample: '<svg xmlns="http://www.w3.org/2000/svg"><script href="svg.js"/></svg>',
      },
      ...["xhtml", "svg"].map((name, index) => ({
        path: `tests/${name}.js`,
        size: 1,
        sha256: String(95 + index).repeat(32),
        flags: [],
        textSample: "eval(payload);",
      })),
    ];

    const findings = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.filter((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "tests/xhtml.js", severity: "high" }),
        expect.objectContaining({ file: "tests/svg.js", severity: "high" }),
      ]),
    );
    expect(findings).toHaveLength(2);
  });

  test("follows scripts after an abruptly closed HTML comment", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({ action: { default_popup: "tests/popup.html" } }),
      {
        path: "tests/popup.html",
        size: 48,
        sha256: "86".repeat(32),
        flags: [],
        textSample: '<!--><script src="payload.js"></script>',
      },
      {
        path: "tests/payload.js",
        size: 14,
        sha256: "87".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
    ];

    const finding = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.find((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(finding).toMatchObject({ file: "tests/payload.js", severity: "high" });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("does not apply Node extension fallback to browser URLs", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({
        background: { service_worker: "scripts/controller.js" },
        options_page: "tests/manifest-entry",
      }),
      {
        path: "scripts/controller.js",
        size: 100,
        sha256: "88".repeat(32),
        flags: [],
        textSample:
          'import "../tests/imported"; chrome.scripting.executeScript({ files: ["tests/injected"] });',
      },
      {
        path: "tests/imported.js",
        size: 14,
        sha256: "89".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
      {
        path: "tests/injected.js",
        size: 14,
        sha256: "8a".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
      {
        path: "tests/manifest-entry.js",
        size: 14,
        sha256: "8b".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
    ];

    const findings = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.filter((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(findings).toEqual([
      expect.objectContaining({ file: "tests/imported.js", severity: "medium", testScoped: true }),
      expect.objectContaining({ file: "tests/injected.js", severity: "medium", testScoped: true }),
      expect.objectContaining({
        file: "tests/manifest-entry.js",
        severity: "medium",
        testScoped: true,
      }),
    ]);
  });

  test("resolves plain Worker URLs against the owning extension document", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({ action: { default_popup: "popup.html" } }),
      {
        path: "popup.html",
        size: 58,
        sha256: "70".repeat(32),
        flags: [],
        textSample: '<script type="module" src="scripts/popup.js"></script>',
      },
      {
        path: "scripts/popup.js",
        size: 25,
        sha256: "71".repeat(32),
        flags: [],
        textSample: 'import "./controller.js";',
      },
      {
        path: "scripts/controller.js",
        size: 38,
        sha256: "72".repeat(32),
        flags: [],
        textSample: 'new Worker("tests/payload.js");',
      },
      {
        path: "tests/payload.js",
        size: 14,
        sha256: "73".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
      {
        path: "scripts/tests/payload.js",
        size: 14,
        sha256: "79".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
    ];

    const parsed = parseBrowserExtensionManifest(files).manifest;
    expect(parsed.consumerDocumentBaseUrlsByPath["scripts/popup.js"]).toContain(
      "drydock-extension://artifact/popup.html",
    );
    const review = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    });
    const findings = review.ruleFindings.filter(
      (candidate) => candidate.ruleId === "code.dynamic-evaluation",
    );
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "high", file: "tests/payload.js" }),
        expect.objectContaining({
          severity: "medium",
          file: "scripts/tests/payload.js",
          testScoped: true,
        }),
      ]),
    );
    expect(findings).toHaveLength(2);
  });

  test("resolves plain Worker URLs from a generated Manifest V2 background page", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({
        manifest_version: 2,
        background: { scripts: ["background/main.js"] },
      }),
      {
        path: "background/main.js",
        size: 38,
        sha256: "7b".repeat(32),
        flags: [],
        textSample: 'new Worker("tests/payload.js");',
      },
      {
        path: "tests/payload.js",
        size: 14,
        sha256: "7c".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
      {
        path: "background/tests/payload.js",
        size: 14,
        sha256: "7d".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
    ];

    const parsed = parseBrowserExtensionManifest(files).manifest;
    expect(parsed.consumerDocumentBaseUrlsByPath["background/main.js"]).toEqual([
      "drydock-extension://artifact/",
    ]);
    const findings = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.filter((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "high", file: "tests/payload.js" }),
        expect.objectContaining({
          severity: "medium",
          file: "background/tests/payload.js",
          testScoped: true,
        }),
      ]),
    );
    expect(findings).toHaveLength(2);
  });

  test("resolves plain Worker URLs from generated Manifest V3 background scripts", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({
        background: {
          scripts: ["background/main.js"],
          service_worker: "service-worker.js",
        },
      }),
      {
        path: "background/main.js",
        size: 38,
        sha256: "8c".repeat(32),
        flags: [],
        textSample: 'new Worker("tests/from-script.js");',
      },
      {
        path: "service-worker.js",
        size: 46,
        sha256: "8d".repeat(32),
        flags: [],
        textSample: 'new Worker("tests/from-service-worker.js");',
      },
      ...["from-script", "from-service-worker"].map((name, index) => ({
        path: `tests/${name}.js`,
        size: 14,
        sha256: String(88 + index).repeat(32),
        flags: [],
        textSample: "eval(payload);",
      })),
    ];

    const parsed = parseBrowserExtensionManifest(files).manifest;
    expect(parsed.consumerDocumentBaseUrlsByPath["background/main.js"]).toEqual([
      "drydock-extension://artifact/",
    ]);
    expect(parsed.consumerDocumentBaseUrlsByPath["service-worker.js"]).toBeUndefined();
    const findings = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.filter((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "high", file: "tests/from-script.js" }),
        expect.objectContaining({
          severity: "medium",
          file: "tests/from-service-worker.js",
          testScoped: true,
        }),
      ]),
    );
    expect(findings).toHaveLength(2);
  });

  test("follows Worker URLs created through the legacy extension.getURL alias", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({ background: { service_worker: "background.js" } }),
      {
        path: "background.js",
        size: 120,
        sha256: "7e".repeat(32),
        flags: [],
        textSample:
          'new Worker(chrome.extension.getURL("tests/chrome.js")); new Worker(browser.extension.getURL("tests/browser.js"));',
      },
      ...["chrome", "browser"].map((name, index) => ({
        path: `tests/${name}.js`,
        size: 14,
        sha256: String(79 + index).repeat(32),
        flags: [],
        textSample: "eval(payload);",
      })),
    ];

    const findings = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.filter((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "high", file: "tests/chrome.js" }),
        expect.objectContaining({ severity: "high", file: "tests/browser.js" }),
      ]),
    );
    expect(findings.every((finding) => finding.testScoped !== true)).toBe(true);
  });

  test("does not resolve Worker URLs against an unrelated extension document", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({
        background: { service_worker: "background/main.js" },
        options_page: "tests/options.html",
      }),
      {
        path: "background/main.js",
        size: 25,
        sha256: "74".repeat(32),
        flags: [],
        textSample: 'new Worker("payload.js");',
      },
      {
        path: "tests/options.html",
        size: 38,
        sha256: "75".repeat(32),
        flags: [],
        textSample: '<script src="options.js"></script>',
      },
      {
        path: "tests/options.js",
        size: 23,
        sha256: "76".repeat(32),
        flags: [],
        textSample: "console.log('options');",
      },
      {
        path: "tests/payload.js",
        size: 14,
        sha256: "77".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
    ];

    const finding = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.find((candidate) => candidate.file === "tests/payload.js");
    expect(finding).toMatchObject({ severity: "medium", testScoped: true });
  });

  test("follows packaged iframe pages from manifest-declared extension pages", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const manifestRecord = manifestFile({ action: { default_popup: "popup.html" } });
    const files = [
      manifestRecord,
      {
        path: "popup.html",
        size: 42,
        sha256: "7a".repeat(32),
        flags: [],
        textSample: '<iframe src="tests/frame.html"></iframe>',
      },
      {
        path: "tests/frame.html",
        size: 38,
        sha256: "7b".repeat(32),
        flags: [],
        textSample: '<script src="payload.js"></script>',
      },
      {
        path: "tests/payload.js",
        size: 14,
        sha256: "7c".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
    ];

    const parsed = parseBrowserExtensionManifest(files).manifest;
    expect(parsed.extensionPageEntrypoints).toEqual(
      expect.arrayContaining(["popup.html", "tests/frame.html", "tests/payload.js"]),
    );
    const review = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    });
    const finding = review.ruleFindings.find(
      (candidate) => candidate.ruleId === "code.dynamic-evaluation",
    );
    expect(finding).toMatchObject({ severity: "high", file: "tests/payload.js" });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("follows packaged frame and meta-refresh pages from extension pages", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const files = [
      manifestFile({
        action: { default_popup: "popup.html" },
        options_page: "refresh.html",
      }),
      {
        path: "popup.html",
        size: 82,
        sha256: "99".repeat(32),
        flags: [],
        textSample:
          '<frameset><frame src="tests/frame.html"></frameset><meta name="description" content="0;url=tests/decoy.html">',
      },
      {
        path: "refresh.html",
        size: 82,
        sha256: "9a".repeat(32),
        flags: [],
        textSample: '<meta content="0; URL=\'tests/refreshed.html\'" HTTP-EQUIV="Refresh">',
      },
      ...["frame", "refreshed", "decoy"].flatMap((name, index) => [
        {
          path: `tests/${name}.html`,
          size: 40,
          sha256: String(101 + index)
            .repeat(64)
            .slice(0, 64),
          flags: [],
          textSample: `<script src="${name}.js"></script>`,
        },
        {
          path: `tests/${name}.js`,
          size: 14,
          sha256: String(104 + index)
            .repeat(64)
            .slice(0, 64),
          flags: [],
          textSample: "eval(payload);",
        },
      ]),
    ];

    const parsed = parseBrowserExtensionManifest(files).manifest;
    expect(parsed.extensionPageEntrypoints).toEqual(
      expect.arrayContaining([
        "tests/frame.html",
        "tests/frame.js",
        "tests/refreshed.html",
        "tests/refreshed.js",
      ]),
    );
    // Refresh-shaped content attributes count on any element, so the
    // meta-description lookalike is followed by design.
    expect(parsed.extensionPageEntrypoints).toContain("tests/decoy.html");
    const findings = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.filter((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "high", file: "tests/frame.js" }),
        expect.objectContaining({ severity: "high", file: "tests/refreshed.js" }),
        expect.objectContaining({ severity: "high", file: "tests/decoy.js" }),
      ]),
    );
    expect(findings).toHaveLength(3);
  });

  test.each([
    ["object", '<object type="text/html" data="tests/frame.html"></object>'],
    ["embed", '<embed type="text/html" src="tests/frame.html">'],
  ])("follows packaged %s documents from manifest-declared extension pages", (_tag, markup) => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const manifestRecord = manifestFile({ action: { default_popup: "popup.html" } });
    const files = [
      manifestRecord,
      {
        path: "popup.html",
        size: 64,
        sha256: "8a".repeat(32),
        flags: [],
        textSample: markup,
      },
      {
        path: "tests/frame.html",
        size: 38,
        sha256: "8b".repeat(32),
        flags: [],
        textSample: '<script src="payload.js"></script>',
      },
      {
        path: "tests/payload.js",
        size: 14,
        sha256: "8c".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
    ];

    const parsed = parseBrowserExtensionManifest(files).manifest;
    expect(parsed.extensionPageEntrypoints).toEqual(
      expect.arrayContaining(["popup.html", "tests/frame.html", "tests/payload.js"]),
    );
    const review = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    });
    const finding = review.ruleFindings.find(
      (candidate) => candidate.ruleId === "code.dynamic-evaluation",
    );
    expect(finding).toMatchObject({ severity: "high", file: "tests/payload.js" });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("follows packaged scripts loaded by an iframe srcdoc", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const manifestRecord = manifestFile({ action: { default_popup: "popup.html" } });
    const files = [
      manifestRecord,
      {
        path: "popup.html",
        size: 88,
        sha256: "7d".repeat(32),
        flags: [],
        textSample:
          '<iframe srcdoc="&lt;script src=&quot;/tests/payload.js&quot;&gt;&lt;/script&gt;"></iframe>',
      },
      {
        path: "tests/payload.js",
        size: 14,
        sha256: "7e".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
    ];

    const parsed = parseBrowserExtensionManifest(files).manifest;
    expect(parsed.extensionPageEntrypoints).toEqual(
      expect.arrayContaining(["popup.html", "tests/payload.js"]),
    );
    const review = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    });
    const finding = review.ruleFindings.find(
      (candidate) => candidate.ruleId === "code.dynamic-evaluation",
    );
    expect(finding).toMatchObject({ severity: "high", file: "tests/payload.js" });
    expect(finding?.testScoped).not.toBe(true);
  });

  test("resolves iframe srcdoc scripts against every candidate document base", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const manifestRecord = manifestFile({ action: { default_popup: "popup.html" } });
    const files = [
      manifestRecord,
      {
        path: "popup.html",
        size: 120,
        sha256: "8d".repeat(32),
        flags: [],
        textSample:
          '<base href="/assets/"><iframe srcdoc="&lt;script src=&quot;tests/payload.js&quot;&gt;&lt;/script&gt;"></iframe>',
      },
      {
        path: "assets/tests/payload.js",
        size: 14,
        sha256: "8e".repeat(32),
        flags: [],
        textSample: "eval(payload);",
      },
      {
        path: "tests/payload.js",
        size: 14,
        sha256: "8f".repeat(32),
        flags: [],
        textSample: "eval(decoy);",
      },
    ];

    const parsed = parseBrowserExtensionManifest(files).manifest;
    // Sources resolve against the document URL and every declared base, so
    // which <base> a browser would actually apply can never hide an edge.
    expect(parsed.extensionPageEntrypoints).toEqual(
      expect.arrayContaining(["popup.html", "assets/tests/payload.js", "tests/payload.js"]),
    );
    const findings = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files },
    }).ruleFindings.filter((candidate) => candidate.ruleId === "code.dynamic-evaluation");
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "high", file: "assets/tests/payload.js" }),
        expect.objectContaining({ severity: "high", file: "tests/payload.js" }),
      ]),
    );
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

  test("flags wildcard externally connectable extension IDs", () => {
    const path = "dist/tab-helper.zip";
    const manifest = buildBrowserReleaseManifest("Tab helper", "1.2.0", [{ path, sha256: SHA }]);
    const manifestRecord = manifestFile({ externally_connectable: { ids: ["*"] } }, true);
    const review = createBrowserExtensionReview({
      manifest,
      artifact: { path, sha256: SHA, files: [manifestRecord] },
    });
    const finding = review.ruleFindings.find(
      (candidate) => candidate.ruleId === "browser.externally-connectable",
    );
    expect(finding).toMatchObject({
      severity: "high",
      evidence: "all extensions and apps may connect through externally_connectable.ids",
    });
    expect(finding?.line).toBe(
      manifestRecord.textSample.split("\n").findIndex((line) => line.includes('"ids"')) + 1,
    );
  });

  test.each(["*://*/", "https://*/", "http://*/", "https://*/sensitive/*", "file:///*"])(
    "flags scheme-wide match pattern %s",
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
    "accessibilityFeatures.modify",
    "accessibilityFeatures.read",
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
    "readingList",
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
    "ttsEngine",
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
    "script-src 'self' 'nonce-review' 'strict-dynamic'; object-src 'self'",
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

  test.each([
    "script-src 'self'; worker-src 'self' 'strict-dynamic'",
    "script-src 'self'; child-src 'self' 'strict-dynamic'",
    "script-src 'self'; img-src 'unsafe-eval'",
    "default-src 'self'; script-src-elem 'unsafe-eval'",
  ])("does not treat non-script CSP keywords as executable policy: %s", (contentSecurityPolicy) => {
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
    expect(review.ruleFindings.map((finding) => finding.ruleId)).not.toContain(
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
