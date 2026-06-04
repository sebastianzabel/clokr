import { defineConfig, devices } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env file manually (no dotenv dep needed)
try {
  const envFile = readFileSync(resolve(__dirname, ".env"), "utf8");
  for (const line of envFile.split("\n")) {
    const [key, ...vals] = line.split("=");
    if (key && !key.startsWith("#") && vals.length) {
      process.env[key.trim()] = vals.join("=").trim();
    }
  }
} catch {
  /* .env optional */
}

// PLAYWRIGHT_BASE_URL is the canonical env var (used by Phase 70 CI axe-scan job).
// BASE_URL is kept for backwards compatibility with existing local workflows.
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || process.env.BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["github"]]
    : [["html", { open: "on-failure" }]],

  use: {
    baseURL: BASE_URL,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      // Phase 70 advisory a11y gate (DEVOPS-V8-05): scans the public /login page only,
      // requires no auth/storageState. Phase 73 will extend this to authenticated pages
      // once docker-compose webServer + seeded DB are wired into CI.
      name: "axe-scan",
      testMatch: /axe-scan\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "desktop-chrome",
      use: {
        ...devices["Desktop Chrome"],
        storageState: ".auth/admin.json",
      },
      dependencies: ["setup"],
    },
    {
      name: "mobile-chrome",
      use: {
        ...devices["Pixel 7"],
        storageState: ".auth/admin.json",
      },
      dependencies: ["setup"],
    },
    {
      name: "tablet",
      use: {
        ...devices["iPad (gen 7)"],
        storageState: ".auth/admin.json",
      },
      dependencies: ["setup"],
    },
  ],
});
