#!/usr/bin/env node
/**
 * capture-screenshots.mjs — standalone showcase-screenshot capturer for the Clokr web app.
 *
 * Drives the running *dev stack* with a real Chromium (the one bundled with the repo's
 * already-installed @playwright/test) and produces two output sets:
 *
 *   1. The full 31-page design set  → OUT_DIR  (default docs/design/screenshots)
 *      Full-page PNG. Desktop 1440x900; the two mobile shots at 390x844;
 *      29-dashboard-dark rendered with the dark mode enabled at 1440x900.
 *
 *   2. A README hero subset          → images/  (fixed name), 1280x800, full-page:
 *      screenshot-dashboard.png, screenshot-time-entries.png, screenshot-leave.png,
 *      screenshot-reports.png, screenshot-employees.png, screenshot-settings.png
 *
 * This is a *script*, not a Playwright test. Run it manually against a seeded dev stack:
 *
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... EMP_EMAIL=... EMP_PASSWORD=... \
 *     node scripts/capture-screenshots.mjs
 *
 * Every capture is wrapped in try/catch: one bad route never aborts the run, and a
 * summary is printed at the end.
 *
 * ── Config (all via env vars, with defaults) ────────────────────────────────────────
 *   BASE_URL        default http://localhost:3000   (dev web server)
 *   ADMIN_EMAIL     default admin@clokr.de
 *   ADMIN_PASSWORD  default admin1234
 *   EMP_EMAIL       default (falls back to ADMIN_EMAIL if unset — see resolveCreds)
 *   EMP_PASSWORD    default (falls back to ADMIN_PASSWORD if unset)
 *   OUT_DIR         default docs/design/screenshots
 *   HEADLESS        default true  (set HEADLESS=false to watch it run)
 *
 * NOTE: credentials are NEVER hardcoded to anything real — the demo creds are supplied
 * at runtime. The defaults above are the repo's generic test values.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdirSync } from "node:fs";

// ── Resolve @playwright/test even though it lives in apps/e2e/node_modules ────────────
// This script sits at repo-root/scripts and is run with a bare `node`, so a plain
// `import "@playwright/test"` would not resolve from the repo root. We locate the module
// via createRequire against several candidate base dirs, then import its file URL.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

async function loadPlaywright() {
  const candidates = [
    join(REPO_ROOT, "apps", "e2e", "package.json"), // where @playwright/test is installed
    join(REPO_ROOT, "package.json"),
    join(process.cwd(), "package.json"),
  ];
  for (const base of candidates) {
    try {
      const req = createRequire(base);
      // @playwright/test is CommonJS — require() returns the object with `chromium`
      // directly. (A dynamic import() of a CJS file would hide it under `.default`.)
      const mod = req("@playwright/test");
      return mod;
    } catch {
      /* try next candidate */
    }
  }
  // Last resort: a bare specifier (works if the loader can resolve it directly).
  return import("@playwright/test");
}

const { chromium } = await loadPlaywright();

// ── Config ───────────────────────────────────────────────────────────────────────────
const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const OUT_DIR = process.env.OUT_DIR || "docs/design/screenshots";
const IMAGES_DIR = "images"; // README hero subset — fixed location & names
const HEADLESS = process.env.HEADLESS !== "false";

function resolveCreds() {
  const adminEmail = process.env.ADMIN_EMAIL || "admin@clokr.de";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin1234";
  // Employee creds fall back to admin creds so the script still runs (admin can view the
  // employee-perspective pages), but a warning is printed so the operator knows the
  // "employee view" shots were captured as admin.
  const empEmail = process.env.EMP_EMAIL || adminEmail;
  const empPassword = process.env.EMP_PASSWORD || adminPassword;
  const empIsFallback = !process.env.EMP_EMAIL;
  return { adminEmail, adminPassword, empEmail, empPassword, empIsFallback };
}

const CREDS = resolveCreds();

// Absolute output dirs (script is CWD-agnostic — resolve against repo root).
const OUT_DIR_ABS = resolve(REPO_ROOT, OUT_DIR);
const IMAGES_DIR_ABS = resolve(REPO_ROOT, IMAGES_DIR);
mkdirSync(OUT_DIR_ABS, { recursive: true });
mkdirSync(IMAGES_DIR_ABS, { recursive: true });

// ── Viewports ─────────────────────────────────────────────────────────────────────────
const VP_DESKTOP = { width: 1440, height: 900 };
const VP_MOBILE = { width: 390, height: 844 };
const VP_README = { width: 1280, height: 800 };

// ── Route map ─────────────────────────────────────────────────────────────────────────
// Design set (31 shots). name → path → role → viewport → theme mode.
// Roles: "public" (no login), "emp" (employee perspective), "admin" (manager/admin).
// The employee-perspective shots (dashboard/time-entries/leave/settings) use `emp`
// because those screens are the personal-view hero surfaces; everything team/admin-wide
// uses `admin` (broadest access ⇒ most populated, least likely to 403 or be empty).
//
// The literal "01…31" index is reconstructed here from docs/design/README.md §5 (Screen
// specs) mapped onto the *real* SvelteKit routes under apps/web/src/routes/(app) and
// (auth). The README uses prototype route names (/time, /close, /compliance, /themes,
// /export …); the real routes differ and are used below.
const DESIGN_SHOTS = [
  // Public (captured logged-out, first)
  { name: "01-login", path: "/login", role: "public", vp: VP_DESKTOP },

  // Employee perspective
  { name: "02-dashboard", path: "/dashboard", role: "emp", vp: VP_DESKTOP },
  { name: "03-time-entries", path: "/time-entries", role: "emp", vp: VP_DESKTOP },
  { name: "04-leave", path: "/leave", role: "emp", vp: VP_DESKTOP },
  { name: "05-reports", path: "/reports", role: "emp", vp: VP_DESKTOP },
  { name: "06-settings", path: "/settings", role: "emp", vp: VP_DESKTOP },
  { name: "07-availability", path: "/availability", role: "emp", vp: VP_DESKTOP },

  // Manager / team
  { name: "08-inbox", path: "/inbox", role: "admin", vp: VP_DESKTOP },
  { name: "09-teamcal", path: "/teamcal", role: "admin", vp: VP_DESKTOP },
  { name: "10-team-time-entries", path: "/team/time-entries", role: "admin", vp: VP_DESKTOP },
  { name: "11-team-leave", path: "/team/leave", role: "admin", vp: VP_DESKTOP },
  { name: "12-shifts", path: "/shifts", role: "admin", vp: VP_DESKTOP },
  { name: "13-shifts-conflicts", path: "/shifts/conflicts", role: "admin", vp: VP_DESKTOP },

  // Admin — people
  { name: "14-employees", path: "/admin/employees", role: "admin", vp: VP_DESKTOP },
  // 15 employee-detail: id is discovered at runtime from the employees list (see EMP_DETAIL).
  { name: "15-employee-detail", path: "__EMP_DETAIL__", role: "admin", vp: VP_DESKTOP },

  // Admin — settings hub + tabs
  { name: "16-admin", path: "/admin", role: "admin", vp: VP_DESKTOP },
  { name: "17-admin-month-close", path: "/admin/month-close", role: "admin", vp: VP_DESKTOP },
  { name: "18-admin-audit", path: "/admin/audit", role: "admin", vp: VP_DESKTOP },
  { name: "19-admin-themes", path: "/admin/themes", role: "admin", vp: VP_DESKTOP },
  { name: "20-admin-export", path: "/admin/export", role: "admin", vp: VP_DESKTOP },
  { name: "21-admin-integrations", path: "/admin/integrations", role: "admin", vp: VP_DESKTOP },
  { name: "22-admin-phorest", path: "/admin/phorest", role: "admin", vp: VP_DESKTOP }, // v1.9 new
  { name: "23-admin-vacation", path: "/admin/vacation", role: "admin", vp: VP_DESKTOP },
  { name: "24-admin-special-leave", path: "/admin/special-leave", role: "admin", vp: VP_DESKTOP },
  { name: "25-admin-shutdowns", path: "/admin/shutdowns", role: "admin", vp: VP_DESKTOP },
  { name: "26-admin-system", path: "/admin/system", role: "admin", vp: VP_DESKTOP },
  { name: "27-admin-import", path: "/admin/import", role: "admin", vp: VP_DESKTOP },

  // Public (logged-out)
  { name: "28-forgot-password", path: "/forgot-password", role: "public", vp: VP_DESKTOP },

  // Dark + mobile
  { name: "29-dashboard-dark", path: "/dashboard", role: "emp", vp: VP_DESKTOP, dark: true },
  { name: "30-dashboard-mobile", path: "/dashboard", role: "emp", vp: VP_MOBILE },
  { name: "31-time-entries-mobile", path: "/time-entries", role: "emp", vp: VP_MOBILE },
];

// README hero subset. name (fixed) → path → role. All 1280x800, full-page, light mode.
// Judgment calls: dashboard/time-entries/leave use the *employee* view (personal hero
// surfaces look best populated with the timer card + calendar); reports/employees/settings
// use *admin* (team-wide / admin-only screens are richer as admin).
const README_SHOTS = [
  { name: "screenshot-dashboard", path: "/dashboard", role: "emp" },
  { name: "screenshot-time-entries", path: "/time-entries", role: "emp" },
  { name: "screenshot-leave", path: "/leave", role: "emp" },
  { name: "screenshot-reports", path: "/reports", role: "admin" },
  { name: "screenshot-employees", path: "/admin/employees", role: "admin" },
  { name: "screenshot-settings", path: "/settings", role: "admin" },
];

// ── Result tracking ────────────────────────────────────────────────────────────────────
const results = []; // { name, set, status: "ok" | "fail", detail }
function record(set, name, status, detail = "") {
  results.push({ set, name, status, detail });
  const tag = status === "ok" ? "✓" : "✗";
  console.log(`  ${tag} [${set}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────

/**
 * Replicates the e2e login UI flow (apps/e2e/tests/helpers.ts):
 *   goto /login → fill E-Mail + Passwort → click "Anmelden" → wait for /dashboard.
 * Uses substring label matching (the real field label is "E-Mail-Adresse").
 */
async function login(page, email, password) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  // E-Mail field — label is "E-Mail-Adresse", match on the "E-Mail" substring.
  await page.getByLabel(/e-?mail/i).first().fill(email);
  // Password field — label is exactly "Passwort" (avoid the show/hide toggle aria-labels).
  await page.getByLabel("Passwort", { exact: true }).fill(password);
  await page.getByRole("button", { name: /anmelden/i }).click();
  // Post-login lands on /dashboard.
  await page.waitForURL("**/dashboard", { timeout: 15_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
}

/**
 * Wait for layout to settle: networkidle + fonts loaded + no running animations,
 * bounded by a timeout so an always-animating page (live timer pulse) still proceeds.
 */
async function settle(page, timeout = 2500) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page
    .waitForFunction(
      () => {
        if (document.fonts && document.fonts.status !== "loaded") return false;
        const anims = document.getAnimations?.() ?? [];
        // Ignore infinite/looping animations (timer pulse) — only block on finite ones.
        const blocking = anims.filter(
          (a) =>
            a.playState === "running" &&
            a.effect?.getTiming?.().iterations !== Infinity,
        );
        return blocking.length === 0;
      },
      null,
      { timeout },
    )
    .catch(() => {});
  // Small settle margin for chart.js canvases / entrance stagger.
  await page.waitForTimeout(600);
}

/** Navigate to an app path, tolerating client-side redirects. */
async function gotoApp(page, path) {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded" });
  await settle(page);
}

/** Set (or clear) dark mode via the app's own mechanism: localStorage `mode` + reload. */
async function setDarkMode(page, enabled) {
  await page.evaluate((on) => {
    if (on) localStorage.setItem("mode", "dark");
    else localStorage.setItem("mode", "light");
  }, enabled);
  await page.reload({ waitUntil: "domcontentloaded" });
  await settle(page);
}

/** Discover the first employee-detail URL from the /admin/employees list. */
async function discoverEmployeeDetailPath(page) {
  await gotoApp(page, "/admin/employees");
  const href = await page
    .locator('a[href^="/admin/employees/"]')
    .first()
    .getAttribute("href")
    .catch(() => null);
  return href; // e.g. "/admin/employees/<id>" or null if list empty
}

async function capture(page, absPath) {
  await page.screenshot({ path: absPath, fullPage: true });
}

// ── Main ──────────────────────────────────────────────────────────────────────────────
async function run() {
  console.log("Clokr showcase screenshots");
  console.log(`  BASE_URL   : ${BASE_URL}`);
  console.log(`  OUT_DIR    : ${OUT_DIR_ABS}`);
  console.log(`  IMAGES_DIR : ${IMAGES_DIR_ABS}`);
  console.log(`  ADMIN      : ${CREDS.adminEmail}`);
  console.log(`  EMP        : ${CREDS.empEmail}${CREDS.empIsFallback ? "  (fallback → ADMIN — set EMP_EMAIL/EMP_PASSWORD for a true employee view)" : ""}`);
  console.log("");

  const browser = await chromium.launch({ headless: HEADLESS });

  // One context (and one page) per role. Login once per role.
  /** @type {Record<string, {ctx: any, page: any}>} */
  const sessions = {};

  async function getSession(role) {
    if (role === "public") {
      if (!sessions.public) {
        const ctx = await browser.newContext({ viewport: VP_DESKTOP, deviceScaleFactor: 1 });
        sessions.public = { ctx, page: await ctx.newPage() };
      }
      return sessions.public;
    }
    if (sessions[role]) return sessions[role];
    const ctx = await browser.newContext({ viewport: VP_DESKTOP, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const email = role === "admin" ? CREDS.adminEmail : CREDS.empEmail;
    const password = role === "admin" ? CREDS.adminPassword : CREDS.empPassword;
    try {
      await login(page, email, password);
    } catch (err) {
      console.error(`  ! login failed for role "${role}" (${email}): ${err.message}`);
      throw err;
    }
    sessions[role] = { ctx, page };
    return sessions[role];
  }

  // Resolve the runtime employee-detail path once (needs an admin session).
  let empDetailPath = null;
  try {
    const { page } = await getSession("admin");
    empDetailPath = await discoverEmployeeDetailPath(page);
    if (!empDetailPath) console.warn("  ! No employee rows found — 15-employee-detail will be skipped.");
  } catch {
    console.warn("  ! Could not establish admin session for employee-detail discovery.");
  }

  // ── Design set (OUT_DIR) ──────────────────────────────────────────────────────────
  console.log("\n── Design set → OUT_DIR ──");
  for (const shot of DESIGN_SHOTS) {
    try {
      let path = shot.path;
      if (path === "__EMP_DETAIL__") {
        if (!empDetailPath) {
          record("design", shot.name, "fail", "no employee id discovered");
          continue;
        }
        path = empDetailPath;
      }

      const { page } = await getSession(shot.role);

      // Viewport for this shot (mobile shots differ from the context default).
      await page.setViewportSize(shot.vp);

      if (shot.role === "public") {
        await gotoApp(page, path);
      } else {
        await gotoApp(page, path);
      }

      // Dark shot: flip mode via app mechanism, then reload; reset afterwards.
      if (shot.dark) {
        await setDarkMode(page, true);
      }

      await settle(page);
      await capture(page, join(OUT_DIR_ABS, `${shot.name}.png`));
      record("design", shot.name, "ok", `${path} @ ${shot.vp.width}x${shot.vp.height}${shot.dark ? " (dark)" : ""}`);

      // Undo per-shot state so later captures in the same session are unaffected.
      if (shot.dark) await setDarkMode(page, false);
      if (shot.vp !== VP_DESKTOP) await page.setViewportSize(VP_DESKTOP);
    } catch (err) {
      record("design", shot.name, "fail", err.message);
      // Best-effort reset so a mid-shot failure doesn't poison the session.
      try {
        const { page } = sessions[shot.role] || {};
        if (page) {
          await page.setViewportSize(VP_DESKTOP);
          await page.evaluate(() => localStorage.setItem("mode", "light")).catch(() => {});
        }
      } catch {
        /* ignore */
      }
    }
  }

  // ── README hero subset (images/) ───────────────────────────────────────────────────
  console.log("\n── README subset → images/ ──");
  for (const shot of README_SHOTS) {
    try {
      const { page } = await getSession(shot.role);
      await page.setViewportSize(VP_README);
      await gotoApp(page, shot.path);
      await settle(page);
      await capture(page, join(IMAGES_DIR_ABS, `${shot.name}.png`));
      record("readme", shot.name, "ok", `${shot.path} @ ${VP_README.width}x${VP_README.height}`);
      await page.setViewportSize(VP_DESKTOP);
    } catch (err) {
      record("readme", shot.name, "fail", err.message);
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────────────────
  for (const s of Object.values(sessions)) {
    await s.ctx.close().catch(() => {});
  }
  await browser.close().catch(() => {});

  // ── Summary ─────────────────────────────────────────────────────────────────────────
  const ok = results.filter((r) => r.status === "ok");
  const fail = results.filter((r) => r.status === "fail");
  console.log("\n────────────── Summary ──────────────");
  console.log(`  Captured : ${ok.length}`);
  console.log(`  Failed   : ${fail.length}`);
  if (fail.length) {
    console.log("  Failures:");
    for (const f of fail) console.log(`    - [${f.set}] ${f.name}: ${f.detail}`);
  }
  console.log("─────────────────────────────────────");

  // Non-zero exit if everything failed (likely stack down / bad creds); otherwise 0.
  process.exitCode = ok.length === 0 ? 1 : 0;
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exitCode = 1;
});
