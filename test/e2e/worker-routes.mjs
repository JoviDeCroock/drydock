/**
 * Which paths the local harness hands to the Worker.
 *
 * Production routes *every* request to the Worker (`run_worker_first: true`)
 * and reaches static assets from inside it through the `ASSETS` binding. The
 * harness deliberately does not: the Vite plugin only wires that binding back
 * into the dev server when the generated config declares one, and with the
 * Worker in front of documents its production security headers reach Vite's
 * dev client — `style-src-elem 'self'` blocks the inline styles Vite injects,
 * and `Strict-Transport-Security` pins `http://127.0.0.1` to HTTPS for every
 * other local server on the machine. Turning those headers off to buy document
 * routing would cost the header coverage the API and public routes have today.
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
