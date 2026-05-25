import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts/check-signal-boundaries.mjs");

describe("signal boundary check", () => {
  test("flags locally-created signals unboxed in DOM text and props", async () => {
    const result = await runFixture(`
      import { useSignal } from "@preact/signals";

      export function Example() {
        const count = useSignal(0);
        return <label><span>{count.value}</span><input value={count.value} /></label>;
      }
    `);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("render signal 'count' directly as JSX text");
    expect(result.stderr).toContain("pass signal 'count' directly to DOM prop 'value'");
  });

  test("allows direct signal boundaries and explicit snapshot escapes", async () => {
    const result = await runFixture(`
      import { useSignal } from "@preact/signals";

      export function Example() {
        const count = useSignal(0);
        return (
          <label>
            <span>{count}</span>
            <input value={count} />
            {/* signals-boundary-ok: exercising a deliberate DOM snapshot */}
            <input value={count.value} />
          </label>
        );
      }
    `);

    expect(result.ok).toBe(true);
  });
});

async function runFixture(source) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "signal-boundary-"));
  const file = path.join(dir, "fixture.tsx");

  try {
    await writeFile(file, source);
    const output = await execFileAsync(process.execPath, [scriptPath, file], {
      cwd: process.cwd(),
    });
    return { ok: true, stdout: output.stdout, stderr: output.stderr };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}
