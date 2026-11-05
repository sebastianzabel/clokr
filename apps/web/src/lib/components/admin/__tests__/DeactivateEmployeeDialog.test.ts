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
    loginOnlyReason: null,
    today: TODAY,
    storedExitDate: null,
    refusal: null,
    absences: [],
    absenceCounts: { CANCEL: 0, SHORTEN: 0, DELETE: 0, SKIP: 0 },
    absencesUnavailableReason: null,
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
    // Review WR-02: the figure is labelled as the current saldo, not as the end saldo.
    expect(screen.getByText("Aktueller Saldo")).toBeTruthy();
    expect(
      screen.getByText("Der Endsaldo steht mit dem Monatsabschluss des Austrittsmonats fest."),
    ).toBeTruthy();
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
    // Review WR-05: a SKIP row is listed in its own group, not under what ends.
    expect(screen.getByRole("heading", { name: "Bleiben unverändert" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Abwesenheiten, die enden" })).toBeTruthy();
    const unchanged = screen
      .getByRole("heading", { name: "Bleiben unverändert" })
      .closest("section")!;
    expect(unchanged.textContent).toContain("Berufsschule");
    expect(unchanged.textContent).toContain("Der Monat ist bereits abgeschlossen.");
    const ending = screen
      .getByRole("heading", { name: "Abwesenheiten, die enden" })
      .closest("section")!;
    expect(ending.textContent).not.toContain("Berufsschule");
    expect(screen.queryByText("Keine Abwesenheiten nach dem letzten Arbeitstag.")).toBeNull();
  });

  it("lists a plan of only unchanged rows under Bleiben unverändert and says nothing ends (review WR-05)", async () => {
    post.mockResolvedValue(
      preview({
        absences: [
          {
            entity: "Absence",
            id: "a9",
            action: "SKIP",
            reason: "PARENTAL_REDUCTION_ACTIVE",
            typeCode: "OTHER",
            status: null,
            startDate: "2026-12-01",
            endDate: "2026-12-31",
            newEndDate: null,
            days: 20,
            newDays: null,
          },
        ],
      }),
    );
    mount();
    await screen.findByRole("heading", { name: "Bleiben unverändert" });
    expect(screen.queryByRole("heading", { name: "Abwesenheiten, die enden" })).toBeNull();
    expect(screen.getByText("Es läuft eine Elternzeit-Kürzung (§ 17 BEEG).")).toBeTruthy();
  });

  it("offers Erneut laden after a failed first load and then shows the day field (review WR-05)", async () => {
    post.mockRejectedValueOnce(new ApiError(500, "Serverfehler"));
    mount();
    await screen.findByRole("alert");
    expect(screen.queryByLabelText("Letzter Arbeitstag")).toBeNull();
    expect(confirmButton().disabled).toBe(true);
    await fireEvent.click(screen.getByRole("button", { name: "Erneut laden" }));
    await waitFor(() => expect(field().value).toBe(TODAY));
    expect(screen.queryByRole("button", { name: "Erneut laden" })).toBeNull();
    expect(confirmButton().disabled).toBe(false);
  });

  it("keeps the day field after a failed reload and Erneut laden asks again for that day (review WR-05)", async () => {
    mount();
    await waitFor(() => expect(field().value).toBe(TODAY));
    post.mockRejectedValueOnce(new ApiError(500, "Serverfehler"));
    await fireEvent.change(field(), { target: { value: "2026-11-03" } });
    await screen.findByRole("alert");
    expect(field().value).toBe("2026-11-03");
    post.mockResolvedValueOnce(preview({ exitDate: "2026-11-03" }));
    await fireEvent.click(screen.getByRole("button", { name: "Erneut laden" }));
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith(PREVIEW_URL, { exitDate: "2026-11-03" }),
    );
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
  });

  it("shows only the counts when the caller may not read the absences (review WR-03)", async () => {
    post.mockResolvedValue(
      preview({
        absences: null,
        absenceCounts: { CANCEL: 2, SHORTEN: 1, DELETE: 0, SKIP: 1 },
        absencesUnavailableReason: "NO_PERMISSION",
      }),
    );
    mount();
    await screen.findByText(
      "3 Abwesenheiten enden oder werden gekürzt, 1 Abwesenheit bleibt unverändert. Einzelheiten siehst du mit deinen Rechten nicht.",
    );
    expect(screen.queryByText(/Krankmeldung|Urlaub$/)).toBeNull();
    expect(screen.queryByText(/\d{2}\.\d{2}\.\d{4} –/)).toBeNull();
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
        absenceCounts: null,
        absencesUnavailableReason: "EXIT_DATE_REFUSED",
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
