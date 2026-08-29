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
      testMatch: [
        "**/local-registry.spec.ts",
        "**/two-factor.spec.ts",
        "**/org-switcher.spec.ts",
        "**/slack-selector.spec.ts",
        "**/npm-scope-guide.spec.ts",
        "**/gate-setup.spec.ts",
      ],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "desktop-smoke",
      testMatch: "**/smoke.spec.ts",
      use: { ...devices["Desktop Chrome"], colorScheme: "light" },
    },
    {
      name: "mobile-smoke",
      testMatch: "**/smoke.spec.ts",
      use: { ...devices["Pixel 7"], colorScheme: "light" },
    },
    {
      name: "dark-smoke",
      testMatch: "**/smoke.spec.ts",
      use: { ...devices["Desktop Chrome"], colorScheme: "dark" },
    },
  ],
  webServer: {
    command: "pnpm e2e:dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
