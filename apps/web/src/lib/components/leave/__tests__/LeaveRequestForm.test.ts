// Phase 415 (GitHub issue #415) — mounted test suite for the shared create/edit dialog. Mirrors
// LeaveReviewDialog.test.ts's own mock setup (Phase 255): mocking "$stores/auth" (not needed
// here since this component never imports the auth store, but the api-client mock pattern below
// is copied verbatim) and "$api/client" so the component can be mounted without pulling in
// SvelteKit's `$app/environment` (apps/web/vitest.config.ts registers no `$app/*` alias).
//
// `lib/components/leave/` sits outside `lint:ui-classes`' scope (CLAUDE.md § UI Consistency
// Rules — only `lib/components/ui/` and `lib/components/layout/` are scanned). This mounted test
// file is the substitute safeguard for that gap.
const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();
vi.mock("$api/client", () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
  },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import LeaveRequestForm from "../LeaveRequestForm.svelte";
import { LEAVE_TYPE_OPTIONS } from "$lib/leave/team-calendar-visibility";
import { SICK_TYPE_CODES } from "$lib/leave/leave-kind";

const EMPLOYEE_ID = "emp-1";

function entitlementRow(overrides: Record<string, unknown> = {}) {
  return {
    typeCode: "VACATION",
    leaveType: { name: "Urlaub" },
    totalDays: 30,
    usedDays: 5,
    carriedOverDays: 0,
    effectiveCarryOverDays: 0,
    carryOverDeadline: null,
    provisionalUsedDays: 0,
    ...overrides,
  };
}

function defaultGetImpl(path: string) {
  if (path.startsWith("/leave/entitlements/")) return Promise.resolve([entitlementRow()]);
  if (path.startsWith("/leave/overtime-balance")) {
    return Promise.resolve({
      balanceHours: 4,
      confirmedMinutes: 240,
      openMonthMinutes: null,
      hasClosedMonth: true,
      maxNegativeBalanceMinutes: null,
      isNegativeLimitExceeded: false,
    });
  }
  if (path.startsWith("/leave/overlap")) return Promise.resolve([]);
  if (path.startsWith("/leave/hours-preview")) {
    return Promise.resolve({ hours: 8, days: 1, minutesNeeded: 480 });
  }
  if (path.startsWith("/special-leave/rules")) return Promise.resolve([]);
  if (path.startsWith("/integrations/phorest/")) {
    return Promise.resolve({ total: 0, collisions: [], deepLink: null });
  }
  return Promise.resolve([]);
}

function renderForm(props: Partial<Record<string, unknown>> = {}) {
  const onSaved = vi.fn();
  const result = renderWithTheme(LeaveRequestForm, {
    open: true,
    employeeId: EMPLOYEE_ID,
    editingRequest: null,
    onSaved,
    ...props,
  } as never);
  return { onSaved, ...result };
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  apiGet.mockImplementation(defaultGetImpl);
  apiPost.mockResolvedValue(undefined);
  apiPatch.mockResolvedValue(undefined);
});

describe("LeaveRequestForm", () => {
  // ── Anti-vacuity gate ─────────────────────────────────────────────────────────────────────
  it("Test 0: a standard mount renders the dialog root and the form", () => {
    renderForm();
    expect(screen.getByTestId("leave-form-modal")).toBeTruthy();
    expect(screen.getByTestId("leave-form")).toBeTruthy();
  });

  // ── Type dropdown — same 9-option list team/leave already uses, no HOLIDAY ──────────────────
  it("the type select offers exactly LEAVE_TYPE_OPTIONS' 9 requestable codes, never HOLIDAY", () => {
    renderForm();
    const select = screen.getByTestId("leave-form-type") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(LEAVE_TYPE_OPTIONS.map((t) => t.code));
    expect(values).not.toContain("HOLIDAY");
  });

  // ── SICK types: half-day disabled + hint (§ 8 BUrlG / EFZG §3-4) ────────────────────────────
  it.each(["SICK", "SICK_CHILD"] as const)(
    "%s: half-day checkbox is disabled and the hint is shown",
    async (code) => {
      renderForm();
      const select = screen.getByTestId("leave-form-type") as HTMLSelectElement;
      await fireEvent.change(select, { target: { value: code } });
      const cb = screen.getByTestId("leave-form-half-day") as HTMLInputElement;
      expect(cb.disabled).toBe(true);
      expect(screen.getByText("Halbe Kranktage sind nicht zulässig")).toBeTruthy();
    },
  );

  it("VACATION: half-day checkbox stays enabled", () => {
    renderForm();
    const cb = screen.getByTestId("leave-form-half-day") as HTMLInputElement;
    expect(cb.disabled).toBe(false);
    expect(SICK_TYPE_CODES.has("VACATION")).toBe(false);
  });

  // ── No person selected (team context before a pick) ─────────────────────────────────────────
  it("empty employeeId: shows the picker hint, fetches nothing employee-scoped", async () => {
    renderForm({ employeeId: "" });
    expect(screen.getByText("Bitte zuerst einen Mitarbeiter auswählen.")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(apiGet).not.toHaveBeenCalledWith(expect.stringContaining("/leave/entitlements/"));
    expect(apiGet).not.toHaveBeenCalledWith(expect.stringContaining("/leave/overtime-balance"));
  });

  // ── Missing-entitlement hint (Phase 415, D-10) ───────────────────────────────────────────────
  it("VACATION with no entitlement row for the year: shows the explicit hint, not empty/zero values", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith("/leave/entitlements/")) return Promise.resolve([]);
      return defaultGetImpl(path);
    });
    renderForm();
    await waitFor(() => expect(screen.getByTestId("leave-form-no-entitlement")).toBeTruthy());
    expect(screen.getByText("Für dieses Jahr ist kein Urlaubsanspruch hinterlegt.")).toBeTruthy();
  });

  it("VACATION with an entitlement row: renders Resturlaub = total + carryOver - used", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith("/leave/entitlements/")) {
        return Promise.resolve([
          entitlementRow({
            totalDays: 30,
            carriedOverDays: 4,
            effectiveCarryOverDays: 4,
            usedDays: 10,
          }),
        ]);
      }
      return defaultGetImpl(path);
    });
    renderForm();
    await waitFor(() => expect(screen.getByText("30 Tage")).toBeTruthy());
    // 30 + 4 - 10 = 24
    expect(screen.getByText("24 Tage")).toBeTruthy();
    expect(screen.queryByTestId("leave-form-no-entitlement")).toBeNull();
  });

  // ── OVERTIME_COMP balance box ────────────────────────────────────────────────────────────────
  it("OVERTIME_COMP: fetches /leave/overtime-balance scoped to employeeId and renders Guthaben", async () => {
    renderForm();
    const select = screen.getByTestId("leave-form-type") as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: "OVERTIME_COMP" } });
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        expect.stringContaining(`/leave/overtime-balance?employeeId=${EMPLOYEE_ID}`),
      ),
    );
    expect(screen.getByText("Guthaben")).toBeTruthy();
  });

  // ── Create mutation: employeeId is ALWAYS sent, even for a self-create ─────────────────────
  it("create: POST /leave/requests always carries employeeId, and onSaved fires once", async () => {
    const { onSaved } = renderForm();
    await fireEvent.input(screen.getByTestId("leave-form-from"), {
      target: { value: "2026-10-05" },
    });
    await fireEvent.input(screen.getByTestId("leave-form-to"), {
      target: { value: "2026-10-06" },
    });
    await fireEvent.click(screen.getByTestId("leave-form-submit"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost.mock.calls[0][0]).toBe("/leave/requests");
    expect(apiPost.mock.calls[0][1]).toMatchObject({
      employeeId: EMPLOYEE_ID,
      type: "VACATION",
      startDate: "2026-10-05",
      endDate: "2026-10-06",
    });
  });

  it("create with no employeeId selected: refuses client-side with the picker hint as inline error, never POSTs", async () => {
    renderForm({ employeeId: "" });
    await fireEvent.input(screen.getByTestId("leave-form-from"), {
      target: { value: "2026-10-05" },
    });
    await fireEvent.input(screen.getByTestId("leave-form-to"), {
      target: { value: "2026-10-06" },
    });
    await fireEvent.click(screen.getByTestId("leave-form-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("leave-form-error").textContent).toContain(
        "Bitte einen Mitarbeiter auswählen",
      ),
    );
    expect(apiPost).not.toHaveBeenCalled();
  });

  // ── Edit mode ────────────────────────────────────────────────────────────────────────────────
  it("edit mode: prefills fields from editingRequest, disables the type select, PATCHes on submit", async () => {
    const { onSaved } = renderForm({
      editingRequest: {
        id: "req-9",
        typeCode: "VACATION",
        startDate: "2026-11-01",
        endDate: "2026-11-03",
        halfDay: false,
        note: "Familienfeier",
      },
    });
    const select = screen.getByTestId("leave-form-type") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("VACATION");
    expect((screen.getByTestId("leave-form-from") as HTMLInputElement).value).toBe("2026-11-01");
    expect((screen.getByTestId("leave-form-note") as HTMLInputElement).value).toBe("Familienfeier");

    await fireEvent.click(screen.getByTestId("leave-form-submit"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(apiPatch.mock.calls[0][0]).toBe("/leave/requests/req-9");
    expect(apiPost).not.toHaveBeenCalled();
  });

  // ── Person picker snippet (Phase 415, D-03) — team-context-only addition ───────────────────
  it("without a personPicker prop (the /leave case), no extra field renders above the type select", () => {
    renderForm();
    const form = screen.getByTestId("leave-form");
    const firstFormGroup = form.querySelector(".form-group");
    expect(firstFormGroup?.querySelector("#f-type")).toBeTruthy();
  });

  // ── Roster-not-imported hint (Phase 430, D-15/D-16) ─────────────────────────────────────────
  const ROSTER_HINT_TEXT =
    "Für diese Woche steht der Schichtplan noch nicht fest. Bitte alle Tage beantragen, die frei sein sollen – auch den Samstag.";

  it("rosterImported: false in the hours-preview response -> the hint renders with the exact owner-specified wording", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith("/leave/hours-preview")) {
        return Promise.resolve({ hours: 8, days: 1, minutesNeeded: 480, rosterImported: false });
      }
      return defaultGetImpl(path);
    });
    renderForm();
    await fireEvent.input(screen.getByTestId("leave-form-from"), {
      target: { value: "2026-10-05" },
    });
    await fireEvent.input(screen.getByTestId("leave-form-to"), {
      target: { value: "2026-10-06" },
    });
    await waitFor(() => expect(screen.getByTestId("leave-form-roster-hint")).toBeTruthy(), {
      timeout: 1000,
    });
    expect(
      screen.getByTestId("leave-form-roster-hint").textContent?.replace(/\s+/g, " ").trim(),
    ).toBe(ROSTER_HINT_TEXT);
  });

  it("rosterImported: true (or absent, the default mock) -> no hint renders", async () => {
    renderForm();
    await fireEvent.input(screen.getByTestId("leave-form-from"), {
      target: { value: "2026-10-05" },
    });
    await fireEvent.input(screen.getByTestId("leave-form-to"), {
      target: { value: "2026-10-06" },
    });
    // Wait for the hours-preview round trip to settle (the days-info bar is proof it landed)
    // before asserting the hint's ABSENCE — an absence checked before the fetch resolves would
    // pass vacuously.
    await waitFor(() => expect(screen.getByTestId("leave-form-days-calc")).toBeTruthy(), {
      timeout: 1000,
    });
    expect(screen.queryByTestId("leave-form-roster-hint")).toBeNull();
  });

  it("non-SHIFT_BASED employee (the default mock never sends rosterImported: false) never shows the hint, even across a date change", async () => {
    renderForm();
    await fireEvent.input(screen.getByTestId("leave-form-from"), {
      target: { value: "2026-10-05" },
    });
    await fireEvent.input(screen.getByTestId("leave-form-to"), {
      target: { value: "2026-10-06" },
    });
    await waitFor(() => expect(screen.getByTestId("leave-form-days-calc")).toBeTruthy(), {
      timeout: 1000,
    });
    expect(screen.queryByTestId("leave-form-roster-hint")).toBeNull();

    await fireEvent.input(screen.getByTestId("leave-form-to"), {
      target: { value: "2026-10-09" },
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByTestId("leave-form-roster-hint")).toBeNull();
  });

  // ── half day = one date (Issue #449, D-4) ───────────────────────────────────────────────────
  describe("half day = one date (#449)", () => {
    it("ticking half-day sets the end date to the start date and disables it", async () => {
      renderForm();
      await fireEvent.input(screen.getByTestId("leave-form-from"), {
        target: { value: "2026-11-02" },
      });
      await fireEvent.input(screen.getByTestId("leave-form-to"), {
        target: { value: "2026-11-06" },
      });
      await fireEvent.click(screen.getByTestId("leave-form-half-day"));

      const to = screen.getByTestId("leave-form-to") as HTMLInputElement;
      expect(to.value).toBe("2026-11-02");
      expect(to.disabled).toBe(true);
    });

    it("while ticked, changing the start date carries the end date along; unticking re-enables it", async () => {
      renderForm();
      await fireEvent.input(screen.getByTestId("leave-form-from"), {
        target: { value: "2026-11-02" },
      });
      await fireEvent.input(screen.getByTestId("leave-form-to"), {
        target: { value: "2026-11-06" },
      });
      await fireEvent.click(screen.getByTestId("leave-form-half-day"));

      await fireEvent.input(screen.getByTestId("leave-form-from"), {
        target: { value: "2026-11-10" },
      });
      const to = screen.getByTestId("leave-form-to") as HTMLInputElement;
      expect(to.value).toBe("2026-11-10");

      await fireEvent.click(screen.getByTestId("leave-form-half-day"));
      expect(to.disabled).toBe(false);
    });

    it("create submit while ticked sends startDate === endDate and halfDay true", async () => {
      renderForm();
      await fireEvent.input(screen.getByTestId("leave-form-from"), {
        target: { value: "2026-11-02" },
      });
      await fireEvent.input(screen.getByTestId("leave-form-to"), {
        target: { value: "2026-11-06" },
      });
      await fireEvent.click(screen.getByTestId("leave-form-half-day"));
      await fireEvent.click(screen.getByTestId("leave-form-submit"));

      await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
      const payload = apiPost.mock.calls[0][1] as {
        startDate: string;
        endDate: string;
        halfDay: boolean;
      };
      expect(payload.startDate).toBe(payload.endDate);
      expect(payload.halfDay).toBe(true);
    });

    it("editing a legacy multi-day half-day request never rewrites the end date, shows the hint, and refuses submit client-side", async () => {
      const { onSaved } = renderForm({
        editingRequest: {
          id: "req-legacy-449",
          typeCode: "VACATION",
          startDate: "2026-11-02",
          endDate: "2026-11-06",
          halfDay: true,
          note: null,
        },
      });

      const to = screen.getByTestId("leave-form-to") as HTMLInputElement;
      expect(to.value).toBe("2026-11-06");
      expect(screen.getByTestId("leave-form-half-day-range-hint")).toBeTruthy();

      await fireEvent.click(screen.getByTestId("leave-form-submit"));
      await waitFor(() =>
        expect(screen.getByTestId("leave-form-error").textContent).toContain(
          "Ein halber Tag ist nur für ein einzelnes Datum möglich.",
        ),
      );
      expect(apiPatch).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
    });

    it("an API 400 error shows the full 'category: detail' message, not just the bare category", async () => {
      apiPatch.mockRejectedValue(
        Object.assign(new Error("Validierungsfehler: endDate: X"), {
          data: { error: "Validierungsfehler", message: "endDate: X" },
        }),
      );
      renderForm({
        editingRequest: {
          id: "req-9",
          typeCode: "VACATION",
          startDate: "2026-11-01",
          endDate: "2026-11-03",
          halfDay: false,
          note: null,
        },
      });
      await fireEvent.click(screen.getByTestId("leave-form-submit"));
      await waitFor(() =>
        expect(screen.getByTestId("leave-form-error").textContent).toContain("endDate: X"),
      );
    });
  });

  it("hint disappears once the date range changes to a week that IS rostered (reactive, matches the existing debounce re-fetch)", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith("/leave/hours-preview")) {
        const rostered = path.includes("startDate=2026-11");
        return Promise.resolve({ hours: 8, days: 1, minutesNeeded: 480, rosterImported: rostered });
      }
      return defaultGetImpl(path);
    });
    renderForm();
    await fireEvent.input(screen.getByTestId("leave-form-from"), {
      target: { value: "2026-10-05" },
    });
    await fireEvent.input(screen.getByTestId("leave-form-to"), {
      target: { value: "2026-10-06" },
    });
    await waitFor(() => expect(screen.getByTestId("leave-form-roster-hint")).toBeTruthy(), {
      timeout: 1000,
    });

    await fireEvent.input(screen.getByTestId("leave-form-from"), {
      target: { value: "2026-11-02" },
    });
    await fireEvent.input(screen.getByTestId("leave-form-to"), {
      target: { value: "2026-11-03" },
    });
    await waitFor(() => expect(screen.queryByTestId("leave-form-roster-hint")).toBeNull(), {
      timeout: 1000,
    });
  });
});
