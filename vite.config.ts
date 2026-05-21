import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import preact from "@preact/preset-vite";

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
  },
  plugins: [preact(), cloudflare()],
});
