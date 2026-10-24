import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { plantCanaryFiles } from "../containers/detonation/canary-files.mjs";

const harnessSource = fs.readFileSync(
  new URL("../containers/detonation/harness.mjs", import.meta.url),
  "utf8",
);

describe("detonation harness privilege boundary", () => {
  test("spawns root-run binaries by absolute path, never through the package's PATH", () => {
    // A step's env PATH starts with `node_modules/.bin`, which the package
    // fills through its own `bin` entries; a bare `setpriv` or `strace` there
    // would run as root.
    expect(harnessSource).not.toMatch(/["'](?:setpriv|strace)["']/);
    expect(harnessSource).toContain('"/usr/bin/setpriv"');
    expect(harnessSource).toContain('"/usr/bin/strace"');
  });

  test("ends tar options before every member operand", () => {
    const memberReads = [...harnessSource.matchAll(/read\(\["-xzOf", TARBALL, ([^\]]+)\]\)/g)];
    expect(memberReads.length).toBeGreaterThan(0);
    for (const [, operands] of memberReads) expect(operands.startsWith('"--", ')).toBe(true);
  });
});

describe("plantCanaryFiles", () => {
  let home: string;
  let outside: string;
  const owner = () => ({ home, uid: process.getuid!(), gid: process.getgid!() });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "canary-home-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "canary-outside-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test("writes nested canaries with the requested mode", () => {
    const file = path.join(home, ".config/gh/hosts.yml");
    plantCanaryFiles([{ path: file, content: "token", mode: 0o600 }], owner());
    expect(fs.readFileSync(file, "utf8")).toBe("token");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test("replaces a symlinked canary file instead of writing through it", () => {
    const target = path.join(outside, "victim");
    fs.writeFileSync(target, "original");
    const file = path.join(home, ".npmrc");
    fs.symlinkSync(target, file);
    plantCanaryFiles([{ path: file, content: "token", mode: 0o600 }], owner());
    expect(fs.readFileSync(target, "utf8")).toBe("original");
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("token");
  });

  test("replaces a symlinked parent directory instead of creating inside its target", () => {
    fs.symlinkSync(outside, path.join(home, ".aws"));
    const file = path.join(home, ".aws/credentials");
    plantCanaryFiles([{ path: file, content: "key", mode: 0o600 }], owner());
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.lstatSync(path.join(home, ".aws")).isDirectory()).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("key");
  });

  test("refuses a path outside the home", () => {
    expect(() =>
      plantCanaryFiles([{ path: path.join(outside, "x"), content: "", mode: 0o600 }], owner()),
    ).toThrow(/outside the package home/);
  });
});
