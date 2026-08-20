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

describe("atpm staged references", () => {
  const stageId =
    "atpm:did:plc:twegdcgytckr5cxm57gyruxa:3lmabcdefghij:e852a96a-83f5-5c21-97c4-dce5b2f116ad";

  test("prints the id atpm's CLI takes, not Drydock's address for the record", () => {
    // The reference is how Drydock addresses the record; the trailing uuid is
    // what `npm stage approve` matches on. Pasting the former would fail.
    expect(npmStageCommandFor("publish", { stageId })).toBe(
      "npm stage approve e852a96a-83f5-5c21-97c4-dce5b2f116ad",
    );
  });

  test("withdraws with rm, because atpm has no reject", () => {
    expect(npmStageCommandFor("reject", { stageId })).toBe(
      "npm stage rm e852a96a-83f5-5c21-97c4-dce5b2f116ad",
    );
  });

  test("prints nothing for a reference that carries no approval id", () => {
    // Better silent than confidently wrong: an older reference has no usable
    // command, and printing the internal address would waste the reader's time.
    expect(
      npmStageCommandFor("publish", {
        stageId: "atpm:did:plc:twegdcgytckr5cxm57gyruxa:3lmabcdefghij",
      }),
    ).toBeNull();
  });
});
