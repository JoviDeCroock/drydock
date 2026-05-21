import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,mjs}"],
    exclude: ["test/workers/**/*.test.{ts,mjs}", "node_modules/**"],
    environment: "node",
    globals: false,
  },
});
