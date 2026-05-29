import { expect, test, type Page } from "@playwright/test";
import * as OTPAuth from "otpauth";

const PASSWORD = "correct horse battery staple";

function totpFromSecret(secret: string): string {
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
  return totp.generate();
}

async function register(page: Page): Promise<string> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `2fa-${unique}@example.test`;
  await page.goto("/register");
  await page.getByLabel("Name").fill("2FA Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 30_000 });
  return email;
}

test("enrolls in TOTP 2FA and signs in through the challenge", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  try {
    const email = await register(page);

    // Enroll from Settings → Security.
    await page.goto("/dashboard/settings");
    await page.getByRole("button", { name: "Enable two-factor" }).click();

    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Current password").fill(PASSWORD);
    await dialog.getByRole("button", { name: "Continue" }).click();

    // The manual-entry key is the base32 TOTP secret.
    const secret = (await dialog.locator("code").first().innerText()).trim();
    expect(secret.length).toBeGreaterThan(0);

    await dialog.getByLabel("Authentication code").fill(totpFromSecret(secret));
    await dialog.getByRole("button", { name: "Verify & enable" }).click();

    // Backup codes are revealed; confirm and close.
    await expect(dialog.getByText("Save your backup codes")).toBeVisible();
    await dialog.getByLabel("I've saved these codes").check();
    await dialog.getByRole("button", { name: "Done" }).click();

    await expect(page.getByText("enabled", { exact: true })).toBeVisible();

    // Sign out via the account menu.
    await page.getByRole("button", { name: /Account menu/ }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL(/\/$/, { timeout: 30_000 });

    // Sign in again — credentials alone should land on the 2FA challenge.
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("heading", { name: "Verify it's you" })).toBeVisible({
      timeout: 30_000,
    });

    await page.getByLabel("Authentication code").fill(totpFromSecret(secret));
    await page.getByRole("button", { name: "Verify" }).click();

    await page.waitForURL(/\/dashboard$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Ready for the next release" })).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await context.close();
  }
});
