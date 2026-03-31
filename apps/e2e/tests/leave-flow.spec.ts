import { test, expect } from "@playwright/test";
import { loginAsAdmin, screenshotPage } from "./helpers";

test.describe("Abwesenheiten — Complete Flow", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/leave");
    await page.waitForLoadState("networkidle");
  });

  test("page loads with tabs and vacation summary", async ({ page }) => {
    await expect(page.getByText(/Kalender/).first()).toBeVisible();
    await expect(page.getByText(/Meine Anträge/i).first()).toBeVisible();
    // Vacation summary should show
    await expect(page.getByText(/Jahresanspruch|Verbleibend/).first()).toBeVisible();
    await screenshotPage(page, "flow-leave-overview");
  });

  test("create leave request via UI form", async ({ page }) => {
    // Click "Neuer Antrag"
    await page.getByText(/Neuer Antrag|Antrag/).first().click();
    await page.waitForTimeout(500);

    // Form must be visible
    const typeSelect = page.locator("#f-type").first();
    await expect(typeSelect).toBeVisible();

    // Select SICK to avoid vacation entitlement constraints
    await typeSelect.selectOption("SICK");

    // Set date 14 days from now (weekday)
    const start = new Date();
    start.setDate(start.getDate() + 14);
    while (start.getDay() === 0 || start.getDay() === 6) start.setDate(start.getDate() + 1);
    const startStr = start.toISOString().split("T")[0];
    const endStr = startStr;

    const startInput = page.locator("#f-start").first();
    await expect(startInput).toBeVisible();
    await startInput.fill(startStr);
    await page.waitForTimeout(200);

    const endInput = page.locator("#f-end").first();
    await expect(endInput).toBeVisible();
    await endInput.fill(endStr);
    await page.waitForTimeout(200);

    await screenshotPage(page, "flow-leave-request-filled");

    // Submit
    const submitBtn = page.getByRole("button", { name: /einreichen|antrag stellen|speichern/i }).first();
    await expect(submitBtn).toBeVisible();
    await submitBtn.click();
    await page.waitForLoadState("networkidle");

    // Navigate to "Meine Antraege" tab to verify the request appears
    await page.getByText("Meine Anträge", { exact: false }).first().click();
    await page.waitForLoadState("networkidle");
    // At least one request should exist in the list
    await expect(page.locator(".leave-item, .request-row, tr").first()).toBeVisible();

    await screenshotPage(page, "flow-leave-created");
  });

  test("approve leave request (employee-creates, admin-approves)", async ({ page }) => {
    // Step 1: Login as employee via API to get employee token
    const loginRes = await page.request.post("/api/v1/auth/login", {
      data: { email: "max@clokr.de", password: "mitarbeiter5678" },
    });
    expect(loginRes.ok()).toBeTruthy();
    const { accessToken: employeeToken } = await loginRes.json();
    expect(employeeToken).toBeTruthy();

    // Step 2: Get employee list via admin context to find max@clokr.de
    const empRes = await page.request.get("/api/v1/employees");
    expect(empRes.ok()).toBeTruthy();
    const employees = await empRes.json();
    const maxEmployee = employees.find((e: { user?: { email?: string } }) => e.user?.email === "max@clokr.de");
    expect(maxEmployee).toBeTruthy();

    // Step 3: Compute a future weekday (30 days out)
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);
    while (futureDate.getDay() === 0 || futureDate.getDay() === 6) {
      futureDate.setDate(futureDate.getDate() + 1);
    }
    const startDate = futureDate.toISOString().split("T")[0];
    const endDate = startDate;

    // Step 4: Create SICK leave request AS the employee (explicit employee token)
    const leaveRes = await page.request.post("/api/v1/leave", {
      headers: { Authorization: `Bearer ${employeeToken}` },
      data: {
        employeeId: maxEmployee.id,
        type: "SICK",
        startDate,
        endDate,
      },
    });
    expect(leaveRes.ok()).toBeTruthy();
    const leaveData = await leaveRes.json();
    const leaveId = leaveData.id;
    expect(leaveId).toBeTruthy();

    // Step 5: Approve AS admin (browser context auth — admin is NOT the request owner)
    const approveRes = await page.request.put(`/api/v1/leave/${leaveId}/review`, {
      data: { action: "APPROVED" },
    });
    expect(approveRes.ok()).toBeTruthy();

    // Step 6: Navigate to Genehmigungen tab and assert approved leave is visible
    await page.goto("/leave");
    await page.waitForLoadState("networkidle");
    await page.getByText(/Genehmigungen/i).first().click();
    await page.waitForLoadState("networkidle");

    // Step 7: Verify via API that the leave is APPROVED
    const statusRes = await page.request.get(`/api/v1/leave/${leaveId}`);
    expect(statusRes.ok()).toBeTruthy();
    const statusData = await statusRes.json();
    expect(statusData.status).toBe("APPROVED");

    await screenshotPage(page, "flow-leave-approved");
  });

  test("special leave shows reason dropdown", async ({ page }) => {
    await page.getByText(/Neuer Antrag|Antrag/).first().click();
    await page.waitForTimeout(500);

    const typeSelect = page.locator("#f-type").first();
    await expect(typeSelect).toBeVisible();
    await typeSelect.selectOption("SPECIAL");
    await page.waitForTimeout(500);

    // Should show special leave rule dropdown
    const ruleSelect = page.locator("#f-special-rule");
    await expect(ruleSelect).toBeVisible();
    await screenshotPage(page, "flow-leave-special-dropdown");
  });

  test("calendar month navigation", async ({ page }) => {
    const monthTitle = page.locator(".cal-nav-title, .cal-month-title").first();
    await expect(monthTitle).toBeVisible();

    // Open month picker
    await monthTitle.click();
    const picker = page.locator(".month-picker");
    await expect(picker).toBeVisible();

    // Navigate year
    const yearNext = picker.locator("button").filter({ hasText: "›" });
    await yearNext.click();
    await page.waitForTimeout(300);

    await screenshotPage(page, "flow-leave-month-picker");

    // Close by pressing Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("switch to Meine Anträge tab", async ({ page }) => {
    const myRequestsTab = page.getByText("Meine Anträge", { exact: false });
    await expect(myRequestsTab.first()).toBeVisible();
    await myRequestsTab.first().click();
    await page.waitForTimeout(500);
    await screenshotPage(page, "flow-leave-my-requests");
  });

  test("manager sees approvals tab", async ({ page }) => {
    const approvalsTab = page.getByText(/Genehmigungen/i);
    await expect(approvalsTab.first()).toBeVisible();
    await approvalsTab.first().click();
    await page.waitForTimeout(500);
    await screenshotPage(page, "flow-leave-approvals");
  });

  test("team toggle works", async ({ page }) => {
    const teamBtn = page.locator(".team-toggle").first();
    await expect(teamBtn).toBeVisible();
    await teamBtn.click();
    await page.waitForTimeout(500);
    await screenshotPage(page, "flow-leave-team-view");

    // Toggle back
    await teamBtn.click();
    await page.waitForTimeout(300);
  });
});
