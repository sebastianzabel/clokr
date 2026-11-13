// Issue #854 (plan 09) - the three panels of Verwalten › Regeln › Dienstplan, mounted. The route page
// cannot be mounted (no `$app` alias), so these mount tests are the panels' gate: lists as
// DataTables, Dialog editors with refusals that keep the dialog open, ConfirmDialog deletions that
// act only after the confirmation, the salon choice of a coverage rule only under the #64 rule
// (Issue #647) and the pattern matrix's one SaveBar with per-person baselines.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const put = vi.fn();
const post = vi.fn();
const del = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("$api/client", () => ({
  api: {
    put: (...a: unknown[]) => put(...a),
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
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

vi.mock("$stores/salon-context", async () => {
  const { writable } = await import("svelte/store");
  const store = writable({
    loaded: true,
    tenant: { id: "t1", name: "Test" },
    salons: [] as Array<{ id: string; name: string }>,
    isMultiSalon: false,
    homeSalonId: null,
    selection: null,
    packages: null,
    roles: [],
  });
  return {
    salonContext: { subscribe: store.subscribe },
    // The test drives the store through this handle.
    testContext: store,
    // The #64 rule, as in the real module.
    showSalonOptions: (s: { isMultiSalon: boolean; salons: unknown[] }) =>
      s.isMultiSalon && s.salons.length > 1,
  };
});

import { renderWithTheme } from "$tests/test-utils";
import { ApiError } from "$api/client";
import * as salonContextModule from "$stores/salon-context";
import type {
  CoverageRule,
  PatternEmployee,
  PatternRow,
  ShiftTemplate,
} from "$lib/shifts/dienstplan-config";
import CoverageRulesPanel from "../CoverageRulesPanel.svelte";
import ShiftTemplatesPanel from "../ShiftTemplatesPanel.svelte";
import WeekPatternsPanel from "../WeekPatternsPanel.svelte";

const TEMPLATES: ShiftTemplate[] = [
  { id: "tpl-early", name: "Frühschicht", startTime: "06:00", endTime: "14:00", color: "#3B82F6" },
  { id: "tpl-late", name: "Spätschicht", startTime: "14:00", endTime: "22:00", color: "#F59E0B" },
];

const RULES: CoverageRule[] = [
  {
    id: "rule-1",
    templateId: "tpl-early",
    dayOfWeek: 1,
    minStaff: "2.50",
    requiresNonSupervised: true,
    salonId: null,
    salonName: null,
    salonActive: null,
  },
  {
    id: "rule-2",
    templateId: null,
    dayOfWeek: -1,
    minStaff: 3,
    requiresNonSupervised: false,
    salonId: "salon-old",
    salonName: "Altstadt",
    salonActive: false,
  },
];

const context = (
  salonContextModule as unknown as {
    testContext: {
      update: (fn: (s: Record<string, unknown>) => Record<string, unknown>) => void;
    };
  }
).testContext;

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue({});
  post.mockResolvedValue({});
  del.mockResolvedValue(undefined);
  context.update((s) => ({ ...s, salons: [], isMultiSalon: false }));
});

describe("ShiftTemplatesPanel", () => {
  const mount = (onChanged = vi.fn().mockResolvedValue(undefined)) => {
    renderWithTheme(ShiftTemplatesPanel, { templates: TEMPLATES, onChanged });
    return onChanged;
  };

  it("lists the templates with their time span", () => {
    mount();
    const table = screen.getByRole("table", { name: /Schichtvorlagen/ });
    expect(table.textContent).toContain("Frühschicht");
    expect(table.textContent).toContain("06:00 – 14:00");
    expect(table.textContent).toContain("Spätschicht");
  });

  it("says so when there is no template", () => {
    renderWithTheme(ShiftTemplatesPanel, { templates: [], onChanged: vi.fn() });
    expect(screen.getByText("Noch keine Schichtvorlagen")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("creates a template from the dialog, toasts, closes and asks the page to reload", async () => {
    const onChanged = mount();
    await fireEvent.click(screen.getByRole("button", { name: "Vorlage anlegen" }));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.input(within(dialog).getByLabelText(/^Name/), {
      target: { value: "  Nachtschicht " },
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/shifts/templates", {
      name: "Nachtschicht",
      startTime: "06:00",
      endTime: "14:00",
      color: expect.any(String),
    });
    expect(success).toHaveBeenCalledWith("Vorlage angelegt.");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("edits a template through its row and sends a PUT with the stored colour", async () => {
    const onChanged = mount();
    await fireEvent.click(screen.getByRole("button", { name: "Spätschicht" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Spätschicht");
    await fireEvent.input(within(dialog).getByLabelText(/^Endzeit/), {
      target: { value: "23:00" },
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/shifts/templates/tpl-late", {
      name: "Spätschicht",
      startTime: "14:00",
      endTime: "23:00",
      color: "#F59E0B",
    });
    expect(success).toHaveBeenCalledWith("Vorlage gespeichert.");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("refuses an empty name without calling the API and keeps the dialog open", async () => {
    mount();
    await fireEvent.click(screen.getByRole("button", { name: "Vorlage anlegen" }));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await screen.findByText("Name, Start- und Endzeit sind Pflichtfelder.")).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("shows the API's own refusal in the dialog", async () => {
    post.mockRejectedValue(new ApiError(409, "Eine Vorlage mit diesem Namen gibt es schon."));
    mount();
    await fireEvent.click(screen.getByRole("button", { name: "Vorlage anlegen" }));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.input(within(dialog).getByLabelText(/^Name/), { target: { value: "Doppelt" } });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await screen.findByText("Eine Vorlage mit diesem Namen gibt es schon.")).toBeTruthy();
    expect(success).not.toHaveBeenCalled();
  });

  it("deletes only after the confirmation", async () => {
    const onChanged = mount();
    await fireEvent.click(screen.getByRole("button", { name: "Vorlage Frühschicht löschen" }));
    expect(del).not.toHaveBeenCalled();
    await fireEvent.click(await screen.findByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/shifts/templates/tpl-early"));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Vorlage gelöscht."));
    expect(onChanged).toHaveBeenCalled();
  });

  it("a refused delete toasts the server's text and keeps the confirmation open", async () => {
    del.mockRejectedValue(new Error("Die Vorlage wird noch verwendet."));
    const onChanged = mount();
    await fireEvent.click(screen.getByRole("button", { name: "Vorlage Frühschicht löschen" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Die Vorlage wird noch verwendet."));
    expect(success).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("CoverageRulesPanel", () => {
  const mount = (rules = RULES) => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    renderWithTheme(CoverageRulesPanel, { rules, templates: TEMPLATES, onChanged });
    return onChanged;
  };
  const withSalonOptions = () =>
    context.update((s) => ({
      ...s,
      isMultiSalon: true,
      salons: [
        { id: "salon-a", name: "Mitte" },
        { id: "salon-b", name: "Nord" },
      ],
    }));

  it("lists the rules; a rule of a deactivated salon keeps its salon column, marked", () => {
    mount();
    const table = screen.getByRole("table", { name: /Bedarfsregeln/ });
    expect(table.textContent).toContain("Frühschicht");
    expect(table.textContent).toContain("Dienstag");
    expect(table.textContent).toContain("2,5");
    expect(table.textContent).toContain("Alle Vorlagen");
    expect(table.textContent).toContain("Alle Tage");
    // Single-salon tenant, but one rule names a salon: the column shows and the rule is marked.
    expect(table.textContent).toContain("Altstadt");
    expect(table.textContent).toContain("Salon deaktiviert");
  });

  it("has no salon column and no salon field without salon options and a tenant-wide list", async () => {
    mount([RULES[0]]);
    const table = screen.getByRole("table", { name: /Bedarfsregeln/ });
    expect(within(table).queryByRole("columnheader", { name: "Salon" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Regel anlegen" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText("Salon")).toBeNull();
  });

  it("creates a rule without a salonId key while the salon choice is hidden", async () => {
    const onChanged = mount([RULES[0]]);
    await fireEvent.click(screen.getByRole("button", { name: "Regel anlegen" }));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/shifts/coverage-rules", {
      templateId: null,
      dayOfWeek: -1,
      minStaff: 2,
      requiresNonSupervised: false,
    });
    expect(success).toHaveBeenCalledWith("Mindestbesetzung angelegt.");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("offers the salon choice under the #64 rule and sends the chosen salon", async () => {
    withSalonOptions();
    mount([RULES[0]]);
    await fireEvent.click(screen.getByRole("button", { name: "Regel anlegen" }));
    const dialog = await screen.findByRole("dialog");
    const select = within(dialog).getByLabelText("Salon") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Alle Salons (ganzes Unternehmen)",
      "Mitte",
      "Nord",
    ]);
    await fireEvent.change(select, { target: { value: "salon-b" } });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toMatchObject({ salonId: "salon-b" });
  });

  it("keeps a deactivated salon selected when its rule is edited, marked in the choice", async () => {
    withSalonOptions();
    mount();
    await fireEvent.click(screen.getByRole("button", { name: "Alle Vorlagen" }));
    const dialog = await screen.findByRole("dialog");
    const select = within(dialog).getByLabelText("Salon") as HTMLSelectElement;
    expect(select.value).toBe("salon-old");
    expect([...select.options].map((o) => o.textContent)).toContain("Altstadt (deaktiviert)");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith(
      "/shifts/coverage-rules/rule-2",
      expect.objectContaining({ salonId: "salon-old", minStaff: 3 }),
    );
    expect(success).toHaveBeenCalledWith("Mindestbesetzung gespeichert.");
  });

  it("refuses a negative minimum without calling the API", async () => {
    mount([RULES[0]]);
    await fireEvent.click(screen.getByRole("button", { name: "Regel anlegen" }));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.input(within(dialog).getByLabelText(/^Mindestens/), {
      target: { value: "-1" },
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await screen.findByText("Die Mindestbesetzung muss eine Zahl ab 0 sein.")).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it("shows the API's refusal (a salon outside the reach) in the dialog", async () => {
    withSalonOptions();
    put.mockRejectedValue(new ApiError(404, "Salon nicht gefunden."));
    mount([RULES[1]]);
    await fireEvent.click(screen.getByRole("button", { name: "Alle Vorlagen" }));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await screen.findByText("Salon nicht gefunden.")).toBeTruthy();
    expect(success).not.toHaveBeenCalled();
  });

  it("deletes only after the confirmation", async () => {
    const onChanged = mount([RULES[0]]);
    await fireEvent.click(screen.getByRole("button", { name: /^Regel Frühschicht.*löschen$/ }));
    expect(del).not.toHaveBeenCalled();
    await fireEvent.click(await screen.findByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/shifts/coverage-rules/rule-1"));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Mindestbesetzung gelöscht."));
    expect(onChanged).toHaveBeenCalled();
  });

  it("says so, with the default, when there is no rule", () => {
    mount([]);
    expect(screen.getByText("Noch keine Mindestbesetzung festgelegt")).toBeTruthy();
    expect(screen.getByText("Ohne Regel gelten 2 Personen.")).toBeTruthy();
  });
});

describe("WeekPatternsPanel", () => {
  const EMPLOYEES: PatternEmployee[] = [
    {
      id: "emp-1",
      firstName: "Anna",
      lastName: "Berg",
      workSchedules: [{ type: "SHIFT_BASED", weeklyHours: 40 }],
    },
    {
      id: "emp-2",
      firstName: "Ben",
      lastName: "Claus",
      workSchedules: [{ type: "SHIFT_BASED", weeklyHours: 20 }],
    },
  ];
  const PATTERNS: PatternRow[] = [
    { employeeId: "emp-1", dayOfWeek: 0, templateId: "tpl-early" },
    { employeeId: "emp-2", dayOfWeek: 4, templateId: "tpl-late" },
  ];
  const mount = () =>
    renderWithTheme(WeekPatternsPanel, {
      employees: EMPLOYEES,
      patterns: PATTERNS,
      templates: TEMPLATES,
    });
  const cell = (name: string) => screen.getByLabelText(name) as HTMLSelectElement;

  it("shows one select per person and weekday, filled from the stored pattern", () => {
    mount();
    expect(cell("Berg, Anna Montag").value).toBe("tpl-early");
    expect(cell("Berg, Anna Dienstag").value).toBe("");
    expect(cell("Claus, Ben Freitag").value).toBe("tpl-late");
    // Mo-Fr columns carry the average Soll hint, Sa/So do not.
    const table = screen.getByRole("table", { name: /Wochenmuster/ });
    expect(table.textContent).toContain("Mo (Ø 6,0 h)");
    expect(within(table).getByText("Sa")).toBeTruthy();
  });

  it("points to the working model when nobody works by roster", () => {
    renderWithTheme(WeekPatternsPanel, { employees: [], patterns: [], templates: TEMPLATES });
    expect(screen.getByText(/Noch niemand arbeitet nach Schichtplan/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("has no save bar and writes nothing until a cell changes", async () => {
    mount();
    expect(screen.queryByRole("button", { name: "Muster speichern" })).toBeNull();
    expect(put).not.toHaveBeenCalled();
    await fireEvent.change(cell("Berg, Anna Dienstag"), { target: { value: "tpl-late" } });
    // A select change alone never writes.
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Muster speichern" })).toBeTruthy();
    expect(screen.getByText("Nicht gespeichert · 1 Änderung")).toBeTruthy();
  });

  it("saves only the changed person, with all seven days and today as the start", async () => {
    mount();
    await fireEvent.change(cell("Berg, Anna Dienstag"), { target: { value: "tpl-late" } });
    await fireEvent.click(screen.getByRole("button", { name: "Muster speichern" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [url, body] = put.mock.calls[0] as [string, { patterns: Array<Record<string, unknown>> }];
    expect(url).toBe("/employees/emp-1/shift-patterns");
    expect(body.patterns).toHaveLength(7);
    expect(body.patterns[0]).toMatchObject({ dayOfWeek: 0, templateId: "tpl-early" });
    expect(body.patterns[1]).toMatchObject({ dayOfWeek: 1, templateId: "tpl-late" });
    expect(body.patterns[2]).toMatchObject({ dayOfWeek: 2, templateId: null });
    expect(body.patterns[0].validFrom).toBe(new Date().toISOString().slice(0, 10));
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("Wochenmuster gespeichert (1 Person)."),
    );
    // The baseline moved: the bar is gone.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Muster speichern" })).toBeNull(),
    );
  });

  it("a failed save keeps the unsaved edit and its bar (T-109-24)", async () => {
    put.mockRejectedValue(new Error("boom"));
    mount();
    await fireEvent.change(cell("Berg, Anna Dienstag"), { target: { value: "tpl-late" } });
    await fireEvent.click(screen.getByRole("button", { name: "Muster speichern" }));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Speichern fehlgeschlagen für alle 1 Personen."),
    );
    expect(success).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Muster speichern" })).toBeTruthy();
    expect(cell("Berg, Anna Dienstag").value).toBe("tpl-late");
  });

  it("a partly failed save clears only the person that succeeded", async () => {
    put.mockImplementation((url: string) =>
      url.includes("emp-2") ? Promise.reject(new Error("boom")) : Promise.resolve({}),
    );
    mount();
    await fireEvent.change(cell("Berg, Anna Dienstag"), { target: { value: "tpl-late" } });
    await fireEvent.change(cell("Claus, Ben Montag"), { target: { value: "tpl-early" } });
    expect(screen.getByText("Nicht gespeichert · 2 Änderungen")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Muster speichern" }));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "Teilweise gespeichert: 1 OK, 1 Fehler. Bitte erneut versuchen.",
      ),
    );
    expect(screen.getByText("Nicht gespeichert · 1 Änderung")).toBeTruthy();
  });

  it("discards the edits back to the stored pattern", async () => {
    mount();
    await fireEvent.change(cell("Berg, Anna Dienstag"), { target: { value: "tpl-late" } });
    await fireEvent.click(screen.getByRole("button", { name: "Verwerfen" }));
    expect(cell("Berg, Anna Dienstag").value).toBe("");
    expect(screen.queryByRole("button", { name: "Muster speichern" })).toBeNull();
  });
});
