import { AikidoFootnote } from "../../components/AikidoPartner";
import { LinkButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { Muted } from "../../components/Typography";

export function InstallProtection() {
  return (
    <Card as="aside" padding="compact" class="flex flex-col gap-4">
      <AikidoFootnote class="self-start" />
      <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between md:gap-6">
        <div class="flex flex-col gap-2 max-w-[680px]">
          <h2 class="m-0 text-[16px] font-medium">Before your next dependency install</h2>
          <Muted class="m-0 text-[13px] leading-[1.6]">
            Aikido Safe Chain checks npm and PyPI downloads against Aikido's malware intelligence
            before installation.
          </Muted>
        </div>
        <LinkButton
          href="https://github.com/AikidoSec/safe-chain#installation"
          target="_blank"
          rel="noopener noreferrer"
          variant="secondary"
          class="self-start shrink-0 md:self-center"
        >
          Set up Safe Chain →
        </LinkButton>
      </div>
    </Card>
  );
}
