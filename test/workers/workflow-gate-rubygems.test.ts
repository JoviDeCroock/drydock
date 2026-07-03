import { describe, expect, test } from "vitest";
import { WorkflowArtifactError } from "../../server/lib/github-app/artifacts";
import {
  classifyBundleArtifact,
  getWorkflowGateAdapter,
  supportedWorkflowGateEcosystems,
} from "../../server/lib/workflow-gates/registry";
import { rubygemsWorkflowGateAdapter } from "../../server/lib/workflow-gates/rubygems";
import type { ParsedGateArtifact } from "../../server/lib/workflow-gates/types";

function gemspec(opts: { name: string; version: string; platform?: string }): string {
  return (
    [
      "--- !ruby/object:Gem::Specification",
      `name: ${opts.name}`,
      "version: !ruby/object:Gem::Version",
      `  version: ${opts.version}`,
      `platform: ${opts.platform ?? "ruby"}`,
      "dependencies: []",
      "executables: []",
      "extensions: []",
      "metadata: {}",
      "require_paths:",
      "- lib",
    ].join("\n") + "\n"
  );
}

function parsedGem(
  path: string,
  spec: { name: string; version: string; platform?: string } | null,
): ParsedGateArtifact {
  return {
    path,
    sha256: "a".repeat(64),
    ecosystem: "rubygems",
    kind: "gem",
    files: [{ path: "lib/x.rb", size: 2, sha256: "s".repeat(64), flags: [] }],
    packageJson: null,
    gemMetadata: spec ? gemspec(spec) : null,
  };
}

describe("rubygems workflow-gate adapter", () => {
  test("is registered and reachable by ecosystem", () => {
    expect(getWorkflowGateAdapter("rubygems")).toBe(rubygemsWorkflowGateAdapter);
    expect(supportedWorkflowGateEcosystems()).toContain("rubygems");
  });

  test("classifies only .gem entries, by path (never ambiguous)", () => {
    expect(rubygemsWorkflowGateAdapter.classifyArtifact("pkg/example-1.0.0.gem")).toBe("gem");
    expect(rubygemsWorkflowGateAdapter.classifyArtifact("example-1.0.0.tgz")).toBeNull();
    expect(rubygemsWorkflowGateAdapter.classifyArtifact("example.whl")).toBeNull();
    // A `.gem` is path-unique, so the combined classifier resolves it directly
    // to rubygems rather than the ambiguous-archive sentinel npm/PyPI share.
    expect(classifyBundleArtifact("example-1.0.0.gem")).toEqual({
      ecosystem: "rubygems",
      kind: "gem",
    });
  });

  test("one gem becomes one candidate with a derived manifest", () => {
    const candidates = rubygemsWorkflowGateAdapter.prepareReleaseCandidates([
      parsedGem("example-1.0.0.gem", { name: "Example", version: "1.0.0" }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].ecosystem).toBe("rubygems");
    expect(candidates[0].package).toEqual({ name: "Example", version: "1.0.0" });
    const manifest = candidates[0].pipelineInput.manifest as { artifacts: unknown[] };
    expect(manifest.artifacts).toHaveLength(1);
  });

  test("native multi-platform gems collapse into one candidate", () => {
    const candidates = rubygemsWorkflowGateAdapter.prepareReleaseCandidates([
      parsedGem("native-1.0.0.gem", { name: "native", version: "1.0.0", platform: "ruby" }),
      parsedGem("native-1.0.0-x86_64-linux.gem", {
        name: "native",
        version: "1.0.0",
        platform: "x86_64-linux",
      }),
    ]);
    expect(candidates).toHaveLength(1);
    expect((candidates[0].pipelineInput.artifacts as unknown[]).length).toBe(2);
  });

  test("distinct gem names fan out into separate candidates", () => {
    const candidates = rubygemsWorkflowGateAdapter.prepareReleaseCandidates([
      parsedGem("a-1.0.0.gem", { name: "a", version: "1.0.0" }),
      parsedGem("b-2.0.0.gem", { name: "b", version: "2.0.0" }),
    ]);
    expect(candidates.map((c) => c.package.name).sort()).toEqual(["a", "b"]);
  });

  test("rejects a metadata-less gem", () => {
    expect.assertions(2);
    try {
      rubygemsWorkflowGateAdapter.prepareReleaseCandidates([parsedGem("bare-1.0.0.gem", null)]);
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowArtifactError);
      expect((err as WorkflowArtifactError).code).toBe("artifact_identity_missing");
    }
  });

  test("rejects same-name gems that disagree on version", () => {
    expect.assertions(1);
    try {
      rubygemsWorkflowGateAdapter.prepareReleaseCandidates([
        parsedGem("dup-1.0.0.gem", { name: "dup", version: "1.0.0" }),
        parsedGem("dup-1.1.0.gem", { name: "dup", version: "1.1.0" }),
      ]);
    } catch (err) {
      expect((err as WorkflowArtifactError).code).toBe("artifact_identity_inconsistent");
    }
  });

  test("rejects two gems that claim the same name and platform", () => {
    expect.assertions(1);
    try {
      rubygemsWorkflowGateAdapter.prepareReleaseCandidates([
        parsedGem("dup-1.0.0.gem", { name: "dup", version: "1.0.0", platform: "ruby" }),
        parsedGem("dup-1.0.0-copy.gem", { name: "dup", version: "1.0.0", platform: "ruby" }),
      ]);
    } catch (err) {
      expect((err as WorkflowArtifactError).code).toBe("artifact_identity_inconsistent");
    }
  });
});
