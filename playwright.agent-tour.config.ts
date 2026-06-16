import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const appPort = Number(process.env.E2E_APP_PORT || process.env.CONDUCTOR_PORT || 5173);
const baseURL = process.env.E2E_APP_URL || `http://127.0.0.1:${appPort}`;
const tourDir = process.env.AGENT_TOUR_DIR || "agent-tour-output";

export default defineConfig({
  testDir: "./test/agent-tour",
  timeout: 240_000,
  expect: {
    timeout: 20_000,
  },
  outputDir: path.join(tourDir, "test-results"),
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(tourDir, "playwright-report"), open: "never" }],
  ],
  use: {
    baseURL,
    trace: "on",
    screenshot: "on",
    video: "on",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm e2e:dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
