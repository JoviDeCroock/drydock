import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { generateKeyPairSync } from "node:crypto";
import { vi } from "vitest";
import { createDb } from "../../../server/db/client";
import * as schema from "../../../server/db/schema";
import type { GithubAppEnv } from "../../../server/lib/github-app/config";
import { getGateForOrganization } from "../../../server/lib/github-app/webhook-gates";
import { executeWorkflowGateJob } from "../../../server/lib/workflow-gate-job";
import { buildZip } from "../../helpers/archive-fixtures";
import { type FakeStageFile, buildFakeStage, stageReference } from "../../helpers/pep694-fake";
import { buildCtxWithGateway, buildLoaderMock, stubGithubFetch } from "./gate";
import { type SeededUser, seedUser, seedWorkflowGate } from "./seed";

// Shared driver for the PEP 694 PyPI gate suites: a seeded PyPI gate, a fake
// stage, a GitHub artifact carrying `pypi-stage.json`, and a mocked sandbox.

export const WHEEL = "demo_package-1.2.0-py3-none-any.whl";
export const SDIST = "demo_package-1.2.0.tar.gz";

export const stagedBytes = (name: string) => new TextEncoder().encode(`staged bytes of ${name}`);

let cachedPrivateKey: string | null = null;

export function githubAppBindings(): GithubAppEnv {
  cachedPrivateKey ??= generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();
  return {
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "drydock-test",
    GITHUB_APP_CLIENT_ID: "client-id",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_PRIVATE_KEY: cachedPrivateKey,
    GITHUB_APP_WEBHOOK_SECRET: "webhook-secret-value-1234567890",
    GITHUB_APP_STATE_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_SECRET: "fallback-secret-with-enough-entropy-aaaaaaaa",
  };
}

// The sandbox is mocked: every parse answers with demo-package's metadata,
// so identity comes from here, not from the opaque fixture bytes.
function pypiLoader(metadataVersion = "1.2.0") {
  const metadata = `Metadata-Version: 2.3\nName: demo-package\nVersion: ${metadataVersion}\n`;
  return buildLoaderMock({
    respond: (request) =>
      request.headers.get("x-archive-format") === "tgz"
        ? Response.json({
            files: [
              {
                path: "demo_package-1.2.0/PKG-INFO",
                size: 40,
                sha256: "03",
                flags: [],
                textSample: metadata,
              },
            ],
            packageJson: null,
          })
        : Response.json({
            files: [
              {
                path: "demo_package-1.2.0.dist-info/METADATA",
                size: 40,
                sha256: "00",
                flags: [],
                textSample: metadata,
              },
              {
                path: "demo_package-1.2.0.dist-info/WHEEL",
                size: 60,
                sha256: "02",
                flags: [],
                textSample: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
              },
              {
                path: "demo_package-1.2.0.dist-info/RECORD",
                size: 10,
                sha256: "01",
                flags: [],
                textSample: "demo_package-1.2.0.dist-info/METADATA,,\n",
              },
            ],
            packageJson: null,
          }),
  });
}

export interface PyPiStageScenario {
  stageFiles?: FakeStageFile[];
  /** Distributions also uploaded in the gate artifact (path → bytes). */
  artifactFiles?: Record<string, Uint8Array>;
  /** Raw `pypi-stage.json`; defaults to a reference to the fake stage. */
  reference?: (stageUrl: string) => string | null;
  page?: () => Response | Promise<Response>;
  file?: (filename: string) => Response | Promise<Response> | null;
  format?: "json" | "html";
  metadataVersion?: string;
  /** Runs after the owner is seeded and before the gate job. */
  beforeRun?: (owner: SeededUser) => Promise<void>;
  /** Extra fetch routes (e.g. a fake Upload 2.0 server), matched before GitHub's. */
  routes?: Record<string, (request: Request) => Response | Promise<Response>>;
}

export async function runPyPiStageGate(options: PyPiStageScenario = {}) {
  const owner = await seedUser();
  const gateId = await seedWorkflowGate(owner, { ecosystem: "pypi", decision: null });
  await options.beforeRun?.(owner);
  const stage = await buildFakeStage({
    project: "demo-package",
    files: options.stageFiles ?? [
      { filename: WHEEL, bytes: stagedBytes(WHEEL) },
      { filename: SDIST, bytes: stagedBytes(SDIST) },
    ],
    page: options.page,
    file: options.file,
    format: options.format,
  });
  const reference = options.reference
    ? options.reference(stage.stageUrl)
    : stageReference([{ name: "demo-package", version: "1.2.0", stageUrl: stage.stageUrl }]);
  const zipEntries = Object.entries(options.artifactFiles ?? {}).map(([path, body]) => ({
    path,
    body,
  }));
  if (reference !== null)
    zipEntries.push({ path: "dist/pypi-stage.json", body: new TextEncoder().encode(reference) });

  const decisions: Array<{ state: string; comment: string }> = [];
  const calls = stubGithubFetch({
    installationToken: true,
    artifacts: [{ id: 4242, name: "pypi-release-candidate", bundleZip: buildZip(zipEntries) }],
    routes: {
      ...options.routes,
      "/deployment_protection_rule": async (request) => {
        decisions.push((await request.json()) as { state: string; comment: string });
        return new Response(null, { status: 204 });
      },
      ...stage.routes,
    },
  });
  const logs: string[] = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    });
  }

  const loader = pypiLoader(options.metadataVersion);
  const db = createDb(env.DB);
  const gateEnv = {
    ...env,
    ...githubAppBindings(),
    LOADER: loader.binding as unknown as WorkerLoader,
  } as Cloudflare.Env;
  await executeWorkflowGateJob(
    gateEnv,
    buildCtxWithGateway(),
    { kind: "workflow_gate", organizationId: owner.organizationId, gateId },
    db,
  );
  const gate = await getGateForOrganization(db, owner.organizationId, gateId);
  const readEvents = () =>
    db
      .select({ type: schema.scanEvents.type, metadataJson: schema.scanEvents.metadataJson })
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.organizationId, owner.organizationId));
  const events = await readEvents();
  return {
    owner,
    gateId,
    gate,
    gateEnv,
    decisions,
    calls,
    logs,
    loader,
    stage,
    events,
    readEvents,
    db,
  };
}

export type PyPiStageGateRun = Awaited<ReturnType<typeof runPyPiStageGate>>;
