import { describe, expect, test } from "vitest";
import {
  installationSettingsUrl,
  newWorkflowUrl,
  PUBLISHING_GUIDE_HREF,
} from "../src/features/publisher-setup/links";
import type { PublicGithubAppInstallation } from "../src/models/github-app";

describe("publisher setup links", () => {
  test("a repository without workflows opens GitHub's editor inside .github/workflows", () => {
    expect(newWorkflowUrl("drydock/example", "main")).toBe(
      "https://github.com/drydock/example/new/main/.github/workflows",
    );
  });

  test("branch segments stay path segments while each is encoded", () => {
    expect(newWorkflowUrl("drydock/example", "release/v1 #2")).toBe(
      "https://github.com/drydock/example/new/release/v1%20%232/.github/workflows",
    );
  });

  test("the publishing guide is the in-app workflow examples section", () => {
    expect(PUBLISHING_GUIDE_HREF).toBe("/docs#gate-workflow");
  });

  test("installation permissions link to the owner's installation settings", () => {
    const installation = {
      installationId: "123",
      accountLogin: "drydock",
      accountType: "Organization",
    } as PublicGithubAppInstallation;
    expect(installationSettingsUrl(installation)).toBe(
      "https://github.com/organizations/drydock/settings/installations/123",
    );
    expect(installationSettingsUrl({ ...installation, accountType: "User" })).toBe(
      "https://github.com/settings/installations/123",
    );
  });
});
