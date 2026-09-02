/**
 * Which ecosystems the UI offers a saved published-pair review for.
 *
 * The server registry (`supportedPublishedEcosystems`) is the authority. This
 * is the browser's copy of that answer, in a dependency-free module so the
 * bundle does not have to reach for the registry — which imports every adapter,
 * broker, and the sandbox client — just to decide whether to draw a button.
 * `test/workers/ecosystem-registry.test.ts` pins the two together.
 */
export const PUBLISHED_REVIEW_ECOSYSTEMS = ["npm", "pypi"] as const;

export type PublishedReviewEcosystem = (typeof PUBLISHED_REVIEW_ECOSYSTEMS)[number];

export function supportsPublishedReview(ecosystem: string): ecosystem is PublishedReviewEcosystem {
  return (PUBLISHED_REVIEW_ECOSYSTEMS as readonly string[]).includes(ecosystem);
}
