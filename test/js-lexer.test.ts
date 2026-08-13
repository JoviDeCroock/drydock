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

  test("keeps Annex B HTML-like line comments opaque", () => {
    const source = "<!-- fake();{payload}\nsafe();\n  --> fake();{payload}\nsafe();";

    expect(kinds(source)).toBe(
      "comment:<!-- fake();{payload} ident:safe punct:( punct:) punct:; comment:--> fake();{payload} ident:safe punct:( punct:) punct:;",
    );

    const interpolation = "const value=`${<!-- fake();{payload}\n1}`;";
    expect(kinds(interpolation)).toBe(
      "ident:const ident:value punct:= template:`${<!-- fake();{payload}\n1}` punct:;",
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
      "import('x')/2/b", // dynamic import result
      "import.meta.url/2/b", // import.meta member result
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
      "var of=4;const ratio=of/2/b", // contextual `of` used as a script binding
      "var await=4;const ratio=await/2/b", // contextual `await` used as a script binding
      "var yield=4;const ratio=yield/2/b", // contextual `yield` used as a sloppy binding
      "function f(await){return await/2/b}", // contextual name used as an ordinary parameter
      "function f(yield){return yield/2/b}", // likewise in a non-generator function
      "function f({await}){if(flag){return await/2/b}}", // destructured params survive nested blocks
      "const f=(await)=>await/2/b", // ordinary arrow parameters are values too
      "class C{m(await){return await/2/b}}", // as are ordinary method parameters
      "const o={m(await){return await/2/b}}", // including object methods
      "async function outer(){const o={[key](){return await/2/b}}}", // computed methods reset an outer async mode
      "async function outer(){class C{method<T>(){return await/2/b}}}", // as do generic methods
      "const o={x:async[key](arg),y:()=>{return await/2/b}}", // computed calls are not methods
      "var await=4;const f=async()=>0\nif(flag) await/2/b", // concise-arrow mode ends at ASI
      "var await=4;async(value);const f=()=>await/2/b", // a prior async call cannot make a later arrow async
      "var await=4;const f=flag?async()=>0:await/2/b", // a conditional alternate restores its outer mode
      "var await=4;async function outer(){class C{async\n[key](){return await/2/b}}}", // ASI makes this an ordinary computed method
      "const {await}=value;await/2/b", // destructured lexical bindings stay visible
      "const {await,await:alias}=value;await/2/b", // property keys cannot erase a prior binding
      "try{}catch(await){await/2/b}", // catch bindings scope over their body
      "try{}catch({await,await:alias}){await/2/b}", // including mixed shorthand/key patterns
      "async function outer(){function inner(){return await/2/b}}", // ordinary nested functions reset async context
      "async function outer(){function inner(x=await/2/b){}}", // including their parameter initializers
      "async function outer(){class C{x=await/2/b}}", // instance fields reset an enclosing async context
      "for(let await of xs){await/2/b}", // lexical for-head bindings scope over a braced body
      "for(const {await} of xs)await/2/b", // and over a concise body
      "{var await=4}await/2/b", // var bindings survive a nested statement block
      "function await(){}await/2/b", // declaration names bind in the containing scope
      "class yield{}yield/2/b", // including contextual class names in sloppy scripts
      "class C{#await=4;m(){return this.#await/2/b}}", // private names are values too
      "const f=():void=>{}\nexport default <any>{a:1}/2/b", // typed arrows cannot leak body state
      "const f=():number=>1\nconst value={a:1}/2/b", // including expression-bodied arrows ending by ASI
      "let value:Outer<Inner<string>>=factory()\nvalue/2/b", // generic closers can share `=`
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
      "function f():()=>void{}/x/.test(a)",
      "function outer(await){async function inner(){return await /x/}}",
      "function outer(yield){function* inner(){return yield /x/}}",
      "const f=async()=>await /x/",
      "class C{async f(){return await /x/}}",
      "class C{*f(){return yield /x/}}",
      "class C{async #f(){return await /x/}}",
      "class C{*#f(){return yield /x/}}",
      "class C{static async *#f(){return yield /x/}}",
      "function outer(){const o={async [key](){return await /x/}}}",
      "function outer(){class C{async method<T>(){return await /x/}}}",
      "function outer(){class C{static *[key](){return yield /x/}}}",
      "function outer(){const f=async <T>(value:T)=>await /x/}",
      "async function outer(){const f=()=>0\nreturn await /x/}",
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
      "type Result=A|\nB\n/x/.test(a)",
      "type Result=A&\nB\n/x/.test(a)",
      "type Result=A extends B?\nC:D\n/x/.test(a)",
      "type Result=A extends B?C:\nD\n/x/.test(a)",
      "import 'x'\n/x/.test(a)",
      "import { x } from 'x'\n/x/.test(a)",
      "import Foo=require('foo')\n/x/.test(a)",
      "export import Foo=require('foo')\n/x/.test(a)",
      "import Foo=Bar.Baz\n/x/.test(a)",
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
      "let value\n/x/.test(a)",
      "var first,second\n/x/.test(a)",
      "let { value }\n/x/.test(a)",
      "var [value]\n/x/.test(a)",
      "let value:string\n/x/.test(a)",
      "let value:A |\nB\n/x/.test(a)",
      "declare let value:{nested:string}\n/x/.test(a)",
      "export let value:string\n/x/.test(a)",
      "declare function f():Result\n/x/.test(a)",
      "export declare function f<T>():T\n/x/.test(a)",
      "for(const value of /x/.global)",
    ]) {
      expect(`${source} -> ${firstSlash(source)}`).toBe(`${source} -> regex`);
    }
  });

  test("keeps line-broken function and class expressions value-shaped", () => {
    for (const source of ["const f=\nfunction(){}/2/b", "const C=\nclass{}/2/b"]) {
      expect(`${source} -> ${firstSlash(source)}`).toBe(`${source} -> punct`);
    }
  });

  test("keeps division after initialized and subsequent value statements", () => {
    for (const source of ["let value=padding\n/2/b", "let value\npadding\n/2/b"]) {
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

  test("inherits contextual modes and bindings inside template interpolations", () => {
    for (const source of [
      "function f(await){const value=`${await/2}`;const re=/x/}",
      "function f(yield){const value=`${yield/2}`;const re=/x/}",
    ]) {
      expect(kinds(source)).toContain("template:");
      expect(kinds(source)).toContain("regex:/x/");
    }
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
