import { describe, expect, test } from "vitest";
import { attestationLinks, githubRepoUrl, resolutionLinks } from "../src/pages/Diff/TrustEvidence";

// Every value linked from the trust card is publisher-controlled: the
// resolution trail is unsigned by construction, and even the attestation's
// repository arrives as a string parsed out of a certificate. So the safety
// property under test is not "is this value trustworthy" but "can this value
// choose a destination" — it must not be able to pick the scheme, the host, or
// anything outside the path shape the row promises.

const PDS = "shiitake.us-east.host.bsky.network";
const DID = "did:plc:twegdcgytckr5cxm57gyruxa";

function trail(steps: Array<{ label: string; value: string; detail?: string }>) {
  return resolutionLinks(steps);
}

describe("resolutionLinks", () => {
  test("links each step to the record that proved it", () => {
    const links = trail([
      { label: "Handle", value: "@ebey.dev", detail: "DNS TXT" },
      { label: "DID", value: DID, detail: "plc.directory" },
      { label: "PDS", value: PDS },
      { label: "Record", value: `at://${DID}/dev.atpm.alpha.package/counter` },
    ]);

    expect(links.get("Handle")).toBe("https://dns.google/resolve?name=_atproto.ebey.dev&type=TXT");
    expect(links.get("DID")).toBe(`https://plc.directory/${DID}`);
    expect(links.get("PDS")).toBe(`https://${PDS}/xrpc/com.atproto.server.describeServer`);
    expect(links.get("Record")).toBe(
      `https://${PDS}/xrpc/com.atproto.repo.getRecord` +
        `?repo=did%3Aplc%3Atwegdcgytckr5cxm57gyruxa&collection=dev.atpm.alpha.package&rkey=counter`,
    );
  });

  test("a handle proved over HTTP links to the file that proved it", () => {
    const links = trail([
      { label: "Handle", value: "@ebey.dev", detail: "/.well-known/atproto-did" },
    ]);
    expect(links.get("Handle")).toBe("https://ebey.dev/.well-known/atproto-did");
  });

  test("did:web resolves against its own domain, in both spellings", () => {
    expect(trail([{ label: "DID", value: "did:web:example.com" }]).get("DID")).toBe(
      "https://example.com/.well-known/did.json",
    );
    expect(trail([{ label: "DID", value: "did:web:example.com:user:alice" }]).get("DID")).toBe(
      "https://example.com/user/alice/did.json",
    );
  });

  // The record link is built from the PDS row, so a trail that never proved a
  // PDS has nowhere honest to point.
  test("drops the record link when no PDS was resolved", () => {
    const links = trail([{ label: "Record", value: `at://${DID}/dev.atpm.alpha.package/counter` }]);
    expect(links.get("Record")).toBeNull();
  });

  test.each([
    ["a scheme", "javascript:alert(1)"],
    ["a path escape", "evil.com/../../admin"],
    ["a credential", "user:pass@evil.com"],
    ["a port", "evil.com:8080"],
    ["a query", "evil.com?x=1"],
    ["whitespace", "evil.com evil2.com"],
    ["an empty value", ""],
  ])("refuses a handle carrying %s", (_case, value) => {
    expect(trail([{ label: "Handle", value, detail: "DNS TXT" }]).get("Handle")).toBeNull();
  });

  test.each([
    ["a traversal", "did:plc:../../../etc"],
    ["a wrong length", "did:plc:short"],
    ["an unknown method", "did:example:abc"],
    ["a did:web escape", "did:web:evil.com%2f..%2fadmin"],
  ])("refuses a DID carrying %s", (_case, value) => {
    expect(trail([{ label: "DID", value }]).get("DID")).toBeNull();
  });

  test("refuses a PDS that is not a bare hostname", () => {
    const links = trail([
      { label: "PDS", value: "https://evil.com" },
      { label: "Record", value: `at://${DID}/dev.atpm.alpha.package/counter` },
    ]);
    expect(links.get("PDS")).toBeNull();
    // A rejected PDS must take the record link down with it rather than
    // falling back to some other host.
    expect(links.get("Record")).toBeNull();
  });

  test("encodes an rkey that tries to add its own query parameters", () => {
    const links = trail([
      { label: "PDS", value: PDS },
      { label: "Record", value: `at://${DID}/dev.atpm.alpha.package/counter&admin=1` },
    ]);
    expect(links.get("Record")).toContain("rkey=counter%26admin%3D1");
  });

  test("refuses a record URI that is not an at:// URI", () => {
    const links = trail([
      { label: "PDS", value: PDS },
      { label: "Record", value: "https://evil.com/record" },
    ]);
    expect(links.get("Record")).toBeNull();
  });
});

describe("githubRepoUrl", () => {
  test("accepts a public repository URL", () => {
    expect(githubRepoUrl("https://github.com/owner/repo")).toBe("https://github.com/owner/repo");
  });

  test.each([
    ["http", "http://github.com/owner/repo"],
    ["a lookalike host", "https://github.com.evil.com/owner/repo"],
    ["a subdomain", "https://raw.github.com/owner/repo"],
    ["a deeper path", "https://github.com/owner/repo/settings"],
    ["an owner only", "https://github.com/owner"],
    ["a non-URL", "owner/repo"],
    ["a scheme", "javascript:alert(1)"],
  ])("refuses %s", (_case, value) => {
    expect(githubRepoUrl(value)).toBeNull();
  });
});

describe("attestationLinks", () => {
  const build = {
    repository: "https://github.com/owner/repo",
    ref: "refs/tags/v1.2.3",
    commit: "9b6b2f07adc181067a94c696fd02ee3f06c18116",
    workflow: ".github/workflows/publish.yaml",
    runUrl: "https://github.com/owner/repo/actions/runs/1/attempts/1",
    runnerEnvironment: "github-hosted",
    signedAt: null,
    logIndex: "2544306340",
    logBaseUrl: "https://rekor.sigstore.dev",
  };

  test("points every proven field at what proved it", () => {
    const links = attestationLinks(build);
    expect(links.repo).toBe("https://github.com/owner/repo");
    // Pinned to the proven commit: the row is about the file that ran for this
    // release, not whatever sits on the branch today.
    expect(links.workflow).toBe(
      `https://github.com/owner/repo/blob/${build.commit}/.github/workflows/publish.yaml`,
    );
    expect(links.ref).toBe("https://github.com/owner/repo/tree/v1.2.3");
    expect(links.commit).toBe(`https://github.com/owner/repo/commit/${build.commit}`);
    expect(links.run).toBe(build.runUrl);
    expect(links.rekor).toBe("https://rekor.sigstore.dev/api/v1/log/entries?logIndex=2544306340");
  });

  test("falls back to the ref when no commit was certified", () => {
    const links = attestationLinks({ ...build, commit: null });
    expect(links.workflow).toBe(
      "https://github.com/owner/repo/blob/v1.2.3/.github/workflows/publish.yaml",
    );
    expect(links.commit).toBeNull();
  });

  test("keeps slashes in a branch ref but encodes the segments", () => {
    const links = attestationLinks({ ...build, commit: null, ref: "refs/heads/release/1.x" });
    expect(links.ref).toBe("https://github.com/owner/repo/tree/release/1.x");
  });

  test("drops every repository-derived link when the repository is not github.com", () => {
    const links = attestationLinks({ ...build, repository: "https://evil.com/owner/repo" });
    expect(links.repo).toBeNull();
    expect(links.workflow).toBeNull();
    expect(links.ref).toBeNull();
    expect(links.commit).toBeNull();
  });

  test("refuses a run URL that left github.com", () => {
    expect(attestationLinks({ ...build, runUrl: "https://evil.com/run" }).run).toBeNull();
  });

  test.each([
    ["a non-hex commit", { commit: "../../../etc/passwd" }],
    ["a short commit", { commit: "abc" }],
  ])("refuses %s", (_case, patch) => {
    expect(attestationLinks({ ...build, ...patch }).commit).toBeNull();
  });

  test("refuses a non-numeric transparency log index", () => {
    expect(attestationLinks({ ...build, logIndex: "1 OR 1=1" }).rekor).toBeNull();
  });

  test("preserves the authenticated transparency-log instance", () => {
    expect(
      attestationLinks({
        ...build,
        logBaseUrl: "https://log2025-1.rekor.sigstore.dev",
      }).rekor,
    ).toBe("https://log2025-1.rekor.sigstore.dev/tile/entries/x009/x938/696");
  });

  test("refuses an unrecognized transparency-log instance", () => {
    expect(attestationLinks({ ...build, logBaseUrl: "https://evil.com" }).rekor).toBeNull();
  });
});
