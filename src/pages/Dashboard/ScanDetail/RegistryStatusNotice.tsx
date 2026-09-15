import { npmStageCommandFor } from "../../../lib/npm-stage-command";
import { Alert } from "../../../components/Alert";
import {
  registryStatusNoticeVariant,
  type RegistryStatusScan,
} from "../../../features/registry-status";

export function RegistryStatusNotice({ scan }: { scan: RegistryStatusScan }) {
  const variant = registryStatusNoticeVariant(scan);
  if (!variant) return null;

  if (variant === "blocked") {
    return (
      <Alert tone="critical">
        <div class="flex flex-col gap-1">
          <strong>npm blocked this version during its own automated validation.</strong>
          <span>
            It cannot be installed, and approving here will not change that. npm does not say which
            check failed. This is independent of the findings below — read them as a second opinion,
            not as the reason.
          </span>
        </div>
      </Alert>
    );
  }

  if (variant === "awaiting_approval") {
    const command = npmStageCommandFor("publish", scan);
    return (
      <Alert tone="warn">
        <div class="flex flex-col gap-1">
          <strong>Approved here, but npm still has this staged.</strong>
          <span>
            Drydock records the decision; it never publishes on your behalf. The release is not out
            until npm&rsquo;s own approval runs, with your normal 2FA.
          </span>
          {command ? (
            <code class="font-mono text-[12px] text-ink select-all">{command}</code>
          ) : null}
        </div>
      </Alert>
    );
  }

  return (
    <p class="m-0 text-[13px] text-ink-muted">
      npm is still validating this version — it is not installable yet.
    </p>
  );
}
