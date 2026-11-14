// Issue #854 (plan 854-20) - the Urlaub tab of the employee detail, mounted: the figures of the
// server as a KpiStrip, one group with its own SaveBar, a save sends the PUT with the amounts and
// the carry-over reason only when it changed, and the server's requirements are errors before the
// request.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const put = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("$api/client", () => ({ api: { put: (...a: unknown[]) => put(...a) } }));
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));

import { renderWithTheme } from "$tests/test-utils";
import UrlaubTab from "../UrlaubTab.svelte";
import type { VacationEntitlement } from "$lib/employees/urlaub-form";

const ENTITLEMENT: VacationEntitlement = {
  year: 2026,
  totalDays: 28,
  usedDays: 6,
  carriedOverDays: 3,
  carryOverDeadline: "2027-03-31T00:00:00.000Z",
  carryOverReason: "ILLNESS",
  carryOverNote: null,
  regularDays: 30,
  statutoryMinimumDays: 20,
  balance: {
    availableDays: 31,
    carriedOverEffectiveDays: 3,
    carryOverKeptWithoutNoticeDays: 0,
    atRiskDays: 0,
    takenDays: 2,
    approvedUpcomingDays: 4,
    pendingDays: 0,
    remainingDays: 25,
    splitAsOf: "2026-11-13",
  },
};

function mount(props: Partial<{ entitlement: VacationEntitlement | null; canEdit: boolean }> = {}) {
  return renderWithTheme(UrlaubTab, {
    employeeId: "emp-1",
    year: 2026,
    entitlement: ENTITLEMENT,
    canEdit: true,
    ...props,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue({});
});

describe("UrlaubTab", () => {
  it("shows the server's figures and the group, and no SaveBar before an edit", () => {
    mount();
    const strip = screen.getByRole("group", { name: "Urlaubsanspruch 2026" });
    for (const label of [
      "Regulärer Anspruch 2026",
      "Gesetzlicher Mindesturlaub",
      "Verfügbar",
      "Genommen",
      "Genehmigt",
      "Resturlaub",
    ]) {
      expect(within(strip).getByText(label)).toBeTruthy();
    }
    expect(screen.getByRole("heading", { name: "Urlaubsanspruch 2026" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull();
  });

  // Issue #940: the tab shows the Resturlaub facade's split, not the stored usedDays as „Genommen“.
  it("shows the facade's taken/approved split under the Urlaubsübersicht's words", () => {
    mount();
    const strip = screen.getByRole("group", { name: "Urlaubsanspruch 2026" });
    expect(strip.textContent).toContain("bis 13.11.2026");
    expect(strip.textContent).toContain("noch nicht genommen");
    expect(strip.textContent).toContain("Anspruch + wirksamer Übertrag (3)");
    expect(screen.queryByTestId("urlaub-carry-kept")).toBeNull();
  });

  it("says why a carry-over past its deadline still counts (no Hinweis, EuGH C-684/16)", () => {
    mount({
      entitlement: {
        ...ENTITLEMENT,
        carryOverDeadline: "2026-03-31T23:59:59.000Z",
        balance: { ...ENTITLEMENT.balance!, carryOverKeptWithoutNoticeDays: 3 },
      },
    });
    const note = screen.getByTestId("urlaub-carry-kept");
    expect(note.textContent).toContain("3 Tage");
    expect(note.textContent).toContain("31.03.2026");
    expect(note.textContent).toContain("EuGH C-684/16");
  });

  it("an amount edit counts 1 change and saves the PUT without the unchanged reason and note", async () => {
    mount();
    await fireEvent.input(screen.getByLabelText(/^Urlaubstage gesamt/), {
      target: { value: "27" },
    });
    const bar = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(bar.textContent).toContain("1 Änderung");
    await fireEvent.click(within(bar).getByRole("button", { name: "Urlaubsanspruch speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/settings/vacation/emp-1", {
      year: 2026,
      totalDays: 27,
      carriedOverDays: 3,
      carryOverDeadline: "2027-03-31",
    });
    await waitFor(() => expect(success).toHaveBeenCalledWith("Urlaubsanspruch gespeichert."));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull(),
    );
  });

  it("an empty total sends the server's suggestion", async () => {
    mount();
    await fireEvent.input(screen.getByLabelText(/^Urlaubstage gesamt/), { target: { value: "" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Urlaubsanspruch speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][1]).toMatchObject({ totalDays: 30 });
  });

  it("a changed reason is sent explicitly, and OTHER without a note is refused before the request", async () => {
    mount();
    await fireEvent.change(screen.getByLabelText("Übertragsgrund"), { target: { value: "OTHER" } });
    expect(await screen.findByText(/Bei „Sonstiges“ ist eine Notiz/)).toBeTruthy();
    const save = screen.getByRole("button", { name: "Urlaubsanspruch speichern" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(put).not.toHaveBeenCalled();

    await fireEvent.input(screen.getByLabelText("Notiz zum Übertrag"), {
      target: { value: "Elternzeit-Beginn verschoben" },
    });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(save);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][1]).toMatchObject({
      carryOverReason: "OTHER",
      carryOverNote: "Elternzeit-Beginn verschoben",
    });
  });

  it("warns below the statutory minimum without blocking the save", async () => {
    mount();
    await fireEvent.input(screen.getByLabelText(/^Urlaubstage gesamt/), {
      target: { value: "10" },
    });
    expect(await screen.findByText(/Unter dem gesetzlichen Mindesturlaub/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Urlaubsanspruch speichern" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("a refused save toasts the server's text and keeps the SaveBar", async () => {
    put.mockRejectedValue(new Error("Unter dem gesetzlichen Mindesturlaub."));
    mount();
    await fireEvent.input(screen.getByLabelText(/^Urlaubstage gesamt/), {
      target: { value: "10" },
    });
    await fireEvent.click(await screen.findByRole("button", { name: "Urlaubsanspruch speichern" }));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Unter dem gesetzlichen Mindesturlaub."),
    );
    expect(screen.getByRole("region", { name: "Speicherleiste" })).toBeTruthy();
  });

  it("without the entitlement it says so and offers no form", () => {
    mount({ entitlement: null });
    expect(screen.getByText(/konnte nicht geladen werden/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Urlaubstage gesamt/)).toBeNull();
  });

  it("without leave-entitlement:update the fields are read-only and no SaveBar can appear", () => {
    mount({ canEdit: false });
    expect((screen.getByLabelText(/^Urlaubstage gesamt/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull();
  });
});
