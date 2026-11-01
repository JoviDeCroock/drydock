import { afterEach, describe, expect, test, vi } from "vitest";
import {
  PyPiStageError,
  compareDistributionSets,
  mergeStageReferences,
  parseAllowedStageUrl,
  parseDistributionFilename,
  parsePyPiStageReference,
  parseStageProjectPage,
  selectStagedReleaseFiles,
  stageProjectUrl,
} from "../server/lib/ecosystems/pypi/stage";
import {
  MAX_STAGE_PAGE_BYTES,
  downloadStagedFile,
  fetchStageProjectPage,
} from "../server/lib/ecosystems/pypi/stage-fetch";
import { stubFetchRoutes } from "./helpers/fetch-stub";
import { FAKE_STAGE_TOKEN, buildFakeStage } from "./helpers/pep694-fake";

const STAGE = `https://pypi.org/stage/${FAKE_STAGE_TOKEN}/`;
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

afterEach(() => {
  vi.unstubAllGlobals();
});

function reference(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema: "drydock.pypi-stage.v1",
    name: "demo-package",
    version: "1.2.0",
    "stage-url": STAGE,
    ...overrides,
  });
}

function expectStageError(fn: () => unknown, code: string, message?: RegExp) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PyPiStageError);
    expect((err as PyPiStageError).code).toBe(code);
    if (message) expect((err as Error).message).toMatch(message);
    expect((err as Error).message).not.toContain(FAKE_STAGE_TOKEN);
    return;
  }
  throw new Error("expected a PyPiStageError");
}

describe("parsePyPiStageReference", () => {
  test("accepts a single top-level stage and a stages array", () => {
    const [single] = parsePyPiStageReference(reference());
    expect(single.name).toBe("demo-package");
    expect(single.stageUrl.href).toBe(STAGE);
    expect(single.sessionUrl).toBeNull();

    const many = parsePyPiStageReference(
      JSON.stringify({
        schema: "drydock.pypi-stage.v1",
        stages: [
          {
            name: "a",
            version: "1.0",
            stage_url: STAGE,
            "session-url": "https://upload.example/s/1",
          },
          { name: "b", version: "2.0", "stage-url": "https://test.pypi.org/stage/x/" },
        ],
        future_field: true,
      }),
    );
    expect(many.map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(many[0].sessionUrl).toBe("https://upload.example/s/1");
  });

  test("fails closed on an unknown schema or malformed JSON", () => {
    expectStageError(
      () => parsePyPiStageReference(reference({ schema: "drydock.pypi-stage.v2" })),
      "stage_reference_invalid",
    );
    expectStageError(() => parsePyPiStageReference("{"), "stage_reference_invalid");
    expectStageError(
      () =>
        parsePyPiStageReference(JSON.stringify({ schema: "drydock.pypi-stage.v1", stages: [] })),
      "stage_reference_invalid",
    );
  });

  test("refuses stage hosts outside the index allowlist without echoing the URL", () => {
    for (const url of [
      `https://evil.example/stage/${FAKE_STAGE_TOKEN}/`,
      `http://pypi.org/stage/${FAKE_STAGE_TOKEN}/`,
      `https://user:pw@pypi.org/stage/${FAKE_STAGE_TOKEN}/`,
      `https://pypi.org:8443/stage/${FAKE_STAGE_TOKEN}/`,
      `https://pypi.org/stage/?t=${FAKE_STAGE_TOKEN}`,
      `https://pypi.org.evil.example/stage/${FAKE_STAGE_TOKEN}/`,
      `https://files.pythonhosted.org/stage/${FAKE_STAGE_TOKEN}/`,
    ]) {
      expectStageError(
        () => parsePyPiStageReference(reference({ "stage-url": url })),
        "stage_reference_invalid",
        /stage-url must be/,
      );
    }
    expect(parseAllowedStageUrl("https://test.pypi.org/stage/abc/")?.origin).toBe(
      "https://test.pypi.org",
    );
  });

  test("rejects invalid names and versions", () => {
    expectStageError(
      () => parsePyPiStageReference(reference({ name: "../x" })),
      "stage_reference_invalid",
    );
    expectStageError(
      () => parsePyPiStageReference(reference({ version: "1 2" })),
      "stage_reference_invalid",
    );
  });
});

describe("mergeStageReferences", () => {
  test("dedupes identical entries and rejects conflicting ones", () => {
    const first = parsePyPiStageReference(reference());
    expect(
      mergeStageReferences([first, parsePyPiStageReference(reference({ name: "Demo_Package" }))])
        .size,
    ).toBe(1);
    expectStageError(
      () => mergeStageReferences([first, parsePyPiStageReference(reference({ version: "1.3.0" }))]),
      "stage_reference_invalid",
    );
  });
});

describe("stage project pages", () => {
  test("builds the normalized PEP 503 project URL under the stage root", () => {
    expect(stageProjectUrl(new URL("https://pypi.org/stage/t"), "Demo_Package").href).toBe(
      "https://pypi.org/stage/t/demo-package/",
    );
  });

  test("parses PEP 691 JSON with relative file URLs", () => {
    const page = parseStageProjectPage(
      JSON.stringify({
        meta: { "api-version": "1.1" },
        name: "demo-package",
        files: [
          {
            filename: "demo_package-1.2.0.tar.gz",
            url: "../f/demo.tar.gz#x",
            hashes: { sha256: SHA_A.toUpperCase() },
            size: 1234,
          },
        ],
      }),
      "application/vnd.pypi.simple.v1+json",
      new URL("https://pypi.org/stage/t/demo-package/"),
    );
    expect(page.name).toBe("demo-package");
    expect(page.files[0]).toEqual({
      filename: "demo_package-1.2.0.tar.gz",
      sha256: SHA_A,
      url: new URL("https://pypi.org/stage/t/f/demo.tar.gz"),
      size: 1234,
    });
  });

  test("falls back to PEP 503 HTML anchors with sha256 fragments", () => {
    const page = parseStageProjectPage(
      `<html><body><a href="https://files.pythonhosted.org/x/demo_package-1.2.0-py3-none-any.whl#sha256=${SHA_B}" data-requires-python="&gt;=3.9">demo_package-1.2.0-py3-none-any.whl</a></body></html>`,
      "text/html; charset=utf-8",
      new URL("https://pypi.org/stage/t/demo-package/"),
    );
    expect(page.name).toBeNull();
    expect(page.files).toEqual([
      {
        filename: "demo_package-1.2.0-py3-none-any.whl",
        sha256: SHA_B,
        url: new URL("https://files.pythonhosted.org/x/demo_package-1.2.0-py3-none-any.whl"),
        size: null,
      },
    ]);
  });

  test("rejects malformed, unsupported, or hostile pages", () => {
    const pageUrl = new URL("https://pypi.org/stage/t/demo-package/");
    expectStageError(
      () => parseStageProjectPage("{", "application/vnd.pypi.simple.v1+json", pageUrl),
      "stage_unavailable",
    );
    expectStageError(
      () =>
        parseStageProjectPage(
          JSON.stringify({ meta: { "api-version": "2.0" }, files: [] }),
          "application/vnd.pypi.simple.v1+json",
          pageUrl,
        ),
      "stage_unavailable",
    );
    expectStageError(
      () => parseStageProjectPage("[]", "application/json", pageUrl),
      "stage_unavailable",
    );
    expectStageError(
      () => parseStageProjectPage('<a href="x">../../etc/passwd</a>', "text/html", pageUrl),
      "stage_unavailable",
    );
  });
});

describe("selectStagedReleaseFiles", () => {
  const url = new URL("https://files.pythonhosted.org/f");
  test("keeps this version's files and ignores other versions", () => {
    const { files, problems } = selectStagedReleaseFiles(
      {
        name: "demo-package",
        files: [
          { filename: "demo_package-1.2.0-py3-none-any.whl", sha256: SHA_A, url, size: null },
          { filename: "demo_package-1.2.0.tar.gz", sha256: SHA_B, url, size: null },
          { filename: "demo_package-1.1.0.tar.gz", sha256: SHA_B, url, size: null },
        ],
      },
      "Demo.Package",
      "1.2",
    );
    expect(problems).toEqual([]);
    expect(files.map((file) => file.filename)).toEqual([
      "demo_package-1.2.0-py3-none-any.whl",
      "demo_package-1.2.0.tar.gz",
    ]);
  });

  test("flags foreign, unattributable, digestless, and conflicting entries", () => {
    const { problems } = selectStagedReleaseFiles(
      {
        name: "other",
        files: [
          { filename: "evil-1.2.0.tar.gz", sha256: SHA_A, url, size: null },
          { filename: "demo_package-1.2.0.exe", sha256: SHA_A, url, size: null },
          { filename: "demo_package-1.2.0.tar.gz", sha256: null, url, size: null },
          { filename: "demo_package-1.2.0-py3-none-any.whl", sha256: SHA_A, url, size: null },
          { filename: "demo_package-1.2.0-py3-none-any.whl", sha256: SHA_B, url, size: null },
          { filename: "demo_package-1.2.0-py2-none-any.whl", sha256: SHA_A, url: null, size: null },
        ],
      },
      "demo-package",
      "1.2.0",
    );
    expect(problems).toEqual([
      "stage page is for project other, not demo-package",
      "stage lists evil-1.2.0.tar.gz, which belongs to another project",
      "stage lists demo_package-1.2.0.exe, which is not a wheel or sdist of demo-package",
      "stage lists demo_package-1.2.0.tar.gz without a sha256 digest",
      "stage lists demo_package-1.2.0-py3-none-any.whl more than once with different digests",
      "stage lists demo_package-1.2.0-py2-none-any.whl without a download URL",
    ]);
  });

  test("ignores unparseable filenames of other releases on an overlaid page", () => {
    const { files, problems } = selectStagedReleaseFiles(
      {
        name: "demo-package",
        files: [
          { filename: "demo_package-1.2.0-py3-none-any.whl", sha256: SHA_A, url, size: 12 },
          { filename: "demo_package-0.9.0-py2.6.egg", sha256: SHA_B, url, size: null },
          { filename: "demo-package-1.1.win32.exe", sha256: SHA_B, url, size: null },
          { filename: "README.txt", sha256: null, url: null, size: null },
          {
            filename: "Demo.Package-1.2.0-x-y-z-w-py3-none-any.whl",
            sha256: SHA_B,
            url,
            size: null,
          },
        ],
      },
      "demo-package",
      "1.2.0",
    );
    expect(files).toEqual([
      { filename: "demo_package-1.2.0-py3-none-any.whl", sha256: SHA_A, url, size: 12 },
    ]);
    expect(problems).toEqual([
      "stage lists Demo.Package-1.2.0-x-y-z-w-py3-none-any.whl, which is not a wheel or sdist of demo-package",
    ]);
  });

  test("an empty stage is a problem, not a pass", () => {
    expect(selectStagedReleaseFiles({ name: null, files: [] }, "demo", "1.0").problems).toEqual([
      "stage has no files for demo 1.0",
    ]);
  });
});

describe("compareDistributionSets", () => {
  test("requires identical filenames and digests on both sides", () => {
    expect(
      compareDistributionSets("artifact", [{ path: "dist/a-1.0.tar.gz", sha256: SHA_A }], "stage", [
        { path: "a-1.0.tar.gz", sha256: SHA_A.toUpperCase() },
      ]),
    ).toEqual([]);
    expect(
      compareDistributionSets(
        "artifact",
        [
          { path: "dist/a-1.0.tar.gz", sha256: SHA_A },
          { path: "dist/a-1.0-py3-none-any.whl", sha256: SHA_A },
        ],
        "stage",
        [
          { path: "a-1.0.tar.gz", sha256: SHA_B },
          { path: "a-1.0-cp312-cp312-linux_x86_64.whl", sha256: SHA_A },
        ],
      ),
    ).toEqual([
      "a-1.0.tar.gz sha256 differs: artifact aaaaaaaaaaaa…, stage bbbbbbbbbbbb…",
      "a-1.0-py3-none-any.whl is in the artifact but not on the stage",
      "a-1.0-cp312-cp312-linux_x86_64.whl is on the stage but not in the artifact",
    ]);
  });

  test("a basename twice on one side is a problem even when one copy matches", () => {
    expect(
      compareDistributionSets(
        "artifact",
        [
          { path: "a/a-1.0.tar.gz", sha256: SHA_B },
          { path: "b/a-1.0.tar.gz", sha256: SHA_A },
        ],
        "stage",
        [{ path: "a-1.0.tar.gz", sha256: SHA_A }],
      ),
    ).toContain("a-1.0.tar.gz appears more than once in the artifact");
  });

  test("parses wheel and sdist filenames", () => {
    expect(parseDistributionFilename("demo_package-1.2.0-1-py3-none-any.whl")).toEqual({
      name: "demo_package",
      version: "1.2.0",
    });
    expect(parseDistributionFilename("demo_package-1.2.0.tar.gz")).toEqual({
      name: "demo_package",
      version: "1.2.0",
    });
    expect(parseDistributionFilename("demo.whl")).toBeNull();
    expect(parseDistributionFilename("demo-.tar.gz")).toBeNull();
  });
});

describe("stage fetch egress", () => {
  test("follows a same-origin redirect and sends the PEP 691 Accept header", async () => {
    const stage = await buildFakeStage({ project: "demo-package", files: [] });
    let accept: string | null = null;
    stubFetchRoutes({
      "https://pypi.org/stage/redirect/demo-package/": () =>
        new Response(null, {
          status: 301,
          headers: { location: `${stage.stageUrl}demo-package/` },
        }),
      [stage.stageUrl]: (url, init) => {
        accept = new Headers(init?.headers).get("accept");
        return stage.routes[stage.stageUrl](new Request(url));
      },
    });
    const page = await fetchStageProjectPage(
      new URL("https://pypi.org/stage/redirect/"),
      "demo-package",
    );
    expect(page.files).toEqual([]);
    expect(accept).toContain("application/vnd.pypi.simple.v1+json");
  });

  test("refuses redirects off the allowlist and never names the URL", async () => {
    const fetchMock = stubFetchRoutes({
      [STAGE]: () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://evil.example/${FAKE_STAGE_TOKEN}` },
        }),
    });
    await expect(fetchStageProjectPage(new URL(STAGE), "demo-package")).rejects.toMatchObject({
      code: "stage_unavailable",
      message: "stage index page for demo-package redirected off the allowed index origins",
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContainEqual(
      expect.stringContaining("evil.example"),
    );
  });

  test("staged files may only come from the index's own file origins", async () => {
    const fetchMock = stubFetchRoutes({});
    for (const url of [
      "https://evil.example/f.whl",
      "https://test-files.pythonhosted.org/f.whl",
      "http://files.pythonhosted.org/f.whl",
    ]) {
      await expect(
        downloadStagedFile(new URL(url), "https://pypi.org", "f.whl"),
      ).rejects.toMatchObject({
        code: "stage_unavailable",
        message: "staged file f.whl is not on an allowed index origin",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a staged download stops at the caller's remaining byte budget", async () => {
    const fileUrl = "https://files.pythonhosted.org/stage-files/t/f.whl";
    stubFetchRoutes({ [fileUrl]: () => new Response(new Uint8Array(64)) });
    await expect(
      downloadStagedFile(new URL(fileUrl), "https://pypi.org", "f.whl", 32),
    ).rejects.toMatchObject({
      code: "stage_unavailable",
      message: "staged file f.whl is too large, too slow, or could not be read",
    });
    await expect(
      downloadStagedFile(new URL(fileUrl), "https://pypi.org", "f.whl", 64),
    ).resolves.toHaveLength(64);
  });

  test("a staged download whose body stalls is bounded by a total deadline", async () => {
    const fileUrl = "https://files.pythonhosted.org/stage-files/t/f.whl";
    stubFetchRoutes({
      [fileUrl]: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(8));
            },
          }),
        ),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const download = downloadStagedFile(new URL(fileUrl), "https://pypi.org", "f.whl");
      const settled = expect(download).rejects.toMatchObject({
        message: "staged file f.whl is too large, too slow, or could not be read",
      });
      await vi.advanceTimersByTimeAsync(61_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  test("oversized, failing, and unreachable stages are stage_unavailable", async () => {
    stubFetchRoutes({
      [`${STAGE}demo-package/`]: () =>
        new Response("x", {
          headers: {
            "content-type": "application/vnd.pypi.simple.v1+json",
            "content-length": String(MAX_STAGE_PAGE_BYTES + 1),
          },
        }),
      [`${STAGE}missing/`]: () => new Response("nope", { status: 404 }),
      [`${STAGE}down/`]: () => {
        throw new TypeError(`network failure for ${STAGE}`);
      },
    });
    await expect(fetchStageProjectPage(new URL(STAGE), "demo-package")).rejects.toMatchObject({
      code: "stage_unavailable",
      message: "stage index page for demo-package is too large or could not be read",
    });
    await expect(fetchStageProjectPage(new URL(STAGE), "missing")).rejects.toMatchObject({
      message: "stage index page for missing answered HTTP 404",
    });
    const unreachable = fetchStageProjectPage(new URL(STAGE), "down");
    await expect(unreachable).rejects.toMatchObject({
      message: "stage index page for down could not be reached",
    });
    await expect(unreachable).rejects.not.toMatchObject({
      message: expect.stringContaining(FAKE_STAGE_TOKEN),
    });
  });
});
