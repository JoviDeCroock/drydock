#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const ROOT = process.cwd();
const DEFAULT_TARGETS = ["src"];
const EXTENSIONS = new Set([".tsx"]);
const ESCAPE_COMMENT = "signals-boundary-ok";
const SIGNAL_IMPORT_SOURCES = new Set(["@preact/signals", "@preact/signals-core"]);
const SIGNAL_FACTORIES = new Set(["signal", "computed", "useSignal", "useComputed"]);
const DOM_SIGNAL_ATTRIBUTES = new Set(["checked", "disabled", "open", "selected", "value"]);

const findings = [];

for (const file of collectFiles(process.argv.slice(2))) {
  checkFile(file);
}

if (findings.length > 0) {
  console.error("Signal boundary check found over-eager .value reads:\n");
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}:${finding.column} ${finding.message}`);
  }
  console.error(
    `\nUse // ${ESCAPE_COMMENT}: <reason> on the same or previous line for intentional snapshots.`,
  );
  process.exit(1);
}

function collectFiles(args) {
  const targets = args.length > 0 ? args : DEFAULT_TARGETS;
  const files = [];

  for (const target of targets) {
    const absolute = path.resolve(ROOT, target);
    if (!fs.existsSync(absolute)) continue;
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      walk(absolute, files);
    } else if (EXTENSIONS.has(path.extname(absolute))) {
      files.push(absolute);
    }
  }

  return files.sort();
}

function walk(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".wrangler") {
      continue;
    }

    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(absolute, files);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      files.push(absolute);
    }
  }
}

function checkFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = text.split(/\r?\n/);
  const importedFactories = new Set();
  const signals = new Set();

  collectSignalNames(source, importedFactories, signals);
  inspectJsx(source, lines, signals, file);
}

function collectSignalNames(source, importedFactories, signals) {
  function visit(node) {
    if (ts.isImportDeclaration(node) && SIGNAL_IMPORT_SOURCES.has(moduleName(node))) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (SIGNAL_FACTORIES.has(imported)) importedFactories.add(element.name.text);
        }
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (
        isSignalFactoryCall(node.initializer, importedFactories) ||
        isSignalType(node.type, source)
      ) {
        signals.add(node.name.text);
      }
    }

    if (ts.isParameter(node) && ts.isIdentifier(node.name) && isSignalType(node.type, source)) {
      signals.add(node.name.text);
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
}

function inspectJsx(source, lines, signals, file) {
  function visit(node) {
    if (ts.isJsxAttribute(node)) {
      inspectAttribute(node, source, lines, signals, file);
    } else if (ts.isJsxExpression(node)) {
      inspectTextExpression(node, source, lines, signals, file);
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
}

function inspectAttribute(node, source, lines, signals, file) {
  const attrName = node.name.getText(source);
  if (!DOM_SIGNAL_ATTRIBUTES.has(attrName)) return;
  if (!node.initializer || !ts.isJsxExpression(node.initializer)) return;
  if (!isDomTag(attributeTag(node, source))) return;

  const signalName = signalValueName(node.initializer.expression, signals);
  if (!signalName || hasEscape(lines, source, node)) return;

  report(file, source, node, `pass signal '${signalName}' directly to DOM prop '${attrName}'`);
}

function inspectTextExpression(node, source, lines, signals, file) {
  if (!isDomTextExpression(node, source)) return;

  const signalName = signalValueName(node.expression, signals);
  if (!signalName || hasEscape(lines, source, node)) return;

  report(file, source, node, `render signal '${signalName}' directly as JSX text`);
}

function moduleName(node) {
  return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
}

function isSignalFactoryCall(node, importedFactories) {
  if (!node || !ts.isCallExpression(node)) return false;
  const expression = unwrap(node.expression);
  return ts.isIdentifier(expression) && importedFactories.has(expression.text);
}

function isSignalType(node, source) {
  if (!node) return false;
  return /\b(?:Readonly)?Signal\s*</.test(node.getText(source));
}

function signalValueName(node, signals) {
  const expression = unwrap(node);
  if (!expression || !ts.isPropertyAccessExpression(expression)) return null;
  if (expression.name.text !== "value") return null;
  const target = unwrap(expression.expression);
  return target && ts.isIdentifier(target) && signals.has(target.text) ? target.text : null;
}

function unwrap(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function attributeTag(node, source) {
  const parent = node.parent.parent;
  if (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) {
    return parent.tagName.getText(source);
  }
  return "";
}

function isDomTextExpression(node, source) {
  if (!ts.isJsxElement(node.parent)) return false;
  return isDomTag(node.parent.openingElement.tagName.getText(source));
}

function isDomTag(name) {
  return /^[a-z][\w-]*$/.test(name);
}

function hasEscape(lines, source, node) {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  return lineHasEscape(lines, position.line) || lineHasEscape(lines, position.line - 1);
}

function lineHasEscape(lines, index) {
  return index >= 0 && index < lines.length && lines[index].includes(ESCAPE_COMMENT);
}

function report(file, source, node, message) {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  findings.push({
    file: path.relative(ROOT, file),
    line: position.line + 1,
    column: position.character + 1,
    message,
  });
}
