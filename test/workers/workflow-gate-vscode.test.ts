import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import { validateReleaseTargetShape } from "../../server/lib/github-app/validation";
import {
  classifyBundleArtifact,
  getWorkflowGateAdapter,
  supportedWorkflowGateEcosystems,
} from "../../server/lib/workflow-gates/registry";
import { resolveBundleArtifacts } from "../../server/lib/workflow-gates/resolve";
import { vscodeWorkflowGateAdapter } from "../../server/lib/workflow-gates/vscode";
import type { ResolvedReleaseBundle } from "../../server/lib/github-app/artifacts";

const SHA = "cd".repeat(32);

describe("VS Code workflow-gate adapter", () => {
  test("registers vscode and classifies VSIX artifacts", () => {
    expect(getWorkflowGateAdapter("vscode")).toBe(vscodeWorkflowGateAdapter);
    expect(supportedWorkflowGateEcosystems()).toEqual(
      expect.arrayContaining(["pypi", "npm", "vscode"]),
    );
    expect(classifyBundleArtifact("dist/example.remote-text-fetcher-1.0.0.vsix")).toEqual({
      ecosystem: "vscode",
      kind: "vsix",
    });
  });

  test("accepts vscode release targets", () => {
    expect(() =>
      validateReleaseTargetShape({
        ecosystem: "vscode",
        repositoryId: 123,
        repositoryFullName: "octo/example",
        environment: "vscode",
        installationRowId: "installation",
        organizationId: "org",
        artifactName: null,
        createdByUserId: null,
      }),
    ).not.toThrow();
  });

  test("parses VSIX bytes through the shared ZIP sandbox and prepares a scan candidate", async () => {
    const bundle: ResolvedReleaseBundle = {
      artifactId: 1,
      artifactName: "vscode-release-candidate",
      artifactSizeBytes: 1,
      artifacts: [
        {
          path: "dist/remote-text-fetcher-1.0.0.vsix",
          bytes: new Uint8Array([1, 2, 3]),
          sha256: SHA,
          ecosystem: "vscode",
          kind: "vsix",
        },
      ],
    };

    const loader = buildLoaderMock({
      files: [
        {
          path: "extension/package.json",
          size: 120,
          sha256: "00",
          flags: [],
          textSample: JSON.stringify({
            name: "remote-text-fetcher",
            publisher: "example",
            version: "1.0.0",
            engines: { vscode: "^1.80.0" },
            main: "./out/extension",
            activationEvents: ["onStartupFinished"],
          }),
        },
        {
          path: "extension/out/extension.js",
          size: 26,
          sha256: "00",
          flags: [],
          textSample: "exports.activate = () => {};",
        },
      ],
      packageJson: null,
    });
    const parsed = await resolveBundleArtifacts(
      { ...env, LOADER: loader.binding as unknown as WorkerLoader } as Cloudflare.Env,
      buildCtxWithGateway(),
      bundle,
    );
    expect(loader.calls).toEqual(["zip"]);
    expect(parsed[0].files.some((file) => file.path === "extension/package.json")).toBe(true);
    const [candidate] = vscodeWorkflowGateAdapter.prepareReleaseCandidates(parsed);
    expect(candidate).toMatchObject({
      ecosystem: "vscode",
      package: { name: "example.remote-text-fetcher", version: "1.0.0" },
    });
    expect(candidate.pipelineInput.manifest).toMatchObject({
      ecosystem: "vscode",
      package: "example.remote-text-fetcher",
      version: "1.0.0",
    });
  });
});

interface SandboxResult {
  files: { path: string; size: number; sha256: string; flags: string[]; textSample?: string }[];
  packageJson: { name?: string; version?: string } | null;
}

function buildLoaderMock(result: SandboxResult) {
  const calls: string[] = [];
  return {
    calls,
    binding: {
      load: vi.fn(() => ({
        getEntrypoint: () => ({
          fetch: vi.fn(async (request: Request) => {
            calls.push(request.headers.get("x-archive-format") ?? "");
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
