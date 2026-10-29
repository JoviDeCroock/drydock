import { describe, expect, test } from "vitest";
import { parseDocument, stringify } from "yaml";
import { validateSetupDraft } from "../server/lib/github-app/setup-draft";
import {
  materializeSetupCommands,
  summarizeSetupCommands,
  SETUP_WORKED_EXAMPLES,
  NPM_PREPARE_TOKEN,
  NPM_STAGE_TOKEN,
  NPM_PUBLISH_TOKEN,
} from "../server/lib/github-app/setup-examples";
import {
  npmArchivePrepareCommand,
  npmArchivePublishCommand,
} from "../server/lib/github-app/setup-npm-archives";
import { SETUP_DRAFT_REQUEST } from "./helpers/publisher-setup-fixtures";

const context = {
  files: [
    {
      path: ".github/scripts/stage-packages.mjs",
      sha: "b".repeat(40),
      content: 'function publicationArgs(directory) { return ["stage", "publish", directory]; }',
    },
  ],
  warnings: [],
};
const monorepo = SETUP_WORKED_EXAMPLES.find((example) => example.case.includes("Changesets"))!;

function changed(path: string[], value: unknown) {
  const document = parseDocument(monorepo.proposedWorkflow);
  document.setIn(path, value);
  return materializeSetupCommands(document.toString({ lineWidth: 0 }));
}

describe("publisher setup worked examples", () => {
  test.each(SETUP_WORKED_EXAMPLES)("validates the complete $case example", (example) => {
    const rendered = materializeSetupCommands(example.proposedWorkflow);
    expect(() =>
      validateSetupDraft(
        example.originalWorkflow,
        rendered,
        SETUP_DRAFT_REQUEST,
        example === monorepo ? context : undefined,
      ),
    ).not.toThrow();
    expect(rendered.length).toBeLessThanOrEqual(48_000);
  });

  test("Changesets versioning remains intact and only its publish input runs the canonical publisher", () => {
    const before = parseDocument(monorepo.originalWorkflow).toJS();
    const after = parseDocument(materializeSetupCommands(monorepo.proposedWorkflow)).toJS();
    expect(after.jobs.release).toEqual(before.jobs.release);
    expect(after.jobs.prepare.steps.at(-2).run).toBe(npmArchivePrepareCommand);
    expect(after.jobs.publish.steps.at(-1).with.publish).toBe(npmArchivePublishCommand("stage"));
    expect(
      after.jobs.publish.steps.some((step: { run?: string }) => step.run?.includes("pnpm install")),
    ).toBe(false);
    expect(after.jobs.publish.if).toContain("has_packages");
  });

  test("only exact canonical command scalars collapse for the judge", () => {
    const rendered = materializeSetupCommands(monorepo.proposedWorkflow);
    const summary = summarizeSetupCommands(rendered);
    expect(summary).toContain(NPM_PREPARE_TOKEN);
    expect(summary).toContain(NPM_STAGE_TOKEN);
    const altered = changed(
      ["jobs", "publish", "steps", "5", "with", "publish"],
      npmArchivePublishCommand("stage") + " && echo changed",
    );
    expect(summarizeSetupCommands(altered)).toContain("echo changed");
    expect(() =>
      validateSetupDraft(monorepo.originalWorkflow, altered, SETUP_DRAFT_REQUEST, context),
    ).toThrow();
  });

  test("embedded text and other YAML fields never interpolate a template", () => {
    const input = stringify({
      jobs: {
        publish: {
          name: NPM_STAGE_TOKEN,
          steps: [{ run: `echo ${NPM_STAGE_TOKEN}` }, { env: { TEXT: NPM_PREPARE_TOKEN } }],
        },
      },
    });
    expect(materializeSetupCommands(input)).toBe(input);
  });

  test("a staged publisher cannot become a direct publisher", () => {
    const rendered = materializeSetupCommands(
      monorepo.proposedWorkflow.replace(NPM_STAGE_TOKEN, NPM_PUBLISH_TOKEN),
    );
    expect(() =>
      validateSetupDraft(monorepo.originalWorkflow, rendered, SETUP_DRAFT_REQUEST, context),
    ).toThrow(/changed staged publishing/);
  });

  test.each([
    [
      ["jobs", "publish", "steps", "5", "with", "publish"],
      "node .github/scripts/stage-packages.mjs",
    ],
    [["jobs", "prepare", "steps", "5", "run"], "pnpm -r publish"],
    [["jobs", "prepare", "steps", "6", "with", "path"], "other/"],
    [["jobs", "publish", "steps", "4", "with", "path"], "other/"],
  ] as [string[], unknown][])(
    "refuses noncanonical publisher/preparation or bundle paths %#",
    (path, value) => {
      expect(() =>
        validateSetupDraft(
          monorepo.originalWorkflow,
          changed(path, value),
          SETUP_DRAFT_REQUEST,
          context,
        ),
      ).toThrow();
    },
  );

  test.each(["working-directory", "shell"])(
    "canonical preparation cannot inherit %s defaults",
    (key) => {
      const rendered = changed(
        ["jobs", "prepare", "defaults", "run", key],
        key === "shell" ? "python {0}" : "packages/a",
      );
      expect(() =>
        validateSetupDraft(monorepo.originalWorkflow, rendered, SETUP_DRAFT_REQUEST, context),
      ).toThrow();
    },
  );

  test("incomplete supporting evidence prevents a Changesets proposal", () => {
    expect(() =>
      validateSetupDraft(
        monorepo.originalWorkflow,
        materializeSetupCommands(monorepo.proposedWorkflow),
        SETUP_DRAFT_REQUEST,
        { files: context.files, warnings: ["The file budget was reached."] },
      ),
    ).toThrow(/incomplete/);
  });
});
