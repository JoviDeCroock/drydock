import { describe, expect, test } from "vitest";
import { jsTokenText, tokenizeJs } from "../server/lib/platform/js-lexer";

// `/` is the one character whose meaning a lexer cannot read off the preceding
// character alone, and both consumers are hurt by getting it wrong: the constant
// folder would fold inside a regex literal, and the diff view's reformatter
// would insert a line break inside one (a regex cannot span lines, so the
// reviewer would be shown code that does not parse).
function kinds(source: string): string {
  return tokenizeJs(source)
    .filter((token) => token.type !== "ws")
    .map((token) => `${token.type}:${jsTokenText(source, token)}`)
    .join(" ");
}

function firstSlash(source: string): string {
  const token = tokenizeJs(source).find(
    (candidate) => jsTokenText(source, candidate)[0] === "/" && candidate.type !== "comment",
  );
  return token ? token.type : "none";
}

describe("tokenizeJs comments", () => {
  test("keeps a leading hashbang opaque", () => {
    const source = "#!/usr/bin/env -S node --conditions={a,b}\nconst value=1;";

    expect(kinds(source)).toBe(
      "comment:#!/usr/bin/env -S node --conditions={a,b} ident:const ident:value punct:= number:1 punct:;",
    );
  });
});

describe("tokenizeJs regex vs division", () => {
  test("reads a slash after a value as division", () => {
    for (const source of [
      "f(a)/2/b", // call result
      "a[0]/2/b", // element access
      "({a:1})/2/b", // parenthesised expression
      "var o={a:1}/2/b", // object literal
      "var o={a:{}/2/b}", // object value after a property colon
      "var o=a?b:{}/2/b", // object value after a conditional colon
      "return{a:1}/2/b", // object literal after a keyword
      "const C=class{}/2/b", // class expression result
      "const f=function(){}/2/b", // function expression result
      "const f=async function(){}/2/b", // async function expression result
      "const f=function(a=function(){}){}/2/b", // nested defaults keep the outer body pending
      "const C=class extends mixin(class{}){}/2/b", // nested class expressions do the same
      "const C=class extends function(){}{}/2/b", // same-depth function heritage body opens first
      "const C=class extends class{}{}/2/b", // as does a same-depth class heritage body
      "class C{class={}/2/b}", // a field named `class`, not a nested declaration
      "var o={module,x:{}/2/b}", // declaration-shaped object shorthand
      "a.b/2/c", // property
      "obj.if(a)/2/b", // keyword-shaped method name
      "obj?.while(a)/2/b", // optional keyword-shaped method name
      "obj.for.await(a)/2/b", // property chain that resembles `for await`
      "1/2/3", // numbers
      "i++/2/b", // postfix update result
      "i--/2/b", // postfix update result
      "result.default/2/b", // keyword-shaped property name
      "result.return/2/b", // keyword-shaped property name
      "result?.extends/2/b", // optional keyword-shaped property name
      "typeof x/2/b", // the operand, not the keyword, precedes the slash
      "value\n/2/b", // an ordinary line break does not force ASI
      "while(a){break\nvalue\n/2/b}", // `value` is not a same-line break label
      "while(a){continue\nvalue\n/2/b}", // nor a same-line continue label
      "const π=1;π/2/b", // non-ASCII identifiers are still values
      "const 变量=1;变量/2/b", // including non-Latin scripts
      "export const value={}\n/2/b", // exported object initializer result
      "export const value='text'\n/2/b", // a string initializer is not a module specifier
      "export const value=class{}\n/2/b", // exported class-expression result
      "export const value=function(){}\n/2/b", // exported function-expression result
      "!function(){}/2/b", // an IIFE wrapper's own closing brace is still a value
      "const C=class{m(){}}/2/b", // and so is a class expression's, past its members
    ]) {
      expect(`${source} -> ${firstSlash(source)}`).toBe(`${source} -> punct`);
    }
  });

  test("reads a slash in statement position as a regex", () => {
    for (const source of [
      "if(a)/x/.test(a)",
      "while(a)/x/.test(a)",
      "for(;;)/x/.test(a)",
      "if(a){b()}/x/.test(a)",
      "for(;;){}/x/.test(a)",
      "function f(){}/x/.test(a)",
      "a=>{}/x/.test(a)",
      "class A{}/x/.test(a)",
      "export default class extends mixin({a:1}){}/x/.test(a)",
      "function f():void{}/x/.test(a)",
      'function f():{value:string}{return{value:""}}/x/.test(a)',
      "class C{method():Result{}}/x/.test(a)",
      "interface Result{value:string}/x/.test(a)",
      "export default interface Result{value:string}/x/.test(a)",
      "export default enum Result{Value}/x/.test(a)",
      "declare global{interface Result{value:string}}/x/.test(a)",
      "@sealed class Result{}/x/.test(a)",
      "@sealed({deep:true}) class Result{}/x/.test(a)",
      "try{}catch{}/x/.test(a)",
      "label:{b()}/x/.test(a)",
      "switch(a){case 1:{b()}/x/.test(a)}",
      "switch(a){case b ? c : d:{b()}/x/.test(a)}",
      "switch(a){default:{b()}/x/.test(a)}",
      "async function f(){for await(x of xs)/x/.test(a)}",
      "export default /x/.test(a)",
      "class A extends /x/.constructor{}",
      "return /x/.test(a)",
      "a=/x/.test(a)",
      "/x/.test(a)",
      "debugger\n/x/.test(a)",
      "debugger/*\n*/ /x/.test(a)",
      "debugger\u2028/x/.test(a)",
      "while(a){break\n/x/.test(a)}",
      "label:while(a){continue label\n/x/.test(a)}",
      "type Result={value:string}\n/x/.test(a)",
      "type Result=string\n/x/.test(a)",
      "type Result={a:string}|{b:string}\n/x/.test(a)",
      "import 'x'\n/x/.test(a)",
      "import { x } from 'x'\n/x/.test(a)",
      "import 'x'\nimport 'y'\n/x/.test(a)",
      "const x=1;export { x }\n/x/.test(a)",
      "import 'x'\nclass A{}/x/.test(a)",
      "import 'x'\n{}/x/.test(a)",
      // Minified bundles are IIFE wrappers, so statement positions directly
      // inside a function-expression body are the common case, not a corner.
      "!function(){e:{b()}/x/.test(a)}()",
      "(function(){e:{b()}/x/.test(a)})()",
      "!function(){function g(){}/x/.test(a)}()",
      "!function(){if(a){b()}/x/.test(a)}()",
      "var f=function(){interface R{v:string}/x/.test(a)}",
      "!function(){type T={a:1}\n/x/.test(a)}()",
      "class C{static{function f(){}/x/.test(a)}}",
      "const C=class{static{label:{b()}/x/.test(a)}}",
      "class C extends function(){}{}/x/.test(a)",
      "class C extends class{}{}/x/.test(a)",
      "class C extends function(){}{static{function f(){}/x/.test(a)}}",
      "class C extends class{}{static{label:{b()}/x/.test(a)}}",
      "call()\nfunction f(){}/x/.test(a)",
      "const value=1\nclass A{}/x/.test(a)",
      "call()\ninterface Result{value:string}/x/.test(a)",
      "call()\nimport 'x'\n/x/.test(a)",
      "call()\n@sealed class Result{}/x/.test(a)",
    ]) {
      expect(`${source} -> ${firstSlash(source)}`).toBe(`${source} -> regex`);
    }
  });

  test("keeps line-broken function and class expressions value-shaped", () => {
    for (const source of ["const f=\nfunction(){}/2/b", "const C=\nclass{}/2/b"]) {
      expect(`${source} -> ${firstSlash(source)}`).toBe(`${source} -> punct`);
    }
  });

  test("keeps a statement-position regex whole", () => {
    // The failure this guards: `;` and `{` inside the regex body read as real
    // punctuation, which is what let the reformatter break a line inside it.
    expect(kinds("if(a)/x;y{z}/.test(a)")).toBe(
      "ident:if punct:( ident:a punct:) regex:/x;y{z}/ punct:. ident:test punct:( ident:a punct:)",
    );
  });

  test("keeps Unicode identifiers in one token", () => {
    expect(kinds("const π=变量𐊧;")).toBe("ident:const ident:π punct:= ident:变量𐊧 punct:;");
    expect(kinds(String.raw`const \u{61}=valu\u0065;`)).toBe(
      String.raw`ident:const ident:\u{61} punct:= ident:valu\u0065 punct:;`,
    );
  });

  test("keeps JSON-superset line separators inside quoted strings", () => {
    for (const separator of ["\u2028", "\u2029"]) {
      const source = `const text="before${separator}'chi'+'ld_process';after";`;
      const strings = tokenizeJs(source).filter((token) => token.type === "string");

      expect(strings).toHaveLength(1);
      expect(jsTokenText(source, strings[0])).toBe(`"before${separator}'chi'+'ld_process';after"`);
    }
  });

  test("keeps comments, regexes, and nested templates whole inside interpolation", () => {
    const source = 'const s=`${/}/.test(x) ? `inner;{x}` : "x"}`;';
    const template = tokenizeJs(source).find((token) => token.type === "template");

    expect(template && jsTokenText(source, template)).toBe('`${/}/.test(x) ? `inner;{x}` : "x"}`');
    expect(tokenizeJs(source).filter((token) => token.type === "template")).toHaveLength(1);

    const comment = "const s=`${/* } and ` */ `inner;{x}`}`;";
    const commentTemplate = tokenizeJs(comment).find((token) => token.type === "template");
    expect(commentTemplate && jsTokenText(comment, commentTemplate)).toBe(
      "`${/* } and ` */ `inner;{x}`}`",
    );
  });

  test("scans unbalanced brackets to EOF instead of throwing", () => {
    // Samples are clipped at a byte budget, so a source that closes brackets it
    // never opened is routine input rather than an edge case.
    expect(kinds("a)/2/b")).toBe("ident:a punct:) punct:/ number:2 punct:/ ident:b");
    expect(() => tokenizeJs("}/x/".repeat(50))).not.toThrow();
  });

  test("does not overflow on deeply nested templates", () => {
    let source = "x";
    for (let depth = 0; depth < 16_000; depth += 1) source = "`${" + source + "}`";

    expect(() => tokenizeJs(source)).not.toThrow();
    expect(tokenizeJs(source)).toEqual([{ type: "template", start: 0, end: source.length }]);
  });

  test("clears deeply nested pending function bodies in bounded time", () => {
    // Truncated hostile samples can open many nested function expressions
    // without ever reaching their bodies. Cleanup must be keyed by depth:
    // filtering the complete pending list at each closing `);` is quadratic.
    const depth = 24_000;
    const source = `x=${"function(".repeat(depth)}x${");".repeat(depth)}`;
    const start = performance.now();

    const tokens = tokenizeJs(source);

    expect(tokens).toHaveLength(depth * 4 + 3);
    expect(performance.now() - start).toBeLessThan(1_500);
  }, 5_000);
});
