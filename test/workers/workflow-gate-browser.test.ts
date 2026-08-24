import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import {
  classifyBundleArtifact,
  getWorkflowGateAdapter,
  supportedWorkflowGateEcosystems,
} from "../../server/lib/ecosystems";
import { browserWorkflowGateAdapter } from "../../server/lib/ecosystems/browser/workflow-gate";
import {
  WorkflowArtifactError,
  type ResolvedReleaseBundle,
} from "../../server/lib/github-app/artifacts";
import { resolveBundleArtifacts } from "../../server/lib/workflow-gates/resolve";

const SHA = "cd".repeat(32);
const OTHER_SHA = "ce".repeat(32);

describe("browser extension workflow-gate adapter", () => {
  test("registers browser extensions and keeps generic ZIPs out of auto-detection", () => {
    expect(getWorkflowGateAdapter("browser")).toBe(browserWorkflowGateAdapter);
    expect(supportedWorkflowGateEcosystems()).toContain("browser");
    expect(browserWorkflowGateAdapter.classifyArtifact("dist/tab-helper.zip")).toBe("zip");
    expect(classifyBundleArtifact("dist/tab-helper.zip")).toBeNull();
    expect(classifyBundleArtifact("dist/source.zip")).toBeNull();
    expect(classifyBundleArtifact("dist/tab-helper.xpi")).toEqual({
      ecosystem: "browser",
      kind: "xpi",
    });
    expect(
      browserWorkflowGateAdapter.detectArtifact({ files: [manifestFile()], packageJson: null }),
    ).toBeNull();
  });

  test("parses extension bytes through the shared ZIP sandbox and prepares a candidate", async () => {
    const bundle: ResolvedReleaseBundle = {
      artifactId: 1,
      artifactName: "browser-extension-release-candidate",
      artifactSizeBytes: 3,
      artifacts: [
        {
          path: "dist/tab-helper.zip",
          bytes: new Uint8Array([1, 2, 3]),
          sha256: SHA,
          ecosystem: "browser",
          kind: "zip",
        },
      ],
    };
    const loader = buildLoaderMock({
      files: [manifestFile()],
      packageJson: null,
    });
    const parsed = await resolveBundleArtifacts(
      { ...env, LOADER: loader.binding as unknown as WorkerLoader } as Cloudflare.Env,
      buildCtxWithGateway(),
      bundle,
    );
    expect(loader.formats).toEqual(["zip-buffered"]);
    const [candidate] = browserWorkflowGateAdapter.prepareReleaseCandidates(parsed);
    expect(candidate).toMatchObject({
      ecosystem: "browser",
      package: { name: "tab-helper@example.invalid", version: "1.2.0" },
      pipelineInput: {
        manifest: { ecosystem: "browser" },
        artifact: { path: "dist/tab-helper.zip", sha256: SHA },
      },
    });
  });

  test("fails closed on missing identity and duplicate extension archives", () => {
    expect(() =>
      browserWorkflowGateAdapter.prepareReleaseCandidates([
        parsedArtifact("dist/bad.zip", [
          { path: "background.js", size: 1, sha256: "00", flags: [], textSample: "0" },
        ]),
      ]),
    ).toThrow(WorkflowArtifactError);

    expect(() =>
      browserWorkflowGateAdapter.prepareReleaseCandidates([
        parsedArtifact("dist/one.zip", [manifestFile()]),
        parsedArtifact("dist/two.xpi", [manifestFile()]),
      ]),
    ).toThrow(/more than one archive/);
  });

  test("keeps same-name Chrome archives separate without a stable extension id", () => {
    const candidates = browserWorkflowGateAdapter.prepareReleaseCandidates([
      parsedArtifact("dist/chrome.zip", [nameOnlyManifestFile()]),
      parsedArtifact("dist/edge.zip", [nameOnlyManifestFile()], OTHER_SHA),
    ]);
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((candidate) => candidate.scanKey))).toEqual(
      new Set([SHA, OTHER_SHA]),
    );
    expect(candidates.map((candidate) => candidate.pipelineInput)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifact: expect.objectContaining({ path: "dist/chrome.zip" }) }),
        expect.objectContaining({ artifact: expect.objectContaining({ path: "dist/edge.zip" }) }),
      ]),
    );
  });

  test("keeps case-distinct Gecko extension ids separate", () => {
    const candidates = browserWorkflowGateAdapter.prepareReleaseCandidates([
      parsedArtifact("dist/upper.xpi", [manifestFile("Tab-Helper@Example.Invalid")]),
      parsedArtifact("dist/lower.xpi", [manifestFile("tab-helper@example.invalid")], OTHER_SHA),
    ]);

    expect(candidates.map((candidate) => candidate.package.name)).toEqual([
      "Tab-Helper@Example.Invalid",
      "tab-helper@example.invalid",
    ]);
  });
});

function manifestFile(extensionId = "tab-helper@example.invalid") {
  const value = {
    manifest_version: 3,
    name: "Tab helper",
    version: "1.2.0",
    browser_specific_settings: { gecko: { id: extensionId } },
  };
  return {
    path: "manifest.json",
    size: JSON.stringify(value).length,
    sha256: "11".repeat(32),
    flags: [],
    textSample: JSON.stringify(value),
  };
}

function nameOnlyManifestFile() {
  const value = {
    manifest_version: 3,
    name: "Tab helper",
    version: "1.2.0",
  };
  return {
    path: "manifest.json",
    size: JSON.stringify(value).length,
    sha256: "12".repeat(32),
    flags: [],
    textSample: JSON.stringify(value),
  };
}

function parsedArtifact(
  path: string,
  files: Array<ReturnType<typeof manifestFile> | ReturnType<typeof nameOnlyManifestFile>>,
  sha256 = SHA,
) {
  return {
    path,
    sha256,
    ecosystem: "browser",
    kind: path.endsWith(".xpi") ? "xpi" : "zip",
    files,
    packageJson: null,
  };
}

function buildLoaderMock(result: unknown) {
  const formats: string[] = [];
  return {
    formats,
    binding: {
      load: vi.fn(() => ({
        getEntrypoint: () => ({
          fetch: vi.fn(async (request: Request) => {
            formats.push(request.headers.get("x-archive-format") ?? "");
            return Response.json(result);
          }),
        }),
      })),
    },
  };
}

function buildCtxWithGateway() {
  const ctx = createExecutionContext() as ExecutionContext & {
    exports: { NpmStageGateway(options: { props: unknown }): Fetcher };
  };
  ctx.exports = { NpmStageGateway: vi.fn(() => ({ fetch: vi.fn() }) as unknown as Fetcher) };
  return ctx;
}
