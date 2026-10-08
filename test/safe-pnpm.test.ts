import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const roots: string[] = [];
const script = new URL("../scripts/safe-pnpm.sh", import.meta.url);
const trustedBinary = '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 23\n';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "drydock-safe-pnpm-"));
  roots.push(root);
  const commands = path.join(root, "commands");
  const scripts = path.join(root, "scripts");
  mkdirSync(commands);
  mkdirSync(scripts);
  const wrapper = path.join(scripts, "safe-pnpm.sh");
  copyFileSync(script, wrapper);
  const binary = path.join(root, ".context/safe-chain/1.5.24/macos-arm64/safe-chain");
  const command = (name: string, body: string) =>
    writeFileSync(path.join(commands, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  command("uname", 'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac');
  command("pnpm", 'echo "UNPROTECTED PNPM"; exit 99');
  const run = (...args: string[]) =>
    spawnSync("sh", [wrapper, ...args], {
      env: { ...process.env, PATH: `${commands}:${process.env.PATH}` },
      encoding: "utf8",
    });
  const cache = (contents: string) => {
    mkdirSync(path.dirname(binary), { recursive: true });
    writeFileSync(binary, contents, { mode: 0o755 });
  };
  // Replace only the fixture's release digest so a harmless executable can
  // exercise argument/exit propagation with the real checksum utility.
  const trustFixtureBinary = () => {
    const digest = createHash("sha256").update(trustedBinary).digest("hex");
    writeFileSync(
      wrapper,
      readFileSync(wrapper, "utf8").replace(
        "638932561b1e5e93affbe442567c4144795d0993a83022df02d7833495279f5a",
        digest,
      ),
    );
  };
  return { binary, command, run, cache, trustFixtureBinary };
}

describe("Safe Chain pnpm bootstrap", () => {
  test("rejects a corrupted cached binary before executing any package manager", () => {
    const f = fixture();
    f.cache(trustedBinary);
    const result = f.run("install", "--frozen-lockfile");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum verification failed");
    expect(result.stdout).toBe("");
  });

  test("rejects an untrusted download and leaves no cached executable", () => {
    const f = fixture();
    f.command("curl", 'while [ "$1" != -o ]; do shift; done; shift; echo untrusted > "$1"');
    const result = f.run("install");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum verification failed");
    expect(result.stdout).toBe("");
    expect(existsSync(f.binary)).toBe(false);
  });

  test("stops on a download failure without falling back to pnpm", () => {
    const f = fixture();
    f.command("curl", "exit 7");
    const result = f.run("install");
    expect(result.status).toBe(7);
    expect(result.stdout).toBe("");
    expect(existsSync(f.binary)).toBe(false);
  });

  test.each([
    ["install", "--frozen-lockfile"],
    ["add", "@scope/a package", "--save-dev"],
    ["update"],
    ["dlx", "some-tool"],
  ])("forwards pnpm arguments %j and preserves the scanner exit status", (...args) => {
    const f = fixture();
    f.trustFixtureBinary();
    f.cache(trustedBinary);
    f.command("curl", "exit 7");
    const result = f.run(...args);
    expect(result.status).toBe(23);
    expect(result.stdout).toBe(["pnpm", ...args].join("\n") + "\n");
  });
});
