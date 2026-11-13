// Issue #854 (plan 854-15) - the four sections of System › Allgemein, mounted: each saves exactly the keys of
// its registry section, an invalid value blocks the save, the Bundesland hint of #390 is shown, and the
// two-factor switch saves at once and rolls back when the server refuses.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/svelte";

const put = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("$api/client", () => ({ api: { put: (...a: unknown[]) => put(...a) } }));
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));

import { renderWithTheme } from "$tests/test-utils";
import { settingsSection } from "$lib/settings/settings-pages";
import CompanySection from "../CompanySection.svelte";
import PasswordSection from "../PasswordSection.svelte";
import SessionSection from "../SessionSection.svelte";
import TwoFactorSection from "../TwoFactorSection.svelte";

const keysOf = (id: string) => [...settingsSection(id).keys].sort();
const bar = () => screen.queryByRole("region", { name: "Speicherleiste" });

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue({});
});

describe("CompanySection", () => {
  const config = { tenantName: "Muster GmbH", federalState: "BAYERN", timezone: "Europe/Vienna" };

  it("explains that a new salon inherits the Bundesland (#390)", () => {
    renderWithTheme(CompanySection, { config });
    expect(
      screen.getByText(
        /Vorgabe für neu angelegte Salons\. Feiertage richten sich nach dem Bundesland/,
      ),
    ).toBeTruthy();
  });

  it("shows the stored values and saves the three company keys together", async () => {
    renderWithTheme(CompanySection, { config });
    const name = screen.getByLabelText("Firmenname") as HTMLInputElement;
    expect(name.value).toBe("Muster GmbH");
    expect((screen.getByLabelText("Bundesland") as HTMLSelectElement).value).toBe("BAYERN");
    expect((screen.getByLabelText("Zeitzone") as HTMLSelectElement).value).toBe("Europe/Vienna");
    expect(bar()).toBeNull();

    await fireEvent.input(name, { target: { value: "Neue GmbH" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Unternehmen speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/settings/work", {
      tenantName: "Neue GmbH",
      federalState: "BAYERN",
      timezone: "Europe/Vienna",
    });
    expect(Object.keys(put.mock.calls[0][1]).sort()).toEqual(keysOf("allgemein-unternehmen"));
    await waitFor(() => expect(bar()).toBeNull());
  });

  it("blocks an empty company name", async () => {
    renderWithTheme(CompanySection, { config });
    await fireEvent.input(screen.getByLabelText("Firmenname"), { target: { value: "  " } });
    const region = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(region.textContent).toContain("1 Fehler");
    expect(
      (screen.getByRole("button", { name: "Unternehmen speichern" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it("keeps the edit when the save fails", async () => {
    put.mockRejectedValueOnce(new Error("Nicht erlaubt"));
    renderWithTheme(CompanySection, { config });
    const name = screen.getByLabelText("Firmenname") as HTMLInputElement;
    await fireEvent.input(name, { target: { value: "Neue GmbH" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Unternehmen speichern" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Nicht erlaubt"));
    expect(name.value).toBe("Neue GmbH");
    expect(bar()).not.toBeNull();
  });
});

describe("PasswordSection", () => {
  const config = {
    passwordMinLength: 12,
    passwordRequireUpper: true,
    passwordRequireLower: true,
    passwordRequireDigit: true,
    passwordRequireSpecial: false,
  };

  it("saves the five policy keys to /settings/security", async () => {
    renderWithTheme(PasswordSection, { config });
    const length = screen.getByLabelText("Mindestlänge (Zeichen)") as HTMLInputElement;
    expect(length.value).toBe("12");
    await fireEvent.input(length, { target: { value: "14" } });
    await fireEvent.click(screen.getByLabelText("Sonderzeichen erforderlich"));
    await fireEvent.click(await screen.findByRole("button", { name: "Richtlinie speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/settings/security", {
      passwordMinLength: 14,
      passwordRequireUpper: true,
      passwordRequireLower: true,
      passwordRequireDigit: true,
      passwordRequireSpecial: true,
    });
    expect(Object.keys(put.mock.calls[0][1]).sort()).toEqual(keysOf("allgemein-passwort"));
  });

  it("blocks a length outside 8..128 and does not save on a single change", async () => {
    renderWithTheme(PasswordSection, { config });
    await fireEvent.input(screen.getByLabelText("Mindestlänge (Zeichen)"), {
      target: { value: "7" },
    });
    const region = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(region.textContent).toContain("1 Fehler");
    expect(
      (screen.getByRole("button", { name: "Richtlinie speichern" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });
});

describe("SessionSection", () => {
  const config = {
    sessionTimeoutMinutes: 60,
    refreshTokenDays: 7,
    rememberMeEnabled: true,
    rememberMeDays: 30,
    maxSessionsPerUser: 0,
    loginMaxAttempts: 5,
    loginLockoutMinutes: 15,
  };

  it("saves the seven session keys, and only those", async () => {
    renderWithTheme(SessionSection, { config });
    await fireEvent.input(screen.getByLabelText("Inaktivitäts-Timeout (Minuten)"), {
      target: { value: "30" },
    });
    await fireEvent.click(await screen.findByRole("button", { name: "Sitzungen speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/settings/security", {
      ...config,
      sessionTimeoutMinutes: 30,
    });
    expect(Object.keys(put.mock.calls[0][1]).sort()).toEqual(keysOf("allgemein-sitzungen"));
  });

  it("disables the Angemeldet-bleiben duration while the option is off", async () => {
    renderWithTheme(SessionSection, { config });
    const days = screen.getByLabelText(/Dauer von „Angemeldet bleiben“/) as HTMLInputElement;
    expect(days.disabled).toBe(false);
    await fireEvent.click(screen.getByLabelText("„Angemeldet bleiben“ erlauben"));
    expect(days.disabled).toBe(true);
  });

  it("blocks a value outside its bound", async () => {
    renderWithTheme(SessionSection, { config });
    await fireEvent.input(screen.getByLabelText("Fehlversuche bis zur Sperre (Versuche)"), {
      target: { value: "21" },
    });
    const region = await screen.findByRole("region", { name: "Speicherleiste" });
    expect(region.textContent).toContain("1 Fehler");
    expect(put).not.toHaveBeenCalled();
  });
});

describe("TwoFactorSection", () => {
  const label = "Zwei-Faktor-Authentifizierung per E-Mail verlangen";

  it("saves at once, with the one key and no SaveBar", async () => {
    renderWithTheme(TwoFactorSection, { config: { twoFaEnabled: false } });
    const box = screen.getByLabelText(label) as HTMLInputElement;
    expect(box.checked).toBe(false);
    await fireEvent.click(box);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/settings/security", { twoFaEnabled: true });
    expect(Object.keys(put.mock.calls[0][1])).toEqual(keysOf("allgemein-zwei-faktor"));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Einstellung gespeichert."));
    expect(bar()).toBeNull();
    expect(box.checked).toBe(true);
  });

  it("puts the previous value back and says so when the server refuses", async () => {
    put.mockRejectedValueOnce(new Error("Nicht erlaubt"));
    renderWithTheme(TwoFactorSection, { config: { twoFaEnabled: false } });
    const box = screen.getByLabelText(label) as HTMLInputElement;
    await fireEvent.click(box);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Nicht erlaubt"));
    expect(box.checked).toBe(false);
  });
});
