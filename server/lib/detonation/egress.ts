import { WorkerEntrypoint } from "cloudflare:workers";
import {
  canaryNeedles,
  findCanaryKinds,
  redactCanaries,
  type CanaryNeedle,
  type CanarySet,
} from "./canaries";
import type {
  CanaryKind,
  DetonationEcosystem,
  DetonationEgressEvent,
  DetonationPhase,
} from "./types";

/**
 * The only registry origin an npm prepare phase may reach. Dependencies
 * resolve anonymously from the public registry; the organization's npm token
 * never enters this path (staged bytes arrive through `NpmStageGateway` before
 * the container starts).
 */
const DETONATION_REGISTRY_ORIGIN = "https://registry.npmjs.org";

/**
 * What a PyPI prepare phase may read: the simple index and the file host pip
 * downloads wheels from, by origin and path prefix. The release's own bytes
 * arrive from the gate's GitHub artifact before the container starts, so no
 * GitHub or PyPI credential is ever on this path.
 */
const PYPI_PREPARE_READS: ReadonlyArray<{ origin: string; pathPrefix: string }> = [
  { origin: "https://pypi.org", pathPrefix: "/simple/" },
  { origin: "https://files.pythonhosted.org", pathPrefix: "/packages/" },
];

/**
 * How much of a request body the canary scan reads. Scanned as a stream with
 * an overlap, so a token cannot hide behind padding below this; a body past
 * it is recorded as such.
 */
const EGRESS_BODY_SCAN_BYTES = 32 * 1024 * 1024;

const MAX_RECORDED_PATH_CHARS = 256;

export type DetonationEgressAction = "forward" | "sinkhole";

/**
 * Prepare installs with scripts disabled (npm `--ignore-scripts`; pip with
 * binary wheels only), so no package code is running yet and anonymous
 * registry reads for the run's own ecosystem are the only traffic expected.
 * Once detonation starts, nothing leaves: every request is recorded and
 * answered locally, including ones to the registry (a second-stage download
 * from npm or PyPI is still a second-stage download).
 */
export function evaluateDetonationEgress(
  phase: DetonationPhase,
  method: string,
  url: string,
  ecosystem: DetonationEcosystem = "npm",
): DetonationEgressAction {
  if (phase !== "prepare") return "sinkhole";
  const normalized = method.toUpperCase();
  if (normalized !== "GET" && normalized !== "HEAD") return "sinkhole";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "sinkhole";
  }
  if (ecosystem === "pypi") {
    return PYPI_PREPARE_READS.some(
      ({ origin, pathPrefix }) =>
        parsed.origin === origin && parsed.pathname.startsWith(pathPrefix),
    )
      ? "forward"
      : "sinkhole";
  }
  return parsed.origin === DETONATION_REGISTRY_ORIGIN ? "forward" : "sinkhole";
}

// npm only needs content negotiation to resolve and download; everything else
// (session ids, a stray `authorization`) stays inside the container.
const FORWARDED_HEADERS = ["accept", "accept-encoding", "user-agent", "if-none-match"];

export interface DetonationEgressProps {
  /** `DurableObjectId.toString()` of the `DetonationSandbox` that owns this container. */
  sandboxId: string;
  canaries: CanarySet["values"];
  /** Selects the prepare-phase registry reads; absent means npm. */
  ecosystem?: DetonationEcosystem;
}

interface BodyScan {
  hits: Set<CanaryKind>;
  bytes: number;
}

async function scanBody(request: Request, needles: readonly CanaryNeedle[]): Promise<BodyScan> {
  const scan: BodyScan = { hits: new Set(), bytes: 0 };
  if (!request.body) return scan;
  let body: ReadableStream<Uint8Array> = request.body;
  const encoding = request.headers.get("content-encoding")?.toLowerCase();
  if (encoding === "gzip" || encoding === "deflate") {
    body = body.pipeThrough(
      new DecompressionStream(encoding) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
    );
  }
  // Keep enough of the previous chunk that a needle split across a chunk
  // boundary is still seen whole.
  const overlap = needles.reduce((max, { needle }) => Math.max(max, needle.length), 0);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const reader = body.getReader();
  let tail = "";
  try {
    while (scan.bytes < EGRESS_BODY_SCAN_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      scan.bytes += value.byteLength;
      const window = tail + decoder.decode(value, { stream: true });
      for (const kind of findCanaryKinds(window, needles)) scan.hits.add(kind);
      tail = window.slice(-overlap);
    }
  } catch {
    // A corrupt compressed body is still an exfiltration attempt; keep what decoded.
  } finally {
    await reader.cancel().catch(() => {});
  }
  return scan;
}

/**
 * The host as recorded: canary values redacted in place, or, when a token was
 * only found across label boundaries, everything left of the registrable
 * domain replaced so no fragment of it is persisted.
 */
function recordedHost(hostname: string, hits: CanaryKind[], needles: readonly CanaryNeedle[]) {
  if (hits.length === 0) return hostname.slice(0, 253);
  // Partial redaction could leave the fragments of a second canary split across
  // labels, so a carrying host keeps only its registrable suffix.
  const registrable = redactCanaries(hostname.split(".").slice(-2).join("."), needles);
  return `[canary:${hits.join(",")}].${registrable}`.slice(0, 253);
}

/** A write to a package registry: publishing, unpublishing, or changing owners or tokens. */
export function isRegistryWrite(event: Pick<DetonationEgressEvent, "host" | "method">): boolean {
  // `registry.npmjs.org.` (fully qualified) reaches the same registry.
  const host = event.host.replace(/\.$/, "");
  return REGISTRY_HOSTS.has(host) && event.method !== "GET" && event.method !== "HEAD";
}

const REGISTRY_HOSTS = new Set([
  new URL(DETONATION_REGISTRY_ORIGIN).hostname,
  "registry.yarnpkg.com",
  // twine uploads to `upload.pypi.org/legacy/`; token and project management
  // live on `pypi.org` itself.
  "upload.pypi.org",
  "pypi.org",
  "test.pypi.org",
]);

/**
 * Every HTTP(S) request the detonation container makes lands here (the
 * container starts with `enableInternet: false` and all HTTP plus HTTPS is
 * intercepted, with Cloudflare terminating TLS on a per-instance CA). It runs
 * outside the container, so package code cannot hide what it sent.
 */
export class DetonationEgress extends WorkerEntrypoint<Cloudflare.Env, DetonationEgressProps> {
  async fetch(request: Request): Promise<Response> {
    const { sandboxId, canaries, ecosystem } = this.ctx.props;
    const namespace = this.env.DETONATION_SANDBOX;
    if (!namespace) return new Response("detonation egress unavailable", { status: 503 });
    const sandbox = namespace.get(namespace.idFromString(sandboxId));
    const phase = await sandbox.currentPhase();
    const action = evaluateDetonationEgress(phase, request.method, request.url, ecosystem);

    const needles = canaryNeedles(canaries);
    // Hostnames arrive lowercased, so a token smuggled in a subdomain is
    // matched case-insensitively there.
    const hostNeedles = needles.map(({ kind, needle }) => ({ kind, needle: needle.toLowerCase() }));
    const url = new URL(request.url);
    // DNS labels cap at 63 characters, so an encoded token is split across
    // several; match the hostname with its dots removed as well.
    const hostHits = findCanaryKinds(
      `${url.hostname}\n${url.hostname.replaceAll(".", "")}`,
      hostNeedles,
    );
    const headerText = Array.from(request.headers, ([name, value]) => `${name}: ${value}`).join(
      "\n",
    );
    const body =
      action === "forward"
        ? { hits: new Set<CanaryKind>(), bytes: 0 }
        : await scanBody(request, needles);
    const canaryHits = new Set([
      ...findCanaryKinds(`${request.url}\n${headerText}`, needles),
      ...hostHits,
      ...body.hits,
    ]);
    const event: DetonationEgressEvent = {
      phase,
      method: request.method.toUpperCase().slice(0, 16),
      host: recordedHost(url.hostname, hostHits, hostNeedles),
      path: redactCanaries(`${url.pathname}${url.search}`, needles).slice(
        0,
        MAX_RECORDED_PATH_CHARS,
      ),
      bodyBytes: body.bytes,
      canaryHits: Array.from(canaryHits),
      action: action === "forward" ? "forwarded" : "sinkholed",
    };
    // Recording is part of the boundary: an event that cannot be recorded
    // must not be forwarded either.
    await sandbox.recordEgress(event);

    if (action === "sinkhole") {
      // A plausible success keeps a stealer on its normal path, so later
      // stages (a second download, a follow-up POST) show up too.
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }

    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    return fetch(request.url, { method: request.method, headers, redirect: "manual" });
  }
}
