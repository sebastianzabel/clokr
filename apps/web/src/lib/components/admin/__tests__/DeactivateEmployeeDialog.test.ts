// Issue #615 (D-13, AC-615-8/9) — the deactivate dialog, mounted: last working day field bound by
// the server's today, preview on open and on every date change, stale responses dropped, saldo /
// Resturlaub / absences shown or one calm line per withheld figure, a refused day disables the
// confirm button, the confirm sends the chosen day and a rejection stays inside the dialog.
vi.mock("$stores/auth", () => ({ authStore: { subscribe: () => () => {} } }));
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
  return { ApiError, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() } };
});

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { api, ApiError } from "$api/client";
import type { DeactivatePreview } from "$lib/api/deactivate-preview";
import DeactivateEmployeeDialog from "../DeactivateEmployeeDialog.svelte";

const TODAY = "2026-11-05";
const EMPLOYEE = { id: "emp-fixture-1", firstName: "Exit615", lastName: "Fixture" };

function preview(over: Partial<DeactivatePreview> = {}): DeactivatePreview {
  return {
    exitDate: TODAY,
    today: TODAY,
    storedExitDate: null,
    refusal: null,
    absences: [],
    saldo: { balanceMinutes: -12000, asOf: "2026-11-04" },
    saldoUnavailableReason: null,
    vacation: {
      year: 2026,
      entitlementDays: 30,
      storedEntitlementDays: 30,
      entitlementRecomputed: false,
      carriedOverEffectiveDays: 0,
      availableDays: 30,
      takenDays: 12,
      remainingAtExitDays: 18,
      asOf: TODAY,
    },
    vacationUnavailableReason: null,
    ...over,
  };
}

const post = api.post as unknown as Mock<
  (url: string, body: { exitDate?: string }) => Promise<DeactivatePreview>
>;
const patch = api.patch as unknown as Mock<(url: string, body: unknown) => Promise<unknown>>;
const onDeactivated = vi.fn();

function mount() {
  return renderWithTheme(DeactivateEmployeeDialog, {
    open: true,
    employee: EMPLOYEE,
    onDeactivated,
  });
}

const field = () => screen.getByLabelText("Letzter Arbeitstag") as HTMLInputElement;
const confirmButton = () =>
  screen.getByRole("button", { name: "Deaktivieren" }) as HTMLButtonElement;
const PREVIEW_URL = `/employees/${EMPLOYEE.id}/deactivate/preview`;
const DEACTIVATE_URL = `/employees/${EMPLOYEE.id}/deactivate`;

beforeEach(() => {
  post.mockReset();
  patch.mockReset();
  onDeactivated.mockReset();
  post.mockResolvedValue(preview());
  patch.mockResolvedValue({ success: true });
});

describe("DeactivateEmployeeDialog", () => {
  it("asks without a day on open and starts on the server's today", async () => {
    mount();
    await waitFor(() => expect(field().value).toBe(TODAY));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(PREVIEW_URL, {});
    expect(field().max).toBe(TODAY);
  });

  it("starts on the stored exit date when it is earlier and loads the preview for it", async () => {
    post.mockImplementation(async (_url: string, body: { exitDate?: string }) =>
      body.exitDate
        ? preview({ exitDate: body.exitDate, storedExitDate: "2026-10-31" })
        : preview({ storedExitDate: "2026-10-31" }),
    );
    mount();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post).toHaveBeenLastCalledWith(PREVIEW_URL, { exitDate: "2026-10-31" });
    await waitFor(() => expect(field().value).toBe("2026-10-31"));
    expect(field().max).toBe(TODAY);
  });

  it("shows the saldo, the Resturlaub and the empty absence list", async () => {
    mount();
    await screen.findByText(/−200:00 h/);
    expect(screen.getByText(/Stand gestern, 04\.11\.2026/)).toBeTruthy();
    expect(screen.getByText("18 Tage Resturlaub im Austrittsjahr 2026")).toBeTruthy();
    expect(screen.getByText("Keine Abwesenheiten nach dem letzten Arbeitstag.")).toBeTruthy();
    expect(confirmButton().disabled).toBe(false);
  });

  it("names the § 5 recompute", async () => {
    post.mockResolvedValue(
      preview({
        vacation: { ...preview().vacation!, entitlementRecomputed: true, entitlementDays: 25 },
      }),
    );
    mount();
    await screen.findByText("Der Anspruch 2026 wird nach § 5 BUrlG auf 25 Tage neu berechnet.");
  });

  it("lists every absence with type, period and what happens to it", async () => {
    post.mockResolvedValue(
      preview({
        absences: [
          {
            entity: "LeaveRequest",
            id: "a1",
            action: "CANCEL",
            reason: "AFTER_EXIT",
            typeCode: "VACATION",
            status: "APPROVED",
            startDate: "2026-11-16",
            endDate: "2026-11-18",
            newEndDate: null,
            days: 3,
            newDays: null,
          },
          {
            entity: "LeaveRequest",
            id: "a2",
            action: "SHORTEN",
            reason: "SPANS_EXIT",
            typeCode: "SICK",
            status: "APPROVED",
            startDate: "2026-11-03",
            endDate: "2026-11-09",
            newEndDate: TODAY,
            days: 5,
            newDays: 3,
          },
          {
            entity: "Absence",
            id: "a3",
            action: "SKIP",
            reason: "CLOSED_MONTH",
            typeCode: "VOCATIONAL_SCHOOL",
            status: null,
            startDate: "2026-09-01",
            endDate: "2026-12-31",
            newEndDate: null,
            days: 20,
            newDays: null,
          },
        ],
      }),
    );
    mount();
    await screen.findByText("16.11.2026 – 18.11.2026");
    expect(screen.getByText("Urlaub")).toBeTruthy();
    expect(screen.getByText("wird storniert")).toBeTruthy();
    expect(screen.getByText("Krankmeldung")).toBeTruthy();
    expect(screen.getByText("wird auf den letzten Arbeitstag (05.11.2026) gekürzt")).toBeTruthy();
    expect(screen.getByText("Berufsschule")).toBeTruthy();
    expect(screen.getByText("bleibt unverändert")).toBeTruthy();
    expect(screen.getByText("Der Monat ist bereits abgeschlossen.")).toBeTruthy();
    expect(screen.queryByText("Keine Abwesenheiten nach dem letzten Arbeitstag.")).toBeNull();
  });

  it("shows one calm line and no number for a withheld figure", async () => {
    post.mockResolvedValue(
      preview({
        saldo: null,
        saldoUnavailableReason: "NO_PERMISSION",
        vacation: null,
        vacationUnavailableReason: "NO_PERMISSION",
      }),
    );
    mount();
    await screen.findByText("Das Saldo kannst du mit deinen Rechten nicht einsehen.");
    expect(
      screen.getByText("Den Resturlaub kannst du mit deinen Rechten nicht einsehen."),
    ).toBeTruthy();
    expect(screen.queryByText(/Stand gestern/)).toBeNull();
    expect(screen.queryByText(/Tage Resturlaub/)).toBeNull();
  });

  it("shows the refusal and disables the confirm button", async () => {
    post.mockResolvedValue(
      preview({
        refusal: {
          status: 409,
          code: "MONTH_LOCKED",
          error: "Der Monat ist bereits abgeschlossen.",
        },
        absences: null,
        vacation: null,
        vacationUnavailableReason: "EXIT_DATE_REFUSED",
      }),
    );
    mount();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Der Monat ist bereits abgeschlossen.");
    expect(confirmButton().disabled).toBe(true);
    expect(screen.queryByText("Keine Abwesenheiten nach dem letzten Arbeitstag.")).toBeNull();
  });

  it("disables the confirm button while a preview loads", async () => {
    post.mockReturnValue(new Promise(() => {}));
    mount();
    await screen.findByText("Vorschau wird geladen …");
    expect(confirmButton().disabled).toBe(true);
  });

  it("reloads on every date change", async () => {
    mount();
    await screen.findByText(/−200:00 h/);
    post.mockImplementation(async (_url: string, body: { exitDate?: string }) =>
      preview({
        exitDate: body.exitDate ?? TODAY,
        saldo: { balanceMinutes: 90, asOf: "2026-11-02" },
      }),
    );
    await fireEvent.change(field(), { target: { value: "2026-11-03" } });
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith(PREVIEW_URL, { exitDate: "2026-11-03" }),
    );
    await screen.findByText(/\+1:30 h/);
  });

  it("never lets an older response overwrite a newer one", async () => {
    mount();
    await screen.findByText(/−200:00 h/);
    let releaseOld: (p: DeactivatePreview) => void = () => {};
    const old = new Promise<DeactivatePreview>((resolve) => (releaseOld = resolve));
    post.mockReturnValueOnce(old);
    post.mockResolvedValueOnce(
      preview({ exitDate: "2026-11-03", saldo: { balanceMinutes: 600, asOf: "2026-11-02" } }),
    );
    await fireEvent.change(field(), { target: { value: "2026-11-02" } });
    await fireEvent.change(field(), { target: { value: "2026-11-03" } });
    await screen.findByText(/\+10:00 h/);
    releaseOld(
      preview({ exitDate: "2026-11-02", saldo: { balanceMinutes: 6000, asOf: "2026-11-01" } }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByText(/\+100:00 h/)).toBeNull();
    expect(screen.getByText(/\+10:00 h/)).toBeTruthy();
  });

  it("says that the person cannot sign in, that absences end and that reactivating restores none", async () => {
    mount();
    await screen.findByText(/−200:00 h/);
    expect(screen.getByText(/Exit615 Fixture kann sich danach nicht mehr anmelden/)).toBeTruthy();
    expect(screen.getByText(/Die Zeitdaten bleiben erhalten/)).toBeTruthy();
    expect(
      screen.getByText(/Abwesenheiten nach dem letzten Arbeitstag werden storniert oder gekürzt/),
    ).toBeTruthy();
    expect(screen.getByText(/Ein Reaktivieren bringt sie nicht zurück/)).toBeTruthy();
  });

  it("confirms with the chosen day, then closes and reports", async () => {
    mount();
    await screen.findByText(/−200:00 h/);
    post.mockImplementation(async (_url: string, body: { exitDate?: string }) =>
      preview({ exitDate: body.exitDate ?? TODAY }),
    );
    await fireEvent.change(field(), { target: { value: "2026-11-03" } });
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    await fireEvent.click(confirmButton());
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(DEACTIVATE_URL, { exitDate: "2026-11-03" });
    await waitFor(() => expect(onDeactivated).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps a server rejection inside the open dialog", async () => {
    patch.mockRejectedValueOnce(new ApiError(409, "Der Monat ist bereits abgeschlossen."));
    mount();
    await screen.findByText(/−200:00 h/);
    await fireEvent.click(confirmButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Der Monat ist bereits abgeschlossen.");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onDeactivated).not.toHaveBeenCalled();
  });
});
