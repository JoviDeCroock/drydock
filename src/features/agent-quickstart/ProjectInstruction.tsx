import { CodeBlock } from "../../components/CodeBlock";
import projectInstruction from "./package-review.md?raw";

export function ProjectInstruction() {
  return (
    <div class="flex flex-col gap-3">
      <p class="m-0 text-[14px] text-ink-muted leading-[1.65] max-w-[680px]">
        Add this instruction to your project&apos;s <code class="font-mono">AGENTS.md</code> or
        equivalent agent rules. It gives the agent a repeatable review step for public npm and PyPI
        dependency upgrades. Check that your project permits external review requests first.
      </p>
      <CodeBlock title="AGENTS.md · package review" lang="markdown">
        {projectInstruction}
      </CodeBlock>
      <a href="/agents/package-review.md" class="text-[13px] self-start">
        Read the plain-text instruction →
      </a>
    </div>
  );
}
