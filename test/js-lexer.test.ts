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

describe("tokenizeJs regex vs division", () => {
  test("reads a slash after a value as division", () => {
    for (const source of [
      "f(a)/2/b", // call result
      "a[0]/2/b", // element access
      "({a:1})/2/b", // parenthesised expression
      "var o={a:1}/2/b", // object literal
      "return{a:1}/2/b", // object literal after a keyword
      "class C{class={}/2/b}", // a field named `class`, not a nested declaration
      "a.b/2/c", // property
      "1/2/3", // numbers
      "typeof x/2/b", // the operand, not the keyword, precedes the slash
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
      "const A=class extends mixin({a:1}){}/x/.test(a)",
      "try{}catch{}/x/.test(a)",
      "return /x/.test(a)",
      "a=/x/.test(a)",
      "/x/.test(a)",
    ]) {
      expect(`${source} -> ${firstSlash(source)}`).toBe(`${source} -> regex`);
    }
  });

  test("keeps a statement-position regex whole", () => {
    // The failure this guards: `;` and `{` inside the regex body read as real
    // punctuation, which is what let the reformatter break a line inside it.
    expect(kinds("if(a)/x;y{z}/.test(a)")).toBe(
      "ident:if punct:( ident:a punct:) regex:/x;y{z}/ punct:. ident:test punct:( ident:a punct:)",
    );
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
});
