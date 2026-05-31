import { describe, expect, it } from "vitest";
import {
  npmStagedPublishWorkflow,
  npmTrustCommand,
  pypiReleaseWorkflow,
  setupDefaults,
} from "../src/pages/Dashboard/Setup/workflow-templates";

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("npmStagedPublishWorkflow", () => {
  const yaml = npmStagedPublishWorkflow({ packageName: "@scope/pkg" });

  it("is tag-triggered and grants no credentials at the top level", () => {
    expect(yaml).toContain('tags: ["v*"]');
    expect(yaml).toContain("permissions:\n  contents: read");
  });

  it("mints the OIDC token in exactly one job", () => {
    expect(count(yaml, "id-token: write")).toBe(1);
  });

  it("stages instead of publishing and never uses a long-lived token", () => {
    expect(yaml).toContain("npm stage publish");
    expect(yaml).not.toContain("npm publish");
    // Trusted publishing uses no GitHub secrets and no token env binding.
    expect(yaml).not.toContain("secrets.");
    expect(yaml).not.toContain("NODE_AUTH_TOKEN");
  });

  it("disables the package-manager cache in every job on the publish path", () => {
    expect(count(yaml, "package-manager-cache: false")).toBe(2);
  });

  it("gates the credentialed job behind the npm environment", () => {
    expect(yaml).toContain(`name: ${setupDefaults.npmEnvironment}`);
    expect(yaml).toContain("https://www.npmjs.com/package/@scope/pkg");
  });

  it("requires a staged-publishing-capable npm and verifies the tarball identity", () => {
    expect(yaml).toContain("npm@^11.15.0");
    expect(yaml).toContain(`EXPECTED_PACKAGES_JSON: '["@scope/pkg"]'`);
    expect(yaml).toContain("!expected.has(p.name)");
  });

  it("isolates pack output and selects tarballs by package identity", () => {
    expect(yaml).toContain("npm pack --json --pack-destination drydock-npm-pack");
    expect(yaml).toContain('PACK_ARGS+=(--workspace "$package")');
    expect(yaml).toContain('npm pack "${PACK_ARGS[@]}" --json');
    expect(yaml).toContain("selected-tarballs.txt");
    expect(yaml).toContain("missing packed tarball(s)");
    expect(yaml).toContain("found more than one packed tarball");
    expect(yaml).toContain("path: drydock-npm-pack");
    expect(yaml).not.toContain(".drydock-npm-pack");
    expect(yaml).not.toContain('path: "*.tgz"');
    expect(yaml).not.toContain('TARBALL="$(ls *.tgz)"');
  });

  it("supports monorepo release flows that stage more than one selected package", () => {
    const monorepo = npmStagedPublishWorkflow({ packageName: "@scope/a\n@scope/b" });
    expect(monorepo).toContain(`EXPECTED_PACKAGES_JSON: '["@scope/a","@scope/b"]'`);
    expect(monorepo).toContain("expected.join");
    expect(monorepo).toContain("selected.join");
    expect(monorepo).toContain("done < drydock-npm-pack/selected-tarballs.txt");
  });

  it("honors a custom environment", () => {
    expect(npmStagedPublishWorkflow({ packageName: "pkg", environment: "release" })).toContain(
      "name: release",
    );
  });

  it("falls back to a placeholder when the package name is empty", () => {
    const placeholder = npmStagedPublishWorkflow({ packageName: "" });
    expect(placeholder).toContain("https://www.npmjs.com/package/<package>");
  });
});

describe("npmTrustCommand", () => {
  const command = npmTrustCommand({ owner: "acme", repo: "widgets", packageName: "@acme/widgets" });

  it("is stage-only: allows stage publish and disallows direct publish", () => {
    expect(command).toContain("--allow-stage-publish");
    expect(command).toContain("--no-allow-publish");
  });

  it("binds trust to the repo, workflow file, environment, and package", () => {
    expect(command).toContain("--repo acme/widgets");
    expect(command).toContain(`--file ${setupDefaults.npmWorkflowFilename}`);
    expect(command).toContain(`--env ${setupDefaults.npmEnvironment}`);
    expect(command).toContain("@acme/widgets");
  });

  it("respects a custom workflow filename", () => {
    expect(
      npmTrustCommand({
        owner: "acme",
        repo: "widgets",
        packageName: "@acme/widgets",
        workflowFilename: "publish.yml",
      }),
    ).toContain("--file publish.yml");
  });

  it("falls back to placeholders for empty owner/repo", () => {
    const command = npmTrustCommand({ owner: "", repo: "", packageName: "pkg" });
    expect(command).toContain("--repo <owner>/<repo>");
  });

  it("emits stage-only trust commands for each selected package", () => {
    const command = npmTrustCommand({ owner: "acme", repo: "widgets", packageName: "a\nb" });
    expect(count(command, "--allow-stage-publish")).toBe(2);
    expect(command).toContain("--no-allow-publish a");
    expect(command).toContain("--no-allow-publish b");
    expect(command).toContain("npm trust list a");
    expect(command).toContain("npm trust list b");
  });
});

describe("pypiReleaseWorkflow", () => {
  const yaml = pypiReleaseWorkflow();

  it("is a plain tag-triggered publish with no workflow_dispatch target picker", () => {
    expect(yaml).toContain('tags: ["v*"]');
    expect(yaml).not.toContain("workflow_dispatch");
    expect(yaml).not.toContain("Where to publish");
    expect(yaml).not.toContain("testpypi");
    expect(yaml).not.toContain("dry-run");
  });

  it("uploads the artifact Drydock reviews by its expected name", () => {
    expect(yaml).toContain("pypi-release-candidate");
  });

  it("gates the publish job on the environment and exchanges OIDC there", () => {
    expect(yaml).toContain(`environment: ${setupDefaults.pypiEnvironment}`);
    expect(count(yaml, "id-token: write")).toBe(1);
  });

  it("builds once and never rebuilds in the publish job", () => {
    expect(count(yaml, "actions/checkout@")).toBe(1);
    expect(count(yaml, "python -m build")).toBe(1);
  });

  it("publishes through the PyPI trusted-publishing action", () => {
    expect(yaml).toContain("pypa/gh-action-pypi-publish@release/v1");
  });

  it("honors custom environment and python version", () => {
    const custom = pypiReleaseWorkflow({ environment: "release", pythonVersion: "3.11" });
    expect(custom).toContain("environment: release");
    expect(custom).toContain('python-version: "3.11"');
  });
});
