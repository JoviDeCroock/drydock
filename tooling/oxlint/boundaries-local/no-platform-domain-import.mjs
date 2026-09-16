/**
 * Keep `server/lib/platform/` domain-free mechanically. AGENTS.md and the
 * shared-primitives skill define platform as the home for HTTP, error, retry,
 * crypto, path-safety, and concurrency primitives that know nothing about
 * scans, organizations, ecosystems, or persistence. A platform module that
 * reaches up into `server/db/`, `server/routes/`, `server/lib/<domain>/`, or
 * `server/types.ts` drags the whole domain graph into every primitive's
 * import closure and quietly re-creates the layering this directory exists to
 * prevent.
 *
 *   server/lib/platform/rate-limit.ts: import { createDb } from "../../db/client"; // flagged
 *   server/lib/platform/http.ts:       import type { Env } from "../../types";      // flagged
 *   server/lib/platform/http.ts:       import { isRecord } from "./guards";         // ok
 *
 * Scope and limitations:
 *   - Only files inside `server/lib/platform/` are constrained.
 *   - Only relative specifiers are resolved; package imports (`hono`, `zod`)
 *     are the platform's business.
 *   - Type-only imports are flagged too: a type dependency on the domain still
 *     couples the primitive's contract to it. Pass the shape structurally or
 *     move the type into platform.
 */

import path from "node:path";

const PLATFORM_SEGMENT = "/server/lib/platform/";

function normalize(filename) {
  return String(filename ?? "").replaceAll("\\", "/");
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "server/lib/platform/ must not import domain code; pass domain dependencies in as arguments",
      recommended: true,
    },
    messages: {
      platformDomainImport:
        'Platform module imports "{{specifier}}", which resolves outside server/lib/platform/. Platform primitives are domain-free: take the dependency as an argument or move the code out of platform (see AGENTS.md and the shared-primitives skill).',
    },
    schema: [],
  },

  create(context) {
    const rawFilename =
      context.physicalFilename ??
      context.getPhysicalFilename?.() ??
      context.filename ??
      context.getFilename?.();
    const filename = path.posix.resolve(normalize(rawFilename));
    const platformIndex = filename.lastIndexOf(PLATFORM_SEGMENT);
    if (platformIndex === -1) return {};

    const platformRoot = filename.slice(0, platformIndex + PLATFORM_SEGMENT.length);
    const fileDir = filename.slice(0, filename.lastIndexOf("/"));

    function checkSpecifier(node, specifier) {
      if (typeof specifier !== "string") return;
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) return;
      const resolved = path.posix.resolve(fileDir, specifier);
      if (resolved.startsWith(platformRoot)) return;
      context.report({
        node,
        messageId: "platformDomainImport",
        data: { specifier },
      });
    }

    function sourceOf(node) {
      const source = node.source;
      if (!source) return undefined;
      if (typeof source.value === "string") return source.value;
      if (source.type === "TemplateLiteral" && source.expressions.length === 0) {
        return source.quasis[0]?.value?.cooked;
      }
      return undefined;
    }

    return {
      ImportDeclaration(node) {
        checkSpecifier(node.source, sourceOf(node));
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkSpecifier(node.source, sourceOf(node));
      },
      ExportAllDeclaration(node) {
        checkSpecifier(node.source, sourceOf(node));
      },
      ImportExpression(node) {
        checkSpecifier(node.source ?? node, sourceOf(node));
      },
    };
  },
};

export default rule;
