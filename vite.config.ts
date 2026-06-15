import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { ADDITIONAL_PRERENDER_ROUTES } from "./src/lib/prerender-routes";

declare const process: {
  env: {
    CLOUDFLARE_VITE_PERSIST_STATE_PATH?: string;
  };
};

export default defineConfig(({ mode }) => {
  const persistStatePath = process.env.CLOUDFLARE_VITE_PERSIST_STATE_PATH;

  return {
    server: {
      port: 5173,
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
