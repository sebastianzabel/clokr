/**
 * Phase 843 (AC-4, AC-7, D-843-10, D-843-12) - keyboard, axe and the #636 stacking proofs on the
 * example page /admin/bausteine.
 *
 * The page renders every block in six nested theme x mode frames (`bausteine-frame-<theme>-<mode>`)
 * and offers two live overlays in its head: `bausteine-open-dialog` (the Dialog) and
 * `bausteine-open-confirm` (a ConfirmDialog). The tests:
 *
 *   1. Dialog       Tab and Shift+Tab stay inside it however often they are pressed, a press inside
 *                   released on the overlay keeps it open (A1), a click on the overlay closes it,
 *                   Escape closes it and focus returns to the trigger.
 *   2. Combobox     ArrowDown opens the listbox, ArrowDown / ArrowUp move the highlight, Enter
 *                   selects the highlighted item.
 *   3. Tabs         ArrowRight / ArrowLeft move the selection.
 *   4. DatePicker   the calendar opens, a day is picked, the segments show it.
 *   5. Toolbar      „+ Filter“ opens its popover, an option is chosen, a removable chip appears.
 *   6. axe          WCAG 2 A/AA including colour contrast, once per frame (six tests).
 *   7. #636         at 1440 px an open ConfirmDialog covers the topbar: `elementFromPoint` over the
 *                   topbar returns the overlay, the page behind is inert, Tab stays in the dialog.
 *
 * The assertions name a focus position or a selection, never just visibility: a trap that lets
 * focus leave, or a listbox whose Enter selects nothing, fails the test (T-843-30). Where a result
 * could be reached by accident a positive control comes first (the topbar lies under the probe
 * point before the dialog opens; a click on the overlay does close the dialog).
 *
 * Needs only the tenant fixture (no seed). Auth: API login plus addInitScript, the same model as
 * startpage-feedback-843.spec.ts. No fixed sleeps: every wait is an auto-waiting assertion.
 */
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PASSWORD = "test1234";

const THEMES = ["pflaume", "salz", "petrol"] as const;
const MODES = ["light", "dark"] as const;
const FRAMES = THEMES.flatMap((theme) => MODES.map((mode) => ({ theme, mode })));
const FIRST_FRAME = "bausteine-frame-pflaume-light";

async function signIn(page: Page, request: APIRequestContext, tenant: TestTenant): Promise<void> {
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
  await page.addInitScript(({ accessToken, refreshToken, user }) => {
    try {
      localStorage.setItem("accessToken", accessToken);
      localStorage.setItem("refreshToken", refreshToken);
      localStorage.setItem("user", JSON.stringify(user));
    } catch {
      /* localStorage may be locked; the auth store then falls back to the login page */
    }
  }, auth);
}

async function openExamplePage(
  page: Page,
  request: APIRequestContext,
  tenant: TestTenant,
): Promise<void> {
  await signIn(page, request, tenant);
  await page.goto("/admin/bausteine");
  await expect(page.getByTestId("bausteine-page")).toBeVisible();
}

/**
 * The visible text of the focused element when it lies inside `container`, else null. A trap that
 * lets focus escape (to the page behind, or to <body>) makes this null.
 */
async function focusedTextInside(container: Locator): Promise<string | null> {
  return container.evaluate((root) => {
    const active = document.activeElement;
    if (!active || !root.contains(active)) return null;
    return (active.textContent ?? "").trim() || active.tagName.toLowerCase();
  });
}

/**
 * Presses `key` more often than the container has focusable elements and proves after every press
 * that focus is still inside it. Returns the distinct focus positions visited, so the caller can
 * require that focus really moved (a frozen focus would pass the "inside" check trivially).
 */
async function pressAndStayInside(
  page: Page,
  container: Locator,
  key: "Tab" | "Shift+Tab",
  presses: number,
): Promise<Set<string>> {
  const visited = new Set<string>();
  for (let i = 1; i <= presses; i++) {
    await page.keyboard.press(key);
    await expect
      .poll(() => focusedTextInside(container), { message: `${key} #${i} left the container` })
      .not.toBeNull();
    const where = await focusedTextInside(container);
    if (where) visited.add(where);
  }
  return visited;
}

// ── 1. Dialog ────────────────────────────────────────────────────────────────────────────────
test("the Dialog traps Tab, ignores a press released on the overlay, closes on Escape and returns focus", async ({
  page,
  request,
  tenant,
}) => {
  await openExamplePage(page, request, tenant);
  const trigger = page.getByTestId("bausteine-open-dialog");
  const dialog = page.getByRole("dialog", { name: "Beispieldialog" });

  await trigger.click();
  await expect(dialog).toBeVisible();
  // The primary action carries [data-autofocus]; it, not the first tabbable, takes the focus.
  await expect(dialog.getByRole("button", { name: "Übernehmen" })).toBeFocused();

  // The dialog holds two buttons; six presses in each direction go round it several times.
  const forward = await pressAndStayInside(page, dialog, "Tab", 6);
  expect(forward.size, "Tab moved focus between the dialog's controls").toBeGreaterThanOrEqual(2);
  const backward = await pressAndStayInside(page, dialog, "Shift+Tab", 6);
  expect(
    backward.size,
    "Shift+Tab moved focus between the dialog's controls",
  ).toBeGreaterThanOrEqual(2);

  // A1: a press that starts inside the content and is released on the overlay is a drag, not a
  // click on the overlay, so the dialog stays open.
  const body = await dialog.locator(".modal-body p").boundingBox();
  expect(body, "the dialog body has a box").not.toBeNull();
  await page.mouse.move(body!.x + body!.width / 2, body!.y + body!.height / 2);
  await page.mouse.down();
  await page.mouse.move(8, 8);
  await page.mouse.up();
  await expect(dialog).toBeVisible();

  // Positive control for the line above: a real click on the overlay does close the dialog, so
  // "still open" was not a dialog that ignores the overlay altogether.
  await page.mouse.click(8, 8);
  await expect(dialog).toBeHidden();

  // Escape closes, and focus returns to the control that opened the dialog.
  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

// ── 2. Combobox ──────────────────────────────────────────────────────────────────────────────
test("the Combobox opens on ArrowDown, moves its highlight with ArrowDown and ArrowUp and selects on Enter", async ({
  page,
  request,
  tenant,
}) => {
  await openExamplePage(page, request, tenant);
  const frame = page.getByTestId(FIRST_FRAME);
  const input = frame.getByRole("combobox", { name: "Stammsalon" });
  const listbox = page.getByRole("listbox");
  const highlighted = listbox.locator('[role="option"][data-highlighted]');

  await expect(input).toHaveValue("Salon Süd");
  await input.focus();
  // P6: the first ArrowDown opens the list.
  await page.keyboard.press("ArrowDown");
  await expect(listbox).toBeVisible();

  // The next ArrowDown puts the highlight on one item, whatever the open step highlighted.
  await page.keyboard.press("ArrowDown");
  await expect(highlighted).toHaveCount(1);
  const first = ((await highlighted.textContent()) ?? "").trim();
  expect(first).not.toBe("");

  // ArrowDown moves on to another item, ArrowUp returns, ArrowDown goes on again.
  await page.keyboard.press("ArrowDown");
  await expect(highlighted).not.toHaveText(first);
  await expect(highlighted).toHaveCount(1);
  const second = ((await highlighted.textContent()) ?? "").trim();
  expect(second, "ArrowDown moved the highlight to another item").not.toBe(first);
  await page.keyboard.press("ArrowUp");
  await expect(highlighted).toHaveText(first);
  await page.keyboard.press("ArrowDown");
  await expect(highlighted).toHaveText(second);

  // Enter selects exactly the highlighted item and closes the list.
  await page.keyboard.press("Enter");
  await expect(listbox).toBeHidden();
  await expect(input).toHaveValue(second);
  expect(second, "the selection changed away from the initial Salon Süd").not.toBe("Salon Süd");
});

// ── 3. Tabs ──────────────────────────────────────────────────────────────────────────────────
test("the page tabs move their selection with ArrowRight and ArrowLeft", async ({
  page,
  request,
  tenant,
}) => {
  await openExamplePage(page, request, tenant);
  const frame = page.getByTestId(FIRST_FRAME);
  const overview = frame.getByRole("tab", { name: "Übersicht" });
  const requests = frame.getByRole("tab", { name: "Anträge" });

  await expect(overview).toHaveAttribute("aria-selected", "true");
  await expect(requests).toHaveAttribute("aria-selected", "false");
  await overview.focus();

  await page.keyboard.press("ArrowRight");
  await expect(requests).toHaveAttribute("aria-selected", "true");
  await expect(overview).toHaveAttribute("aria-selected", "false");
  await expect(requests).toBeFocused();
  // The panel follows the selection.
  await expect(frame.getByText("Hier warten offene Anträge auf eine Entscheidung.")).toBeVisible();

  await page.keyboard.press("ArrowLeft");
  await expect(overview).toHaveAttribute("aria-selected", "true");
  await expect(requests).toHaveAttribute("aria-selected", "false");
  await expect(overview).toBeFocused();
});

// ── 4. DatePicker ────────────────────────────────────────────────────────────────────────────
test("the DatePicker opens its calendar and a picked day shows in the segments", async ({
  page,
  request,
  tenant,
}) => {
  await openExamplePage(page, request, tenant);
  const frame = page.getByTestId(FIRST_FRAME);
  const segments = frame.locator('[role="spinbutton"]');

  // The demo starts on 2026-11-01 (German order: day, month, year).
  await expect(segments).toHaveText(["01", "11", "2026"]);

  await frame.getByRole("button", { name: "Kalender öffnen" }).click();
  const grid = page.getByRole("grid");
  await expect(grid).toBeVisible();

  await grid.locator('[role="gridcell"][data-value="2026-11-18"] [data-bits-day]').click();
  await expect(segments).toHaveText(["18", "11", "2026"]);
  await expect(grid).toBeHidden();
});

// ── 5. Toolbar popover ───────────────────────────────────────────────────────────────────────
test("the toolbar's „+ Filter“ popover opens and a chosen option becomes a removable chip", async ({
  page,
  request,
  tenant,
}) => {
  await openExamplePage(page, request, tenant);
  const frame = page.getByTestId(FIRST_FRAME);
  const chip = frame.getByText("Status: Aktiv");

  await expect(chip).toHaveCount(0);
  await frame.getByRole("button", { name: "+ Filter" }).click();
  await page.getByRole("radio", { name: "Aktiv" }).click();

  await expect(chip).toBeVisible();
  const remove = frame.getByRole("button", { name: "Filter Status entfernen" });
  await expect(remove).toBeVisible();

  // Closing the popover first (Escape), then removing the chip takes the filter off again.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("radio", { name: "Aktiv" })).toBeHidden();
  await remove.click();
  await expect(chip).toHaveCount(0);
});

// ── 6. axe, once per frame ───────────────────────────────────────────────────────────────────
for (const { theme, mode } of FRAMES) {
  test(`axe finds no WCAG 2 A/AA violation, colour contrast included, in the frame ${theme} ${mode}`, async ({
    page,
    request,
    tenant,
  }) => {
    // Entrance animations would paint blended colours into the contrast measurement.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openExamplePage(page, request, tenant);
    const testId = `bausteine-frame-${theme}-${mode}`;
    const frame = page.getByTestId(testId);
    await expect(frame).toBeVisible();
    await page.waitForLoadState("networkidle");

    // Colour contrast stays enabled: the rule list is the tag set alone.
    const results = await new AxeBuilder({ page })
      .include(`[data-testid="${testId}"]`)
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const report = results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
    }));
    expect(report, `axe violations in ${testId}: ${JSON.stringify(report, null, 2)}`).toEqual([]);
    // Anti-vacuity: the scan looked at something (a wrong selector would pass an empty page).
    expect(results.passes.length, `axe checked nothing inside ${testId}`).toBeGreaterThan(0);
  });
}

// ── 7. #636: the dialog covers the topbar ────────────────────────────────────────────────────
test("an open ConfirmDialog covers the topbar at 1440 px, makes the page inert and keeps Tab inside", async ({
  page,
  request,
  tenant,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openExamplePage(page, request, tenant);

  const topbar = page.locator("header.topbar");
  await expect(topbar).toBeVisible();
  const box = await topbar.boundingBox();
  expect(box, "the topbar has a box").not.toBeNull();
  const probe = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };

  /** What lies at the probe point, and whether the page child holding the topbar is inert. */
  const stack = () =>
    page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      const bar = document.querySelector("header.topbar");
      const holder = [...document.body.children].find((c) => bar && c.contains(bar));
      return {
        inTopbar: !!hit?.closest("header.topbar"),
        inScrim: !!hit?.closest(".scrim"),
        hit: hit ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join(".")}` : "none",
        holderInert: !!holder?.hasAttribute("inert"),
      };
    }, probe);

  // Positive control: before the dialog opens the probe point lies on the topbar, so the "scrim"
  // answer below is the dialog's doing and not a probe that never touched the bar.
  const before = await stack();
  expect(before.inTopbar, `before: element at the topbar centre is ${before.hit}`).toBe(true);
  expect(before.holderInert).toBe(false);

  await page.getByTestId("bausteine-open-confirm").click();
  const dialog = page.getByRole("dialog", { name: "Eintrag löschen?" });
  await expect(dialog).toBeVisible();

  const open = await stack();
  expect(open.inScrim, `the element at the topbar centre is ${open.hit}, not the overlay`).toBe(
    true,
  );
  expect(open.inTopbar, "the topbar still receives pointer events").toBe(false);
  expect(open.holderInert, "the page child holding the topbar is inert").toBe(true);

  // Tab and Shift+Tab never reach the topbar or the page behind.
  const forward = await pressAndStayInside(page, dialog, "Tab", 6);
  expect(forward.size, "Tab moved focus between the dialog's controls").toBeGreaterThanOrEqual(2);
  await pressAndStayInside(page, dialog, "Shift+Tab", 6);

  // Escape closes it; the page is live again.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const after = await stack();
  expect(after.holderInert, "the page is no longer inert after closing").toBe(false);
  expect(after.inTopbar, `after: element at the topbar centre is ${after.hit}`).toBe(true);
});
