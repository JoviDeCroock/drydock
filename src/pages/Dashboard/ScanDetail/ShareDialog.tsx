import { useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useId } from "preact/hooks";
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
import { Field } from "../../../components/Field";
import { EmptyLine, MonoDetail } from "../../../components/Typography";

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
  rejected,
  npmPackageClaimOwned,
  npmPackageManagementAllowed,
  npmBadgeNote,
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
  /** A rejected review goes public when listed, without waiting for a release. */
  rejected: boolean;
  npmPackageClaimOwned?: boolean;
  npmPackageManagementAllowed?: boolean;
  /** Why this review cannot answer the npm badge (`npmBadgeAuthorityNote`). */
  npmBadgeNote: string | null;
  onEnable: () => void;
  onRevoke: () => void;
  onSetFeedListing: (listed: boolean) => void;
}) {
  const share = readSignalProp(shareProp);
  const error = readSignalProp(errorProp);
  const attestationAvailable = readSignalProp(attestationAvailableProp);
  const saving = readSignalProp(status) === "saving";
  const confirmingRevoke = useSignal(false);
  const linkId = useId();
  const badgeId = useId();

  const badge = shareBadgeMarkdown({
    origin: location.origin,
    ecosystem: badgeEcosystem,
    packageName,
    reportUrl: share?.url ?? "",
    tag: badgeTag,
    badgePublic,
    feedListed: share !== null && share.threatFeedListedAt !== null,
    npmPackageClaimOwned,
    npmPackageManagementAllowed,
  });
  // What the badge answers for. An untagged scan only ever answers the default
  // badge, so it reads as `latest` rather than as nothing.
  const badgeLine = badgeTag ?? DEFAULT_BADGE_TAG;

  const close = () => {
    confirmingRevoke.value = false;
    onClose();
  };
  const create = () => {
    confirmingRevoke.value = false;
    onEnable();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      size="md"
      title="Share report"
      description={
        share && !share.includesFiles
          ? "This link shares findings and the changed-file list only. Include the diff to share the redacted staged samples you are reading here."
          : "Anyone with the link can read this review: risk, findings, manifest changes, and the redacted staged side of the file diff."
      }
      footer={
        share ? (
          <Show
            when={confirmingRevoke}
            fallback={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  class="mr-auto"
                  onClick={() => (confirmingRevoke.value = true)}
                  disabled={saving}
                >
                  Revoke link…
                </Button>
                {!share.includesFiles ? (
                  <Button size="sm" onClick={onEnable} disabled={saving}>
                    {saving ? "Updating…" : "Include diff"}
                  </Button>
                ) : null}
                <Button variant="secondary" size="sm" onClick={close}>
                  Done
                </Button>
              </>
            }
          >
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => (confirmingRevoke.value = false)}
                disabled={saving}
              >
                Keep link
              </Button>
              <Button variant="danger" size="sm" onClick={onRevoke} disabled={saving}>
                {saving ? "Revoking…" : "Revoke link"}
              </Button>
            </>
          </Show>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button size="sm" onClick={create} disabled={saving}>
              {saving ? "Creating…" : "Create public link"}
            </Button>
          </>
        )
      }
    >
      {error ? <Alert tone="critical">{error}</Alert> : null}
      {share ? (
        <>
          <Field label="Report link" for={linkId}>
            <div class="flex items-center gap-2">
              {/* The inputs stay read-only rather than disabled so the text is
                  selectable when CopyButton reports the clipboard unavailable. */}
              <Input id={linkId} value={share.url} readOnly mono class="flex-1 min-w-0" />
              {/* Initial focus on Copy, not the field: a focused field scrolls
                  to the token's tail and hides which link this is. */}
              <CopyButton
                text={share.url}
                label="Copy link"
                variant={share.includesFiles ? "primary" : "secondary"}
                autofocus
              />
            </div>
          </Field>
          {share.awaitingPublication ? (
            <Alert tone="info">
              {rejected
                ? "This link answers as not found until you list the rejection publicly or the release is published."
                : "This link and its listing go live once this release is published; until then they answer as not found."}
            </Alert>
          ) : null}
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
          <label class="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              class="mt-0.5"
              checked={share.threatFeedListedAt !== null}
              disabled={saving}
              onChange={(e) => onSetFeedListing((e.target as HTMLInputElement).checked)}
            />
            <span class="flex flex-col gap-0.5">
              <span class="text-[13px] text-ink">List in public threat feed</span>
              <span class="text-[12px] leading-[1.5] text-ink-muted">
                Adds the report to{" "}
                <a
                  href="/public/threat-feed.json"
                  target="_blank"
                  rel="noreferrer"
                  class="text-ink-muted underline hover:text-ink"
                >
                  threat-feed.json
                </a>
                , the discoverable index security partners consume.
              </span>
            </span>
          </label>
          <Show when={confirmingRevoke}>
            <Alert tone="warn">
              Revoke this link? Anyone holding it gets not found from now on, and a listed report
              leaves the threat feed.
            </Alert>
          </Show>
        </>
      ) : (
        <EmptyLine>
          Only organization members can see this review until you create a link. Creating one
          requires an owner or admin role.
        </EmptyLine>
      )}

      {npmBadgeNote ? <EmptyLine>{npmBadgeNote}</EmptyLine> : null}
      {badge ? (
        <div class="flex flex-col gap-1.5">
          <Field label="README badge" for={badgeId}>
            <div class="flex items-center gap-2">
              <Input id={badgeId} value={badge} readOnly mono class="flex-1 min-w-0" />
              <CopyButton text={badge} />
            </div>
          </Field>
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
