/**
 * A custom NPM_REGISTRY marks a private or self-hosted deployment, which keeps
 * every public-registry diff off (PyPI and atpm included): those would reach
 * the public internet from a private install. The anonymous routes and the
 * dependency review job both read this.
 */
export function publicDiffEgressAllowed(env: { NPM_REGISTRY?: string }): boolean {
  return (
    (env.NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "") ===
    "https://registry.npmjs.org"
  );
}
