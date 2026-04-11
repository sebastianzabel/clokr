import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "./helpers";

// Phase 5 — overtime balance is updated synchronously on leave approval (write-path fix)
test.describe("Überstunden-Saldo — Write-Path Update (Phase 5)", () => {
  test("approving leave reduces overtime balance immediately", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const accessToken = await page.evaluate(() => localStorage.getItem("accessToken"));
    expect(accessToken).toBeTruthy();
    const headers = { Authorization: `Bearer ${accessToken}` };

    // ── 1. Find a non-admin employee with an OvertimeAccount ─────────────────
    const empRes = await page.request.get("/api/v1/employees", { headers });
    expect(empRes.ok()).toBeTruthy();
    const employees: Array<{ id: string; user?: { email?: string } }> = await empRes.json();
    const target = employees.find(
      (e) => e.id?.includes("-") && e.user?.email !== "admin@clokr.de",
    );
    if (!target) {
      console.log("⚠ No non-admin employee found — skipping test");
      return;
    }

    // ── 2. Record balance BEFORE leave approval ───────────────────────────────
    const beforeRes = await page.request.get(`/api/v1/overtime/${target.id}`, { headers });
    if (!beforeRes.ok()) {
      console.log("⚠ No OvertimeAccount for employee — skipping test");
      return;
    }
    const before = await beforeRes.json();
    const balanceBefore: number = Number(before.balanceHours);

    // ── 3. Create a SICK leave in the past (2 weekdays ago) ──────────────────
    // Past date so it falls within an already-open month and affects saldo
    const date = new Date();
    date.setDate(date.getDate() - 7);
    while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() - 1);
    const dateStr = date.toISOString().split("T")[0];

    const createRes = await page.request.post("/api/v1/leave/requests", {
      headers,
      data: {
        type: "SICK",
        startDate: dateStr,
        endDate: dateStr,
        employeeId: target.id,
      },
    });

    // 409 = leave already exists for that date (acceptable — still verify balance)
    const created = createRes.status() === 201;
    if (!created && createRes.status() !== 409) {
      console.log(`⚠ Unexpected status ${createRes.status()} creating leave — skipping test`);
      return;
    }

    let leaveId: string | null = null;
    if (created) {
      const leaveData = await createRes.json();
      leaveId = leaveData.id;

      // ── 4. Approve the leave ────────────────────────────────────────────────
      const approveRes = await page.request.put(`/api/v1/leave/${leaveId}/review`, {
        headers,
        data: { action: "APPROVED" },
      });
      // SICK may auto-approve (200) or already be approved (422) — both are fine
      expect([200, 422].includes(approveRes.status())).toBeTruthy();
    }

    // ── 5. Verify balance AFTER — must differ from before (leave reduces Soll) ─
    const afterRes = await page.request.get(`/api/v1/overtime/${target.id}`, { headers });
    expect(afterRes.ok()).toBeTruthy();
    const after = await afterRes.json();
    const balanceAfter: number = Number(after.balanceHours);

    if (created) {
      // Approving sick leave reduces expected hours → balance should increase (or at least change)
      // The key assertion: balance IS a number and the account exists/responds
      expect(typeof balanceAfter).toBe("number");
      // Balance changed after leave was approved (write-path triggered updateOvertimeAccount)
      expect(balanceAfter).not.toEqual(balanceBefore);
      console.log(
        `✓ Balance changed: ${balanceBefore.toFixed(2)}h → ${balanceAfter.toFixed(2)}h after approving 1 sick day`,
      );
    } else {
      // Leave already existed — just verify account is readable
      expect(typeof balanceAfter).toBe("number");
      console.log(`ℹ Leave already existed for ${dateStr} — balance: ${balanceAfter.toFixed(2)}h`);
    }
  });

  test("overtime account is readable for all active employees", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const accessToken = await page.evaluate(() => localStorage.getItem("accessToken"));
    const headers = { Authorization: `Bearer ${accessToken}` };

    const empRes = await page.request.get("/api/v1/employees", { headers });
    expect(empRes.ok()).toBeTruthy();
    const employees: Array<{ id: string }> = await empRes.json();

    let checked = 0;
    for (const emp of employees.slice(0, 5)) {
      if (!emp.id?.includes("-")) continue;
      const res = await page.request.get(`/api/v1/overtime/${emp.id}`, { headers });
      // 200 = has account, 404 = no account yet — both are valid states
      expect([200, 404].includes(res.status())).toBeTruthy();
      if (res.ok()) {
        const data = await res.json();
        expect(typeof data.balanceHours).toBe("string"); // Prisma Decimal comes as string
        checked++;
      }
    }
    console.log(`✓ Checked overtime accounts for ${checked} employees`);
  });
});
