import os from "node:os";
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

const CI = !!process.env.CI;

// PLAYWRIGHT_BASE_URL is the canonical env var (used by Phase 70 CI axe-scan job).
// BASE_URL is kept for backwards compatibility with existing local workflows.
// Default to http://localhost:3001 (Phase 73-07 docker-compose.test.yml web service).
const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL || process.env.BASE_URL || "http://localhost:3001";

// D-08: 4 workers on CI (GitHub Actions standard runner is 4 cores),
// half the cores locally so the developer keeps a usable machine.
// Override via PLAYWRIGHT_WORKERS=N when debugging a flake at low parallelism.
const explicitWorkers = process.env.PLAYWRIGHT_WORKERS
  ? parseInt(process.env.PLAYWRIGHT_WORKERS, 10)
  : undefined;
const workers =
  explicitWorkers && Number.isFinite(explicitWorkers) && explicitWorkers > 0
    ? explicitWorkers
    : CI
      ? 4
      : Math.max(1, Math.floor(os.cpus().length / 2));

// D-07: bring up the full stack via docker-compose with --wait.
// `WEB_SERVER_DISABLED=true` lets developers point at an already-running dev stack
// (e.g. http://localhost:3000) without docker overhead.
const webServerDisabled = process.env.WEB_SERVER_DISABLED === "true";

// Health probe target is api-test on host port 4001 when using the default :3001 web URL.
// When PLAYWRIGHT_BASE_URL is overridden to a non-:3001 host (e.g. dev stack at :3000),
// the developer is expected to set WEB_SERVER_DISABLED=true as well.
const HEALTH_URL = `${BASE_URL.replace(":3001", ":4001")}/api/v1/health`;

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers,
  reporter: CI
    ? [["html", { open: "never" }], ["github"]]
    : [["html", { open: "on-failure" }], ["line"]],

  use: {
    baseURL: BASE_URL,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },

  // D-07: bring up the full test stack via docker-compose with --wait.
  // Reuses an existing running stack locally (developer-friendly), forces fresh on CI.
  // Skip entirely with WEB_SERVER_DISABLED=true (talk to an already-running dev stack).
  webServer: webServerDisabled
    ? undefined
    : {
        command:
          "docker compose -f ../../docker-compose.test.yml up --wait --quiet-pull",
        url: HEALTH_URL,
        reuseExistingServer: !CI,
        timeout: 180_000,
        stdout: "pipe",
        stderr: "pipe",
      },

  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      // Phase 70 advisory a11y gate (DEVOPS-V8-05): scans the public /login page only,
      // requires no auth/storageState.
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
    {
      // Phase 75 — Visual regression baselines (D-02, D-03, D-04).
      // Runs ONLY inside the pinned mcr.microsoft.com/playwright:v1.58.2-jammy image.
      // Outside that image, font rendering will differ and the run will be all-red.
      // Use `docker compose -f docker-compose.e2e.yml run --rm e2e-visual` locally.
      name: "visual",
      testMatch: /visual\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        // Honor prefers-reduced-motion at the browser level (defense-in-depth
        // alongside the per-test freezeAnimations fixture in visual.setup.ts).
        reducedMotion: "reduce",
        // Force a stable color-scheme so theme `data-theme="pflaume"` is consistent.
        colorScheme: "light",
        storageState: ".auth/admin.json",
      },
      // Per-test threshold defaults: D-04 sets 0.2% max diff ratio.
      // Override per-spec: `expect(page).toHaveScreenshot({ maxDiffPixelRatio: 0.005 })`.
      expect: {
        toHaveScreenshot: {
          maxDiffPixelRatio: 0.002,
          animations: "disabled",
          caret: "hide",
          scale: "css",
        },
      },
      dependencies: ["setup"],
    },
  ],
});
