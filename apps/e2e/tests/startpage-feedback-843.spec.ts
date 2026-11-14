/**
 * Phase 843 (AC-3, D-843-08, D-843-19) - every write of the start pages acknowledges its result.
 *
 * One person, one day, six writes, each asserted on the text of the toast status region (the polite
 * live region the Toast block mounts empty at app start; `toast-region-status`). The scope is the
 * region's test id because the Spinner also renders role=status:
 *
 *   /dashboard     clock in -> „Eingestempelt HH:MM[ · <Salon>]“, break start -> „Pause gestartet HH:MM“,
 *                  break end -> „Pause beendet HH:MM“, clock out -> „Ausgestempelt HH:MM“
 *   /leave         a one-day request through the form -> „Antrag gestellt · <Art> <Zeitraum>“
 *   /time-entries  the day's entry, end one minute later -> „Korrektur gespeichert“
 *
 * The salon part of the clock-in text depends on the tenant (a single-salon fixture may name none),
 * so it is only required to be non-empty text after „ · “ when present; no salon name is hard-coded.
 * The leave request is a sick day (the existing leave-flow.spec pattern): it does not meet the
 * vacation-entitlement guard that a bare fixture tenant would trip, and the acknowledgement text
 * is built the same way for every type. The day is a future weekday inside the current year.
 *
 * Needs only the tenant fixture (no seed). Auth: API login plus addInitScript, the same model as
 * narrow-648-843.spec.ts. No fixed sleeps: every wait is an auto-waiting locator assertion.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PASSWORD = "test1234";

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

/**
 * A weekday after today that stays inside the current calendar year (the /leave list is
 * year-scoped). Local noon before formatting, so the UTC cut cannot yield the previous day.
 */
function futureWeekdayInCurrentYear(offsetDays: number): string {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const year = today.getFullYear();
  const target = new Date(today);
  target.setDate(target.getDate() + offsetDays);
  if (target.getFullYear() === year) {
    while (target.getDay() === 0 || target.getDay() === 6) target.setDate(target.getDate() + 1);
  }
  if (target.getFullYear() !== year) {
    target.setFullYear(year, 11, 31);
    while (target.getDay() === 0 || target.getDay() === 6) target.setDate(target.getDate() - 1);
  }
  if (target.getTime() <= today.getTime()) {
    throw new Error(`no future weekday left in ${year} for offset ${offsetDays}`);
  }
  const y = target.getFullYear();
  const m = String(target.getMonth() + 1).padStart(2, "0");
  const d = String(target.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The time one minute after an `HH:MM` value. */
function oneMinuteLater(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = (h * 60 + m + 1) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

test("every start-page write acknowledges its result in the toast status region", async ({
  page,
  request,
  tenant,
}) => {
  await signIn(page, request, tenant);
  const region = page.getByTestId("toast-region-status");

  // ── /dashboard: clock in, break start, break end, clock out ──────────────────────────────
  await page.goto("/dashboard");
  // The region is mounted empty at app start; nothing has been acknowledged yet.
  await expect(region).toBeAttached();
  await expect(region).toHaveText("");

  await page.getByRole("button", { name: "Einstempeln", exact: true }).click();
  // A salon part, when the page names one, is „ · “ followed by non-empty text.
  await expect(region).toHaveText(/^\s*Eingestempelt \d{2}:\d{2}( · \S.*)?\s*$/);

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(region).toContainText(/Pause gestartet \d{2}:\d{2}/);

  await page.getByRole("button", { name: "Weiterarbeiten", exact: true }).click();
  await expect(region).toContainText(/Pause beendet \d{2}:\d{2}/);

  await page.getByRole("button", { name: "Ausstempeln", exact: true }).click();
  await expect(region).toContainText(/Ausgestempelt \d{2}:\d{2}/);

  // ── /leave: a one-day request through the form ───────────────────────────────────────────
  const day = futureWeekdayInCurrentYear(90);
  await page.goto("/leave");
  await page.getByTestId("leave-new-request").click();
  const form = page.getByTestId("leave-form");
  await expect(form).toBeVisible();
  await form.getByTestId("leave-form-type").selectOption("SICK");
  await form.getByTestId("leave-form-from").fill(day);
  await form.getByTestId("leave-form-to").fill(day);
  await form.getByTestId("leave-form-submit").click();
  await expect(region).toContainText("Antrag gestellt · ");

  // ── /time-entries: the day's entry, end one minute later ─────────────────────────────────
  await page.goto("/time-entries?view=list");
  // Issue #927: the row actions sit in the row's „…“ menu; open it, then choose „Bearbeiten“.
  await page
    .getByTestId(/^time-entry-row-[0-9a-f-]+-menu$/)
    .first()
    .click();
  await page
    .getByTestId(/^time-entry-row-[0-9a-f-]+-edit$/)
    .first()
    .click();
  const end = page.getByTestId("time-entry-modal-end");
  await expect(end).toBeVisible();
  // The break the flow above took lasted a few seconds. Since #596 (#845) the running break is a
  // server state, and a break shorter than a minute leaves no Break row (a double tap is no
  // Ruhepause), so the entry carries no break slot. The correction under test is the end time.
  await expect(page.getByTestId("break-slot-0")).toHaveCount(0);
  await end.fill(oneMinuteLater(await end.inputValue()));
  await page.getByTestId("time-entry-modal-save").click();
  await expect(region).toContainText("Korrektur gespeichert");
});
