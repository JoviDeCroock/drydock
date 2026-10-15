import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { API_KEY_ROUTES } from "../server/lib/auth/api-keys";
import {
  OPENAPI_OPERATIONS,
  buildOpenApiDocument,
  documentedApiKeyRoutes,
  openApiPath,
} from "../server/lib/openapi/document";

const CHECKED_IN = fileURLToPath(new URL("../docs/openapi.json", import.meta.url));

function serialized(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}

describe("OpenAPI document", () => {
  test("documents exactly the routes an API key may reach", () => {
    expect(documentedApiKeyRoutes().sort()).toEqual([...API_KEY_ROUTES].sort());
  });

  test("every path template parameter is declared, and nothing else is a path parameter", () => {
    for (const operation of OPENAPI_OPERATIONS) {
      const templated = [...openApiPath(operation.route).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const declared = (operation.parameters ?? [])
        .filter((parameter) => parameter.in === "path")
        .map((parameter) => parameter.name);
      expect(declared.sort(), operation.operationId).toEqual(templated.sort());
    }
  });

  test("every $ref resolves inside the document", () => {
    const document = buildOpenApiDocument();
    const refs = [...JSON.stringify(document).matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const target = ref
        .replace(/^#\//, "")
        .split("/")
        .reduce<unknown>(
          (node, key) => (node as Record<string, unknown> | undefined)?.[key],
          document,
        );
      expect(target, ref).toBeTruthy();
    }
  });

  type Operation = { security?: unknown[]; responses: Record<string, unknown> };
  const operations = (document: Record<string, unknown>) =>
    Object.entries(document.paths as Record<string, Record<string, Operation>>).flatMap(
      ([path, methods]) =>
        Object.entries(methods).map(([method, operation]) => ({
          name: `${method.toUpperCase()} ${path}`,
          operation,
        })),
    );

  test("every API-key operation documents its rate-limit response", () => {
    for (const { name, operation } of operations(buildOpenApiDocument())) {
      if (operation.security?.length === 0) continue;
      expect(operation.responses["429"], name).toBeTruthy();
    }
  });

  test("response objects stay open to fields outside the contract", () => {
    const document = buildOpenApiDocument();
    const schemas = (document.components as { schemas: Record<string, unknown> }).schemas;
    const responseSchemas = new Set(
      operations(document).flatMap(({ operation }) =>
        [...JSON.stringify(operation.responses).matchAll(/"#\/components\/schemas\/(\w+)"/g)].map(
          (match) => match[1],
        ),
      ),
    );
    expect(responseSchemas.size).toBeGreaterThan(1);
    for (const name of responseSchemas) {
      expect(JSON.stringify(schemas[name]), name).not.toContain('"additionalProperties":false');
    }
  });

  test("operation ids are unique", () => {
    const ids = OPENAPI_OPERATIONS.map((operation) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // `WRITE_OPENAPI=1 pnpm exec vitest run --project node test/openapi-document.test.ts`
  // regenerates the file after a deliberate contract change.
  test("docs/openapi.json is the current document", () => {
    if (process.env.WRITE_OPENAPI === "1") writeFileSync(CHECKED_IN, serialized());
    expect(readFileSync(CHECKED_IN, "utf8")).toBe(serialized());
  });
});
