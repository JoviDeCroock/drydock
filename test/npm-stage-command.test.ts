import { describe, expect, test } from "vitest";
import { npmStageCommandFor } from "../src/lib/npm-stage-command";

const stageId = "stage-1a2b3c4d5e";

describe("npm stage commands", () => {
  test("maps each decision to its npm subcommand", () => {
    expect(npmStageCommandFor("publish", { stageId })).toBe(`npm stage approve ${stageId}`);
    expect(npmStageCommandFor("no_publish", { stageId })).toBe(`npm stage reject ${stageId}`);
  });

  test("trims surrounding whitespace from the stage id", () => {
    expect(npmStageCommandFor("publish", { stageId: `  ${stageId}  ` })).toBe(
      `npm stage approve ${stageId}`,
    );
  });

  test("pins commands to the registry captured for the scan", () => {
    expect(
      npmStageCommandFor("publish", {
        stageId,
        registryUrl: "https://registry.example.test/team's",
      }),
    ).toBe(`npm stage approve ${stageId} --registry 'https://registry.example.test/team'\\''s'`);
  });

  test("refuses an unsafe captured registry instead of falling back to the default", () => {
    expect(
      npmStageCommandFor("publish", {
        stageId,
        registryUrl: "file:///tmp/registry",
      }),
    ).toBeNull();
  });

  test("has no command for workflow-gate scans", () => {
    expect(npmStageCommandFor("publish", { source: "workflow_gate", stageId })).toBeNull();
  });

  test("has no command without a stage id", () => {
    expect(npmStageCommandFor("publish", {})).toBeNull();
    expect(npmStageCommandFor("publish", { stageId: null })).toBeNull();
    expect(npmStageCommandFor("publish", { stageId: "   " })).toBeNull();
  });

  test("refuses stage ids that would carry shell metacharacters into a paste", () => {
    expect(npmStageCommandFor("publish", { stageId: "stage-1; rm -rf /" })).toBeNull();
    expect(npmStageCommandFor("publish", { stageId: "stage-1 && curl evil.example" })).toBeNull();
    expect(npmStageCommandFor("publish", { stageId: "$(whoami)" })).toBeNull();
    expect(npmStageCommandFor("publish", { stageId: "`id`" })).toBeNull();
    // Too short to be a real stage id, and a bare word is still worth rejecting.
    expect(npmStageCommandFor("publish", { stageId: "abc" })).toBeNull();
  });
});
