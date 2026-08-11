import { useComputed, useSignal } from "@preact/signals";
import type { PublicEcosystem } from "../../../../server/lib/public-feed";
import { badgeMarkdown } from "../../../lib/badge-markdown";
import { formatDateTime } from "../../../lib/format";
import type { DecisionStatus, PublicShareInfo } from "../../../models/scan";
import { publicReportAttestationUrl } from "../../../models/scan";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { Input } from "../../../components/Input";
import { EmptyLine, MonoDetail, MonoLabel } from "../../../components/Typography";

export function ShareDialog({
  open,
  onClose,
  share,
  status,
  error,
  attestationAvailable,
  badgeEcosystem,
  packageName,
  onEnable,
  onRevoke,
  onSetFeedListing,
}: {
  open: boolean;
  onClose: () => void;
  share: PublicShareInfo | null;
  status: DecisionStatus;
  error: string | null;
  attestationAvailable: boolean | null;
  badgeEcosystem: PublicEcosystem | null;
  packageName: string | null;
  onEnable: () => void;
  onRevoke: () => void;
  onSetFeedListing: (listed: boolean) => void;
}) {
  const copied = useSignal(false);
  const badgeCopied = useSignal(false);
  // Rendered directly as signal children so the copy feedback re-renders only
  // the text node, not the dialog (signals-local/no-signal-conditional-jsx).
  const copyLabel = useComputed(() => (copied.value ? "Copied ✓" : "Copy"));
  const badgeCopyLabel = useComputed(() => (badgeCopied.value ? "Copied ✓" : "Copy"));
  const saving = status === "saving";

  const copyToClipboard = async (text: string, feedback: typeof copied) => {
    try {
      await navigator.clipboard.writeText(text);
      feedback.value = true;
      setTimeout(() => (feedback.value = false), 2000);
    } catch {
      // Clipboard access denied — the text stays selectable in the input.
    }
  };

  const copyLink = () => (share ? copyToClipboard(share.url, copied) : Promise.resolve());

  // The badge endpoint only answers for feed-listed scans with a resolvable
  // ecosystem, so the snippet appears exactly when it would render something.
  const badge =
    share && share.threatFeedListedAt !== null && badgeEcosystem && packageName
      ? badgeMarkdown({
          origin: location.origin,
          ecosystem: badgeEcosystem,
          packageName,
          reportUrl: share.url,
        })
      : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Share report"
      description="A public link serves this review's canonical report — findings, risk, and manifest changes — to anyone who has it. Individual file contents are never included; findings still quote the redacted lines they matched."
      footer={
        share ? (
          <>
            <Button variant="danger" size="sm" onClick={onRevoke} disabled={saving}>
              {saving ? "Revoking…" : "Revoke link"}
            </Button>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={onEnable} disabled={saving}>
              {saving ? "Creating…" : "Create public link"}
            </Button>
          </>
        )
      }
    >
      {error ? <Alert tone="critical">{error}</Alert> : null}
      {share ? (
        <>
          <div class="flex items-center gap-2">
            <Input value={share.url} readOnly class="flex-1 font-mono text-[12px]" />
            <Button variant="secondary" size="sm" onClick={copyLink}>
              {copyLabel}
            </Button>
          </div>
          <MonoDetail
            parts={[
              <span key="shared">shared {formatDateTime(share.sharedAt)}</span>,
              attestationAvailable ? (
                <a
                  key="attestation"
                  href={publicReportAttestationUrl(share.token)}
                  class="text-ink-muted hover:text-ink"
                  download
                >
                  signed attestation
                </a>
              ) : null,
            ]}
          />
          {attestationAvailable === false ? (
            <EmptyLine>Signed attestations are not configured for this deployment.</EmptyLine>
          ) : null}
          <EmptyLine>
            Anyone with the link can read the report; revoking invalidates it immediately.
          </EmptyLine>
          <label class="flex items-start gap-2 text-[13px] text-ink-muted cursor-pointer">
            <input
              type="checkbox"
              class="mt-0.5"
              checked={share.threatFeedListedAt !== null}
              disabled={saving}
              onChange={(e) => onSetFeedListing((e.target as HTMLInputElement).checked)}
            />
            <span>
              List publicly — the report appears in the discoverable{" "}
              <a
                href="/public/threat-feed.json"
                target="_blank"
                rel="noreferrer"
                class="text-ink-muted underline hover:text-ink"
              >
                threat-feed.json
              </a>{" "}
              index that security partners consume and powers the status badge for this
              release&apos;s dist-tag, not just behind this link.
            </span>
          </label>
          {badge ? (
            <div class="flex flex-col gap-1.5">
              <MonoLabel as="span">README badge</MonoLabel>
              <div class="flex items-center gap-2">
                <Input value={badge} readOnly class="flex-1 font-mono text-[12px]" />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void copyToClipboard(badge, badgeCopied)}
                >
                  {badgeCopyLabel}
                </Button>
              </div>
              <EmptyLine>
                Paste into the package&apos;s README. The badge always shows the newest listed
                review for this package; unlisting reverts it to &ldquo;not reviewed&rdquo;.
              </EmptyLine>
            </div>
          ) : null}
        </>
      ) : (
        <EmptyLine>
          This review is currently visible to organization members only. Requires an owner or admin
          role.
        </EmptyLine>
      )}
    </Dialog>
  );
}
