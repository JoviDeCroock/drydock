import { defineConfig, normalizePath, type Plugin } from "vite";
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

// preset-vite's own preact/debug injection latches onto the first module any
// environment resolves with the default index.html importer. The Cloudflare
// worker environment resolves server/index.ts first, so the client entry never
// got it. Own the injection here (client entry, dev server only) and keep the
// preset's off, so it can never land in the worker bundle instead.
function preactDebugInDevClient(): Plugin {
  let clientEntry = "";
  return {
    name: "drydock:preact-debug",
    apply: "serve",
    applyToEnvironment: (environment) => environment.name === "client",
    configResolved(config) {
      clientEntry = normalizePath(`${config.root}/src/index.tsx`);
    },
    transform(code, id) {
      if (id.split("?")[0] !== clientEntry) return;
      // A static import evaluates before the entry's body, so the debug hooks
      // are installed before hydrate/render. Kept on line 1 so only that line's
      // columns shift and `map: null` keeps the existing source map.
      return { code: `import "preact/debug";${code}`, map: null };
    },
  };
}

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
      preactDebugInDevClient(),
      preact({
        devToolsEnabled: false,
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
