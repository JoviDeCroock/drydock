import { describe, expect, test } from "vitest";
import { sanitizeJsSource } from "./helpers/sanitized-source.mjs";

// The invariant scans over our own source (ecosystem branching, execution
// primitives) are only as strong as this blanking: if it blanked real code the
// scans would go blind, and if it kept comments or detection regexes they
// would false-positive. Pin both directions.

describe("sanitizeJsSource", () => {
  test("keeps code, so forbidden constructs stay findable", () => {
    const sanitized = sanitizeJsSource('const x = eval("1 + 1");\n');
    expect(sanitized).toMatch(/\beval\s*\(/);
  });

  test("blanks comments, detection regexes, strings, and templates", () => {
    const source = [
      "// eval(comment) should vanish",
      "/* new Function(block) too */",
      "const pattern = /\\beval\\s*\\(/;",
      'const s = "eval(in a string)";',
      "const t = `eval(${x})`;",
      "const keep = 1;",
    ].join("\n");
    const sanitized = sanitizeJsSource(source);
    expect(sanitized).not.toContain("eval");
    expect(sanitized).not.toContain("Function");
    expect(sanitized).toContain("const keep = 1;");
  });

  test("preserves newlines and offsets, so match indexes map to real lines", () => {
    const source = '// first line comment\nconst two = "x";\n';
    const sanitized = sanitizeJsSource(source);
    expect(sanitized.length).toBe(source.length);
    expect(sanitized.split("\n").length).toBe(source.split("\n").length);
    expect(sanitized.indexOf("const two")).toBe(source.indexOf("const two"));
  });

  test("keepString retains only the selected literals with their spelling", () => {
    const source = 'if (ecosystem === "npm" || label === "not-an-ecosystem") run();\n';
    const sanitized = sanitizeJsSource(source, (value) => value === "npm");
    expect(sanitized).toContain('=== "npm"');
    expect(sanitized).not.toContain("not-an-ecosystem");
  });
});
