import { test as setup } from "@playwright/test";
import { login, TEST_ADMIN } from "./helpers";

const AUTH_FILE = ".auth/admin.json";

setup("authenticate as admin", async ({ page }) => {
  await login(page, TEST_ADMIN.email, TEST_ADMIN.password);
  await page.context().storageState({ path: AUTH_FILE });
});
