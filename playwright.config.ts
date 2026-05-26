import { defineConfig, devices } from "@playwright/test";

const appPort = Number(process.env.E2E_APP_PORT || process.env.CONDUCTOR_PORT || 5173);
const baseURL = process.env.E2E_APP_URL || `http://127.0.0.1:${appPort}`;

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 90_000,
  expect: {
    timeout: 20_000,
  },
  outputDir: ".context/e2e-artifacts/test-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: ".context/e2e-artifacts/playwright-report", open: "never" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
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
