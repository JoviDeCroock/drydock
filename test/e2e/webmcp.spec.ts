import { expect, test, type Page, type Request } from "@playwright/test";
import { summarizePackageJsonDiff } from "../../server/lib/review/serialize";

interface ToolResult {
  isError?: boolean;
  structuredContent: Record<string, unknown>;
}
interface Harness {
  names(): string[];
  abortedRegistrations: number;
  call(name: string, input: Record<string, unknown>): Promise<ToolResult>;
  start(id: string, name: string, input: Record<string, unknown>): void;
  result(id: string): Promise<ToolResult>;
  abort(id: string): void;
}
type TestWindow = Window & { __webmcp: Harness };

const canonicalPackage = "@agent/review";
const pairArgs = (to = "2.0.0", name = canonicalPackage) => ({
  ecosystem: "npm",
  package: name,
  from: "1.0.0",
  to,
});

function pairResponse(url: URL) {
  return {
    ecosystem: "npm",
    packageName: canonicalPackage,
    fromVersion: url.searchParams.get("from"),
    toVersion: url.searchParams.get("to"),
    fromPackageJson: null,
    toPackageJson: null,
    diff: [
      { path: "alpha.js", status: "modified", flags: ["truncated"] },
      { path: "slow.js", status: "added", flags: [] },
      { path: "manual.js", status: "added", flags: [] },
      { path: "hidden.js", status: "unchanged", flags: ["truncated"] },
      { path: "native.bin", status: "added", flags: ["binary", "content-skipped"] },
    ],
    packageJsonDiff: summarizePackageJsonDiff(null, null),
    findings: [
      {
        severity: "high",
        ruleId: "code.dynamic-execution",
        file: "alpha.js",
        line: 1,
        reason: "A new dynamic execution capability",
        evidence: "quoted evidence",
        diffStatus: "modified",
        releaseDelta: true,
      },
      {
        severity: "medium",
        ruleId: "code.process-execution",
        file: "alpha.js",
        reason: "Existing process execution context",
        evidence: "prior quoted evidence",
        diffStatus: "modified",
        releaseDelta: false,
      },
    ],
    risk: {
      artifactRisk: "high",
      releaseRisk: "high",
      contextRisk: "medium",
      releaseFindingCount: 1,
      contextFindingCount: 1,
      unknownFindingCount: 0,
      priorApprovedContextFindingCount: 0,
    },
    notices: ["Some package text samples were omitted from cached evidence."],
    textSamplesOmitted: true,
    provenance: [],
    attestation: null,
    displayName: null,
    cachedAt: "2026-10-15T12:00:00.000Z",
  };
}

function fileResponse(path: string) {
  const record = {
    path,
    size: 42,
    sha256: "a".repeat(64),
    flags: ["truncated"],
    textSample: `export const evidence = '${path}';\n`,
  };
  return path === "native.bin"
    ? {
        path,
        before: null,
        after: { ...record, flags: ["binary", "content-skipped"], textSample: undefined },
        textSamplesOmitted: true,
      }
    : {
        path,
        before: { ...record, flags: ["baseline-truncated"] },
        after: record,
        textSamplesOmitted: true,
      };
}

function gate() {
  let release!: () => void;
  let requested!: () => void;
  return {
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    started: new Promise<void>((resolve) => {
      requested = resolve;
    }),
    release: () => release(),
    requested: () => requested(),
  };
}

async function installHarness(
  page: Page,
  mode: "supported" | "unsupported" | "rejected" = "supported",
) {
  await page.addInitScript((registrationMode) => {
    type Tool = {
      name: string;
      execute(input: unknown, options: { signal: AbortSignal }): Promise<ToolResult>;
    };
    const tools = new Map<string, Tool>();
    const calls = new Map<string, { controller: AbortController; result: Promise<ToolResult> }>();
    const harness: Harness = {
      names: () => [...tools.keys()].sort(),
      abortedRegistrations: 0,
      async call(name, input) {
        const tool = tools.get(name);
        if (!tool) throw new Error(`Tool unavailable: ${name}`);
        return tool.execute(input, { signal: new AbortController().signal });
      },
      start(id, name, input) {
        const tool = tools.get(name);
        if (!tool) throw new Error(`Tool unavailable: ${name}`);
        const controller = new AbortController();
        calls.set(id, { controller, result: tool.execute(input, { signal: controller.signal }) });
      },
      result: (id) => {
        const call = calls.get(id);
        if (!call) throw new Error("Unknown call");
        return call.result;
      },
      abort: (id) => calls.get(id)?.controller.abort(),
    };
    (window as unknown as TestWindow).__webmcp = harness;
    localStorage.setItem("drydock:active-organization-id", "private-org-must-not-be-sent");
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value:
        registrationMode === "unsupported"
          ? undefined
          : {
              async registerTool(tool: Tool, options: { signal: AbortSignal }) {
                await Promise.resolve();
                if (registrationMode === "rejected")
                  throw new DOMException("Disabled by browser", "NotAllowedError");
                options.signal.throwIfAborted();
                if (tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
                tools.set(tool.name, tool);
                options.signal.addEventListener(
                  "abort",
                  () => {
                    harness.abortedRegistrations++;
                    if (tools.get(tool.name) === tool) tools.delete(tool.name);
                  },
                  { once: true },
                );
              },
            },
    });
  }, mode);
}

async function mockPublicApi(
  page: Page,
  heldPairs = new Map<string, ReturnType<typeof gate>>(),
  heldFiles = new Map<string, ReturnType<typeof gate>>(),
) {
  const requests: Request[] = [];
  await page.route("**/api/auth/**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/public/v1/package-diff**", async (route) => {
    const request = route.request();
    requests.push(request);
    const url = new URL(request.url());
    if (url.pathname.endsWith("/versions")) {
      await route.fulfill({
        json: {
          ecosystem: "npm",
          packageName: canonicalPackage,
          displayName: null,
          versions: ["3.0.0", "2.0.0", "1.0.0"].map((version) => ({ version, distTags: [] })),
          suggested: { from: "1.0.0", to: "2.0.0" },
        },
      });
      return;
    }
    const file = url.pathname.endsWith("/file");
    const path = url.searchParams.get("path") ?? "";
    const held = file ? heldFiles.get(path) : heldPairs.get(url.searchParams.get("package") ?? "");
    if (held) {
      held.requested();
      await held.wait;
    }
    await route
      .fulfill({ json: file ? fileResponse(path) : pairResponse(url) })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || !/closed|cancel|abort|disposed/i.test(error.message))
          throw error;
      });
  });
  return requests;
}

function errorsOn(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    if (!request.failure()?.errorText.includes("ERR_ABORTED"))
      errors.push(`${request.url()}: ${request.failure()?.errorText}`);
  });
  return errors;
}

async function ready(page: Page) {
  await page.goto("/diff");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).__webmcp.names()))
    .toEqual(["compare_package_versions", "get_changed_file"]);
}

async function compare(page: Page, to = "2.0.0", name = canonicalPackage) {
  return page.evaluate(
    (args) => (window as unknown as TestWindow).__webmcp.call("compare_package_versions", args),
    pairArgs(to, name),
  );
}

test("WebMCP comparisons and file inspection synchronize the visible review", async ({
  page,
  context,
}, testInfo) => {
  const errors = errorsOn(page);
  await installHarness(page);
  const requests = await mockPublicApi(page);
  await context.addCookies([
    { name: "session", value: "must-not-be-sent", url: testInfo.project.use.baseURL as string },
  ]);
  await ready(page);
  const first = await compare(page, "2.0.0", "canonical-alias");
  expect(first.isError).not.toBe(true);
  expect(first.structuredContent).toMatchObject({
    packageName: canonicalPackage,
    textSamplesOmitted: true,
    notices: pairResponse(new URL("http://test?from=1.0.0&to=2.0.0")).notices,
    findings: pairResponse(new URL("http://test?from=1.0.0&to=2.0.0")).findings,
  });
  expect(first.structuredContent.reviewUrl).toBe(
    `${testInfo.project.use.baseURL}/diff/@agent/review/1.0.0/2.0.0`,
  );
  await expect(page).toHaveURL(/\/diff\/@agent\/review\/1\.0\.0\/2\.0\.0$/);
  await expect(page.getByRole("heading", { name: canonicalPackage, exact: true })).toBeVisible();
  await expect(page.getByLabel("From version")).toHaveValue("1.0.0");
  await expect(page.getByLabel("To version")).toHaveValue("2.0.0");
  expect((await compare(page, "3.0.0")).isError).not.toBe(true);
  await expect(page).toHaveURL(/\/1\.0\.0\/3\.0\.0$/);
  await expect(page.getByLabel("To version")).toHaveValue("3.0.0");
  await page.getByPlaceholder("Filter files").fill("no-match");
  const inspected = await page.evaluate(
    (args) => (window as unknown as TestWindow).__webmcp.call("get_changed_file", args),
    { ...pairArgs("3.0.0"), path: "hidden.js" },
  );
  expect(inspected.structuredContent).toEqual(fileResponse("hidden.js"));
  await expect(page.getByPlaceholder("Filter files")).toHaveValue("");
  await expect(page.getByRole("checkbox", { name: "Changed files only" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "hidden.js", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByText("truncated", { exact: true })).toBeVisible();
  const binary = await page.evaluate(
    (args) => (window as unknown as TestWindow).__webmcp.call("get_changed_file", args),
    { ...pairArgs("3.0.0"), path: "native.bin" },
  );
  expect(binary.structuredContent).toMatchObject({
    before: null,
    after: { flags: ["binary", "content-skipped"] },
    textSamplesOmitted: true,
  });
  await expect(page.getByText("binary", { exact: true })).toBeVisible();
  await expect(page.getByText("content skipped", { exact: true })).toBeVisible();
  const pairRequests = requests.filter(
    (request) => new URL(request.url()).pathname === "/api/public/v1/package-diff",
  );
  expect(pairRequests).toHaveLength(2);
  for (const request of requests) {
    const headers = await request.allHeaders();
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers["x-organization-id"]).toBeUndefined();
    expect(headers["x-organization-strict"]).toBeUndefined();
  }
  await page.screenshot({ path: testInfo.outputPath("webmcp-visible-review.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a newer comparison supersedes an older delayed request", async ({ page }) => {
  const errors = errorsOn(page);
  const held = gate();
  await installHarness(page);
  await mockPublicApi(page, new Map([["slow-a", held]]));
  await ready(page);
  await page.evaluate(
    (args) =>
      (window as unknown as TestWindow).__webmcp.start("old", "compare_package_versions", args),
    pairArgs("2.0.0", "slow-a"),
  );
  await held.started;
  const latest = await compare(page, "3.0.0");
  expect(latest.isError).not.toBe(true);
  held.release();
  const old = await page.evaluate(() => (window as unknown as TestWindow).__webmcp.result("old"));
  expect(old).toMatchObject({ isError: true, structuredContent: { status: 409 } });
  await expect(page).toHaveURL(/\/1\.0\.0\/3\.0\.0$/);
  await expect(page.getByLabel("To version")).toHaveValue("3.0.0");
  expect(errors).toEqual([]);
});

test("a manual file selection wins over a delayed agent file request", async ({ page }) => {
  const errors = errorsOn(page);
  const held = gate();
  await installHarness(page);
  await mockPublicApi(page, new Map(), new Map([["slow.js", held]]));
  await ready(page);
  expect((await compare(page)).isError).not.toBe(true);
  await page.evaluate(
    (args) => (window as unknown as TestWindow).__webmcp.start("file", "get_changed_file", args),
    { ...pairArgs(), path: "slow.js" },
  );
  await held.started;
  const manual = page.getByRole("button", { name: /^manual\.js/ });
  await manual.click();
  await expect(manual).toHaveAttribute("aria-current", "true");
  held.release();
  const result = await page.evaluate(() =>
    (window as unknown as TestWindow).__webmcp.result("file"),
  );
  expect(result).toMatchObject({ isError: true, structuredContent: { status: 409 } });
  await expect(manual).toHaveAttribute("aria-current", "true");
  expect(errors).toEqual([]);
});

test("leaving the diff unregisters tools and prevents a delayed comparison from routing back", async ({
  page,
}) => {
  const errors = errorsOn(page);
  const held = gate();
  await installHarness(page);
  await mockPublicApi(page, new Map([["slow-a", held]]));
  await ready(page);
  await page.evaluate(
    (args) =>
      (window as unknown as TestWindow).__webmcp.start("away", "compare_package_versions", args),
    pairArgs("2.0.0", "slow-a"),
  );
  await held.started;
  await page.getByRole("link", { name: "Privacy", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Privacy Policy", exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as TestWindow).__webmcp.names()))
    .toEqual([]);
  expect(
    await page.evaluate(() => (window as unknown as TestWindow).__webmcp.abortedRegistrations),
  ).toBe(2);
  held.release();
  expect(
    await page.evaluate(() => (window as unknown as TestWindow).__webmcp.result("away")),
  ).toMatchObject({
    isError: true,
    structuredContent: { status: 409 },
  });
  await expect(page).toHaveURL(/\/privacy$/);
  expect(errors).toEqual([]);
});

test("caller cancellation returns unavailable evidence without late navigation", async ({
  page,
}) => {
  const errors = errorsOn(page);
  const held = gate();
  await installHarness(page);
  await mockPublicApi(page, new Map([["slow-a", held]]));
  await ready(page);
  await page.evaluate(
    (args) =>
      (window as unknown as TestWindow).__webmcp.start(
        "cancelled",
        "compare_package_versions",
        args,
      ),
    pairArgs("2.0.0", "slow-a"),
  );
  await held.started;
  await page.evaluate(() => (window as unknown as TestWindow).__webmcp.abort("cancelled"));
  expect(
    await page.evaluate(() => (window as unknown as TestWindow).__webmcp.result("cancelled")),
  ).toMatchObject({ isError: true, structuredContent: { status: 499 } });
  held.release();
  await expect(page).toHaveURL(/\/diff$/);
  expect(errors).toEqual([]);
});

test("cancelling file inspection prevents late evidence from replacing the cancellation state", async ({
  page,
}) => {
  const errors = errorsOn(page);
  const held = gate();
  await installHarness(page);
  await mockPublicApi(page, new Map(), new Map([["slow.js", held]]));
  await ready(page);
  expect((await compare(page)).isError).not.toBe(true);
  await page.evaluate(
    (args) =>
      (window as unknown as TestWindow).__webmcp.start("cancel-file", "get_changed_file", args),
    { ...pairArgs(), path: "slow.js" },
  );
  await held.started;
  await page.evaluate(() => (window as unknown as TestWindow).__webmcp.abort("cancel-file"));
  expect(
    await page.evaluate(() => (window as unknown as TestWindow).__webmcp.result("cancel-file")),
  ).toMatchObject({ isError: true, structuredContent: { status: 499 } });
  await expect(page.getByText("File inspection cancelled.", { exact: true })).toBeVisible();
  const completed = page.waitForEvent("requestfinished", (request) =>
    request.url().includes("path=slow.js"),
  );
  held.release();
  await completed;
  await expect(page.getByText("File inspection cancelled.", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const mode of ["unsupported", "rejected"] as const) {
  test(`the ordinary diff remains usable when WebMCP is ${mode}`, async ({ page }) => {
    const errors = errorsOn(page);
    await installHarness(page, mode);
    await mockPublicApi(page);
    await page.goto("/diff");
    await page.getByLabel("npm package name or pkg.pr.new URL").fill("ordinary-package");
    await page.getByRole("button", { name: "Diff latest versions", exact: true }).click();
    await expect(page).toHaveURL(/\/diff\/@agent\/review\/1\.0\.0\/2\.0\.0$/);
    await expect(page.getByRole("heading", { name: canonicalPackage, exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as TestWindow).__webmcp.names())).toEqual(
      [],
    );
    expect(errors).toEqual([]);
  });
}
