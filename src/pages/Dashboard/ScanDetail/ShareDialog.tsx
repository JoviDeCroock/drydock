import { DEFAULT_BADGE_TAG, type PublicEcosystem } from "../../../../server/lib/public-feed";
import { shareBadgeMarkdown } from "../../../lib/badge-markdown";
import { formatDateTime } from "../../../lib/format";
import type { DecisionStatus, PublicShareInfo } from "../../../models/scan";
import { publicReportAttestationUrl } from "../../../models/scan";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { CopyButton } from "../../../components/CopyButton";
import { Dialog } from "../../../components/Dialog";
import { Input } from "../../../components/Input";
import { readSignalProp, type SignalOrValue } from "../../../components/signal-props";
import { EmptyLine, MonoDetail, MonoLabel } from "../../../components/Typography";

export function ShareDialog({
  open,
  onClose,
  share: shareProp,
  status,
  error: errorProp,
  attestationAvailable: attestationAvailableProp,
  badgeEcosystem,
  packageName,
  badgeTag,
  badgePublic,
  npmPackageClaimOwned,
  onEnable,
  onRevoke,
  onSetFeedListing,
}: {
  // Signals are read here so the share round-trip re-renders the dialog, not
  // the review page that mounts it.
  open: SignalOrValue<boolean>;
  onClose: () => void;
  share: SignalOrValue<PublicShareInfo | null>;
  status: SignalOrValue<DecisionStatus>;
  error: SignalOrValue<string | null>;
  attestationAvailable: SignalOrValue<boolean | null>;
  badgeEcosystem: PublicEcosystem | null;
  packageName: string | null;
  // The dist-tag this release was staged under, so the snippet points at the
  // line the maintainer just listed rather than at `latest`.
  badgeTag: string | null;
  /**
   * Whether this package's badge answers with no opt-in at all. Decides
   * whether the snippet is worth handing over before anything is shared.
   */
  badgePublic: boolean;
  npmPackageClaimOwned?: boolean;
  onEnable: () => void;
  onRevoke: () => void;
  onSetFeedListing: (listed: boolean) => void;
}) {
  const share = readSignalProp(shareProp);
  const error = readSignalProp(errorProp);
  const attestationAvailable = readSignalProp(attestationAvailableProp);
  const saving = readSignalProp(status) === "saving";

  const badge = shareBadgeMarkdown({
    origin: location.origin,
    ecosystem: badgeEcosystem,
    packageName,
    reportUrl: share?.url ?? "",
    tag: badgeTag,
    badgePublic,
    feedListed: share !== null && share.threatFeedListedAt !== null,
    npmPackageClaimOwned,
  });
  // What the badge answers for. An untagged scan only ever answers the default
  // badge, so it reads as `latest` rather than as nothing.
  const badgeLine = badgeTag ?? DEFAULT_BADGE_TAG;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Share report"
      description={
        share && !share.includesFiles
          ? "This existing link shares findings and the changed-file list only. Include the diff to let readers open the same redacted staged samples you are reading here."
          : "A public link serves this review to anyone who has it: risk, findings, manifest changes, and the file diff itself — the same redacted staged samples you are reading here, with findings pinned to their lines. The previous version is never fetched for a public reader, so shared files show the staged side only. Revoking the link takes all of it back immediately."
      }
      footer={
        share ? (
          <>
            <Button variant="danger" size="sm" onClick={onRevoke} disabled={saving}>
              {saving ? "Revoking…" : "Revoke link"}
            </Button>
            {!share.includesFiles ? (
              <Button size="sm" onClick={onEnable} disabled={saving}>
                {saving ? "Updating…" : "Include diff"}
              </Button>
            ) : null}
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
            {/* The inputs stay read-only rather than disabled so the text is
                selectable when CopyButton reports the clipboard unavailable. */}
            <Input value={share.url} readOnly mono class="flex-1" />
            <CopyButton text={share.url} />
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
              index that security partners consume, not just behind this link.
            </span>
          </label>
        </>
      ) : (
        <EmptyLine>
          This review is currently visible to organization members only. Requires an owner or admin
          role.
        </EmptyLine>
      )}

      {badgeEcosystem === "npm" && npmPackageClaimOwned !== true ? (
        <EmptyLine>
          This organization has no confirmed assignment for this npm package. Its reports remain
          shareable, but its reviews cannot control the public badge. Contact support if historical
          ownership needs review.
        </EmptyLine>
      ) : null}
      {badge ? (
        <div class="flex flex-col gap-1.5">
          <MonoLabel as="span">README badge</MonoLabel>
          <div class="flex items-center gap-2">
            <Input value={badge} readOnly mono class="flex-1" />
            <CopyButton text={badge} />
          </div>
          {badgePublic ? (
            <EmptyLine>
              Paste into the package&apos;s README. It follows your approvals on the{" "}
              <code class="font-mono">{badgeLine}</code> tag on its own — approve a release and the
              badge moves to it, with nothing to share or list. Publish a newer version that Drydock
              reviews but nobody approves and the badge reports <em>that</em> version as &ldquo;not
              reviewed&rdquo; rather than keep vouching for this one. A release Drydock never sees
              leaves the badge where it is.
            </EmptyLine>
          ) : (
            <EmptyLine>
              Paste into the package&apos;s README. The badge shows the newest listed review on the{" "}
              <code class="font-mono">{badgeLine}</code> tag; a review of another release line never
              displaces it, and unlisting reverts it to &ldquo;not reviewed&rdquo;. Publish a newer
              version on this tag without listing its review and the badge reports <em>that</em>{" "}
              version as &ldquo;not reviewed&rdquo; rather than keep vouching for this one.
            </EmptyLine>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
