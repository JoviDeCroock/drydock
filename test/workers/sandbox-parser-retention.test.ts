import { describe, expect, test } from "vitest";
import { sandboxSource, SANDBOX_MAX_ENTRIES, SANDBOX_MAX_FILES } from "../../server/lib/sandbox";
// @ts-expect-error -- plain-JS fixture writer shared with the parser suites
import { buildTar } from "../helpers/archive-fixtures.mjs";

// Executes the *rendered* sandbox module, the same string the Worker loader is
// handed in production. The parser functions are unit-tested directly in
// test/tar-parser.test.mjs; what only exists here is the wiring from the
// sandbox `env` caps into the readers.
interface SandboxModule {
  fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
}

function loadRenderedSandbox(): SandboxModule {
  // `export default {…}` → `return {…}`. The trailing `json()` helper is a
  // function declaration, so it hoists above the return.
  const source = sandboxSource().replace("export default", "return");
  return new Function(source)() as SandboxModule;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const compressed = new Response(
    new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new CompressionStream("gzip")),
  );
  return new Uint8Array(await compressed.arrayBuffer());
}

const BASE_ENV = {
  NPM_REGISTRY: "https://registry.npmjs.org",
  ARCHIVE_FORMAT: "tgz",
  MAX_FILES: SANDBOX_MAX_FILES,
  MAX_ENTRIES: SANDBOX_MAX_ENTRIES,
  MAX_TAR_BYTES: 25 * 1024 * 1024,
  MAX_STREAM_TAR_BYTES: 250 * 1024 * 1024,
};

interface SandboxFile {
  path: string;
  size: number;
  sha256: string;
  flags: string[];
  textSample?: string;
}

async function parseTgz(
  entries: Array<{ name: string; body: string }>,
  env: Record<string, unknown> = {},
): Promise<{ files: SandboxFile[]; packageJson: { name?: string; version?: string } | null }> {
  const tar = buildTar(entries) as { buffer: Uint8Array };
  const body = await gzip(tar.buffer);
  const sandbox = loadRenderedSandbox();
  const res = await sandbox.fetch(
    new Request("https://sandbox.local/download", {
      method: "POST",
      body: body as unknown as BodyInit,
      headers: { "content-type": "application/octet-stream", "x-archive-format": "tgz" },
    }),
    { ...BASE_ENV, ...env },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    files: SandboxFile[];
    packageJson: { name?: string; version?: string } | null;
  };
}

const MANIFEST = JSON.stringify({ name: "pkg", version: "1.0.0" });

describe("rendered sandbox module: per-file sample retention", () => {
  const bigBody = `${"// pad\n".repeat(2_000)}eval(process.env.SECRET);\n`;

  test("ships whole bodies when no cap is set (the staged/reviewed parse)", async () => {
    const parsed = await parseTgz([
      { name: "package/package.json", body: MANIFEST },
      { name: "package/index.js", body: bigBody },
    ]);

    const index = parsed.files.find((file) => file.path === "index.js");
    expect(index?.textSample).toBe(bigBody);
    expect(index?.flags).not.toContain("truncated");
    // Detection must be able to see a payload buried past any fixed window.
    expect(index?.textSample).toContain("eval(process.env.SECRET)");
    expect(parsed.packageJson).toMatchObject({ name: "pkg", version: "1.0.0" });
  });

  test("clips per-file samples on the wire when MAX_TEXT_SAMPLE_CHARS is set", async () => {
    const uncapped = await parseTgz([
      { name: "package/package.json", body: MANIFEST },
      { name: "package/index.js", body: bigBody },
    ]);
    const capped = await parseTgz(
      [
        { name: "package/package.json", body: MANIFEST },
        { name: "package/index.js", body: bigBody },
      ],
      { MAX_TEXT_SAMPLE_CHARS: 1024 },
    );

    const cappedIndex = capped.files.find((file) => file.path === "index.js");
    const uncappedIndex = uncapped.files.find((file) => file.path === "index.js");
    expect(cappedIndex?.textSample?.length ?? 0).toBeLessThanOrEqual(1024);
    expect(cappedIndex?.flags).toContain("truncated");
    // Identity is still computed over every byte, so the diff can still prove
    // whether the file changed against the other side.
    expect(cappedIndex?.sha256).toBe(uncappedIndex?.sha256);
    expect(cappedIndex?.size).toBe(uncappedIndex?.size);
    // The whole point: the wire payload shrinks.
    expect(JSON.stringify(capped.files).length).toBeLessThan(
      JSON.stringify(uncapped.files).length / 4,
    );
  });

  test("keeps the manifest whole under a cap so package identity survives", async () => {
    const manifest = JSON.stringify({
      name: "pkg",
      version: "1.0.0",
      description: "d".repeat(4_000),
    });

    const parsed = await parseTgz([{ name: "package/package.json", body: manifest }], {
      MAX_TEXT_SAMPLE_CHARS: 512,
    });

    const packageJson = parsed.files.find((file) => file.path === "package.json");
    expect(packageJson?.textSample).toBe(manifest);
    expect(packageJson?.flags).not.toContain("truncated");
    expect(parsed.packageJson).toMatchObject({ name: "pkg", version: "1.0.0" });
  });

  test("no credential material is reachable from the sandbox env", async () => {
    // The sandbox's own env only carries caps and the registry URL; npm auth
    // lives in the gateway's props, never here.
    expect(Object.keys(BASE_ENV).join(",").toLowerCase()).not.toContain("token");
    const parsed = await parseTgz([{ name: "package/package.json", body: MANIFEST }]);
    expect(JSON.stringify(parsed)).not.toContain("npm_");
  });
});
