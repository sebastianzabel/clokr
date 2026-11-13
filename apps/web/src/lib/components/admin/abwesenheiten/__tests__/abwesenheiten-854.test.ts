// Issue #854 (plan 11) - the three panels of Verwalten › Regeln › Abwesenheiten, mounted: every settings section
// saves exactly the keys of its registry section through its own SaveBar (#878, D-854-04), a refused save keeps
// the edit, invalid values block the request, and the Sonderurlaub list loads lazily and writes through a Dialog.
// The route page cannot be mounted (no `$app` alias), so these mount tests are the panels' gate.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const put = vi.fn();
const post = vi.fn();
const get = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("$api/client", () => ({
  api: {
    put: (...a: unknown[]) => put(...a),
    post: (...a: unknown[]) => post(...a),
    get: (...a: unknown[]) => get(...a),
  },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));

import { renderWithTheme } from "$tests/test-utils";
import { ApiError } from "$api/client";
import { settingsSection } from "$lib/settings/settings-pages";
import {
  clampDayToMonth,
  clampKarenzDays,
  holidayRulesSummary,
  parseThresholdsInput,
  uebertragFrom,
  verfallMessages,
} from "$lib/settings/abwesenheiten";
import { ruleDaysMessage, type SpecialLeaveRule } from "$lib/settings/sonderurlaub";
import UrlaubPanel from "../UrlaubPanel.svelte";
import UebertragPanel from "../UebertragPanel.svelte";
import SonderurlaubPanel from "../SonderurlaubPanel.svelte";

const keysOf = (id: string) => [...settingsSection(id).keys].sort();
const bar = () => screen.queryByRole("region", { name: "Speicherleiste" });
/** The request body as the server receives it (undefined values are dropped by JSON). */
const sentBody = (call = 0) => JSON.parse(JSON.stringify(put.mock.calls[call][1]));
const input = (label: string | RegExp) => screen.getByLabelText(label) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue({});
  post.mockResolvedValue({});
  get.mockResolvedValue([]);
});

describe("pure helpers", () => {
  it("clampDayToMonth lowers a day that does not exist in the month and never raises one", () => {
    expect(clampDayToMonth(31, 4)).toBe(30);
    expect(clampDayToMonth(31, 2)).toBe(28);
    expect(clampDayToMonth(15, 6)).toBe(15);
    expect(clampDayToMonth(null, 6)).toBeNull();
  });

  it("a stored carry-over of 15 June is read as 15 June (the old page raised it to the 30th)", () => {
    const values = uebertragFrom({ carryOverDeadlineDay: 15, carryOverDeadlineMonth: 6 });
    expect(values.carryOverDeadlineDay).toBe(15);
  });

  it("parseThresholdsInput drops invalid entries, removes duplicates and sorts descending", () => {
    expect(parseThresholdsInput("7, 30; 14 30 abc 0 400")).toEqual([30, 14, 7]);
    expect(parseThresholdsInput("")).toEqual([]);
  });

  it("verfallMessages judges the list only while the warnings are on", () => {
    const base = {
      vacationReminderStartMonth: 10,
      carryoverWarningEnabled: true,
      carryoverWarningThresholds: "",
    };
    expect(verfallMessages(base).carryoverWarningThresholds).toMatch(/mindestens einen/);
    expect(
      verfallMessages({ ...base, carryoverWarningThresholds: "30, x" }).carryoverWarningThresholds,
    ).toMatch(/1 bis 365/);
    expect(
      verfallMessages({
        ...base,
        carryoverWarningThresholds: "1,2,3,4,5,6,7,8,9,10,11",
      }).carryoverWarningThresholds,
    ).toMatch(/Höchstens 10/);
    expect(verfallMessages({ ...base, carryoverWarningEnabled: false })).toEqual({});
    expect(verfallMessages({ ...base, carryoverWarningThresholds: "60, 30" })).toEqual({});
  });

  it("clampKarenzDays caps at 3 (EFZG) and falls back to 3 for nothing", () => {
    expect(clampKarenzDays(14)).toBe(3);
    expect(clampKarenzDays(0)).toBe(0);
    expect(clampKarenzDays(null)).toBe(3);
    expect(clampKarenzDays(undefined)).toBe(3);
  });

  it("holidayRulesSummary names which rule applies from which year", () => {
    const base = {
      christmasEveRule: "NORMAL",
      newYearsEveRule: "NORMAL",
      holidayRulesValidFromYear: 2027,
    } as const;
    expect(holidayRulesSummary(base)).toBe("Aktuell keine Sonderregelung aktiv.");
    expect(holidayRulesSummary({ ...base, christmasEveRule: "HALF_DAY" })).toMatch(
      /^Heiligabend \(halber Tag\) gilt ab 2027\./,
    );
    expect(holidayRulesSummary({ ...base, newYearsEveRule: "FULL_DAY_OFF" })).toMatch(
      /^Silvester \(ganzer Tag frei\) gilt ab 2027\./,
    );
    expect(
      holidayRulesSummary({
        ...base,
        christmasEveRule: "HALF_DAY",
        newYearsEveRule: "FULL_DAY_OFF",
      }),
    ).toMatch(/und Silvester \(ganzer Tag frei\) gelten ab 2027/);
  });

  it("ruleDaysMessage accepts 0.5 to 30 and refuses everything else", () => {
    expect(ruleDaysMessage(0.5)).toBeNull();
    expect(ruleDaysMessage(30)).toBeNull();
    expect(ruleDaysMessage(0)).not.toBeNull();
    expect(ruleDaysMessage(31)).not.toBeNull();
    expect(ruleDaysMessage(null)).not.toBeNull();
  });
});

describe("UrlaubPanel", () => {
  const CONFIG = {
    defaultVacationDays: "30.00",
    defaultApprenticeVacationDays: "20.00",
    carryOverDeadlineDay: 31,
    carryOverDeadlineMonth: 3,
    sickNoteRequiredAfterDays: 14, // legacy row, above the EFZG cap
    holidayRulesValidFromYear: 2026,
  };
  const mount = (config = CONFIG, onSaved = vi.fn()) => {
    renderWithTheme(UrlaubPanel, { config, onSaved });
    return onSaved;
  };

  it("shows the overview figures and no SaveBar while nothing changed", () => {
    mount();
    expect(screen.getByRole("group", { name: "Eckdaten der Urlaubsregeln" })).toBeTruthy();
    expect(screen.getByText("Jahresurlaub (Standard)")).toBeTruthy();
    expect(screen.getByText("31. März")).toBeTruthy();
    expect(bar()).toBeNull();
  });

  it("Urlaubsanspruch saves ONLY its five keys, then reports the saved values to the page", async () => {
    const onSaved = mount();
    await fireEvent.input(input("Jahresurlaub (Basis 5-Tage-Woche)"), { target: { value: "28" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Urlaubsanspruch speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][0]).toBe("/settings/work");
    expect(Object.keys(sentBody()).sort()).toEqual(keysOf("abwesenheiten-anspruch"));
    expect(sentBody().defaultVacationDays).toBe(28);
    await waitFor(() => expect(bar()).toBeNull());
    expect(success).toHaveBeenCalledWith("Urlaubsanspruch gespeichert.");
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ defaultVacationDays: 28 }));
  });

  it("the part-time help line follows the typed days (4-day week)", async () => {
    mount();
    expect(screen.getByText(/4-Tage-Woche → 24 Tage/)).toBeTruthy();
    await fireEvent.input(input("Jahresurlaub (Basis 5-Tage-Woche)"), { target: { value: "25" } });
    expect(screen.getByText(/4-Tage-Woche → 20 Tage/)).toBeTruthy();
  });

  it("the Vollzeit-Arbeitstage choice exists only while the pro-rata calculation is on", async () => {
    mount();
    expect(screen.getByLabelText("Vollzeit-Arbeitstage pro Woche")).toBeTruthy();
    await fireEvent.click(input("Teilzeit-Urlaub automatisch anteilig berechnen"));
    expect(screen.queryByLabelText("Vollzeit-Arbeitstage pro Woche")).toBeNull();
  });

  it("an invalid value sends nothing and marks the field", async () => {
    mount();
    await fireEvent.input(input("Jahresurlaub (Basis 5-Tage-Woche)"), { target: { value: "0" } });
    const save = (await screen.findByRole("button", {
      name: "Urlaubsanspruch speichern",
    })) as HTMLButtonElement;
    // The SaveBar blocks the save while a field is invalid.
    expect(save.disabled).toBe(true);
    await fireEvent.click(save);
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByText(/1 Fehler/)).toBeTruthy();
    expect(screen.getByText(/Gib Tage von 1 bis 365 an/)).toBeTruthy();
  });

  it("the Azubi minimum of 20 days (§ 3 BUrlG) is enforced before the request", async () => {
    mount();
    await fireEvent.input(input("Urlaubstage Azubis (Basis 5-Tage-Woche)"), {
      target: { value: "15" },
    });
    const save = (await screen.findByRole("button", {
      name: "Urlaubsanspruch speichern",
    })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await fireEvent.click(save);
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByText(/Gib Tage von 20 \(§ 3 BUrlG\)/)).toBeTruthy();
  });

  it("Urlaubsanträge saves ONLY its four keys", async () => {
    mount();
    await fireEvent.click(input("Halbe Tage erlauben"));
    await fireEvent.input(input("Vorlaufzeit (Tage)"), { target: { value: "14" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Urlaubsanträge speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(Object.keys(sentBody()).sort()).toEqual(keysOf("abwesenheiten-antraege"));
    expect(sentBody()).toMatchObject({ halfDayAllowed: false, vacationLeadTimeDays: 14 });
  });

  it("Krankmeldung reads a legacy threshold of 14 as 3 and saves ONLY its two keys", async () => {
    mount();
    expect(input("Nachweispflicht nach (Kalendertagen)").value).toBe("3");
    await fireEvent.click(input("Mitarbeitende dürfen eine Krankmeldung selbst eintragen"));
    await fireEvent.click(await screen.findByRole("button", { name: "Krankmeldung speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(Object.keys(sentBody()).sort()).toEqual(keysOf("abwesenheiten-krankheit"));
    expect(sentBody()).toEqual({ sickSelfReport: false, sickNoteRequiredAfterDays: 3 });
  });

  it("a threshold above 3 days is refused before the request", async () => {
    mount();
    await fireEvent.input(input("Nachweispflicht nach (Kalendertagen)"), {
      target: { value: "5" },
    });
    await fireEvent.click(await screen.findByRole("button", { name: "Krankmeldung speichern" }));
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByText(/ganze Kalendertage von 0 bis 3/)).toBeTruthy();
  });

  it("Heiligabend und Silvester saves ONLY its three keys and explains the rule", async () => {
    mount();
    expect(screen.getByText("Aktuell keine Sonderregelung aktiv.")).toBeTruthy();
    await fireEvent.change(screen.getByLabelText("Heiligabend (24.12.)"), {
      target: { value: "HALF_DAY" },
    });
    expect(screen.getByText(/Heiligabend \(halber Tag\) gilt ab 2026/)).toBeTruthy();
    await fireEvent.click(await screen.findByRole("button", { name: "Feiertagsregeln speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(Object.keys(sentBody()).sort()).toEqual(keysOf("abwesenheiten-feiertage"));
    expect(sentBody()).toEqual({
      christmasEveRule: "HALF_DAY",
      newYearsEveRule: "NORMAL",
      holidayRulesValidFromYear: 2026,
    });
  });

  it("the sections are independent: one edit shows one SaveBar and saving it leaves the other edit", async () => {
    mount();
    await fireEvent.input(input("Vorlaufzeit (Tage)"), { target: { value: "7" } });
    await fireEvent.click(input("Mitarbeitende dürfen eine Krankmeldung selbst eintragen"));
    expect(screen.getAllByRole("region", { name: "Speicherleiste" })).toHaveLength(2);
    await fireEvent.click(await screen.findByRole("button", { name: "Krankmeldung speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(Object.keys(sentBody()).sort()).toEqual(keysOf("abwesenheiten-krankheit"));
    await waitFor(() =>
      expect(screen.getAllByRole("region", { name: "Speicherleiste" })).toHaveLength(1),
    );
    expect(input("Vorlaufzeit (Tage)").value).toBe("7");
  });

  it("a refused save keeps the edit and the SaveBar and says so", async () => {
    put.mockRejectedValue(new Error("Kein Zugriff."));
    mount();
    await fireEvent.input(input("Vorlaufzeit (Tage)"), { target: { value: "7" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Urlaubsanträge speichern" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Kein Zugriff."));
    expect(input("Vorlaufzeit (Tage)").value).toBe("7");
    expect(bar()).not.toBeNull();
  });

  it("discard puts the stored value back and removes the SaveBar", async () => {
    mount();
    await fireEvent.input(input("Vorlaufzeit (Tage)"), { target: { value: "7" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Verwerfen" }));
    expect(input("Vorlaufzeit (Tage)").value).toBe("0");
    expect(bar()).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });
});

describe("UebertragPanel", () => {
  const CONFIG = { carryOverDeadlineDay: 31, carryOverDeadlineMonth: 3 };
  const mount = (config: Record<string, unknown> = CONFIG, onSaved = vi.fn()) => {
    renderWithTheme(UebertragPanel, { config, onSaved });
    return onSaved;
  };

  it("Übertrag saves ONLY its three keys and reports the deadline to the page", async () => {
    const onSaved = mount();
    await fireEvent.click(input("Übertrag ins Folgejahr erfordert eine Begründung"));
    await fireEvent.click(await screen.findByRole("button", { name: "Übertrag speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(Object.keys(sentBody()).sort()).toEqual(keysOf("abwesenheiten-uebertrag"));
    expect(sentBody()).toEqual({
      carryOverDeadlineDay: 31,
      carryOverDeadlineMonth: 3,
      carryOverRequiresReason: false,
    });
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ carryOverDeadlineDay: 31, carryOverDeadlineMonth: 3 }),
    );
  });

  it("choosing a shorter month lowers the day; a day that fits stays", async () => {
    mount();
    await fireEvent.change(screen.getByLabelText("Monat des Verfalls"), { target: { value: "4" } });
    expect(input("Tag des Verfalls").value).toBe("30");
    await fireEvent.input(input("Tag des Verfalls"), { target: { value: "15" } });
    await fireEvent.change(screen.getByLabelText("Monat des Verfalls"), { target: { value: "6" } });
    expect(input("Tag des Verfalls").value).toBe("15");
  });

  it("a day beyond the month is refused before the request", async () => {
    mount({ carryOverDeadlineDay: 30, carryOverDeadlineMonth: 4 });
    await fireEvent.input(input("Tag des Verfalls"), { target: { value: "31" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Übertrag speichern" }));
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByText(/Gib einen Tag von 1 bis 30 an \(April\)/)).toBeTruthy();
  });

  it("Warnung vor Verfall saves ONLY its three keys, the list parsed to numbers", async () => {
    mount({
      ...CONFIG,
      carryoverWarningThresholds: [60, 30, 14, 7],
      vacationReminderStartMonth: 10,
    });
    expect(input("Schwellwerte (Tage vor Verfall)").value).toBe("60, 30, 14, 7");
    await fireEvent.input(input("Schwellwerte (Tage vor Verfall)"), {
      target: { value: "7, 30, 14, 30" },
    });
    await fireEvent.change(screen.getByLabelText("Erinnerung ab Monat"), {
      target: { value: "9" },
    });
    await fireEvent.click(await screen.findByRole("button", { name: "Verfallswarnung speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(Object.keys(sentBody()).sort()).toEqual(keysOf("abwesenheiten-verfallswarnung"));
    expect(sentBody()).toEqual({
      vacationReminderStartMonth: 9,
      carryoverWarningEnabled: true,
      carryoverWarningThresholds: [30, 14, 7],
    });
  });

  it("an unreadable list is refused; switching the warnings off disables and releases the field", async () => {
    mount();
    await fireEvent.input(input("Schwellwerte (Tage vor Verfall)"), { target: { value: "30, x" } });
    await fireEvent.click(await screen.findByRole("button", { name: "Verfallswarnung speichern" }));
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByText(/ganze Tage von 1 bis 365/)).toBeTruthy();
    await fireEvent.click(input("Hinweise automatisch versenden"));
    expect(input("Schwellwerte (Tage vor Verfall)").disabled).toBe(true);
    expect(screen.queryByText(/ganze Tage von 1 bis 365 an, getrennt/)).toBeNull();
  });

  it("the two sections do not share a request", async () => {
    mount();
    await fireEvent.click(input("Übertrag ins Folgejahr erfordert eine Begründung"));
    await fireEvent.click(input("Hinweise automatisch versenden"));
    expect(screen.getAllByRole("region", { name: "Speicherleiste" })).toHaveLength(2);
    await fireEvent.click(screen.getByRole("button", { name: "Übertrag speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(Object.keys(sentBody()).sort()).toEqual(keysOf("abwesenheiten-uebertrag"));
  });
});

describe("SonderurlaubPanel", () => {
  const RULES: SpecialLeaveRule[] = [
    {
      id: "r1",
      name: "Eigene Hochzeit",
      reason: "Gesetzlicher Anspruch gemäß § 616 BGB",
      defaultDays: "1.00",
      isStatutory: true,
      requiresProof: true,
      isActive: true,
    },
    {
      id: "r2",
      name: "Ehrenamtlicher Einsatz",
      reason: null,
      defaultDays: "2.50",
      isStatutory: false,
      requiresProof: false,
      isActive: false,
    },
  ];

  it("loads nothing while the tab is not shown", () => {
    renderWithTheme(SonderurlaubPanel, { active: false });
    expect(get).not.toHaveBeenCalled();
  });

  it("lists the rules with days, proof, kind and status once the tab is shown", async () => {
    get.mockResolvedValue(RULES);
    renderWithTheme(SonderurlaubPanel, { active: true });
    const table = await screen.findByRole("table", { name: /Sonderurlaubsregeln/ });
    expect(get).toHaveBeenCalledWith("/special-leave/rules");
    expect(table.textContent).toContain("Eigene Hochzeit");
    expect(table.textContent).toContain("Gesetzlich");
    expect(table.textContent).toContain("Betrieblich");
    expect(table.textContent).toContain("Deaktiviert");
    expect(table.textContent).toContain("2.5");
  });

  it("says so when loading fails and offers a retry", async () => {
    get.mockRejectedValueOnce(new Error("down"));
    renderWithTheme(SonderurlaubPanel, { active: true });
    await screen.findByText(/konnten nicht geladen werden/);
    get.mockResolvedValue(RULES);
    await fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await screen.findByRole("table", { name: /Sonderurlaubsregeln/ });
  });

  it("creates a rule from the dialog: POST with trimmed name, closes, toasts and reloads", async () => {
    get.mockResolvedValue(RULES);
    renderWithTheme(SonderurlaubPanel, { active: true });
    await screen.findByRole("table", { name: /Sonderurlaubsregeln/ });
    await fireEvent.click(screen.getByRole("button", { name: "Regel anlegen" }));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.input(within(dialog).getByLabelText(/^Anlass/), {
      target: { value: "  Blutspende " },
    });
    await fireEvent.input(within(dialog).getByLabelText(/^Anzahl Tage/), {
      target: { value: "0.5" },
    });
    await fireEvent.click(within(dialog).getByLabelText("Nachweis erforderlich"));
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toBe("/special-leave/rules");
    expect(JSON.parse(JSON.stringify(post.mock.calls[0][1]))).toEqual({
      name: "Blutspende",
      defaultDays: 0.5,
      requiresProof: true,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(success).toHaveBeenCalledWith("Regel angelegt.");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("a rule without a name or with 0 days sends nothing", async () => {
    get.mockResolvedValue(RULES);
    renderWithTheme(SonderurlaubPanel, { active: true });
    await screen.findByRole("table", { name: /Sonderurlaubsregeln/ });
    await fireEvent.click(screen.getByRole("button", { name: "Regel anlegen" }));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await within(dialog).findByText("Gib den Anlass an.")).toBeTruthy();
    await fireEvent.input(within(dialog).getByLabelText(/^Anlass/), { target: { value: "X" } });
    await fireEvent.input(within(dialog).getByLabelText(/^Anzahl Tage/), {
      target: { value: "0" },
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await within(dialog).findByText(/Gib die Tage von 0,5 bis 30 an/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it("a statutory rule keeps its name: the field is locked and the PUT carries no name", async () => {
    get.mockResolvedValue(RULES);
    renderWithTheme(SonderurlaubPanel, { active: true });
    await fireEvent.click(await screen.findByRole("button", { name: /^Eigene Hochzeit/ }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText(/^Anlass/) as HTMLInputElement).disabled).toBe(true);
    await fireEvent.input(within(dialog).getByLabelText(/^Anzahl Tage/), {
      target: { value: "2" },
    });
    await fireEvent.click(within(dialog).getByLabelText("Regel ist aktiv"));
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][0]).toBe("/special-leave/rules/r1");
    expect(sentBody()).toEqual({
      reason: "Gesetzlicher Anspruch gemäß § 616 BGB",
      defaultDays: 2,
      requiresProof: true,
      isActive: false,
    });
    expect(success).toHaveBeenCalledWith("Regel gespeichert.");
  });

  it("a refusal of the API stays in the dialog with the server's text", async () => {
    get.mockResolvedValue(RULES);
    post.mockRejectedValue(new ApiError(409, "Eine Regel mit diesem Namen gibt es schon."));
    renderWithTheme(SonderurlaubPanel, { active: true });
    await screen.findByRole("table", { name: /Sonderurlaubsregeln/ });
    await fireEvent.click(screen.getByRole("button", { name: "Regel anlegen" }));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.input(within(dialog).getByLabelText(/^Anlass/), {
      target: { value: "Doppelt" },
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(
      await within(dialog).findByText("Eine Regel mit diesem Namen gibt es schon."),
    ).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(error).not.toHaveBeenCalled();
  });
});
