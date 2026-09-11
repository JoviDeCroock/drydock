import { describe, expect, test } from "vitest";
import {
  computeIntentEnvelope,
  extractDeclaredRepository,
  normalizeIntentEnvelope,
  normalizeRepositoryUrl,
} from "../server/lib/intent-envelope.ts";

describe("normalizeRepositoryUrl", () => {
  test("normalizes plain https URLs and strips .git", () => {
    expect(normalizeRepositoryUrl("https://github.com/owner/repo")).toBe(
      "https://github.com/owner/repo",
    );
    expect(normalizeRepositoryUrl("https://github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo",
    );
    expect(normalizeRepositoryUrl("https://gitlab.com/owner/repo.git/")).toBe(
      "https://gitlab.com/owner/repo",
    );
  });

  test("truncates known-forge URLs to owner/repo", () => {
    expect(normalizeRepositoryUrl("https://github.com/owner/repo/tree/main/packages/core")).toBe(
      "https://github.com/owner/repo",
    );
  });

  test("canonicalizes case-insensitive forge identities", () => {
    expect(normalizeRepositoryUrl("https://github.com/Owner/Repo.git")).toBe(
      "https://github.com/owner/repo",
    );
    expect(normalizeRepositoryUrl("bitbucket:Workspace/Repo")).toBe(
      "https://bitbucket.org/workspace/repo",
    );
  });

  test("preserves GitLab subgroup paths and trims browser suffixes", () => {
    expect(normalizeRepositoryUrl("https://gitlab.com/group/subgroup/project.git")).toBe(
      "https://gitlab.com/group/subgroup/project",
    );
    expect(normalizeRepositoryUrl("gitlab:group/subgroup/project")).toBe(
      "https://gitlab.com/group/subgroup/project",
    );
    expect(normalizeRepositoryUrl("https://gitlab.com/group/subgroup/project/-/tree/main")).toBe(
      "https://gitlab.com/group/subgroup/project",
    );
  });

  test("keeps the full path for unknown hosts (self-hosted forges)", () => {
    expect(normalizeRepositoryUrl("https://git.example.com/group/subgroup/repo")).toBe(
      "https://git.example.com/group/subgroup/repo",
    );
  });

  test("handles git+https, git, ssh, and http schemes", () => {
    expect(normalizeRepositoryUrl("git+https://github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo",
    );
    expect(normalizeRepositoryUrl("git://github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo",
    );
    expect(normalizeRepositoryUrl("git+ssh://git@gitlab.com/owner/repo.git")).toBe(
      "https://gitlab.com/owner/repo",
    );
    expect(normalizeRepositoryUrl("http://github.com/owner/repo")).toBe(
      "https://github.com/owner/repo",
    );
  });

  test("handles scp-like git@host:owner/repo.git", () => {
    expect(normalizeRepositoryUrl("git@github.com:owner/repo.git")).toBe(
      "https://github.com/owner/repo",
    );
  });

  test("expands github:/gitlab:/bitbucket: and bare owner/repo shorthands", () => {
    expect(normalizeRepositoryUrl("github:owner/repo")).toBe("https://github.com/owner/repo");
    expect(normalizeRepositoryUrl("gitlab:owner/repo")).toBe("https://gitlab.com/owner/repo");
    expect(normalizeRepositoryUrl("bitbucket:owner/repo")).toBe("https://bitbucket.org/owner/repo");
    expect(normalizeRepositoryUrl("owner/repo")).toBe("https://github.com/owner/repo");
  });

  test("unwraps { url } objects (including nested type field)", () => {
    expect(
      normalizeRepositoryUrl({ type: "git", url: "git+https://github.com/owner/repo.git" }),
    ).toBe("https://github.com/owner/repo");
    expect(normalizeRepositoryUrl({ url: "github:owner/repo" })).toBe(
      "https://github.com/owner/repo",
    );
  });

  test("rejects garbage, unsupported schemes, and oversized input", () => {
    expect(normalizeRepositoryUrl(undefined)).toBeNull();
    expect(normalizeRepositoryUrl(null)).toBeNull();
    expect(normalizeRepositoryUrl(42)).toBeNull();
    expect(normalizeRepositoryUrl([])).toBeNull();
    expect(normalizeRepositoryUrl("")).toBeNull();
    expect(normalizeRepositoryUrl("   ")).toBeNull();
    expect(normalizeRepositoryUrl("not a url at all")).toBeNull();
    expect(normalizeRepositoryUrl("ftp://github.com/owner/repo")).toBeNull();
    expect(normalizeRepositoryUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeRepositoryUrl({ url: 42 })).toBeNull();
    expect(normalizeRepositoryUrl("https://github.com/owner-only")).toBeNull();
    expect(normalizeRepositoryUrl(`https://github.com/${"a".repeat(600)}/repo`)).toBeNull();
  });

  test("rejects owner/repo segments with unsafe characters", () => {
    expect(normalizeRepositoryUrl("https://github.com/ow ner/repo")).toBeNull();
    expect(normalizeRepositoryUrl("github:owner/repo?x=1")).toBeNull();
  });
});

describe("extractDeclaredRepository", () => {
  test("reads a string repository from the staged package.json text", () => {
    const declared = extractDeclaredRepository({
      manifestText: JSON.stringify({ name: "pkg", repository: "github:owner/repo" }),
      files: [],
    });
    expect(declared).toBe("github:owner/repo");
  });

  test("reads an object repository from the staged package.json text", () => {
    const declared = extractDeclaredRepository({
      manifestText: JSON.stringify({
        name: "pkg",
        repository: { type: "git", url: "git+https://github.com/owner/repo.git" },
      }),
      files: [],
    });
    expect(declared).toEqual({ type: "git", url: "git+https://github.com/owner/repo.git" });
  });

  test("falls back to PyPI PKG-INFO Project-URL headers", () => {
    const declared = extractDeclaredRepository({
      manifestText: null,
      files: [
        {
          path: "demo-1.0.0/PKG-INFO",
          textSample:
            "Metadata-Version: 2.1\nName: demo\nProject-URL: Homepage, https://example.com\nProject-URL: Source, https://github.com/owner/repo\n\nBody text with Project-URL: Fake, https://evil.example\n",
        },
      ],
    });
    expect(declared).toBe("https://github.com/owner/repo");
  });

  test("falls back to Home-page when no repository-like Project-URL exists", () => {
    const declared = extractDeclaredRepository({
      manifestText: null,
      files: [
        {
          path: "demo.dist-info/METADATA",
          textSample:
            "Metadata-Version: 2.1\nName: demo\nHome-page: https://github.com/owner/repo\n",
        },
      ],
    });
    expect(declared).toBe("https://github.com/owner/repo");
  });

  test("returns null for malformed manifest text and missing metadata", () => {
    expect(extractDeclaredRepository({ manifestText: "{not json", files: [] })).toBeNull();
    expect(
      extractDeclaredRepository({ manifestText: JSON.stringify({ name: "pkg" }), files: [] }),
    ).toBeNull();
    expect(extractDeclaredRepository({ manifestText: null, files: [] })).toBeNull();
  });

  test("stays linear on a pathologically long comma-less Project-URL line (ReDoS guard)", () => {
    // `textSample` is the whole decoded metadata file, so a hostile PKG-INFO can
    // pack a header line with hundreds of KB of padding and no comma. The old
    // `\s*([^,]+),` split backtracked quadratically on that (tens of seconds of
    // Worker CPU per scan). Parsing must stay linear, the over-long line must be
    // skipped, and it must not shadow a later valid header in the same file.
    const padding = " ".repeat(200_000);
    const textSample =
      `Metadata-Version: 2.1\nName: demo\nProject-URL:${padding}no-comma-here\n` +
      "Project-URL: Source, https://github.com/owner/repo\n";
    const startedAt = performance.now();
    const declared = extractDeclaredRepository({
      manifestText: null,
      files: [{ path: "demo-1.0.0/PKG-INFO", textSample }],
    });
    const elapsedMs = performance.now() - startedAt;
    expect(declared).toBe("https://github.com/owner/repo");
    // The quadratic version took ~60s on this input; linear parsing is single
    // digit ms. A generous bound keeps the regression signal without flaking.
    expect(elapsedMs).toBeLessThan(2000);
  });
});

describe("computeIntentEnvelope", () => {
  test("workflow gate context yields attested with gate signals", () => {
    const envelope = computeIntentEnvelope({
      workflowGate: { repositoryFullName: "owner/repo", runId: 123, environment: "release" },
    });
    expect(envelope.tier).toBe("attested");
    expect(envelope.repository).toBe("https://github.com/owner/repo");
    expect(envelope.signals).toEqual([
      { kind: "workflow-gate", detail: "repo owner/repo, run 123, environment release" },
    ]);
  });

  test("attested keeps the manifest declaration as a secondary signal", () => {
    const envelope = computeIntentEnvelope({
      workflowGate: { repositoryFullName: "owner/repo", runId: 7, environment: "release" },
      declaredRepository: "git+https://github.com/owner/repo.git",
    });
    expect(envelope.tier).toBe("attested");
    expect(envelope.signals).toHaveLength(2);
    expect(envelope.signals[1]).toEqual({
      kind: "manifest-repository",
      detail: "manifest declares https://github.com/owner/repo",
    });
  });

  test("a parseable manifest repository yields declared", () => {
    const envelope = computeIntentEnvelope({
      declaredRepository: { url: "git://gitlab.com/owner/repo.git" },
    });
    expect(envelope.tier).toBe("declared");
    expect(envelope.repository).toBe("https://gitlab.com/owner/repo");
    expect(envelope.signals).toEqual([
      {
        kind: "manifest-repository",
        detail:
          "manifest declares https://gitlab.com/owner/repo — claimed by the package, not verified",
      },
    ]);
  });

  test("no gate and no parseable repository yields absent", () => {
    expect(computeIntentEnvelope({})).toEqual({ tier: "absent", repository: null, signals: [] });
    expect(computeIntentEnvelope({ declaredRepository: "///nope" })).toEqual({
      tier: "absent",
      repository: null,
      signals: [],
    });
  });

  test("a malformed gate context degrades to the declared/absent path", () => {
    expect(
      computeIntentEnvelope({
        workflowGate: { repositoryFullName: "", runId: 1, environment: "release" },
      }).tier,
    ).toBe("absent");
    expect(
      computeIntentEnvelope({
        workflowGate: { repositoryFullName: "owner/repo", runId: 1, environment: " " },
        declaredRepository: "github:owner/repo",
      }).tier,
    ).toBe("declared");
  });
});

describe("normalizeIntentEnvelope", () => {
  test("round-trips a computed envelope", () => {
    const envelope = computeIntentEnvelope({
      workflowGate: { repositoryFullName: "owner/repo", runId: 9, environment: "release" },
    });
    expect(normalizeIntentEnvelope(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope);
  });

  test("returns null for missing or malformed values", () => {
    expect(normalizeIntentEnvelope(undefined)).toBeNull();
    expect(normalizeIntentEnvelope(null)).toBeNull();
    expect(normalizeIntentEnvelope("attested")).toBeNull();
    expect(normalizeIntentEnvelope([])).toBeNull();
    expect(normalizeIntentEnvelope({})).toBeNull();
    expect(normalizeIntentEnvelope({ tier: "verified" })).toBeNull();
  });

  test("rejects a declared tier after its repository evidence becomes malformed", () => {
    expect(
      normalizeIntentEnvelope({
        tier: "declared",
        repository: 42,
        signals: [
          { kind: "manifest-repository", detail: "ok" },
          "garbage",
          { kind: 1, detail: "no" },
          { kind: "missing-detail" },
        ],
      }),
    ).toBeNull();
  });

  test("rejects evidence-free attested tiers", () => {
    expect(normalizeIntentEnvelope({ tier: "attested" })).toBeNull();
    expect(
      normalizeIntentEnvelope({
        tier: "attested",
        repository: "https://github.com/owner/repo",
        signals: [],
      }),
    ).toBeNull();
    expect(
      normalizeIntentEnvelope({
        tier: "attested",
        repository: "javascript:alert(1)",
        signals: [{ kind: "workflow-gate", detail: "repo owner/repo, run 1" }],
      }),
    ).toBeNull();
  });

  test("tolerates absent signals and caps oversized valid arrays", () => {
    expect(normalizeIntentEnvelope({ tier: "absent" })).toEqual({
      tier: "absent",
      repository: null,
      signals: [],
    });
    const flooded = normalizeIntentEnvelope({
      tier: "attested",
      repository: "https://github.com/owner/repo",
      signals: [
        { kind: "workflow-gate", detail: "repo owner/repo, run 1" },
        ...Array.from({ length: 99 }, (_, i) => ({ kind: "k", detail: `d${i}` })),
      ],
    });
    expect(flooded?.signals).toHaveLength(20);
  });
});
