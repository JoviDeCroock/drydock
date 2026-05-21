import { Hono } from "hono";
import { analyzeWithAi } from "../lib/ai-review";
import { createDb, persistScan } from "../db";
import { fetchPackageMetadata, pickPreviousVersion } from "../lib/registry";
import {
  computeRisk,
  createPackageDiff,
  deterministicFindings,
  summarizePackageJsonDiff,
  type PackageJsonSummary,
} from "../lib/review";
import { downloadInSandbox, SandboxError } from "../lib/sandbox";
import type { Bindings, ScanInput, ScanResult, Variables } from "../types";

const STAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,160}$/;

export const scanRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

scanRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<ScanInput>;
  const input: ScanInput = {
    stageId: String(body.stageId || ""),
    maxFiles: body.maxFiles,
    maxBytesPerFile: body.maxBytesPerFile,
  };
  if (!STAGE_ID_RE.test(input.stageId)) {
    return c.json({ error: "invalid stageId" }, 400);
  }

  try {
    const staged = await downloadInSandbox(c.env, c.executionCtx, {
      stageId: input.stageId,
      maxFiles: input.maxFiles,
      maxBytesPerFile: input.maxBytesPerFile,
    });

    const previous = await maybeDownloadPreviousVersion(c.env, c.executionCtx, staged.packageJson ?? null, input);
    const diff = previous
      ? createPackageDiff(previous.files, staged.files)
      : createPackageDiff([], staged.files);
    const packageJsonDiff = summarizePackageJsonDiff(previous?.packageJson, staged.packageJson);
    const ruleFindings = deterministicFindings(staged.files, diff);
    const aiFindings = await analyzeWithAi(c.env, staged.files, diff, packageJsonDiff, ruleFindings);
    const risk = computeRisk(ruleFindings);
    const scanId = crypto.randomUUID();

    const result: ScanResult = {
      id: scanId,
      stageId: input.stageId,
      package: {
        name: staged.packageJson?.name ?? null,
        stagedVersion: staged.packageJson?.version ?? null,
        previousVersion: previous?.packageJson?.version ?? null,
      },
      fileCount: staged.files.length,
      previousFileCount: previous?.files.length ?? 0,
      packageJson: staged.packageJson ?? null,
      packageJsonDiff,
      diff,
      ruleFindings,
      aiFindings,
      risk,
      safety: {
        tokenExposedToSandbox: false,
        directSandboxNetwork: false,
        outboundPolicy: "only npm staged tarball, published tarball, and package metadata endpoints via gateway",
        aiInputPolicy: "package bytes are untrusted evidence, not instructions; JSON schema output only",
        fileExplorerPolicy: "package file previews are escaped text; no package-provided HTML/script/image execution",
      },
    };

    if (c.env.DB) {
      await persistScan(createDb(c.env.DB), {
        id: scanId,
        stageId: input.stageId,
        packageJson: staged.packageJson,
        previousPackageJson: previous?.packageJson,
        risk,
        status: "complete",
        summary: { packageJsonDiff, diff, safety: result.safety },
        ai: aiFindings,
        files: staged.files,
        diff,
        findings: ruleFindings,
      });
    }

    return c.json(result);
  } catch (err) {
    if (err instanceof SandboxError) {
      return c.json({ error: "sandbox download failed", detail: err.detail }, 502);
    }
    throw err;
  }
});

async function maybeDownloadPreviousVersion(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  pkg: PackageJsonSummary | null,
  input: ScanInput,
) {
  if (!pkg?.name || !pkg.version) return null;
  const metadata = await fetchPackageMetadata(env, pkg.name).catch(() => null);
  if (!metadata) return null;
  const version = pickPreviousVersion(metadata, pkg.version);
  const tarballUrl = version ? metadata.versions?.[version]?.dist?.tarball : null;
  if (!version || !tarballUrl) return null;
  return downloadInSandbox(env, ctx, {
    tarballUrl,
    maxFiles: input.maxFiles,
    maxBytesPerFile: input.maxBytesPerFile,
  });
}
