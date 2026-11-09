/**
 * Issue #850 — the shift planning speaks to the salon manager: the page "Hinweise zur
 * Schichtplanung" (/shifts/conflicts) is ONE list of notices (date, person, reason, action), the
 * Planungsbedarf week reads "KW n · d.–d. Mon.".
 *
 * Test 1 drives a marked shift end to end on the real stack: a shift is planned for a person,
 * then a vacation over that day is approved — the approval marks the shift (`conflictsWithLeave`,
 * Phase 43-04). The notice list shows it with its German date, the person, the reason and the
 * action „Schicht behalten“; the explanation sits behind (i); the action clears the mark and the
 * row leaves the list.
 *
 * The Sichtbarkeits-Durchlauf (Issue #710) then proves at 1280/390/360 px, light and dark, that
 * the notice row with its action and the opened explanation are in the viewport, and that the
 * Planungsbedarf week label is.
 *
 * Setup goes through the API with the tenant admin token (person, entitlement, shift, vacation,
 * approval). No fixed calendar date: the day is the second Wednesday of March NEXT year, chosen
 * because no Bundesland has a public holiday then; the page's date range is set to that month.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { defineVisibilityWalkthrough } from "../helpers/visibility-walkthrough";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const PASSWORD = "test1234";
const YEAR = new Date().getFullYear() + 1;

/** The second Wednesday of March of next year, YYYY-MM-DD. */
function secondWednesdayOfMarch(): string {
  const first = new Date(Date.UTC(YEAR, 2, 1));
  const offset = (3 - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(YEAR, 2, 1 + offset + 7)).toISOString().slice(0, 10);
}

const DAY = secondWednesdayOfMarch();
const DAY_LABEL = `Mi., ${Number(DAY.slice(8, 10))}. März`;

/** Creates a person with a shift on DAY and approves a vacation over it: the shift is marked. */
async function seedMarkedShift(request: APIRequestContext, token: string): Promise<string> {
  const headers = { "content-type": "application/json", Authorization: `Bearer ${token}` };
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const emp = await request.post(`${API_BASE}/api/v1/employees`, {
    headers,
    data: {
      email: `hinweis-${stamp}@example.test`,
      firstName: "Hanna",
      lastName: `Hinweis ${stamp.slice(-4)}`,
      employeeNumber: `HW-${stamp.slice(-6)}`,
      hireDate: new Date("2024-01-01T00:00:00.000Z").toISOString(),
      role: "EMPLOYEE",
    },
  });
  expect(emp.status(), `create the person (${await emp.text()})`).toBeLessThan(300);
  const employeeId = ((await emp.json()) as { id: string }).id;

  const ent = await request.get(
    `${API_BASE}/api/v1/leave/entitlements/${employeeId}?year=${YEAR}`,
    {
      headers,
    },
  );
  expect(ent.ok(), `read the ${YEAR} entitlement (${ent.status()})`).toBe(true);

  const shift = await request.post(`${API_BASE}/api/v1/shifts`, {
    headers,
    data: { employeeId, date: DAY, startTime: "09:00", endTime: "17:00" },
  });
  expect(shift.status(), `plan the shift (${await shift.text()})`).toBeLessThan(300);

  const leave = await request.post(`${API_BASE}/api/v1/leave/requests`, {
    headers,
    data: { employeeId, type: "VACATION", startDate: DAY, endDate: DAY, halfDay: false },
  });
  expect(leave.status(), `request the vacation (${await leave.text()})`).toBe(201);
  const leaveId = ((await leave.json()) as { id: string }).id;

  const review = await request.patch(`${API_BASE}/api/v1/leave/requests/${leaveId}/review`, {
    headers,
    data: { status: "APPROVED" },
  });
  expect(review.status(), `approve the vacation (${await review.text()})`).toBe(200);
  return employeeId;
}

async function adminToken(request: APIRequestContext, tenantId: string): Promise<string> {
  const res = await request.post(`${API_BASE}/api/v1/auth/login`, {
    headers: { "content-type": "application/json" },
    data: { email: `admin@${tenantId}.test`, password: PASSWORD },
  });
  expect(res.ok(), `login as the tenant admin (${res.status()})`).toBe(true);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** Narrows the page to March of next year and waits for the list request. */
async function showMarch(page: Page): Promise<void> {
  const loaded = page.waitForResponse(
    (r) => r.url().includes("/api/v1/shifts/conflicts?") && r.url().includes(`to=${YEAR}-03-31`),
  );
  // fill() fires input and change; the inputs are disabled while a load runs, fill() waits.
  await page.getByLabel("Von").fill(`${YEAR}-03-01`);
  await page.getByLabel("Bis").fill(`${YEAR}-03-31`);
  expect((await loaded).status()).toBe(200);
}

test.describe("Hinweise zur Schichtplanung (Issue #850)", () => {
  test("a marked shift is one notice with date, person, reason and action", async ({
    page,
    request,
    tenant,
  }) => {
    await seedMarkedShift(request, tenant.adminToken);

    await page.goto("/login");
    await page.getByLabel("E-Mail").fill(`admin@${tenant.tenantId}.test`);
    await page.getByLabel("Passwort", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: /anmelden/i }).click();
    await page.waitForURL(/\/(dashboard|time-entries|leave|$)/, { timeout: 10_000 });

    await page.goto("/shifts/conflicts");
    await expect(page.getByRole("heading", { name: "Hinweise zur Schichtplanung" })).toBeVisible();
    await showMarch(page);

    const row = page.getByTestId("shift-notice").filter({ hasText: "Hanna Hinweis" });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-kind", "marked");
    await expect(row).toContainText(DAY_LABEL);
    await expect(row).toContainText("09:00–17:00");
    await expect(row).toContainText("Überschneidet sich mit Urlaub oder Berufsschule.");
    // No ISO date and no developer word anywhere in the list.
    const listText = await page.getByTestId("shift-notice-list").innerText();
    expect(listText).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(listText).not.toMatch(/flag|SHIFT_|Generator|Audit/i);

    // The explanation sits behind (i).
    await row.locator("summary").click();
    await expect(row.getByText(/genehmigtem Urlaub oder einem Berufsschultag/)).toBeVisible();

    // The action clears the mark; the row leaves the list.
    const restored = page.waitForResponse(
      (r) => /\/api\/v1\/shifts\/[^/]+\/restore$/.test(r.url()) && r.request().method() === "POST",
    );
    await row.getByRole("button", { name: "Schicht behalten" }).click();
    expect((await restored).ok()).toBe(true);
    await expect(page.getByTestId("toast-success")).toContainText("Hinweis erledigt");
    await expect(page.getByTestId("shift-notice").filter({ hasText: "Hanna Hinweis" })).toHaveCount(
      0,
    );
  });

  test("the Planungsbedarf week reads „KW n · …“, never an ISO date", async ({ page, tenant }) => {
    await page.goto("/login");
    await page.getByLabel("E-Mail").fill(`admin@${tenant.tenantId}.test`);
    await page.getByLabel("Passwort", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: /anmelden/i }).click();
    await page.waitForURL(/\/(dashboard|time-entries|leave|$)/, { timeout: 10_000 });
    await page.goto("/shifts/planning");
    const label = page.locator(".week-pager-label");
    await expect(label).toHaveText(/^KW \d{1,2} · /);
    expect(await label.innerText()).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

defineVisibilityWalkthrough({
  title: "Hinweise zur Schichtplanung",
  path: "/shifts/conflicts",
  ready: async (page) => {
    await expect(page.getByRole("heading", { name: "Hinweise zur Schichtplanung" })).toBeVisible();
    // Seed through the API with the session the walkthrough stored, then show the seeded month.
    const token = await page.evaluate(() => localStorage.getItem("accessToken") ?? "");
    await seedMarkedShift(page.request, token);
    await showMarch(page);
  },
  steps: [
    {
      name: "Hinweis mit Aktion",
      act: async (page) => {
        await page.getByTestId("shift-notice").first().scrollIntoViewIfNeeded();
      },
      target: (page) => [
        page.getByTestId("shift-notice").first(),
        page.getByRole("button", { name: "Schicht behalten" }).first(),
      ],
    },
    {
      name: "Erklärung hinter (i)",
      act: async (page) => {
        await page.getByTestId("shift-notice").first().locator("summary").click();
      },
      target: (page) =>
        page
          .getByTestId("shift-notice")
          .first()
          .getByText(/genehmigtem Urlaub oder einem Berufsschultag/),
    },
  ],
});

defineVisibilityWalkthrough({
  title: "Planungsbedarf Woche",
  path: "/shifts/planning",
  steps: [
    {
      name: "Wochenlabel",
      act: async (page) => {
        await expect(page.locator(".week-pager-label")).toHaveText(/^KW \d{1,2} · /);
      },
      target: (page) => page.locator(".week-pager-label"),
    },
  ],
});
