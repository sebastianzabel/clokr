/**
 * Issue #710 — "Sichtbarkeits-Durchlauf": a reusable walkthrough that proves the target of every
 * step lies IN THE VIEWPORT after the step, not merely in the DOM.
 *
 * Why it exists: the role editor opened below the table, out of sight, for several releases
 * (#692). Every mounted test was green because it asserted that the element exists. `toBeVisible()`
 * is no better here: an element far below the fold is "visible". Only `toBeInViewport()` answers
 * "can the user see what the click did".
 *
 * Usage (see tests/role-editor-visibility-710.spec.ts):
 *
 *   defineVisibilityWalkthrough({
 *     title: "role editor opens in view",
 *     path: "/admin/roles",
 *     ready: (page) => expect(page.getByRole("table")).toBeVisible(),
 *     steps: [
 *       {
 *         name: "Ansehen",
 *         act: (page) => page.getByRole("row", { name: /Admin/ }).getByRole("button", { name: "Ansehen" }).click(),
 *         target: (page) => page.locator("#role-editor-form"),
 *       },
 *     ],
 *   });
 *
 * It registers one test per width (1280, 390, 360) x theme (light, dark). Each test signs in as
 * the admin of a throwaway tenant, sets the theme (stored `mode` + server preference + the
 * emulated colour scheme), runs the steps in order and, per step, asserts `toBeInViewport()` on
 * the target and takes a screenshot afterwards (also when the assertion failed).
 *
 * Screenshots: set `VISIBILITY_SHOTS_DIR` to an output directory (created on demand); files are
 * named `<slug(title)>--<width>-<light|dark>--<NN>-<slug(step)>.png`. Unset: no screenshots.
 * Run it against a stack with real data (the throwaway tenant of the fixture, or the Demo seed) —
 * never the dev database.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PASSWORD = "test1234";

export const WALKTHROUGH_VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 360, height: 800 },
] as const;

export const WALKTHROUGH_MODES = ["light", "dark"] as const;
export type WalkthroughMode = (typeof WALKTHROUGH_MODES)[number];

export interface WalkthroughStep {
  /** Shown in the assertion message and the screenshot file name. */
  name: string;
  /** The interaction (click, fill, keyboard ...). */
  act: (page: Page) => Promise<void>;
  /** What the user is expected to SEE afterwards; asserted with `toBeInViewport()`. */
  target: (page: Page) => Locator | Locator[];
}

export interface VisibilityWalkthrough {
  title: string;
  /** App path opened after sign-in. */
  path: string;
  /** Optional wait until the page is interactive (runs before the first step). */
  ready?: (page: Page) => Promise<void>;
  steps: WalkthroughStep[];
  /** Screenshot directory; defaults to `VISIBILITY_SHOTS_DIR`. */
  outDir?: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Signs in as the throwaway tenant's admin and stores the theme the way the app reads it. */
export async function signInForWalkthrough(
  page: Page,
  request: APIRequestContext,
  tenant: TestTenant,
  mode: WalkthroughMode,
): Promise<void> {
  const res = await request.post(`${API_BASE}/api/v1/auth/login`, {
    headers: { "content-type": "application/json" },
    data: { email: `admin@${tenant.tenantId}.test`, password: PASSWORD },
  });
  expect(res.ok(), `login as the tenant admin (${res.status()})`).toBe(true);
  const auth = (await res.json()) as {
    accessToken: string;
    refreshToken: string;
    user: Record<string, unknown>;
  };
  // The server preference would override the stored mode after sign-in, so set both.
  const pref = await request.put(`${API_BASE}/api/v1/me/preferences`, {
    headers: { "content-type": "application/json", Authorization: `Bearer ${auth.accessToken}` },
    data: { mode },
  });
  expect(pref.ok(), `store the ${mode} mode preference (${pref.status()})`).toBe(true);
  await page.addInitScript(
    ({ accessToken, refreshToken, user, m }) => {
      try {
        localStorage.setItem("accessToken", accessToken);
        localStorage.setItem("refreshToken", refreshToken);
        localStorage.setItem("user", JSON.stringify(user));
        localStorage.setItem("mode", m);
      } catch {
        /* localStorage may be locked; the cell then fails on the mode assertion */
      }
    },
    { ...auth, m: mode },
  );
  await page.emulateMedia({ colorScheme: mode });
}

/** Registers the width x theme matrix of one walkthrough as Playwright tests. */
export function defineVisibilityWalkthrough(w: VisibilityWalkthrough): void {
  test.describe(`Sichtbarkeits-Durchlauf — ${w.title}`, () => {
    for (const viewport of WALKTHROUGH_VIEWPORTS) {
      for (const mode of WALKTHROUGH_MODES) {
        test(`${viewport.width} px, ${mode === "light" ? "hell" : "dunkel"}`, async ({
          page,
          request,
          tenant,
        }) => {
          const shotsDir = w.outDir ?? process.env.VISIBILITY_SHOTS_DIR;
          if (shotsDir) mkdirSync(shotsDir, { recursive: true });
          await page.setViewportSize(viewport);
          await signInForWalkthrough(page, request, tenant, mode);
          await page.goto(w.path);
          // Anti-vacuity: the cell under test really is in the theme it claims.
          await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
          await w.ready?.(page);

          for (const [i, step] of w.steps.entries()) {
            const where = `${w.title} / step ${i + 1} "${step.name}" / ${viewport.width} px ${mode}`;
            await step.act(page);
            const raw = step.target(page);
            const targets = Array.isArray(raw) ? raw : [raw];
            expect(targets.length, `${where}: the step names a target`).toBeGreaterThan(0);
            try {
              for (const target of targets) {
                await expect(target, `${where}: target is in the viewport`).toBeInViewport();
              }
            } finally {
              // Screenshot after the assertion settled (a smooth scroll is done by then) and also
              // when it failed, so a red step keeps its evidence.
              if (shotsDir) {
                await page.screenshot({
                  path: join(
                    shotsDir,
                    `${slug(w.title)}--${viewport.width}-${mode}--${String(i + 1).padStart(2, "0")}-${slug(step.name)}.png`,
                  ),
                });
              }
            }
          }
        });
      }
    }
  });
}
