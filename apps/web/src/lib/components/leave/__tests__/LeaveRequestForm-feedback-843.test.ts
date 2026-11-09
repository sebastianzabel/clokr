// #843 (D-843-08, D-843-19) - a new leave request acknowledges its result. The create path is
// mounted against the real dialog and pinned to the EXACT text the action-messages module builds;
// a refused write and an edit never produce the success toast (T-843-28).
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { toasts } from "$stores/toast";
import { leaveRequested } from "$lib/feedback/action-messages";
import LeaveRequestForm from "../LeaveRequestForm.svelte";

const EMPLOYEE_ID = "emp-1";

function serveGets(path: string) {
  if (path.startsWith("/leave/entitlements/")) {
    return Promise.resolve([
      {
        typeCode: "VACATION",
        leaveType: { name: "Urlaub" },
        totalDays: 30,
        usedDays: 5,
        carriedOverDays: 0,
        effectiveCarryOverDays: 0,
        carryOverDeadline: null,
        provisionalUsedDays: 0,
      },
    ]);
  }
  if (path.startsWith("/leave/hours-preview")) {
    return Promise.resolve({ hours: 8, days: 1, minutesNeeded: 480 });
  }
  if (path.startsWith("/integrations/phorest/")) {
    return Promise.resolve({ total: 0, collisions: [], deepLink: null });
  }
  return Promise.resolve([]);
}

let success: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  apiGet.mockImplementation(serveGets);
  apiPost.mockResolvedValue({ id: "req-1" });
  apiPatch.mockResolvedValue(undefined);
  success = vi.spyOn(toasts, "success").mockReturnValue(crypto.randomUUID());
  error = vi.spyOn(toasts, "error").mockReturnValue(crypto.randomUUID());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderForm(props: Partial<Record<string, unknown>> = {}) {
  const onSaved = vi.fn();
  renderWithTheme(LeaveRequestForm, {
    open: true,
    employeeId: EMPLOYEE_ID,
    editingRequest: null,
    onSaved,
    ...props,
  } as never);
  return { onSaved };
}

async function fill(start: string, end: string) {
  await fireEvent.input(screen.getByTestId("leave-form-from"), { target: { value: start } });
  await fireEvent.input(screen.getByTestId("leave-form-to"), { target: { value: end } });
}

describe("LeaveRequestForm acknowledges a new request (#843)", () => {
  it("a created one-day vacation request toasts the type and the day, once", async () => {
    const { onSaved } = renderForm();
    await fill("2026-11-10", "2026-11-10");
    await fireEvent.click(screen.getByTestId("leave-form-submit"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(success).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledWith(
      leaveRequested("Urlaub", "2026-11-10", "2026-11-10", false),
    );
    expect(success).toHaveBeenCalledWith("Antrag gestellt · Urlaub 10.11.2026");
    expect(error).not.toHaveBeenCalled();
  });

  it("the type label follows the chosen type and a half day is named", async () => {
    const { onSaved } = renderForm();
    await fireEvent.change(screen.getByTestId("leave-form-type"), {
      target: { value: "OVERTIME_COMP" },
    });
    await fill("2026-11-10", "2026-11-10");
    await fireEvent.click(screen.getByTestId("leave-form-half-day"));
    await fireEvent.click(screen.getByTestId("leave-form-submit"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(success).toHaveBeenCalledWith(
      leaveRequested("Überstundenausgleich", "2026-11-10", "2026-11-10", true),
    );
  });

  it("a refused request (409) keeps the inline error and toasts no success", async () => {
    apiPost.mockRejectedValue(new Error("Konflikt: Zeitraum überschneidet sich"));
    const { onSaved } = renderForm();
    await fill("2026-11-10", "2026-11-10");
    await fireEvent.click(screen.getByTestId("leave-form-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("leave-form-error").textContent).toContain("Konflikt"),
    );
    expect(success).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("a rejected request (400) keeps the server message and toasts no success", async () => {
    apiPost.mockRejectedValue(Object.assign(new Error(""), { data: { error: "Ungültig" } }));
    renderForm();
    await fill("2026-11-10", "2026-11-12");
    await fireEvent.click(screen.getByTestId("leave-form-submit"));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("leave-form-error").textContent).toContain("Ungültig"),
    );
    expect(success).not.toHaveBeenCalled();
  });

  it("editing an existing request PATCHes and toasts no „Antrag gestellt“", async () => {
    const { onSaved } = renderForm({
      editingRequest: {
        id: "req-9",
        typeCode: "VACATION",
        startDate: "2026-11-10",
        endDate: "2026-11-12",
        halfDay: false,
        note: null,
      },
    });
    await fireEvent.click(screen.getByTestId("leave-form-submit"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(apiPost).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });
});
