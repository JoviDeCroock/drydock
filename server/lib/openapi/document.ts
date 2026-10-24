import { z } from "zod";
import {
  ApiKeyIdentity,
  ErrorResponse,
  OpenApiDocument,
  PackageReleases,
  PublicPackageDiff,
  PublicPackageVersions,
  ReleaseReceipt,
  ReportExport,
  ScanDetail,
  ScanList,
  ScanOverview,
  ScanStatus,
  StagedDecisionRequest,
  StagedPublishDiscovery,
  StartScanRequest,
  StartedScan,
  WorkflowGate,
  openApiSchemas,
} from "./schemas";

// The OpenAPI 3.1 description of Drydock's automation surface: every route an
// organization API key reaches (exactly `API_KEY_ROUTES`,
// `API_KEY_SCAN_ROUTES`, and `API_KEY_DECIDE_ROUTES`) plus the anonymous
// package-diff endpoints. Built from the zod contracts in `schemas.ts`;
// `docs/openapi.json` is this document checked in, kept current by
// `test/openapi-document.test.ts`.

const OPENAPI_API_VERSION = "1.2.0";

type ZodSchema = z.ZodType;

interface ParameterSpec {
  name: string;
  in: "path" | "query";
  required?: boolean;
  description: string;
  schema: Record<string, unknown>;
}

interface OperationSpec {
  /** Defaults to `get`. */
  method?: "get" | "post";
  /** Hono route path, e.g. `/api/v1/scans/:id`; rendered with `{id}` params. */
  route: string;
  operationId: string;
  summary: string;
  description?: string;
  tag: "API keys" | "Reviews" | "Packages" | "Workflow gates" | "Public diff" | "Meta";
  parameters?: ParameterSpec[];
  requestBody?: ZodSchema;
  /** Starts work and answers 202; reachable only by a key with `scan` access. */
  startsWork?: boolean;
  /** Records a staged-publish decision; reachable only by a `decide_staged` key. */
  decidesStaged?: boolean;
  /** A `startsWork` route that answers 200 with work already under way, described here. */
  existingWork?: string;
  response: ZodSchema;
  /** Media type of the success response, when it is not plain JSON. */
  download?: boolean;
  anonymous?: boolean;
  errors: number[];
}

const stringParam = (
  name: string,
  where: "path" | "query",
  description: string,
  required = where === "path",
): ParameterSpec => ({ name, in: where, required, description, schema: { type: "string" } });

const SCAN_ID = stringParam("id", "path", "Review (scan) id");
const PAGE_PARAMS = [
  stringParam("cursor", "query", "`nextCursor` from the previous page"),
  {
    name: "limit",
    in: "query" as const,
    description: "Page size",
    schema: { type: "integer", minimum: 1 },
  },
];
const ECOSYSTEM_PARAM: ParameterSpec = {
  name: "ecosystem",
  in: "query",
  description: "Registry; defaults to `npm`",
  schema: { type: "string", enum: ["npm", "pypi", "vscode", "atpm"] },
};
const PUBLIC_ECOSYSTEM_PARAM: ParameterSpec = {
  ...ECOSYSTEM_PARAM,
  schema: { type: "string", enum: ["npm", "pypi", "atpm"] },
};
const PUBLIC_PAIR_PARAMS = [
  stringParam("package", "query", "Package name", true),
  stringParam("from", "query", "Baseline version", true),
  stringParam("to", "query", "Target version", true),
  PUBLIC_ECOSYSTEM_PARAM,
];

export const OPENAPI_OPERATIONS: readonly OperationSpec[] = [
  {
    route: "/api/v1/api-keys/current",
    operationId: "getCurrentApiKey",
    summary: "Describe the calling API key",
    description: "The key's name, display prefix, expiry, and organization. API keys only.",
    tag: "API keys",
    response: ApiKeyIdentity,
    errors: [400, 401],
  },
  {
    route: "/api/v1/openapi.json",
    operationId: "getOpenApiDocument",
    summary: "This OpenAPI document",
    tag: "Meta",
    response: OpenApiDocument,
    errors: [401],
  },
  {
    route: "/api/v1/scans",
    operationId: "listScans",
    summary: "List the organization's reviews",
    description:
      "Newest first. `filter` defaults to `undecided`. `stageId` narrows the list to the reviews of one npm stage.",
    tag: "Reviews",
    parameters: [
      {
        name: "stageId",
        in: "query",
        description: "Only the reviews of this npm stage id (from `npm stage publish`)",
        schema: { type: "string", maxLength: 200 },
      },
      {
        name: "filter",
        in: "query",
        description: "Decision filter",
        schema: {
          type: "string",
          enum: [
            "undecided",
            "published_without_decision",
            "decided",
            "publish",
            "no_publish",
            "all",
          ],
        },
      },
      ...PAGE_PARAMS,
    ],
    response: ScanList,
    errors: [401, 403],
  },
  {
    method: "post",
    route: "/api/v1/scans",
    operationId: "startScan",
    summary: "Start a review",
    description:
      "Queues a review of one staged npm publish (`stageId`) or one published release. Needs a key with `scan` access; poll `GET /api/v1/scans/{id}/status` for the result. A stage the organization already has a review of (one that has not failed) is answered 200 with that review and `existing: true`, so a retried request starts nothing. Starting a review never records a release decision.",
    tag: "Reviews",
    requestBody: StartScanRequest,
    startsWork: true,
    existingWork: "The stage already has a review in this organization; nothing was started",
    response: StartedScan,
    errors: [400, 401, 403, 404, 409, 413, 422, 429, 502, 503],
  },
  {
    method: "post",
    route: "/api/v1/staged-publishes/scan",
    operationId: "checkNpmForStagedPublishes",
    summary: "Check npm for staged publishes",
    description:
      "The dashboard's \"Check npm\": lists the organization's staged npm publishes with its npm token and starts a review of each one not reviewed yet. Needs a key with `scan` access.",
    tag: "Reviews",
    startsWork: true,
    response: StagedPublishDiscovery,
    errors: [400, 401, 403, 429, 502],
  },
  {
    method: "post",
    route: "/api/v1/scans/:id/decision",
    operationId: "recordStagedDecision",
    summary: "Record a decision on a staged publish",
    description:
      "Records the advisory publish / no-publish decision on a completed staged npm publish review, as the key's creator. Needs a key with `decide_staged` access. It never approves or rejects anything on npm, and a key is refused (`403 api_key_staged_decisions_only`) on a workflow-gate package or a published-release review. Every decision needs `totpCode`, a current code from the authenticator of the member who created the key: missing is `401 two_factor_required`, wrong is `401 two_factor_invalid`, and a creator without two-factor authentication is `403 two_factor_enrollment_required`. Attempts are limited to 10 per 15 minutes per creator.",
    tag: "Reviews",
    parameters: [SCAN_ID],
    requestBody: StagedDecisionRequest,
    decidesStaged: true,
    response: ScanDetail,
    errors: [400, 401, 403, 404, 409, 429],
  },
  {
    route: "/api/v1/scans/overview",
    operationId: "getScanOverview",
    summary: "Dashboard counts for the last 30 days",
    tag: "Reviews",
    response: ScanOverview,
    errors: [401, 403],
  },
  {
    route: "/api/v1/scans/:id",
    operationId: "getScan",
    summary: "Read one review",
    tag: "Reviews",
    parameters: [SCAN_ID],
    response: ScanDetail,
    errors: [401, 403, 404],
  },
  {
    route: "/api/v1/scans/:id/status",
    operationId: "getScanStatus",
    summary: "A review's lifecycle status, for polling",
    tag: "Reviews",
    parameters: [SCAN_ID],
    response: ScanStatus,
    errors: [401, 403, 404],
  },
  {
    route: "/api/v1/scans/:id/report.json",
    operationId: "exportScanReport",
    summary: "Export a completed review",
    description:
      "Byte-stable canonical JSON, served as a download. 409 until the review completes.",
    tag: "Reviews",
    parameters: [SCAN_ID],
    response: ReportExport,
    download: true,
    errors: [401, 403, 404, 409],
  },
  {
    route: "/api/v1/scans/:id/release-receipt.json",
    operationId: "getReleaseReceipt",
    summary: "The Release Receipt of a completed review",
    description:
      "Served as a download with `x-drydock-receipt-sha256`. 409 until the review completes.",
    tag: "Reviews",
    parameters: [SCAN_ID],
    response: ReleaseReceipt,
    download: true,
    errors: [401, 403, 404, 409],
  },
  {
    route: "/api/v1/packages/:name{.+}/releases",
    operationId: "listPackageReleases",
    summary: "One package's reviews in this organization",
    description: "Scoped npm names keep their slash: `/api/v1/packages/@scope/name/releases`.",
    tag: "Packages",
    parameters: [stringParam("name", "path", "Package name"), ECOSYSTEM_PARAM, ...PAGE_PARAMS],
    response: PackageReleases,
    errors: [400, 401, 403],
  },
  {
    route: "/api/v1/github-app/workflow-gates/by-scan/:scanId",
    operationId: "getWorkflowGateByScan",
    summary: "The workflow gate a review belongs to",
    tag: "Workflow gates",
    parameters: [stringParam("scanId", "path", "Review (scan) id")],
    response: WorkflowGate,
    errors: [401, 403, 404],
  },
  {
    route: "/api/public/v1/package-diff",
    operationId: "getPublicPackageDiff",
    summary: "Diff two published releases",
    description:
      "Anonymous and rate limited per IP. Parses public release archives without executing them. On npm, `from`/`to` also accept pkg.pr.new preview URLs.",
    tag: "Public diff",
    parameters: PUBLIC_PAIR_PARAMS,
    response: PublicPackageDiff,
    anonymous: true,
    errors: [400, 404, 429],
  },
  {
    route: "/api/public/v1/package-diff/versions",
    operationId: "listPublicPackageVersions",
    summary: "A public package's published versions",
    tag: "Public diff",
    parameters: [stringParam("package", "query", "Package name", true), PUBLIC_ECOSYSTEM_PARAM],
    response: PublicPackageVersions,
    anonymous: true,
    errors: [400, 404, 429],
  },
];

/** Hono's `:param` and `:param{regex}` segments as OpenAPI `{param}`. */
export function openApiPath(route: string): string {
  return route.replace(/:([A-Za-z_][\w]*)(\{[^}]*\})?/g, "{$1}");
}

const COMPONENT_REF_PREFIX = "#/components/schemas/";

/**
 * Every registered schema in one conversion, so a schema used inside another
 * renders as a `$ref` to its own component. Converting schemas one at a time
 * inlines a per-schema `$defs` block whose refs `components.schemas` cannot
 * resolve.
 */
function componentSchemas(): Record<string, unknown> {
  const { schemas } = z.toJSONSchema(openApiSchemas, {
    target: "draft-2020-12",
    io: "output",
    unrepresentable: "any",
    uri: (id) => `${COMPONENT_REF_PREFIX}${id}`,
  }) as { schemas: Record<string, Record<string, unknown>> };
  if ("__shared" in schemas) {
    throw new Error("an OpenAPI schema references an id'd schema outside openApiSchemas");
  }
  return Object.fromEntries(
    Object.entries(schemas).map(([id, { $schema: _dialect, $id: _uri, ...rest }]) => [id, rest]),
  );
}

function componentRef(schema: ZodSchema): { $ref: string } {
  const id = openApiSchemas.get(schema)?.id;
  if (typeof id !== "string") throw new Error("every OpenAPI response schema needs a registry id");
  return { $ref: `${COMPONENT_REF_PREFIX}${id}` };
}

const STATUS_TEXT: Record<number, string> = {
  400: "Invalid request",
  401: "Missing, unknown, or expired credential",
  403: "Not allowed for this credential or organization",
  404: "Not found in this organization",
  409: "The review has not completed or was superseded, or the package is claimed by another organization",
  413: "The release archive is larger than Drydock reviews",
  422: "The registry named a package Drydock cannot review",
  429: "Rate limited; honor `retry-after`",
  502: "The registry rejected or could not answer the request",
  503: "The registry could not be verified; retry later",
};

let cachedDocument: Record<string, unknown> | null = null;

/** The document is a pure function of this module, so one isolate builds it once. */
export function openApiDocument(): Record<string, unknown> {
  cachedDocument ??= buildOpenApiDocument();
  return cachedDocument;
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const schemas = componentSchemas();
  const paths: Record<string, Record<string, unknown>> = {};

  const errorRef = componentRef(ErrorResponse);

  for (const operation of OPENAPI_OPERATIONS) {
    const responses: Record<string, unknown> = {
      [operation.startsWork ? "202" : "200"]: {
        description: operation.download ? "Download" : operation.startsWork ? "Accepted" : "OK",
        content: { "application/json": { schema: componentRef(operation.response) } },
      },
      ...(operation.existingWork
        ? {
            "200": {
              description: operation.existingWork,
              content: { "application/json": { schema: componentRef(operation.response) } },
            },
          }
        : {}),
    };
    // Every key request is charged to a per-IP and a per-key budget before its
    // route runs, so each key operation can answer 429.
    const errors = operation.anonymous
      ? operation.errors
      : [...new Set([...operation.errors, 429])];
    for (const status of errors) {
      responses[String(status)] = {
        description: STATUS_TEXT[status],
        content: { "application/json": { schema: errorRef } },
      };
    }
    let requestBody: Record<string, unknown> | undefined;
    if (operation.requestBody) {
      requestBody = {
        required: true,
        content: { "application/json": { schema: componentRef(operation.requestBody) } },
      };
    }
    paths[openApiPath(operation.route)] = {
      ...paths[openApiPath(operation.route)],
      [operation.method ?? "get"]: {
        operationId: operation.operationId,
        summary: operation.summary,
        ...(operation.description ? { description: operation.description } : {}),
        tags: [operation.tag],
        ...(operation.anonymous ? { security: [] } : {}),
        ...(operation.startsWork ? { "x-drydock-api-key-access": "scan" } : {}),
        ...(operation.decidesStaged ? { "x-drydock-api-key-access": "decide_staged" } : {}),
        ...(operation.parameters?.length ? { parameters: operation.parameters } : {}),
        ...(requestBody ? { requestBody } : {}),
        responses,
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Drydock API",
      version: OPENAPI_API_VERSION,
      description:
        "Automation surface for Drydock. Authenticate with an organization API key (`Authorization: Bearer ddk_…`); see docs/api-keys.md. Every key reads; a key with `scan` access can also start reviews (operations marked `x-drydock-api-key-access: scan`), and a key with `decide_staged` access can also record the advisory decision on a staged npm publish (`x-drydock-api-key-access: decide_staged`). No key decides a workflow gate. Package-diff endpoints are anonymous.",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    },
    servers: [{ url: "https://drydock.org", description: "Hosted Drydock" }],
    security: [{ apiKey: [] }],
    tags: [...new Set(OPENAPI_OPERATIONS.map((operation) => operation.tag))].map((name) => ({
      name,
    })),
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "ddk_…",
          description: "Organization API key from Settings → Integrations → API keys",
        },
      },
      schemas,
    },
  };
}

/** The routes this document marks as needing a key, in `API_KEY_ROUTES` form. */
export function documentedApiKeyRoutes(access: "read" | "scan" | "decide_staged"): string[] {
  const accessOf = (operation: OperationSpec) =>
    operation.decidesStaged ? "decide_staged" : operation.startsWork ? "scan" : "read";
  return OPENAPI_OPERATIONS.filter(
    (operation) => !operation.anonymous && accessOf(operation) === access,
  ).map((operation) => `${(operation.method ?? "get").toUpperCase()} ${operation.route}`);
}
