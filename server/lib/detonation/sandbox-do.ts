import { DurableObject } from "cloudflare:workers";
import { readBoundedText } from "../platform/bounded-body";
import { generateCanaries, type CanarySet } from "./canaries";
import { isRegistryWrite, type DetonationEgressProps } from "./egress";
import { encodePyPiPrepareBundle } from "./pypi";
import {
  DETONATION_HARNESS_VERSION,
  type DetonationEcosystem,
  type PyPiDetonationFile,
  type DetonationEgressEvent,
  type DetonationErrorCode,
  type DetonationPhase,
  type HarnessDetonateRequest,
} from "./types";

const HARNESS_PORT = 8080;
const HARNESS_ORIGIN = "http://harness.drydock.internal";
const STARTUP_TIMEOUT_MS = 60_000;
const PREPARE_TIMEOUT_MS = 150_000;
const STEP_TIMEOUT_MS = 30_000;
const DETONATE_TIMEOUT_MS = 180_000;
/** Slack between the harness's own budget and ours, so its report usually arrives first. */
const HARNESS_RESPONSE_GRACE_MS = 30_000;
/** Bounds what a hostile-influenced harness response can cost the parent. */
const MAX_HARNESS_RESPONSE_BYTES = 4 * 1024 * 1024;
/**
 * Recorded egress per bucket. The buckets are separate so a package cannot
 * spend the detonation record during prepare (a manifest full of URL
 * dependencies) or bury a canary behind junk requests: events that carry a
 * canary or write to a registry are kept in their own bucket.
 */
const MAX_PREPARE_EGRESS = 50;
const MAX_DETONATE_EGRESS = 200;
const MAX_PRIORITY_EGRESS = 100;
/** The harness writes its report in one go once headers are out. */
const HARNESS_BODY_DEADLINE_MS = 30_000;

export interface DetonationRunOutput {
  /** Raw harness JSON text. Hostile-influenced; the caller must run it through `parseHarnessReport`. */
  reportJson: string | null;
  prepareJson: string | null;
  egress: DetonationEgressEvent[];
  /** Registry reads forwarded during prepare. Counted, not recorded: they are npm resolving dependencies. */
  forwardedRegistryReads: number;
  egressTruncated: boolean;
  /** This run's fake credentials, so the caller can redact them from evidence. */
  canaryValues: CanarySet["values"];
  errorCode: DetonationErrorCode | null;
}

interface EgressFactory {
  DetonationEgress(options: { props: DetonationEgressProps }): Fetcher;
}

class DetonationRunError extends Error {
  constructor(readonly code: DetonationErrorCode) {
    super(code);
  }
}

async function readHarnessText(response: Response): Promise<string> {
  const text = await readBoundedText(response, {
    maxBytes: MAX_HARNESS_RESPONSE_BYTES,
    deadlineMs: Date.now() + HARNESS_BODY_DEADLINE_MS,
  });
  if (text === null) throw new DetonationRunError("harness_report_invalid");
  return text;
}

/**
 * One container per run, addressed by a fresh name, so no state (planted
 * canaries, a backgrounded payload, a poisoned npm cache) carries from one
 * package's detonation into another's.
 *
 * This object is trusted Worker code. The container it drives is not: it runs
 * the package's install scripts and entry points with `enableInternet: false`,
 * and its only way out is HTTP(S) through `DetonationEgress`.
 */
export class DetonationSandbox extends DurableObject<Cloudflare.Env> {
  // Fail closed: an object that lost its state while a container is still
  // alive must never fall back to the forwarding policy.
  private phase: DetonationPhase = "detonate";
  private priorityEgress: DetonationEgressEvent[] = [];
  private prepareEgress: DetonationEgressEvent[] = [];
  private detonateEgress: DetonationEgressEvent[] = [];
  private forwardedRegistryReads = 0;
  private egressTruncated = false;

  async currentPhase(): Promise<DetonationPhase> {
    return this.phase;
  }

  async recordEgress(event: DetonationEgressEvent): Promise<void> {
    if (event.action === "forwarded") {
      this.forwardedRegistryReads += 1;
      return;
    }
    const [bucket, cap] =
      event.canaryHits.length > 0 || isRegistryWrite(event)
        ? [this.priorityEgress, MAX_PRIORITY_EGRESS]
        : event.phase === "prepare"
          ? [this.prepareEgress, MAX_PREPARE_EGRESS]
          : [this.detonateEgress, MAX_DETONATE_EGRESS];
    if (bucket.length >= cap) {
      this.egressTruncated = true;
      return;
    }
    bucket.push(event);
  }

  /** Runs one reviewed npm tarball. */
  async detonate(tarball: ArrayBuffer): Promise<DetonationRunOutput> {
    return this.run("npm", { path: "/prepare", body: tarball });
  }

  /** Runs one reviewed PyPI wheel and/or sdist, bound to the scan's digests by the caller. */
  async detonatePyPi(files: PyPiDetonationFile[]): Promise<DetonationRunOutput> {
    return this.run("pypi", { path: "/prepare-pypi", body: encodePyPiPrepareBundle(files) });
  }

  private async run(
    ecosystem: DetonationEcosystem,
    prepare: { path: string; body: ArrayBuffer | Uint8Array<ArrayBuffer> },
  ): Promise<DetonationRunOutput> {
    const container = this.ctx.container;
    const canaries = generateCanaries();
    const output: DetonationRunOutput = {
      reportJson: null,
      prepareJson: null,
      egress: [],
      forwardedRegistryReads: 0,
      egressTruncated: false,
      canaryValues: canaries.values,
      errorCode: null,
    };
    if (!container) return { ...output, errorCode: "container_unavailable" };

    this.phase = "prepare";
    this.priorityEgress = [];
    this.prepareEgress = [];
    this.detonateEgress = [];
    this.forwardedRegistryReads = 0;
    this.egressTruncated = false;

    try {
      if (container.running) await container.destroy();
      const egressProps: DetonationEgressProps = {
        sandboxId: this.ctx.id.toString(),
        canaries: canaries.values,
        ecosystem,
      };
      const egress = (this.ctx.exports as unknown as EgressFactory).DetonationEgress({
        props: egressProps,
      });
      // Interception must be in place before the harness can be asked to do
      // anything; a container that cannot be fenced is never used.
      try {
        container.start({ enableInternet: false });
        await container.interceptAllOutboundHttp(egress);
        await container.interceptOutboundHttps("*", egress);
      } catch {
        throw new DetonationRunError("container_unavailable");
      }

      const harness = container.getTcpPort(HARNESS_PORT);
      await waitForHarness(harness);

      const prepared = await harness.fetch(`${HARNESS_ORIGIN}${prepare.path}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: prepare.body,
        signal: AbortSignal.timeout(PREPARE_TIMEOUT_MS),
      });
      if (!prepared.ok) throw new DetonationRunError("harness_failed");
      output.prepareJson = await readHarnessText(prepared);

      // Flip before the request so no detonation-phase request can be
      // evaluated under the prepare policy.
      this.phase = "detonate";
      const request: HarnessDetonateRequest = {
        version: DETONATION_HARNESS_VERSION,
        canaryEnv: canaries.env,
        canaryFiles: canaries.files,
        stepTimeoutMs: STEP_TIMEOUT_MS,
        totalTimeoutMs: DETONATE_TIMEOUT_MS,
      };
      const detonated = await harness.fetch(`${HARNESS_ORIGIN}/detonate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(DETONATE_TIMEOUT_MS + HARNESS_RESPONSE_GRACE_MS),
      });
      if (!detonated.ok) throw new DetonationRunError("harness_failed");
      output.reportJson = await readHarnessText(detonated);
    } catch (err) {
      output.errorCode =
        err instanceof DetonationRunError
          ? err.code
          : err instanceof DOMException && err.name === "TimeoutError"
            ? "timeout"
            : "harness_failed";
    } finally {
      // Egress recorded so far is kept even when the run failed: a payload
      // that crashed the harness may already have tried to send something.
      output.egress = [...this.priorityEgress, ...this.prepareEgress, ...this.detonateEgress];
      output.forwardedRegistryReads = this.forwardedRegistryReads;
      output.egressTruncated = this.egressTruncated;
      if (container.running) await container.destroy().catch(() => {});
    }
    return output;
  }
}

async function waitForHarness(harness: Fetcher): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await harness.fetch(`${HARNESS_ORIGIN}/health`);
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // The container is still booting; the port refuses until the harness listens.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new DetonationRunError("container_unavailable");
}
