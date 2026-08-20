import { npmStageCommandFor } from "../../../lib/npm-stage-command";
import { formatDateTime } from "../../../lib/format";
import { Alert } from "../../../components/Alert";
import { registryStatusVariant, type RegistryStatusScan } from "../../../features/registry-status";

/**
 * What npm says about this exact version, which is not the same question as
 * what Drydock found in it.
 *
 * npm runs its own automated validation on a staged version and can block it
 * outright; a reviewer looking at a clean report has no other way to see that.
 * And approving a release here records a decision — it does not publish
 * anything — so the gap between "approved in Drydock" and "actually on npm" is
 * easy to lose. Both are read off the persisted registry status.
 *
 * `null` is not a status. npm answers 404 both for a version that does not
 * exist and for one the organization's token may not ask about, so an
 * unresolved lookup renders nothing at all rather than anything reassuring or
 * alarming.
 */
/**
 * Two loud variants and three quiet ones. `blocked` and `awaiting_approval` are
 * the only ones that ask the reader to do something, so they are the only ones
 * that get an Alert; the rest are a muted line, because a banner confirming a
 * release went out as planned is a banner nobody reads the next time.
 */
export function RegistryStatusNotice({ scan }: { scan: RegistryStatusScan }) {
  const variant = registryStatusVariant(scan);
  if (!variant) return null;
  const observed = scan.registryVersionStatusAt
    ? formatDateTime(scan.registryVersionStatusAt)
    : null;

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
          {observed ? (
            <span class="font-mono text-[11px] text-ink-subtle">checked {observed}</span>
          ) : null}
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
          {observed ? (
            <span class="font-mono text-[11px] text-ink-subtle">checked {observed}</span>
          ) : null}
        </div>
      </Alert>
    );
  }

  const text =
    variant === "validating"
      ? "npm is still validating this version — it is not installable yet."
      : variant === "published"
        ? "Published to npm."
        : "Published and subsequently removed from npm.";
  return (
    <p class="m-0 text-[13px] text-ink-muted">
      {text}
      {observed ? <span class="text-ink-subtle"> Checked {observed}.</span> : null}
    </p>
  );
}
