import { Page, expect } from "@playwright/test";

export const TEST_ADMIN = {
  email: process.env.TEST_ADMIN_EMAIL || "admin@clokr.de",
  password: process.env.TEST_ADMIN_PASSWORD || "Admin123!Pass",
};

export async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(email);
  await page.getByLabel("Passwort", { exact: true }).fill(password);
  await page.getByRole("button", { name: /anmelden/i }).click();
  // Wait for redirect to dashboard
  await page.waitForURL("**/dashboard", { timeout: 10_000 });
}

export async function loginAsAdmin(page: Page) {
  await login(page, TEST_ADMIN.email, TEST_ADMIN.password);
}

export async function logout(page: Page) {
  await page.getByRole("button", { name: /abmelden/i }).click();
  await page.waitForURL("**/login");
}

/** Take a full-page screenshot for visual reference */
export async function screenshotPage(page: Page, name: string) {
  await page.screenshot({ path: `test-results/screenshots/${name}.png`, fullPage: true });
}
