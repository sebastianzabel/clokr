import { test, expect } from "@playwright/test";
import { TEST_ADMIN, loginAsAdmin, logout } from "./helpers";

test.describe("Authentication", () => {
  test("shows login page", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: /anmelden/i }).or(page.getByText("Anmelden")),
    ).toBeVisible();
    await expect(page.getByLabel("E-Mail")).toBeVisible();
    await expect(page.getByLabel("Passwort", { exact: true })).toBeVisible();
  });

  test("rejects wrong password", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("E-Mail").fill(TEST_ADMIN.email);
    await page.getByLabel("Passwort", { exact: true }).fill("wrongpassword123");
    await page.getByRole("button", { name: /anmelden/i }).click();
    // Wait for error message or page to reload (lockout may show different message)
    await expect(page.getByText(/ungültige|fehlgeschlagen|gesperrt|anmeldedaten/i)).toBeVisible({
      timeout: 5000,
    });
  });

  test("login + logout flow", async ({ page }) => {
    await loginAsAdmin(page);
    await expect(page).toHaveURL(/dashboard/);
    await logout(page);
    await expect(page).toHaveURL(/login/);
  });

  test("redirects unauthenticated to login", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForURL("**/login", { timeout: 5000 });
    await expect(page).toHaveURL(/login/);
  });

  test("remember me checkbox visible", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("Angemeldet bleiben")).toBeVisible();
  });

  test("forgot password link visible", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("Passwort vergessen")).toBeVisible();
  });
});
