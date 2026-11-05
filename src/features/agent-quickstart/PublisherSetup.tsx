import { CodeBlock } from "../../components/CodeBlock";
import { SectionLabel } from "../../components/Typography";
import existingProject from "./existing-project.md?raw";
import newProject from "./new-project.md?raw";

const setupPrompts = [
  {
    id: "existing-project",
    title: "Add Drydock to an existing project",
    description:
      "Your agent maps the release flow you already have, helps you choose a mode, then reviews the draft PR from Drydock's guided setup or prepares the change locally.",
    prompt: existingProject,
  },
  {
    id: "new-project",
    title: "Set up publishing for a new project",
    description:
      "Your agent scaffolds the package and a two-job release workflow, then hands you the registry, GitHub, and Drydock settings that only you can change.",
    prompt: newProject,
  },
];

export function PublisherSetup() {
  return (
    <section id="publisher-setup" class="flex flex-col gap-6 scroll-mt-6">
      <div class="flex flex-col gap-3">
        <SectionLabel as="p">Publisher setup</SectionLabel>
        <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
          Review the build in Drydock before GitHub Actions publishes it.
        </h2>
        <ol class="m-0 pl-5 list-decimal text-[14px] text-ink-muted leading-[1.65] max-w-[680px]">
          <li>A build job builds and packs the release once and uploads the files.</li>
          <li>
            A GitHub Environment holds the publish job while you review those files in Drydock.
          </li>
          <li>
            After you approve, the publish job verifies the checksums and publishes the same files.
          </li>
        </ol>
        <p class="m-0 text-[14px] text-ink-muted leading-[1.65] max-w-[680px]">
          That is the <a href="/docs#workflow-gating">Workflow Gate — enforced</a>, Drydock's GitHub
          Actions integration for npm, PyPI, and VS Code. For npm,{" "}
          <a href="/docs#staged-publishing">Stage Watchtower — advisory</a> reviews packages you
          stage instead, but npm approval does not wait for Drydock.
        </p>
        <p class="m-0 text-[14px] text-ink-muted leading-[1.65] max-w-[680px]">
          Copy the prompt that fits your repository into your coding agent. It walks you through the
          setup in checkpoints and stops before anything that needs your approval.
        </p>
      </div>
      {setupPrompts.map(({ id, title, description, prompt }) => (
        <div key={id} id={id} class="flex flex-col gap-3 scroll-mt-6">
          <h3 class="m-0 text-lg font-medium tracking-[-0.005em]">{title}</h3>
          <p class="m-0 text-[14px] text-ink-muted leading-[1.65] max-w-[680px]">{description}</p>
          <CodeBlock title={title} lang="markdown">
            {prompt}
          </CodeBlock>
          <a href={`/agents/${id}.md`} class="text-[13px] self-start">
            Read the plain-text prompt →
          </a>
        </div>
      ))}
    </section>
  );
}
