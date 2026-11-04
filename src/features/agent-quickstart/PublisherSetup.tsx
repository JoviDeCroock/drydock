import { CodeBlock } from "../../components/CodeBlock";
import { SectionLabel } from "../../components/Typography";
import existingProject from "./existing-project.md?raw";
import newProject from "./new-project.md?raw";

const setupPrompts = [
  {
    id: "existing-project",
    title: "Add Drydock to an existing project",
    description:
      "Map the release flow you already use, then prepare the smallest change that puts artifact review in the right place. Preserve package selection, prereleases, and release tooling.",
    prompt: existingProject,
  },
  {
    id: "new-project",
    title: "Set up publishing for a new project",
    description:
      "Design a release flow around one build, exact artifact review, and a protected publish job. Leave account configuration and the first real release for explicit maintainer approval.",
    prompt: newProject,
  },
];

export function PublisherSetup() {
  return (
    <section id="publisher-setup" class="flex flex-col gap-6 scroll-mt-6">
      <div class="flex flex-col gap-3">
        <SectionLabel as="p">Publisher setup</SectionLabel>
        <h2 class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]">
          Start with your project, not another workflow template.
        </h2>
        <p class="m-0 text-[14px] text-ink-muted leading-[1.65] max-w-[680px]">
          Copy the prompt that fits your repository into your coding agent. Work through its
          findings together before changing release authority. These are setup instructions, not an
          API or permission to publish.
        </p>
        <ol class="m-0 pl-5 text-[14px] text-ink-muted leading-[1.65] max-w-[680px]">
          <li>Build and pack the release once.</li>
          <li>Upload those candidate artifacts for Drydock to review.</li>
          <li>
            Keep the configured GitHub publish job held while a maintainer reviews in Drydock.
          </li>
          <li>
            After approval, publish the same downloaded, digest-verified files without rebuilding.
          </li>
        </ol>
        <p class="m-0 text-[14px] text-ink-muted leading-[1.65] max-w-[680px]">
          Prefer a <a href="/docs#workflow-gating">Workflow Gate — enforced</a> for the configured
          protected job. <a href="/docs#staged-publishing">Stage Watchtower — advisory</a> reviews
          npm staging but cannot block npm approval. Neither removes every alternate publishing
          path.
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
