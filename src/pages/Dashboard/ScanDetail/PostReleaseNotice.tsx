import { packageReleasesPath } from "../../../lib/package-releases-path";
import type { PostReleaseReviewLink } from "../../../models/scan-api";

/**
 * Names the publication alert a post-release review answers, so the reviewer
 * knows the release is already public and what deciding it does. A plain line
 * rather than an Alert: it is context for the decision, not a warning.
 */
export function PostReleaseNotice({
  link,
  organizationId,
}: {
  link: PostReleaseReviewLink;
  organizationId?: string | null;
}) {
  const release = `${link.packageName}@${link.version}`;
  return (
    <p class="m-0 text-[13px] text-ink-muted">
      Post-release review: {release} is already public on npm and raised a publication alert.
      Approving resolves the alert as approved after release; declining keeps it open with next
      steps. Nothing changes on npm.{" "}
      <a href={packageReleasesPath(link.packageName, null, organizationId)}>
        Open the package&rsquo;s alerts
      </a>
    </p>
  );
}
