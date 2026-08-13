import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  FORMAT_MAX_CHARS,
  formatLanguageFor,
  formatSource,
  formatSourcePair,
  looksMinified,
  remapFindingLines,
  type FormattedSource,
} from "../src/components/format-source";
import { jsTokenText, tokenizeJs } from "../server/lib/platform/js-lexer";

// The load-bearing invariant: reformatting inserts whitespace and nothing else.
// If the token stream ever differs, the diff view is showing a reviewer bytes the
// artifact does not contain.
function significantTokens(source: string): string[] {
  return tokenizeJs(source)
    .filter((token) => token.type !== "ws")
    .map((token) => jsTokenText(source, token));
}

function expectTokenStreamPreserved(source: string, formatted: FormattedSource | null): void {
  if (!formatted) return;
  expect(significantTokens(formatted.text)).toEqual(significantTokens(source));
}

function formatJs(source: string): FormattedSource | null {
  const formatted = formatSource(source, "js");
  expectTokenStreamPreserved(source, formatted);
  return formatted;
}

function formatTs(source: string): FormattedSource | null {
  const formatted = formatSource(source, "ts");
  expectTokenStreamPreserved(source, formatted);
  return formatted;
}

function formatJson(source: string): FormattedSource | null {
  const formatted = formatSource(source, "json");
  expectTokenStreamPreserved(source, formatted);
  return formatted;
}

function lines(formatted: FormattedSource | null): string[] {
  return (formatted?.text ?? "").split("\n");
}

describe("formatLanguageFor", () => {
  test("covers the languages whose token boundaries the formatter understands", () => {
    expect(formatLanguageFor("javascript")).toBe("js");
    expect(formatLanguageFor("typescript")).toBe("ts");
    expect(formatLanguageFor("json")).toBe("json");
    expect(formatLanguageFor("css")).toBe("css");
  });

  test("leaves languages whose unsupported syntax makes inserted whitespace meaningful alone", () => {
    expect(formatLanguageFor("jsx")).toBeNull();
    expect(formatLanguageFor("tsx")).toBeNull();
    expect(formatLanguageFor("scss")).toBeNull();
    expect(formatLanguageFor("markdown")).toBeNull();
    expect(formatLanguageFor("yaml")).toBeNull();
    expect(formatLanguageFor("python")).toBeNull();
    expect(formatLanguageFor(undefined)).toBeNull();
  });
});

describe("looksMinified", () => {
  test("flags a single enormous line", () => {
    expect(looksMinified(`const a=${"x".repeat(600)};`)).toBe(true);
  });

  test("flags a bundle whose banner comment is short but whose payload is not", () => {
    expect(looksMinified(`/*! lib v1 */\nfunction a(){${"b();".repeat(200)}}`)).toBe(true);
  });

  test("leaves ordinary sources alone", () => {
    const source = Array.from({ length: 400 }, (_, index) => `const value${index} = ${index};`);
    expect(looksMinified(source.join("\n"))).toBe(false);
    expect(looksMinified("")).toBe(false);
  });
});

describe("formatSource (javascript)", () => {
  test("leaves JSX shipped under JavaScript extensions opaque", () => {
    const longText = "safe;payload".repeat(50);
    const element = `const view=<div>${longText}</div>;danger();`;

    expect(looksMinified(element)).toBe(true);
    expect(formatSource(element, "js")).toBeNull();
    expect(formatSource("const view=<Widget value={x}/>;danger();", "js")).toBeNull();
    expect(formatSource("const view=<>safe;payload</>;danger();", "js")).toBeNull();
    expect(formatSource("export default <Widget/>;danger();", "js")).toBeNull();
    expect(formatSource("if(ready)<Widget/>;danger();", "js")).toBeNull();
    expect(formatSource("if(ready)<>safe;payload</>;danger();", "js")).toBeNull();
    expect(formatSource("for(;;)<Widget>safe;payload</Widget>;danger();", "js")).toBeNull();
  });

  test("leaves unambiguous JSX shipped under TypeScript extensions opaque", () => {
    expect(formatSource("const view=<Widget>safe;payload</Widget>;danger();", "ts")).toBeNull();
    expect(formatSource("const view=<Widget value={x}/>;danger();", "ts")).toBeNull();
    expect(formatSource("const view=<>safe;payload</>;danger();", "ts")).toBeNull();
  });

  test("does not mistake relational expressions for JSX", () => {
    const formatted = formatJs("const result=a<b>c;danger();");

    expect(lines(formatted)).toEqual(["const result=a<b>c;", "danger();"]);
  });

  test("keeps TypeScript angle-bracket assertions reformattable", () => {
    const formatted = formatSource("const value=<Result>input;danger();", "ts");

    expect(lines(formatted)).toEqual(["const value=<Result>input;", "danger();"]);
  });

  test("fails closed when inserted whitespace changes a hostile sample's lexical context", () => {
    expect(formatSource("}function f(){}/re;{}/g", "js")).toBeNull();
  });

  test("breaks a minified statement run onto one line each", () => {
    const formatted = formatJs("var a=1;var b=2;var c=3;");

    expect(lines(formatted)).toEqual(["var a=1;", "var b=2;", "var c=3;"]);
  });

  test("indents block bodies and closes at the opening level", () => {
    const formatted = formatJs("function a(){if(b){c()}else{d()}}");

    expect(lines(formatted)).toEqual([
      "function a(){",
      "  if(b){",
      "    c()",
      "  }else{",
      "    d()",
      "  }",
      "}",
    ]);
  });

  test("keeps for-loop separators on one line", () => {
    const formatted = formatJs("for(var i=0;i<10;i++){f(i)}");

    expect(lines(formatted)).toEqual(["for(var i=0;i<10;i++){", "  f(i)", "}"]);
  });

  test("splits object members but keeps short arrays and call arguments intact", () => {
    const formatted = formatJs("var o={a:1,b:[2,3],c:f(4,5)};");

    expect(lines(formatted)).toEqual(["var o={", "  a:1,", "  b:[2,3],", "  c:f(4,5)", "};"]);
  });

  test("never breaks inside a string, template, or regex literal", () => {
    const source = "var a={s:'x;y{z}',t:`p;{q}${r};`,u:/a;b{c}/g};";
    const formatted = formatJs(source);

    expect(lines(formatted)).toEqual([
      "var a={",
      "  s:'x;y{z}',",
      "  t:`p;{q}${r};`,",
      "  u:/a;b{c}/g",
      "};",
    ]);
  });

  test("keeps regexes and nested templates inside interpolation opaque", () => {
    const source = 'const s=`${/}/.test(x) ? `inner;{x}` : "x"}`;foo();';
    const formatted = formatJs(source);

    expect(lines(formatted)).toEqual(['const s=`${/}/.test(x) ? `inner;{x}` : "x"}`;', "foo();"]);
  });

  test("recognizes class and bindingless catch bodies before a regex statement", () => {
    const classSource = formatJs("class A{}/x;y{z}/.test(a);foo();");
    const catchSource = formatJs("try{}catch{}/x;y{z}/.test(a);foo();");

    expect(lines(classSource)).toEqual(["class A{}", "/x;y{z}/.test(a);", "foo();"]);
    expect(lines(catchSource)).toEqual(["try{}catch{}", "/x;y{z}/.test(a);", "foo();"]);
  });

  test("recognizes typed function and TypeScript declaration bodies before a regex", () => {
    const functionSource = formatJs("function f():void{}/x;y{z}/.test(a);foo();");
    const functionTypeSource = formatJs("function f():()=>void{}/x;y{z}/.test(a);foo();");
    const interfaceSource = formatJs("interface Result{value:string}/x;y{z}/.test(a);foo();");

    expect(lines(functionSource)).toEqual(["function f():void{}", "/x;y{z}/.test(a);", "foo();"]);
    expect(lines(functionTypeSource)).toEqual([
      "function f():()=>void{}",
      "/x;y{z}/.test(a);",
      "foo();",
    ]);
    expect(lines(interfaceSource)).toEqual([
      "interface Result{",
      "  value:string",
      "}",
      "/x;y{z}/.test(a);",
      "foo();",
    ]);
  });

  test("recognizes prefixed and decorated TypeScript declarations before a regex", () => {
    for (const source of [
      "export default interface Result{value:string}/x;y{z}/.test(a);foo();",
      "export default enum Result{Value}/x;y{z}/.test(a);foo();",
      "declare global{interface Result{value:string}}/x;y{z}/.test(a);foo();",
      "@sealed class Result{}/x;y{z}/.test(a);foo();",
      "@sealed({deep:true}) class Result{}/x;y{z}/.test(a);foo();",
    ]) {
      const formatted = formatJs(source);

      expect(formatted?.text).toContain("/x;y{z}/.test(a);");
    }
  });

  test("keeps regexes whole after labeled and case-clause blocks", () => {
    const labelSource = formatJs("label:{foo()}/x;y{z}/.test(a);bar();");
    const caseSource = formatJs("switch(a){case 1:{foo()}/x;y{z}/.test(a);break}");

    expect(lines(labelSource)).toEqual(["label:{", "  foo()", "}", "/x;y{z}/.test(a);", "bar();"]);
    expect(lines(caseSource)).toEqual([
      "switch(a){",
      "  case 1:{",
      "    foo()",
      "  }",
      "  /x;y{z}/.test(a);",
      "  break",
      "}",
    ]);
  });

  test("keeps regexes whole after statements directly inside IIFE wrappers", () => {
    // Minified bundles are function-expression wrappers, so labels and nested
    // declarations sit directly inside a body whose closing brace is a value.
    const labeled = formatJs("!function(){e:{foo()}/x;y{z}/.test(a)}()");
    const nested = formatJs("(function(){function g(){}/x;y{z}/.test(a)})()");

    expect(lines(labeled)).toEqual([
      "!function(){",
      "  e:{",
      "    foo()",
      "  }",
      "  /x;y{z}/.test(a)",
      "}()",
    ]);
    expect(lines(nested)).toEqual([
      "(function(){",
      "    function g(){}",
      "    /x;y{z}/.test(a)",
      "  })()",
    ]);
  });

  test("keeps regexes whole after semicolonless declarations", () => {
    for (const source of [
      "call()\nfunction f(){}/x;y{z}/.test(a);foo();",
      "const value=1\nclass A{}/x;y{z}/.test(a);foo();",
      "call()\ninterface Result{value:string}/x;y{z}/.test(a);foo();",
      "call()\n@sealed class Result{}/x;y{z}/.test(a);foo();",
    ]) {
      const formatted = formatJs(source);

      expect(formatted?.text).toContain("/x;y{z}/.test(a);");
    }
  });

  test("keeps regexes whole after bare variable declarations", () => {
    for (const source of [
      "let value\n/a;b{2}/.test(value);safe();",
      "var first,second\n/a;b{2}/.test(value);safe();",
      "let { value }\n/a;b{2}/.test(value);safe();",
    ]) {
      const formatted = formatJs(source);

      expect(formatted?.text).toContain("/a;b{2}/.test(value);");
    }
  });

  test("keeps both diff sides raw when either side rejects reformatting", () => {
    const shared = `const config={a:1,b:2};${"safe();".repeat(90)}`;
    const pair = formatSourcePair(shared, `${shared}const view=<Widget/>;`, "js");

    expect(pair).toEqual({ before: null, after: null });
  });

  test("still formats one side when the other already needs no re-flow", () => {
    const pair = formatSourcePair("const value=1;\n", "const value=1;safe();", "js");

    expect(pair.before).toBeNull();
    expect(pair.after?.text).toBe("const value=1;\nsafe();");
  });

  test("keeps regexes whole after line-terminated statements and type aliases", () => {
    const debuggerSource = formatJs("debugger\n/x;y{2}/.test(a);foo();");
    const breakSource = formatJs("label:while(a){break label\n/x;y{2}/.test(a);foo()}");
    const typeSource = formatJs("type Result={value:string}\n/x;y{2}/.test(a);foo();");
    const scalarTypeSource = formatJs("type Result=string\n/x;y{2}/.test(a);foo();");
    const unionTypeSource = formatJs(
      "type Result={value:string}|{error:Error}\n/x;y{2}/.test(a);foo();",
    );

    expect(lines(debuggerSource)).toEqual(["debugger", "/x;y{2}/.test(a);", "foo();"]);
    expect(breakSource?.text).toContain("/x;y{2}/.test(a);");
    expect(lines(typeSource)).toEqual([
      "type Result={",
      "  value:string",
      "}",
      "/x;y{2}/.test(a);",
      "foo();",
    ]);
    expect(lines(scalarTypeSource)).toEqual(["type Result=string", "/x;y{2}/.test(a);", "foo();"]);
    expect(unionTypeSource?.text).toContain("/x;y{2}/.test(a);");
  });

  test("does not mistake division after a Unicode identifier for a regex", () => {
    const formatted = formatJs("const π=1;const q=π/2;danger();const r=/x;y{2}/;foo();");

    expect(lines(formatted)).toEqual([
      "const π=1;",
      "const q=π/2;",
      "danger();",
      "const r=/x;y{2}/;",
      "foo();",
    ]);
  });

  test("never breaks inside a Unicode identifier escape", () => {
    const formatted = formatJs(String.raw`const \u{61}=1;const valu\u{65}=2;safe();`);

    expect(lines(formatted)).toEqual([
      String.raw`const \u{61}=1;`,
      String.raw`const valu\u{65}=2;`,
      "safe();",
    ]);
  });

  test("keeps scanning after division by function and class expressions", () => {
    const formatted = formatJs(
      "const a=function(){}/2;danger();const b=class{}/3;const c=async function(){}/4;safe();",
    );

    expect(lines(formatted)).toEqual([
      "const a=function(){}/2;",
      "danger();",
      "const b=class{}/3;",
      "const c=async function(){}/4;",
      "safe();",
    ]);
  });

  test("keeps scanning after division by keyword-named member calls", () => {
    const formatted = formatJs(
      "const a=obj.if(value)/2;danger();const b=obj?.while(value)/3;safe();",
    );

    expect(lines(formatted)).toEqual([
      "const a=obj.if(value)/2;",
      "danger();",
      "const b=obj?.while(value)/3;",
      "safe();",
    ]);
  });

  test("keeps contextual function parameters value-shaped inside their body", () => {
    for (const name of ["await", "yield"]) {
      const formatted = formatJs(
        `function f(${name}){return ${name}/2;danger();const re=/a;b{c}/;safe();}`,
      );

      expect(lines(formatted)).toEqual([
        `function f(${name}){`,
        `  return ${name}/2;`,
        "  danger();",
        "  const re=/a;b{c}/;",
        "  safe();",
        "}",
      ]);
    }
  });

  test("keeps contextual bindings value-shaped across ordinary function forms and scopes", () => {
    for (const source of [
      "function f({await}){if(flag){return await/2;const re=/a;b{c}/;safe()}}",
      "const f=(await)=>{return await/2;const re=/a;b{c}/;safe()}",
      "class C{m(await){return await/2;const re=/a;b{c}/;safe()}}",
      "const o={m(await){return await/2;const re=/a;b{c}/;safe()}}",
      "const {await}=value;await/2;const re=/a;b{c}/;safe()",
      "try{}catch(await){await/2;const re=/a;b{c}/;safe()}",
    ]) {
      const formatted = formatJs(source);

      expect(formatted?.text).toContain("await/2;");
      expect(formatted?.text).toContain("const re=/a;b{c}/;");
    }
  });

  test("restores await and yield keyword roles in nested async and generator functions", () => {
    for (const source of [
      "function outer(await){async function inner(){return await /a;b{c}/;safe()}}",
      "function outer(yield){function* inner(){return yield /a;b{c}/;safe()}}",
      "const f=async()=>await /a;b{c}/;safe()",
    ]) {
      expect(formatJs(source)?.text).toContain("/a;b{c}/");
    }
  });

  test("resets contextual modes for computed and generic methods", () => {
    for (const source of [
      "async function outer(){const o={[key](){return await/2;const re=/a;b{c}/;safe()}}}",
      "async function outer(){class C{method<T>(){return await/2;const re=/a;b{c}/;safe()}}}",
      "const o={x:async[key](arg),y:()=>{return await/2;const re=/a;b{c}/;safe()}}",
    ]) {
      const formatted = formatJs(source);

      expect(formatted?.text).toContain("return await/2;");
      expect(formatted?.text).toContain("const re=/a;b{c}/;");
    }
  });

  test("recognizes async and generator modes across computed and generic method heads", () => {
    for (const source of [
      "function outer(){const o={async [key](){return await /a;b{c}/;safe()}}}",
      "function outer(){class C{async method<T>(){return await /a;b{c}/;safe()}}}",
      "function outer(){const o={*[key](){return yield /a;b{c}/;safe()}}}",
      "function outer(){class C{static *[key](){return yield /a;b{c}/;safe()}}}",
    ]) {
      expect(formatJs(source)?.text).toContain("/a;b{c}/");
    }
  });

  test("tracks async generic arrows and expires concise-arrow modes at ASI", () => {
    for (const source of [
      "function outer(){const f=async <T>(value:T)=>await /a;b{c}/;safe()}",
      "async function outer(){const f=()=>0\nreturn await /a;b{c}/;safe()}",
    ]) {
      expect(formatJs(source)?.text).toContain("/a;b{c}/");
    }

    const division = formatJs(
      "var await=4;const f=async()=>0\nif(flag) await/2;const re=/a;b{c}/;safe()",
    );
    expect(division?.text).toContain("if(flag) await/2;");
    expect(division?.text).toContain("const re=/a;b{c}/;");
  });

  test("restores ordinary contextual modes after unrelated async syntax", () => {
    for (const source of [
      "var await=4;async(value);const f=()=>await/2;const re=/a;b{c}/;safe()",
      "var await=4;const f=flag?async()=>0:await/2;const re=/a;b{c}/;safe()",
      "var await=4;async function outer(){class C{async\n[key](){return await/2;const re=/a;b{c}/;safe()}}}",
    ]) {
      const formatted = formatJs(source);

      expect(formatted?.text).toContain("await/2;");
      expect(formatted?.text).toContain("const re=/a;b{c}/;");
    }
  });

  test("recognizes statement lists inside class static blocks", () => {
    const formatted = formatJs(
      "class C{static{function f(){}/x;y{z}/.test(a);foo()}}" +
        "const D=class{static{label:{bar()}/a;b{c}/.test(d)}};safe();",
    );

    expect(formatted?.text).toContain("/x;y{z}/.test(a);");
    expect(formatted?.text).toContain("/a;b{c}/.test(d)");
    expectTokenStreamPreserved(
      "class C{static{function f(){}/x;y{z}/.test(a);foo()}}" +
        "const D=class{static{label:{bar()}/a;b{c}/.test(d)}};safe();",
      formatted,
    );
  });

  test("keeps class bodies pending past same-depth heritage expression bodies", () => {
    const source =
      "class C extends function(){}{static{function f(){}/x;y{z}/.test(a)}}" +
      "class D extends class{}{static{label:{bar()}/a;b{c}/.test(d)}}";
    const formatted = formatJs(source);

    expect(formatted?.text).toContain("/x;y{z}/.test(a)");
    expect(formatted?.text).toContain("/a;b{c}/.test(d)");
    expectTokenStreamPreserved(source, formatted);
  });

  test("keeps scanning after division by exported expression initializers", () => {
    const formatted = formatJs(
      "export const a={}/2;danger();export const b='text'\n/3;" +
        "export const c=class{}/4;export const d=function(){}/5;safe();",
    );

    expect(lines(formatted)).toEqual([
      "export const a={}/2;",
      "danger();",
      "export const b='text'",
      "/3;",
      "export const c=class{}/4;",
      "export const d=function(){}/5;",
      "safe();",
    ]);
  });

  test("does not treat an ASI-terminated break followed by division as a labeled break", () => {
    const formatted = formatJs("while(a){break\nvalue\n/2;danger()}");

    expect(formatted?.text).toContain("value\n/2;");
    expect(formatted?.text).toContain("danger()\n}");
  });

  test("keeps expression-leading and statement-position regexes whole", () => {
    const exported = formatJs("export default /a;b{c}/g;foo();");
    const extended = formatJs("class A extends /a;b{c}/.constructor{};foo();");
    const forAwait = formatJs("async function f(){for await(x of xs)/a;b{c}/.test(x);foo();}");

    expect(lines(exported)).toEqual(["export default /a;b{c}/g;", "foo();"]);
    expect(lines(extended)).toEqual(["class A extends /a;b{c}/.constructor{};", "foo();"]);
    expect(lines(forAwait)).toEqual([
      "async function f(){",
      "  for await(x of xs)/a;b{c}/.test(x);",
      "  foo();",
      "}",
    ]);
  });

  test("keeps regex statements after static module declarations whole", () => {
    const bareImport = formatJs("import'x'\n/a;b{c}/.test(value);safe();");
    const namedExport = formatJs("const x=1;export{x}\n/a;b{c}/.test(value);safe();");

    expect(bareImport?.text).toContain("/a;b{c}/.test(value);");
    expect(namedExport?.text).toContain("/a;b{c}/.test(value);");
  });

  test("keeps regex statements after multiline type aliases whole", () => {
    for (const source of [
      "type Result=A|\nB\n/a;b{c}/.test(value);safe();",
      "type Result=A&\nB\n/a;b{c}/.test(value);safe();",
      "type Result=A extends B?\nC:D\n/a;b{c}/.test(value);safe();",
      "type Result=A extends B?C:\nD\n/a;b{c}/.test(value);safe();",
    ]) {
      expect(formatTs(source)?.text).toContain("/a;b{c}/.test(value);");
    }
  });

  test("keeps regex statements after TypeScript import-equals declarations whole", () => {
    for (const source of [
      "import Foo=require('foo')\n/a;b{c}/.test(value);safe();",
      "export import Foo=require('foo')\n/a;b{c}/.test(value);safe();",
      "import Foo=Bar.Baz\n/a;b{c}/.test(value);safe();",
    ]) {
      expect(formatTs(source)?.text).toContain("/a;b{c}/.test(value);");
    }
  });

  test("keeps regex statements after semicolonless ambient functions whole", () => {
    for (const source of [
      "declare function f():Result\n/a;b{c}/.test(value);safe();",
      "export declare function f<T>():T\n/a;b{c}/.test(value);safe();",
    ]) {
      expect(formatTs(source)?.text).toContain("/a;b{c}/.test(value);");
    }
  });

  test("never breaks inside strings containing JSON-superset line separators", () => {
    for (const separator of ["\u2028", "\u2029"]) {
      const source = `const text="before${separator}'chi'+'ld_process';after";safe();`;
      const formatted = formatJs(source);

      expect(formatted?.text).toBe(
        `const text="before${separator}'chi'+'ld_process';after";\nsafe();`,
      );
    }
  });

  test("does not swallow division after a postfix update into a regex token", () => {
    const formatted = formatJs("var x=i++/2;danger();var y=i--/3;safe();");

    expect(lines(formatted)).toEqual(["var x=i++/2;", "danger();", "var y=i--/3;", "safe();"]);
  });

  test("keeps TypeScript assertions attached to closing object literals", () => {
    const formatted = formatJs("const config={} as const;const checked={} satisfies Config;foo();");

    expect(lines(formatted)).toEqual([
      "const config={} as const;",
      "const checked={} satisfies Config;",
      "foo();",
    ]);
  });

  test("does not overflow on deeply nested templates", () => {
    let source = "x";
    for (let depth = 0; depth < 16_000; depth += 1) source = "`${" + source + "}`";

    expect(() => formatSource(source, "js")).not.toThrow();
    expect(formatSource(source, "js")).toBeNull();
  });

  test("keeps a trailing line comment with its statement and code below it", () => {
    const formatted = formatJs("a();// note ; and { and }\nb();c();");

    expect(lines(formatted)).toEqual(["a();// note ; and { and }", "b();", "c();"]);
  });

  test("never reflows Annex B HTML-like comments as executable code", () => {
    const open = `<!-- ${"fake();{payload}".repeat(40)}`;
    const close = `safe();\n  --> ${"fake();{payload}".repeat(40)}\nsafe();danger();`;

    expect(looksMinified(open)).toBe(true);
    expect(formatJs(open)).toBeNull();
    expect(formatJs(close)?.text).toBe(
      `safe();\n  --> ${"fake();{payload}".repeat(40)}\nsafe();\ndanger();`,
    );
  });

  test("keeps regexes whole after typed variable declarations", () => {
    for (const source of [
      "let value:string\n/a;b{c}/.test(value);safe();",
      "let value:A |\nB\n/a;b{c}/.test(value);safe();",
      "declare let value:{nested:string}\n/a;b{c}/.test(value);safe();",
      "export let value:string\n/a;b{c}/.test(value);safe();",
    ]) {
      expect(formatTs(source)?.text).toContain("/a;b{c}/.test(value);");
    }
  });

  test("keeps scanning after contextual identifiers and typed arrows divide", () => {
    for (const source of [
      "var of=4;const ratio=of/2;danger();safe();",
      "var await=4;const ratio=await/2;danger();safe();",
      "var yield=4;const ratio=yield/2;danger();safe();",
      "const f=():void=>{}\nexport default <any>{a:1}/2;danger();safe();",
    ]) {
      const formatted = formatTs(source);

      expect(formatted?.text).toContain("/2;");
      expect(formatted?.text).toContain("danger();\nsafe();");
    }
  });

  test("keeps a package executable hashbang on its shipped line", () => {
    const formatted = formatJs(
      "#!/usr/bin/env -S node --conditions={a,b}\n" + "a();b();".repeat(60),
    );

    expect(lines(formatted)?.slice(0, 3)).toEqual([
      "#!/usr/bin/env -S node --conditions={a,b}",
      "a();",
      "b();",
    ]);
  });

  test("gives a block comment between statements its own line", () => {
    const formatted = formatJs("a();/* note */b();");

    expect(lines(formatted)).toEqual(["a();", "/* note */b();"]);
  });

  test("leaves an already-formatted source untouched", () => {
    const source = "function a() {\n  b();\n  c();\n}\n";

    expect(formatSource(source, "js")).toBeNull();
  });

  test("returns null for an empty sample and for one past the size cap", () => {
    expect(formatSource("", "js")).toBeNull();
    expect(formatSource(`a();${"b();".repeat(FORMAT_MAX_CHARS)}`, "js")).toBeNull();
  });

  test("re-flows a minified JSON payload", () => {
    const formatted = formatJson('{"name":"pkg","bin":{"x":"./x.js"},"files":["dist"]}');

    expect(lines(formatted)).toEqual([
      "{",
      '  "name":"pkg",',
      '  "bin":{',
      '    "x":"./x.js"',
      "  },",
      '  "files":[',
      '    "dist"',
      "  ]",
      "}",
    ]);
  });

  test("re-flows top-level and nested JSON arrays", () => {
    const formatted = formatJson('[1,2,{"three":[3,4]}]');

    expect(lines(formatted)).toEqual([
      "[",
      "  1,",
      "  2,",
      "  {",
      '    "three":[',
      "      3,",
      "      4",
      "    ]",
      "  }",
      "]",
    ]);
  });

  test("turns an auto-detected minified JSON array into readable rows", () => {
    const source = `[${Array.from({ length: 300 }, (_, index) => index).join(",")}]`;

    expect(looksMinified(source)).toBe(true);
    expect(lines(formatJson(source))).toHaveLength(302);
  });

  test("survives truncated samples without dropping the tail", () => {
    // Diff samples are clipped at a byte budget, so unterminated strings, block
    // comments, and blocks are routine input rather than an edge case.
    for (const source of ['a();var s="unterminated', "a();/* unterminated", "a();function f(){"]) {
      const formatted = formatSource(source, "js");
      expect(formatted?.text.replace(/\n\s*/g, "") ?? source).toContain(
        source.slice(4).replace(/\n\s*/g, ""),
      );
    }
  });
});

describe("formatSource (css)", () => {
  test("breaks rules and declarations apart", () => {
    const formatted = formatSource(".a{color:red;margin:0}.b{padding:0}", "css");

    expect(lines(formatted)).toEqual([
      ".a{",
      "  color:red;",
      "  margin:0",
      "}",
      ".b{",
      "  padding:0",
      "}",
    ]);
  });

  test("indents nested at-rules", () => {
    const formatted = formatSource("@media(min-width:0){.a{color:red}}", "css");

    expect(lines(formatted)).toEqual([
      "@media(min-width:0){",
      "  .a{",
      "    color:red",
      "  }",
      "}",
    ]);
  });

  test("does not break inside an unquoted url() or a string", () => {
    const source = '.a{background:url(//cdn.example.com/a;b{c}.png);content:"x;y{z}"}';
    const formatted = formatSource(source, "css");

    expect(lines(formatted)).toEqual([
      ".a{",
      "  background:url(//cdn.example.com/a;b{c}.png);",
      '  content:"x;y{z}"',
      "}",
    ]);
  });

  test("does not treat escaped CSS delimiters as structure", () => {
    const selector = formatSource(".foo\\;bar{color:red}", "css");
    const url = formatSource(".a{background:url(foo\\)bar;baz{qux});color:red}", "css");

    expect(lines(selector)).toEqual([".foo\\;bar{", "  color:red", "}"]);
    expect(lines(url)).toEqual([
      ".a{",
      "  background:url(foo\\)bar;baz{qux});",
      "  color:red",
      "}",
    ]);
  });

  test("keeps escaped spellings of url() opaque", () => {
    const source = String.raw`.a{background:u\72l(data:image/svg+xml;utf8,<svg>{}</svg>);color:red}`;
    const formatted = formatSource(source, "css");

    expect(lines(formatted)).toEqual([
      ".a{",
      String.raw`  background:u\72l(data:image/svg+xml;utf8,<svg>{}</svg>);`,
      "  color:red",
      "}",
    ]);
  });

  test("does not break inside a comment", () => {
    const formatted = formatSource("/*! a;b{c} */.a{color:red}", "css");

    expect(lines(formatted)).toEqual(["/*! a;b{c} */.a{", "  color:red", "}"]);
  });

  test("leaves an already-formatted stylesheet untouched", () => {
    // Every break point already ends its line, so there is nothing to gain and a
    // blank line to lose. Stylesheets reach this surface unminified whenever a
    // single long line — one `data:` URI is enough — trips `looksMinified`.
    const source = ".a {\n  color: red;\n  margin: 0;\n}\n.b {\n  padding: 0;\n}\n";

    expect(formatSource(source, "css")).toBeNull();
  });

  test("breaks only what a partially minified stylesheet left on one line", () => {
    const formatted = formatSource(".a{\ncolor:red;margin:0}\n.b{padding:0}\n", "css");

    expect(lines(formatted)).toEqual([
      ".a{",
      "color:red;",
      "  margin:0",
      "}",
      ".b{",
      "  padding:0",
      "}",
      "",
    ]);
  });
});

describe("css formatting invariants", () => {
  // The CSS side is a hand-rolled character scanner rather than a lexer walk, so
  // it gets its own invariants: it may only move whitespace around.
  const cssFragment = fc.constantFrom(
    ".a{",
    "@media(min-width:0){",
    "}",
    "color:red;",
    "margin:0",
    'content:"x;y{z}"',
    "background:url(//cdn.example.com/a;b{c}.png)",
    "/*! a;b{c} */",
    ";",
    "\n",
    " ",
    "\t",
    "'q;{",
    '"',
    "\\",
  );

  test("preserves every non-whitespace character", () => {
    fc.assert(
      fc.property(fc.array(cssFragment, { maxLength: 40 }), (parts) => {
        const source = parts.join("");
        const formatted = formatSource(source, "css");
        if (!formatted) return;
        expect(formatted.text.replace(/\s/g, "")).toBe(source.replace(/\s/g, ""));
      }),
      { numRuns: 500 },
    );
  });

  test("never inserts a blank line and keeps the source line map in range", () => {
    fc.assert(
      fc.property(fc.array(cssFragment, { maxLength: 40 }), (parts) => {
        const source = parts.join("");
        const formatted = formatSource(source, "css");
        if (!formatted) return;
        const outputLines = formatted.text.split("\n");
        expect(formatted.sourceLines).toHaveLength(outputLines.length);
        expect(Math.max(...formatted.sourceLines)).toBeLessThanOrEqual(source.split("\n").length);
        // A blank line the source did not have is a row the reviewer scrolls past
        // for nothing — and doubles the height of every rule when it recurs.
        const sourceBlanks = source.split("\n").filter((line) => !line.trim()).length;
        expect(outputLines.filter((line) => !line.trim()).length).toBeLessThanOrEqual(sourceBlanks);
      }),
      { numRuns: 500 },
    );
  });
});

describe("source line mapping", () => {
  test("maps every line of a reformatted one-liner back to line 1", () => {
    const formatted = formatJs("var a=1;var b=2;function c(){d()}");

    expect(formatted?.sourceLines).toEqual([1, 1, 1, 1, 1]);
  });

  test("keeps counting original lines across a partially minified file", () => {
    const formatted = formatJs("// banner\nvar a=1;var b=2;\nvar c=3;");

    expect(formatted?.text).toBe("// banner\nvar a=1;\nvar b=2;\nvar c=3;");
    expect(formatted?.sourceLines).toEqual([1, 2, 2, 3]);
  });

  test("counts the newlines a template literal carries", () => {
    const formatted = formatJs("var a=`one\ntwo`;var b=2;");

    expect(lines(formatted)).toEqual(["var a=`one", "two`;", "var b=2;"]);
    expect(formatted?.sourceLines).toEqual([1, 2, 2]);
  });
});

describe("remapFindingLines", () => {
  const formatted = formatJs("// banner\nvar a=1;var b=2;\nvar c=3;");

  test("re-pins findings onto the reformatted line and remembers the source line", () => {
    const [banner, body, tail] = remapFindingLines(
      [
        { id: "a", line: 1 },
        { id: "b", line: 2 },
        { id: "c", line: 3 },
      ],
      formatted,
    );

    // Lines 1 and 2 still start where they did, so they are returned untouched;
    // line 3 shifts down by the break inserted inside line 2 and records where
    // it came from.
    expect(banner).toEqual({ id: "a", line: 1 });
    expect(body).toEqual({ id: "b", line: 2 });
    expect(tail).toEqual({ id: "c", line: 4, sourceLine: 3 });
  });

  test("leaves findings alone when nothing was reformatted", () => {
    const findings = [{ id: "a", line: 7 }];

    expect(remapFindingLines(findings, null)).toBe(findings);
  });

  test("passes through findings with no line", () => {
    expect(remapFindingLines([{ id: "a" }, { id: "b", line: null }], formatted)).toEqual([
      { id: "a" },
      { id: "b", line: null },
    ]);
  });

  test("pins every finding on a minified one-liner to the top of the file", () => {
    const oneLiner = formatJs("var a=1;var b=2;var c=3;");

    expect(remapFindingLines([{ id: "a", line: 1 }], oneLiner)).toEqual([{ id: "a", line: 1 }]);
  });

  test("keeps a finding on its own source line when that line splits into many", () => {
    // Line 2 becomes four rows. A finding on line 2 must not drift onto a row
    // carved out of line 1 or line 3 — that would point the reviewer at code the
    // rule never matched.
    const split = formatJs("var head=0;\nif(a){b();c()}\nvar tail=1;");
    expect(lines(split)).toEqual(["var head=0;", "if(a){", "  b();", "  c()", "}", "var tail=1;"]);

    const [finding] = remapFindingLines([{ id: "a", line: 2 }], split);

    // Row 2 is where source line 2 now starts, and rows 2-5 all belong to it.
    expect(finding).toEqual({ id: "a", line: 2 });
    expect(split?.sourceLines.slice(1, 5)).toEqual([2, 2, 2, 2]);
  });

  test("unpins a finding whose line does not exist on this side", () => {
    // The rules run on the scan's 128 KiB sample; this surface may have cached a
    // shorter one. Reformatting adds rows, so a line past the end of the sample
    // would otherwise start landing on an unrelated row instead of the banner.
    const short = formatJs("if(a){b();c()}");

    expect(remapFindingLines([{ id: "a", line: 4 }], short)).toEqual([
      { id: "a", line: null, sourceLine: 4 },
    ]);
  });

  test("never moves a finding onto a row from a different source line", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom("var a=1;", "if(x){y()}", "f({a:1,b:2});", "\n", "// c\n", "g();"),
          { maxLength: 30 },
        ),
        fc.integer({ min: 1, max: 30 }),
        (parts, line) => {
          const source = parts.join("");
          const formatted = formatSource(source, "js");
          if (!formatted) return;
          const [finding] = remapFindingLines([{ id: "a", line }], formatted);
          // The caption always names the artifact's line, pinned or not.
          expect(finding.sourceLine ?? finding.line).toBe(line);
          const row = finding.line;
          // A line this side does not have is unpinned; anything pinned points
          // at a row that came from the line the rule actually reported.
          if (row === null) {
            expect(formatted.sourceLines).not.toContain(line);
            return;
          }
          expect(formatted.sourceLines[row - 1]).toBe(line);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("formatting invariants", () => {
  test("preserves the token stream for arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (source) => {
        expectTokenStreamPreserved(source, formatSource(source, "js"));
      }),
      { numRuns: 500 },
    );
  });

  test("preserves the token stream for generated JavaScript-shaped input", () => {
    const fragment = fc.constantFrom(
      "var a=1;",
      "function f(){",
      "}",
      "if(x){y()}else{z()}",
      "{a:1,b:2}",
      "`t${x}`",
      "/re;{}/g",
      "'s;{}'",
      '"d;{}"',
      "// c\n",
      "/* c */",
      "for(i=0;i<2;i++){g()}",
      "[1,2,3]",
      "a.b(c,d);",
      "\n",
      " ",
    );
    fc.assert(
      fc.property(fc.array(fragment, { maxLength: 40 }), (parts) => {
        expectTokenStreamPreserved(parts.join(""), formatSource(parts.join(""), "js"));
      }),
      { numRuns: 500 },
    );
  });

  test("every output line maps to a source line that exists", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (source) => {
        const formatted = formatSource(source, "js");
        if (!formatted) return;
        const outputLines = formatted.text.split("\n").length;
        const sourceLineCount = source.split("\n").length;
        expect(formatted.sourceLines).toHaveLength(outputLines);
        expect(Math.max(...formatted.sourceLines)).toBeLessThanOrEqual(sourceLineCount);
        // The map is non-decreasing: reformatting never reorders content.
        for (let index = 1; index < formatted.sourceLines.length; index += 1) {
          expect(formatted.sourceLines[index]).toBeGreaterThanOrEqual(
            formatted.sourceLines[index - 1],
          );
        }
      }),
      { numRuns: 500 },
    );
  });

  test("never emits a blank line a reviewer has to scroll past", () => {
    const formatted = formatJs("var a=1; var b=2;  \tvar c=3;");

    expect(lines(formatted)).toEqual(["var a=1;", "var b=2;", "var c=3;"]);
  });

  test("adds no blank line the source did not already have", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (source) => {
        const formatted = formatSource(source, "js");
        if (!formatted) return;
        const sourceBlanks = source.split("\n").filter((line) => !line.trim()).length;
        const outputBlanks = formatted.text.split("\n").filter((line) => !line.trim()).length;
        expect(outputBlanks).toBeLessThanOrEqual(sourceBlanks);
      }),
      { numRuns: 500 },
    );
  });
});
