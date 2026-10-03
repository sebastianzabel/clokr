// Issue #468 (D-12, A-2) — mounted test suite for the Elternzeit-Kürzung dialog. Same mocking
// idiom as LeaveReviewDialog.test.ts (Phase 255): `$stores/auth` is mocked (not imported by the
// component itself, but $api/client transitively pulls in $app/environment through it) and
// `$api/client` is mocked directly so `api.get`/`api.post` are controllable per test.
vi.mock("$stores/auth", () => ({ authStore: { subscribe: () => () => {} } }));

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock("$api/client", () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import ParentalReductionDialog from "../ParentalReductionDialog.svelte";
import { PARENTAL_REDUCTION_HINT } from "$lib/leave/parental-reduction";

const REQUEST = {
  id: "req-1",
  employeeName: "A. Muster",
  startDate: "2026-04-01",
  endDate: "2027-06-30",
};

function twoYearPreview(overrides: { year2026?: Partial<Record<string, unknown>> } = {}) {
  return {
    leaveRequestId: "req-1",
    startDate: "2026-04-01",
    endDate: "2027-06-30",
    years: [
      {
        year: 2026,
        months: 3,
        regularDays: 30,
        proposedReducedDays: 7,
        currentTotalDays: 30,
        resultingTotalDays: 23,
        existing: null,
        committable: true,
        ...overrides.year2026,
      },
      {
        year: 2027,
        months: 0,
        regularDays: 30,
        proposedReducedDays: 0,
        currentTotalDays: 30,
        resultingTotalDays: 30,
        existing: null,
        committable: false,
      },
    ],
  };
}

function renderDialog(preview = twoYearPreview()) {
  apiGet.mockResolvedValue(preview);
  const onChanged = vi.fn();
  renderWithTheme(ParentalReductionDialog, { open: true, request: REQUEST, onChanged });
  return { onChanged };
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

describe("ParentalReductionDialog", () => {
  it("renders the title, both years' preview rows, the hint and the non-committable year's note", async () => {
    renderDialog();
    await screen.findByTestId("parental-reduction-row-2026");
    expect(screen.getByText("Elternzeit-Kürzung erklären")).toBeTruthy();

    const row2026 = screen.getByTestId("parental-reduction-row-2026");
    expect(within(row2026).getByText("3")).toBeTruthy();
    expect(within(row2026).getByText("7")).toBeTruthy();
    expect(within(row2026).getByText(/30\s*→\s*23/)).toBeTruthy();

    const row2027 = screen.getByTestId("parental-reduction-row-2027");
    expect(within(row2027).getByText("kein voller Monat")).toBeTruthy();
    expect(within(row2027).queryByRole("checkbox")).toBeNull();

    expect(screen.getByText(PARENTAL_REDUCTION_HINT)).toBeTruthy();
  });

  it("preselects the committable year's checkbox", async () => {
    renderDialog();
    await screen.findByTestId("parental-reduction-row-2026");
    const row2026 = screen.getByTestId("parental-reduction-row-2026");
    const checkbox = within(row2026).getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it("the declaration date input carries max = today", async () => {
    renderDialog();
    await screen.findByTestId("parental-reduction-row-2026");
    const input = screen.getByTestId("parental-reduction-declared-at") as HTMLInputElement;
    const todayIso = new Date().toISOString().slice(0, 10);
    expect(input.max).toBe(todayIso);
  });

  it("'Kürzung buchen' is disabled until a declaration date is entered", async () => {
    renderDialog();
    await screen.findByTestId("parental-reduction-row-2026");
    const commitButton = screen.getByTestId("parental-reduction-commit") as HTMLButtonElement;
    expect(commitButton.disabled).toBe(true);

    await fireEvent.input(screen.getByTestId("parental-reduction-declared-at"), {
      target: { value: "2026-09-01" },
    });
    expect(commitButton.disabled).toBe(false);
  });

  it("'Kürzung buchen' is disabled again when no year stays selected", async () => {
    renderDialog();
    await screen.findByTestId("parental-reduction-row-2026");
    await fireEvent.input(screen.getByTestId("parental-reduction-declared-at"), {
      target: { value: "2026-09-01" },
    });
    const commitButton = screen.getByTestId("parental-reduction-commit") as HTMLButtonElement;
    expect(commitButton.disabled).toBe(false);

    const row2026 = screen.getByTestId("parental-reduction-row-2026");
    await fireEvent.click(within(row2026).getByRole("checkbox"));
    expect(commitButton.disabled).toBe(true);
  });

  it("submits the declared date and the selected years, then calls onChanged", async () => {
    apiPost.mockResolvedValue({ reductions: [], warnings: [] });
    const { onChanged } = renderDialog();
    await screen.findByTestId("parental-reduction-row-2026");

    await fireEvent.input(screen.getByTestId("parental-reduction-declared-at"), {
      target: { value: "2026-09-01" },
    });
    await fireEvent.click(screen.getByTestId("parental-reduction-commit"));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith("/leave/parental-reductions/req-1", {
      declaredAt: "2026-09-01",
      years: [2026],
    });
  });

  it("a rejected commit shows the server's German message inline and keeps the dialog open", async () => {
    apiPost.mockRejectedValueOnce(
      new Error("Für 2026 ist zu dieser Elternzeit bereits eine Kürzung erklärt."),
    );
    const { onChanged } = renderDialog();
    await screen.findByTestId("parental-reduction-row-2026");

    await fireEvent.input(screen.getByTestId("parental-reduction-declared-at"), {
      target: { value: "2026-09-01" },
    });
    await fireEvent.click(screen.getByTestId("parental-reduction-commit"));

    await waitFor(() =>
      expect(
        screen.getByText("Für 2026 ist zu dieser Elternzeit bereits eine Kürzung erklärt."),
      ).toBeTruthy(),
    );
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByText("Elternzeit-Kürzung erklären")).toBeTruthy();
  });
});
