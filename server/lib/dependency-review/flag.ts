const DEPENDENCY_REVIEW_FLAG = "dependency-review";

/**
 * Whether dependency review is offered to an organization: the `dependency-review`
 * Flagship flag, default off, is the hosted rollout gate. A deployment without a
 * FLAGS binding (self-hosting) offers it everywhere, because the organization's
 * own setting is already an explicit opt-in. A failed lookup reads as off, so an
 * outage never starts posting checks on repositories that weren't rolled out.
 */
export async function dependencyReviewAvailable(
  env: Pick<Cloudflare.Env, "FLAGS">,
  organizationId: string,
): Promise<boolean> {
  if (!env.FLAGS) return true;
  try {
    return await env.FLAGS.getBooleanValue(DEPENDENCY_REVIEW_FLAG, false, {
      targetingKey: organizationId,
      organizationId,
    });
  } catch {
    return false;
  }
}
