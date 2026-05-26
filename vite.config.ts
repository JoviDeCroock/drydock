import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";

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
    },
    plugins: [
      preact(),
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
