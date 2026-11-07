const DEPENDENCY_INTEL_FLAG = "aikido-intel";

/**
 * Whether Aikido Intel lookups run for this review. Unlike the `ai-review`
 * killswitch this defaults off: production data-use rights for the feed are
 * not yet confirmed, so no feed is fetched and no Intel is shown until the
 * Flagship flag is turned on. A missing binding or a failed evaluation reads
 * as off, so the flag can never fail a scan or a public diff.
 *
 * Anonymous `/diff` has no organization and passes `null`: the flag is then
 * evaluated with no targeting context, so organization-targeted rules cannot
 * match and only a flag enabled for everyone turns Intel on there.
 */
export async function dependencyIntelEnabled(
  env: Cloudflare.Env,
  organizationId: string | null,
): Promise<boolean> {
  if (!env.FLAGS) return false;
  try {
    return await env.FLAGS.getBooleanValue(
      DEPENDENCY_INTEL_FLAG,
      false,
      organizationId ? { targetingKey: organizationId, organizationId } : undefined,
    );
  } catch {
    return false;
  }
}
