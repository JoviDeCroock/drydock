// Rebuild sandbox: the disposable Cloudflare container that checks out a
// declared source repository and rebuilds a staged npm package so the Worker
// can compare the result against the staged artifact (`rebuild-attestation.ts`).
//
// This is a *second* isolation ring, separate from the Dynamic Worker parse
// sandbox in `sandbox.ts`, because it deliberately executes hostile code: the
// repository contents, build scripts, and dependency tree are all attacker-
// controlled. Containment, not prevention, is the boundary:
//
//  - Zero credentials ever enter the container. Public repos clone
//    anonymously; the npm staged token stays in the Worker (the staged tarball
//    is unpublished, so the container *cannot* fetch the expected bytes and
//    replay them — the classic self-fetch bypass of post-publish rebuilders).
//  - Egress is deny-by-default: `allowedHosts` covers the supported source
//    forges and the public npm registry (dependency install), nothing else.
//    `interceptHttps` keeps the filter authoritative for TLS traffic too.
//  - Every command is built Worker-side from validated plan fields and
//    shell-quoted; container stdout/stderr is bounded and re-validated by the
//    caller before anything is persisted.
//  - The container is destroyed after a single attestation. Sandbox ids are
//    scan-scoped, so nothing is shared across scans or organizations.

import { Sandbox } from "@cloudflare/sandbox";
import type { RebuildPlan } from "./rebuild-attestation";
import { runRebuildSteps, type RebuildExecution } from "./rebuild-steps";

export class RebuildSandbox extends Sandbox<Cloudflare.Env> {
  // Deny-by-default egress: with `allowedHosts` set and internet disabled,
  // only these hosts resolve from inside the container.
  enableInternet = false;
  interceptHttps = true;
  allowedHosts = [
    // Source forges the intent envelope can normalize to.
    "github.com",
    "codeload.github.com",
    "gitlab.com",
    "bitbucket.org",
    // Dependency install + corepack package-manager downloads.
    "registry.npmjs.org",
  ];
  // Attestations are single-shot; reclaim the container quickly if the Worker
  // dies between exec calls instead of paying for an idle instance.
  sleepAfter = "10m";
}

/**
 * Run one rebuild attempt in a disposable container. Never throws for
 * build-shaped failures — those come back as `{ ok: false }` with step
 * records; only infrastructure faults (container never became reachable)
 * propagate so the caller can classify them separately.
 */
export async function runRebuildInSandbox(
  namespace: DurableObjectNamespace<RebuildSandbox>,
  scanId: string,
  plan: RebuildPlan,
): Promise<RebuildExecution> {
  const { getSandbox } = await import("@cloudflare/sandbox");
  const sandbox = getSandbox(namespace, `rebuild-${scanId}`);
  try {
    return await runRebuildSteps(sandbox, plan);
  } finally {
    // Best-effort teardown; the container is unusable for other scans anyway
    // (id is scan-scoped) and `sleepAfter` reclaims it if this call is lost.
    await sandbox.destroy().catch(() => {});
  }
}
