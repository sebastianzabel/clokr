// Issue #599 (Phase 851): the correction request sends the prefilled times and a required reason; an
// open month is handed back to the ordinary edit, a pending request is explained, nothing else is decided.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";

const createMock = vi.fn();
vi.mock("$api/client", () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public data?: unknown,
    ) {
      super(message);
    }
  }
  return { ApiError, api: { get: vi.fn(), post: vi.fn() } };
});
vi.mock("$lib/me/month-corrections", async (orig) => {
  const real = await orig<typeof import("$lib/me/month-corrections")>();
  return { ...real, createMonthCorrection: (...a: unknown[]) => createMock(...a) };
});
vi.mock("$stores/toast", () => ({ toasts: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { ApiError } from "$api/client";
import MonthCorrectionDialog from "../MonthCorrectionDialog.svelte";

afterEach(() => {
  cleanup();
  createMock.mockReset();
});

const base = {
  open: true,
  day: "2026-10-06",
  dayLabel: "Dienstag, 6. Oktober",
  initialStart: "09:00",
  initialEnd: "17:30",
  initialBreak: 30,
  onCreated: () => {},
};

async function fillReason(text: string) {
  await fireEvent.input(screen.getByLabelText(/Begründung/), { target: { value: text } });
}

describe("MonthCorrectionDialog", () => {
  it("sends nothing without a reason of at least 10 characters", async () => {
    renderWithTheme(MonthCorrectionDialog, base);
    expect(screen.getByTestId("month-correction-send")).toBeDisabled();
    await fillReason("zu kurz");
    expect(screen.getByTestId("month-correction-send")).toBeDisabled();
  });

  it("sends the prefilled times and the reason", async () => {
    const onCreated = vi.fn();
    createMock.mockResolvedValueOnce({ id: "r1", status: "PENDING" });
    renderWithTheme(MonthCorrectionDialog, { ...base, onCreated });
    await fillReason("Ausstempeln an der Kasse hat gehakt");
    await fireEvent.click(screen.getByTestId("month-correction-send"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith({
      targetDate: "2026-10-06",
      startTime: "09:00",
      endTime: "17:30",
      breakMinutes: 30,
      reason: "Ausstempeln an der Kasse hat gehakt",
    });
  });

  it("hands an open month back to the ordinary edit", async () => {
    const onMonthOpen = vi.fn();
    createMock.mockRejectedValueOnce(new ApiError(409, "x", { code: "MONTH_NOT_CLOSED" }));
    renderWithTheme(MonthCorrectionDialog, { ...base, onMonthOpen });
    await fillReason("Ausstempeln an der Kasse hat gehakt");
    await fireEvent.click(screen.getByTestId("month-correction-send"));
    await waitFor(() => expect(onMonthOpen).toHaveBeenCalledTimes(1));
  });

  it("explains a request that is already waiting", async () => {
    createMock.mockRejectedValueOnce(
      new ApiError(409, "x", { code: "MONTH_CORRECTION_PENDING_EXISTS" }),
    );
    renderWithTheme(MonthCorrectionDialog, base);
    await fillReason("Ausstempeln an der Kasse hat gehakt");
    await fireEvent.click(screen.getByTestId("month-correction-send"));
    expect((await screen.findByRole("alert")).textContent).toContain("wartet schon");
  });
});
