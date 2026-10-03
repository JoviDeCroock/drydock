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
  WorkflowGate,
} from "./schemas";

// The OpenAPI 3.1 description of Drydock's automation surface: every route an
// organization API key reaches (exactly `API_KEY_ROUTES`) plus the anonymous
// package-diff endpoints. Built from the zod contracts in `schemas.ts`;
// `docs/openapi.json` is this document checked in, kept current by
// `test/openapi-document.test.ts`.

const OPENAPI_API_VERSION = "1.0.0";

type ZodSchema = z.ZodType;

interface ParameterSpec {
  name: string;
  in: "path" | "query";
  required?: boolean;
  description: string;
  schema: Record<string, unknown>;
}

interface OperationSpec {
  /** Hono route path, e.g. `/api/v1/scans/:id`; rendered with `{id}` params. */
  route: string;
  operationId: string;
  summary: string;
  description?: string;
  tag: "API keys" | "Reviews" | "Packages" | "Workflow gates" | "Public diff" | "Meta";
  parameters?: ParameterSpec[];
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
    description: "Newest first. `filter` defaults to `undecided`.",
    tag: "Reviews",
    parameters: [
      {
        name: "filter",
        in: "query",
        description: "Decision filter",
        schema: {
          type: "string",
          enum: ["undecided", "published_without_decision", "publish", "no_publish", "all"],
        },
      },
      ...PAGE_PARAMS,
    ],
    response: ScanList,
    errors: [401, 403],
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

function jsonSchema(schema: ZodSchema): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return rest;
}

function componentName(schema: ZodSchema): string {
  const id = z.globalRegistry.get(schema)?.id;
  if (typeof id !== "string") throw new Error("every OpenAPI response schema needs a meta id");
  return id;
}

const STATUS_TEXT: Record<number, string> = {
  400: "Invalid request",
  401: "Missing, unknown, or expired credential",
  403: "Not allowed for this credential or organization",
  404: "Not found in this organization",
  409: "The review has not completed",
  429: "Rate limited; honor `retry-after`",
};

let cachedDocument: Record<string, unknown> | null = null;

/** The document is a pure function of this module, so one isolate builds it once. */
export function openApiDocument(): Record<string, unknown> {
  cachedDocument ??= buildOpenApiDocument();
  return cachedDocument;
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const schemas: Record<string, unknown> = { Error: jsonSchema(ErrorResponse) };
  const paths: Record<string, Record<string, unknown>> = {};

  for (const operation of OPENAPI_OPERATIONS) {
    const name = componentName(operation.response);
    schemas[name] = jsonSchema(operation.response);
    const responses: Record<string, unknown> = {
      "200": {
        description: operation.download ? "Download" : "OK",
        content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } },
      },
    };
    for (const status of operation.errors) {
      responses[String(status)] = {
        description: STATUS_TEXT[status],
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      };
    }
    paths[openApiPath(operation.route)] = {
      get: {
        operationId: operation.operationId,
        summary: operation.summary,
        ...(operation.description ? { description: operation.description } : {}),
        tags: [operation.tag],
        ...(operation.anonymous ? { security: [] } : {}),
        ...(operation.parameters?.length ? { parameters: operation.parameters } : {}),
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
        "Read-only automation surface for Drydock. Authenticate with an organization API key (`Authorization: Bearer ddk_…`); see docs/api-keys.md. Package-diff endpoints are anonymous.",
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
export function documentedApiKeyRoutes(): string[] {
  return OPENAPI_OPERATIONS.filter((operation) => !operation.anonymous).map(
    (operation) => `GET ${operation.route}`,
  );
}
