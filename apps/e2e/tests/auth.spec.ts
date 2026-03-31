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

  test("login + logout flow", async ({ page }) => {
    await loginAsAdmin(page);
    await expect(page).toHaveURL(/dashboard/);
    await logout(page);
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

  // Unauthenticated flows — override storageState so these tests have no auth context
  test.describe("unauthenticated flows", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("rejects wrong password", async ({ page }) => {
      await page.goto("/login");
      // Use a non-existent email to avoid incrementing the fail counter on the real admin account
      await page.getByLabel("E-Mail").fill("nonexistent@test.invalid");
      await page.getByLabel("Passwort", { exact: true }).fill("wrongpassword123");
      await page.getByRole("button", { name: /anmelden/i }).click();
      // Wait for error message
      await expect(page.getByText(/ungültige|fehlgeschlagen|gesperrt|anmeldedaten/i)).toBeVisible({
        timeout: 5000,
      });
    });

    test("redirects unauthenticated to login", async ({ page }) => {
      await page.goto("/dashboard");
      await page.waitForURL("**/login", { timeout: 5000 });
      await expect(page).toHaveURL(/login/);
    });
  });
});
