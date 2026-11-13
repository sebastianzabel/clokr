// Issue #853-19 - `LeaveReviewDialog.decide()`: the decision of a task row without the dialog being
// opened. The row's „Genehmigen“ / „Ablehnen“ must run EXACTLY the path of the dialog's buttons
// (collision pre-check, PATCH /review, the sick-leave attest write, toast, reload, limit-exception
// hand-over, the four-eyes guard), so the dialog stays closed (`open: false`) in every case here.
//
// Mocks as in LeaveReviewDialog.test.ts: `$stores/auth` (SvelteKit's `$app/environment` cannot be
// resolved in vitest) and `$api/client`.
vi.mock("$stores/auth", () => ({ authStore: { subscribe: () => () => {} } }));

const apiGet = vi.fn();
const apiPatch = vi.fn();
vi.mock("$api/client", () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
  },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor, cleanup } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import LeaveReviewDialog from "../LeaveReviewDialog.svelte";
import * as dialogModule from "../LeaveReviewDialog.svelte";
import type { DirectDecision } from "$lib/leave/review-facts";
import { toasts } from "$stores/toast";
import type { LeaveReviewRequest } from "$lib/leave/leave-review";

function baseRequest(overrides: Partial<LeaveReviewRequest> = {}): LeaveReviewRequest {
  return {
    id: "req-1",
    employeeId: "emp-1",
    typeCode: "VACATION",
    employee: { firstName: "Alex", lastName: "Muster" },
    startDate: "2026-09-01",
    endDate: "2026-09-05",
    days: 5,
    halfDay: false,
    status: "PENDING",
    note: null,
    attestPresent: false,
    attestValidFrom: null,
    attestValidTo: null,
    ...overrides,
  };
}

type Decide = (
  status: "APPROVED" | "REJECTED",
  reason?: string,
  options?: { toastErrors?: boolean },
) => Promise<DirectDecision>;

function mountClosed(
  overrides: Partial<LeaveReviewRequest> = {},
  currentEmployeeId: string | null = "manager-1",
) {
  const onReviewed = vi.fn();
  const view = renderWithTheme(LeaveReviewDialog, {
    open: false,
    request: baseRequest(overrides),
    currentEmployeeId,
    onReviewed,
  });
  const decide = (view.component as unknown as { decide: Decide }).decide;
  return { onReviewed, decide, ...view };
}

// A named export of a .svelte module is invisible to tsc (the `*.svelte` shim has only a default).
const SELF_APPROVAL_TEXT = (dialogModule as unknown as { SELF_APPROVAL_TEXT: string })
  .SELF_APPROVAL_TEXT;

let toastSuccess: ReturnType<typeof vi.spyOn>;
let toastError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset();
  apiGet.mockImplementation((path: string) => {
    if (typeof path === "string" && path.startsWith("/integrations/phorest/")) {
      return Promise.resolve({ total: 0, collisions: [], deepLink: null });
    }
    return Promise.resolve([]);
  });
  apiPatch.mockResolvedValue(undefined);
  toastSuccess = vi.spyOn(toasts, "success");
  toastError = vi.spyOn(toasts, "error");
});

afterEach(() => {
  toastSuccess.mockRestore();
  toastError.mockRestore();
  cleanup();
});

describe("LeaveReviewDialog.decide() - a decision straight from the row", () => {
  it("Test 0: the dialog is closed, yet decide() is exported", () => {
    const { decide } = mountClosed();
    expect(typeof decide).toBe("function");
    expect(screen.queryByTestId("leave-approval-modal")).toBeNull();
  });

  it("approve: one PATCH /review without a note, the toast names person and decision, onReviewed once", async () => {
    const { decide, onReviewed } = mountClosed();
    const result = await decide("APPROVED");
    expect(result).toEqual({ ok: true });
    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(apiPatch.mock.calls[0][0]).toBe("/leave/requests/req-1/review");
    expect(apiPatch.mock.calls[0][1]).toEqual({ status: "APPROVED", reviewNote: null });
    expect(toastSuccess).toHaveBeenCalledWith(
      "Antrag von Alex Muster genehmigt · 01.09.–05.09.2026",
    );
    expect(onReviewed).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("leave-approval-modal")).toBeNull();
  });

  it("approve of a cancellation request words the toast as a Stornierung", async () => {
    const { decide } = mountClosed({ status: "CANCELLATION_REQUESTED" });
    expect(await decide("APPROVED")).toEqual({ ok: true });
    expect(toastSuccess).toHaveBeenCalledWith(
      "Stornierung von Alex Muster genehmigt · 01.09.–05.09.2026",
    );
  });

  it("reject: the reason is the review note, trimmed; an empty reason sends nothing", async () => {
    const { decide, onReviewed } = mountClosed();
    expect(await decide("REJECTED", "   ")).toEqual({
      ok: false,
      handedOver: false,
      message: "Bitte nenne einen Grund.",
    });
    expect(await decide("REJECTED")).toMatchObject({ ok: false, handedOver: false });
    expect(apiPatch).not.toHaveBeenCalled();
    expect(onReviewed).not.toHaveBeenCalled();

    expect(await decide("REJECTED", "  Zeitraum nicht besetzbar  ")).toEqual({ ok: true });
    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(apiPatch.mock.calls[0][1]).toEqual({
      status: "REJECTED",
      reviewNote: "Zeitraum nicht besetzbar",
    });
    expect(toastSuccess).toHaveBeenCalledWith(
      "Antrag von Alex Muster abgelehnt · 01.09.–05.09.2026",
    );
  });

  it("a stale note of an earlier, abandoned dialog session is never sent", async () => {
    // The dialog's open-effect resets the note; decide() must not depend on it having run.
    const { decide } = mountClosed();
    await decide("REJECTED", "erster Grund");
    apiPatch.mockClear();
    await decide("APPROVED");
    expect(apiPatch.mock.calls[0][1]).toEqual({ status: "APPROVED", reviewNote: null });
  });

  it("the caller's own request is refused with the four-eyes text and nothing is sent", async () => {
    const { decide, onReviewed } = mountClosed({ employeeId: "manager-1" }, "manager-1");
    expect(await decide("APPROVED")).toEqual({
      ok: false,
      handedOver: false,
      message: SELF_APPROVAL_TEXT,
    });
    expect(apiPatch).not.toHaveBeenCalled();
    expect(onReviewed).not.toHaveBeenCalled();
  });

  it("an already decided request is refused and nothing is sent", async () => {
    const { decide } = mountClosed({ status: "APPROVED" });
    expect(await decide("APPROVED")).toMatchObject({ ok: false, handedOver: false });
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it("a sick-leave decision writes the attest back exactly as stored, never a blank one", async () => {
    const { decide } = mountClosed({
      typeCode: "SICK",
      attestPresent: true,
      attestValidFrom: "2026-09-01",
      attestValidTo: "2026-09-03",
    });
    expect(await decide("APPROVED")).toEqual({ ok: true });
    expect(apiPatch).toHaveBeenCalledTimes(2);
    expect(apiPatch.mock.calls[0][0]).toMatch(/\/review$/);
    expect(apiPatch.mock.calls[1][0]).toMatch(/\/attest$/);
    expect(apiPatch.mock.calls[1][1]).toEqual({
      attestPresent: true,
      attestValidFrom: "2026-09-01",
      attestValidTo: "2026-09-03",
    });
  });

  it("a server refusal is returned with its German text and toasted (the dialog is closed)", async () => {
    apiPatch.mockRejectedValueOnce({
      data: { error: "Serverseitige deutsche Meldung" },
      message: "Bad Request",
    });
    const { decide, onReviewed } = mountClosed();
    expect(await decide("APPROVED")).toEqual({
      ok: false,
      handedOver: false,
      message: "Serverseitige deutsche Meldung",
    });
    expect(toastError).toHaveBeenCalledWith("Serverseitige deutsche Meldung");
    expect(onReviewed).not.toHaveBeenCalled();
  });

  it("with toastErrors: false the caller shows the refusal and no toast is raised", async () => {
    apiPatch.mockRejectedValueOnce({ data: { error: "Gesperrt" }, message: "Conflict" });
    const { decide } = mountClosed();
    expect(await decide("REJECTED", "Grund", { toastErrors: false })).toEqual({
      ok: false,
      handedOver: false,
      message: "Gesperrt",
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("booked appointments hand over to the existing confirmation instead of approving", async () => {
    apiGet.mockImplementation((path: string) => {
      if (typeof path === "string" && path.startsWith("/integrations/phorest/")) {
        return Promise.resolve({
          total: 2,
          collisions: [{ date: "2026-09-02", count: 2 }],
          deepLink: null,
        });
      }
      return Promise.resolve([]);
    });
    const { decide, onReviewed } = mountClosed();
    expect(await decide("APPROVED")).toEqual({ ok: false, handedOver: true });
    expect(apiPatch).not.toHaveBeenCalled();
    expect(onReviewed).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("Kundentermine im Zeitraum gebucht")).toBeTruthy());
    await fireEvent.click(screen.getByText("Trotzdem fortfahren"));
    await waitFor(() => expect(onReviewed).toHaveBeenCalledTimes(1));
    expect(apiPatch).toHaveBeenCalledTimes(1);
  });

  it("a limit exception is asked for in the existing reason dialog, and the resend carries it", async () => {
    const exceedance = {
      ruleId: "r1",
      ruleName: null,
      groupKind: "CLASSIFICATION",
      classification: "AZUBI",
      accessRoleId: null,
      accessRoleName: null,
      salonId: "s1",
      maxPersons: 2,
      validFrom: null,
      validUntil: null,
      days: [{ day: "2026-09-02", count: 3, max: 2 }],
    };
    apiPatch.mockRejectedValueOnce(
      Object.assign(new Error("Die Urlaubsgrenze ist überschritten."), {
        status: 409,
        data: { code: "LEAVE_LIMIT_EXCEPTION_REQUIRED", exceedances: [exceedance] },
      }),
    );
    const { decide, onReviewed } = mountClosed();
    expect(await decide("APPROVED")).toEqual({ ok: false, handedOver: true });
    expect(toastError).not.toHaveBeenCalled();
    await waitFor(() => expect(document.getElementById("reason-dialog-textarea")).toBeTruthy());
    await fireEvent.input(document.getElementById("reason-dialog-textarea")!, {
      target: { value: "Bitte dieses Mal durchlassen" },
    });
    await fireEvent.click(screen.getByText("Trotzdem genehmigen"));
    await waitFor(() => expect(onReviewed).toHaveBeenCalledTimes(1));
    expect(apiPatch.mock.calls[1][1]).toEqual({
      status: "APPROVED",
      reviewNote: null,
      limitException: { reason: "Bitte dieses Mal durchlassen" },
    });
  });
});
