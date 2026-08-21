import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { ADDITIONAL_PRERENDER_ROUTES } from "./src/lib/prerender-routes.ts";

declare const process: {
  env: {
    CLOUDFLARE_VITE_PERSIST_STATE_PATH?: string;
    E2E_APP_PORT?: string;
    CONDUCTOR_PORT?: string;
  };
};

// Same port-override chain as test/e2e/dev-server.mjs and playwright.config.ts,
// so parallel Conductor workspaces can run `pnpm run dev` side by side without
// fighting over 5173. strictPort stays on: BETTER_AUTH_URL and the e2e harness
// bake the port into config, so a silently auto-picked port would break auth.
const devPort = Number(process.env.E2E_APP_PORT || process.env.CONDUCTOR_PORT || 5173);

export default defineConfig(({ mode }) => {
  const persistStatePath = process.env.CLOUDFLARE_VITE_PERSIST_STATE_PATH;

  return {
    server: {
      port: devPort,
      strictPort: true,
      watch: {
        ignored: ["**/.context/**"],
      },
    },
    plugins: [
      preact({
        prerender: {
          enabled: true,
          renderTarget: "#app",
          additionalPrerenderRoutes: Array.from(ADDITIONAL_PRERENDER_ROUTES),
          previewMiddlewareEnabled: true,
          previewMiddlewareFallback: "/404",
        },
      }),
      tailwindcss(),
      ...(mode === "test"
        ? []
        : [
            cloudflare({
              persistState: persistStatePath ? { path: persistStatePath } : true,
            }),
          ]),
    ],
  };
});
