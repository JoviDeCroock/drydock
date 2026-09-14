/**
 * Which paths the local harness hands to the Worker.
 *
 * Production routes *every* request to the Worker (`run_worker_first: true`)
 * and reaches static assets from inside it through the `ASSETS` binding. The
 * harness deliberately does not: the Vite plugin wires that binding back into
 * the dev server only when the generated config declares one, and once the
 * Worker is in front of documents it attaches `DOCUMENT_CSP` to them, whose
 * `style-src-elem 'self'` blocks the styles Vite injects at runtime (observed
 * in the browser console on a harness configured that way). Buying document
 * routing means setting `DISABLE_SECURITY_HEADERS`, which drops the headers
 * from the API and public responses that carry them locally today.
 *
 * So the harness names the Worker-owned prefixes instead. The cost is that
 * `assetFallbackRequest` in `server/index.ts` — the `/reports/`, `/diff/`, and
 * `/dashboard/` document rewrites — stays unexercised locally; a document is
 * served by Vite's SPA fallback rather than through the Worker.
 *
 * A prefix missing from this list does not fail visibly: Vite answers `200`
 * with the app shell, so the route looks alive in a browser while its handler
 * never runs. That is how `/public/reports/:token` became unverifiable in local
 * development (#666), which is why `test/dev-server-route-parity.test.mjs` pins
 * this list to the one `server/index.ts` owns.
 */
export const SERVER_OWNED_PATH_PREFIXES = ["/api", "/webhooks", "/og", "/public"];

/** Cloudflare static-routing rules covering each prefix and everything under it. */
export function workerFirstRoutes() {
  return SERVER_OWNED_PATH_PREFIXES.flatMap((prefix) => [prefix, `${prefix}/*`]);
}
