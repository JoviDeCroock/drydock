/**
 * Scope analysis utilities for resolving signal-related imports and types.
 *
 * Adapted from `@preact/eslint-plugin-signals` (its `signals-scope.mjs` is not a
 * public export, so the pieces this plugin needs are vendored here). Uses scope
 * analysis to trace identifiers to their declarations, confirming they originate
 * from `@preact/signals-*` — either via a creator call (signal(), useSignal(),
 * computed(), useComputed()) or a Signal/ReadonlySignal type annotation.
 */

const SIGNAL_PACKAGES = new Set([
  "@preact/signals-core",
  "@preact/signals",
  "@preact/signals-react",
  "@preact/signals-react/runtime",
]);

const SIGNAL_CREATORS = new Set(["signal", "useSignal"]);
const COMPUTED_CREATORS = new Set(["computed", "useComputed"]);
const ALL_SIGNAL_CREATORS = new Set([...SIGNAL_CREATORS, ...COMPUTED_CREATORS]);

/** Type names that represent signal instances. */
const SIGNAL_TYPE_NAMES = new Set(["Signal", "ReadonlySignal"]);

/**
 * Resolve an Identifier to its import source and original exported name.
 * Returns null if the identifier isn't an import binding.
 */
function resolveImport(sourceCode, node) {
  let scope;
  try {
    scope = sourceCode.getScope(node);
  } catch {
    return null;
  }

  while (scope) {
    const variable = scope.variables.find((v) => v.name === node.name);
    if (variable) {
      for (const def of variable.defs) {
        if (def.type === "ImportBinding" && def.parent?.type === "ImportDeclaration") {
          return {
            source: def.parent.source.value,
            importedName:
              def.node.type === "ImportSpecifier" ? def.node.imported.name : def.node.local.name,
          };
        }
      }
      return null;
    }
    scope = scope.upper;
  }
  return null;
}

/**
 * Check whether an Identifier resolves to an import from a signals package
 * with the given exported name set.
 */
function isSignalsImport(sourceCode, node, nameSet) {
  if (node.type !== "Identifier") return false;
  const resolved = resolveImport(sourceCode, node);
  if (!resolved) return false;
  return SIGNAL_PACKAGES.has(resolved.source) && nameSet.has(resolved.importedName);
}

/**
 * Check a CallExpression callee against a name set from signal packages.
 * Returns the matched imported name or null.
 */
function getSignalsCallName(sourceCode, callNode, nameSet) {
  const callee = callNode.callee;

  if (callee.type === "Identifier") {
    if (isSignalsImport(sourceCode, callee, nameSet)) {
      const resolved = resolveImport(sourceCode, callee);
      return resolved ? resolved.importedName : null;
    }
  }

  // Namespace import: core.computed(...)
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    nameSet.has(callee.property.name) &&
    callee.object.type === "Identifier"
  ) {
    const resolved = resolveImport(sourceCode, callee.object);
    if (resolved && SIGNAL_PACKAGES.has(resolved.source)) {
      return callee.property.name;
    }
  }

  return null;
}

/** Check whether a VariableDeclarator is initialised with a signals creator. */
function isSignalCreatorInit(sourceCode, declarator, nameSet = ALL_SIGNAL_CREATORS) {
  const init = declarator.init;
  if (!init || init.type !== "CallExpression") return false;
  return getSignalsCallName(sourceCode, init, nameSet) !== null;
}

/**
 * Check whether a TSTypeReference node refers to Signal or ReadonlySignal
 * imported from a signals package.
 */
function isSignalTypeRef(sourceCode, typeRef) {
  if (!typeRef || typeRef.type !== "TSTypeReference") return false;
  const typeName = typeRef.typeName;

  if (typeName.type === "Identifier" && SIGNAL_TYPE_NAMES.has(typeName.name)) {
    const resolved = resolveImport(sourceCode, typeName);
    // Accept if imported from a signals package, or if we can't resolve it
    // (type-only imports may not always have scope bindings).
    return !resolved || SIGNAL_PACKAGES.has(resolved.source);
  }

  // Qualified: e.g. signals.Signal
  if (
    typeName.type === "TSQualifiedName" &&
    typeName.right.type === "Identifier" &&
    SIGNAL_TYPE_NAMES.has(typeName.right.name)
  ) {
    return true;
  }

  return false;
}

/**
 * Check whether a node has a Signal/ReadonlySignal type annotation.
 * Works on VariableDeclarators, function params, and property definitions.
 */
function hasSignalTypeAnnotation(sourceCode, node) {
  const annotation = node.typeAnnotation || node.id?.typeAnnotation;
  if (!annotation) return false;

  const typeNode = annotation.type === "TSTypeAnnotation" ? annotation.typeAnnotation : annotation;

  return isSignalTypeRef(sourceCode, typeNode);
}

/** Find the type node for `key` inside an object-type-literal annotation. */
function objectPatternMemberType(objectPattern, keyName) {
  const annotation = objectPattern.typeAnnotation;
  if (!annotation || annotation.type !== "TSTypeAnnotation") return null;
  const typeNode = annotation.typeAnnotation;
  if (typeNode?.type !== "TSTypeLiteral") return null;
  for (const member of typeNode.members ?? []) {
    if (
      member.type === "TSPropertySignature" &&
      !member.computed &&
      member.key?.type === "Identifier" &&
      member.key.name === keyName &&
      member.typeAnnotation?.type === "TSTypeAnnotation"
    ) {
      return member.typeAnnotation.typeAnnotation;
    }
  }
  return null;
}

/**
 * Handle the canonical signal-prop pattern where the binding is destructured
 * from a param typed with an inline object literal, e.g.
 * `function Toolbar({ disabled }: { disabled: Signal<boolean> })`. The type
 * annotation lives on the ObjectPattern, not on the binding identifier, so
 * `hasSignalTypeAnnotation` alone misses it.
 */
function isDestructuredSignalBinding(sourceCode, bindingIdent) {
  const prop = bindingIdent?.parent;
  if (!prop || prop.type !== "Property") return false;
  const pattern = prop.parent;
  if (!pattern || pattern.type !== "ObjectPattern") return false;
  const keyName = prop.key?.type === "Identifier" ? prop.key.name : null;
  if (!keyName) return false;
  const typeNode = objectPatternMemberType(pattern, keyName);
  return typeNode ? isSignalTypeRef(sourceCode, typeNode) : false;
}

/**
 * Determine whether an Identifier resolves to a known signal — either via a
 * creator call or a Signal/ReadonlySignal type annotation on its declaration
 * (variable, parameter, import).
 */
function isKnownSignal(sourceCode, node) {
  if (node.type !== "Identifier") return false;

  let scope;
  try {
    scope = sourceCode.getScope(node);
  } catch {
    return false;
  }

  while (scope) {
    const variable = scope.variables.find((v) => v.name === node.name);
    if (variable) {
      for (const def of variable.defs) {
        if (def.type === "Variable" && def.node.type === "VariableDeclarator") {
          if (isSignalCreatorInit(sourceCode, def.node)) return true;
        }
        if (def.name && hasSignalTypeAnnotation(sourceCode, def.name)) return true;
        if (def.name && isDestructuredSignalBinding(sourceCode, def.name)) return true;
      }
      return false;
    }
    scope = scope.upper;
  }
  return false;
}

/**
 * Use TypeScript's type checker (via parser services, when available) to decide
 * whether a node's type is Signal or ReadonlySignal. Catches signals reached
 * through member access (e.g. `model.count`). Returns false when type
 * information is unavailable — which is the common case under oxlint today.
 */
function isSignalByTypeChecker(parserServices, node) {
  if (!parserServices?.program || !parserServices?.esTreeNodeToTSNodeMap) {
    return false;
  }

  try {
    const checker = parserServices.program.getTypeChecker();
    const tsNode = parserServices.esTreeNodeToTSNodeMap.get(node);
    if (!tsNode) return false;
    const type = checker.getTypeAtLocation(tsNode);
    const symbol = type.getSymbol?.() ?? type.aliasSymbol;
    return Boolean(symbol && SIGNAL_TYPE_NAMES.has(symbol.getName()));
  } catch {
    return false;
  }
}

export { isKnownSignal, isSignalByTypeChecker };
