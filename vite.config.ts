import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => ({
  server: {
    port: 5173,
    strictPort: true,
  },
  plugins: [preact(), tailwindcss(), ...(mode === "test" ? [] : [cloudflare()])],
}));
