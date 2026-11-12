// Issue #86 (AC-86-5) - the "Salons" section of the employee detail page, mounted. The directory
// `lib/components/employees/` is outside lint:ui-classes, so this test is its gate. Only the server
// answers (`$api/client`) are mocked. Since Issue #854 the section is a DataTable plus a Dialog
// (FormFields, DatePickers, WeekdayPicker); the assertions on the data, the bodies and the server
// texts are unchanged.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import { fireEvent } from "@testing-library/svelte";

const apiGet = vi.fn();
const apiPost = vi.fn();

vi.mock("$api/client", () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
  ApiError: class extends Error {
    constructor(
      public status: number,
      message = "err",
    ) {
      super(message);
    }
  },
}));

import { renderWithTheme } from "$tests/test-utils";
import { ApiError } from "$api/client";
import SalonAssignmentsSection from "../SalonAssignmentsSection.svelte";

const E = "emp-1";

function assignment(over: Record<string, unknown>) {
  return {
    employeeId: E,
    kind: "DEPLOYMENT",
    validFrom: "2026-01-01",
    validUntil: null,
    weekdays: [],
    ...over,
  };
}

const ASSIGNMENTS = [
  assignment({ id: "a1", salonId: "s-nord", kind: "HOME", validFrom: "2025-01-01" }),
  assignment({ id: "a2", salonId: "s-sued", validFrom: "2026-09-01", weekdays: [1, 3, 5] }),
  assignment({
    id: "a3",
    salonId: "s-ost",
    validFrom: "2025-03-01",
    validUntil: "2025-05-31",
  }),
  assignment({
    id: "a4",
    salonId: "s-gone",
    validFrom: "2024-03-01",
    validUntil: "2024-05-31",
  }),
];

const SALONS = [
  { id: "s-nord", name: "Salon Nord", isActive: true },
  { id: "s-sued", name: "Salon Süd", isActive: true },
  { id: "s-ost", name: "Salon Ost", isActive: false },
];

function answer(over: { assignments?: unknown; salons?: unknown } = {}) {
  apiGet.mockImplementation((path: string) => {
    if (path === `/employees/${E}/salon-assignments`) {
      const a = over.assignments ?? { assignments: ASSIGNMENTS };
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    }
    if (path === "/salons?includeInactive=true") {
      const s = over.salons ?? { salons: SALONS, isMultiSalon: true };
      return s instanceof Error ? Promise.reject(s) : Promise.resolve(s);
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

async function settle() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    await tick();
  }
}

function rowTexts(): string[] {
  return [...document.querySelectorAll('[data-testid^="salon-assignment-row-"]')].map((r) =>
    (r.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  document.body.innerHTML = "";
});

describe("SalonAssignmentsSection - read (Issue #86, AC-86-5)", () => {
  it("renders every assignment with name, period and weekdays; inactive and unknown salons named", async () => {
    answer();
    renderWithTheme(SalonAssignmentsSection, { employeeId: E, canEdit: false });
    await settle();
    expect(rowTexts()).toEqual([
      expect.stringContaining("Einsatzsalon"),
      expect.stringContaining("Stammsalon"),
      expect.stringContaining("Einsatzsalon"),
      expect.stringContaining("Einsatzsalon"),
    ]);
    const rows = rowTexts();
    expect(rows[0]).toContain("Salon Süd");
    expect(rows[0]).toContain("seit 01.09.2026");
    expect(rows[0]).toContain("Mo, Mi, Fr");
    expect(rows[1]).toContain("Salon Nord");
    expect(rows[1]).toContain("seit 01.01.2025");
    expect(rows[2]).toContain("Salon Ost (inaktiv)");
    expect(rows[2]).toContain("01.03.2025 – 31.05.2025");
    expect(rows[2]).toContain("beendet");
    expect(rows[3]).toContain("Unbekannter Salon");
    expect(rows[3]).toContain("alle Tage");
  });

  it("keeps the change buttons out of the heading and the table in the DataTable's scroll container (phone width)", async () => {
    answer();
    renderWithTheme(SalonAssignmentsSection, { employeeId: E, canEdit: true });
    await settle();
    // A button inside the heading row overflows the card on a phone (e2e matrix).
    for (const id of ["salon-assignment-add", "salon-assignment-home"]) {
      const button = document.querySelector(`[data-testid="${id}"]`);
      expect(button, id).not.toBeNull();
      expect(button?.closest("h2"), id).toBeNull();
    }
    const wrapper = document.querySelector('[data-testid="salon-assignments-table"]');
    expect(wrapper?.querySelector(".dt-scroll table")).not.toBeNull();
  });

  it("is a settings group named Salonzuordnungen", async () => {
    answer();
    renderWithTheme(SalonAssignmentsSection, { employeeId: E, canEdit: false });
    await settle();
    expect(document.querySelector("section.settings-group h2")?.textContent).toBe(
      "Salonzuordnungen",
    );
  });

  it("renders no button for a read-only caller", async () => {
    answer();
    renderWithTheme(SalonAssignmentsSection, { employeeId: E, canEdit: false });
    await settle();
    expect(document.querySelectorAll("button").length).toBe(0);
  });

  it("falls back to 'Unbekannter Salon' with a neutral hint when the salon list is refused", async () => {
    answer({ salons: new ApiError(403, "Keine Berechtigung") });
    renderWithTheme(SalonAssignmentsSection, { employeeId: E, canEdit: false });
    await settle();
    const rows = rowTexts();
    expect(rows.length).toBe(4);
    for (const r of rows) expect(r).toContain("Unbekannter Salon");
    expect(document.querySelector('[data-testid="salon-names-hint"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows one German error callout when the assignments cannot be read", async () => {
    answer({ assignments: new ApiError(500, "Interner Serverfehler") });
    renderWithTheme(SalonAssignmentsSection, { employeeId: E, canEdit: false });
    await settle();
    const callouts = document.querySelectorAll('[role="alert"]');
    expect(callouts.length).toBe(1);
    expect(callouts[0].textContent).toContain("Interner Serverfehler");
    expect(rowTexts()).toEqual([]);
  });

  it("shows an empty-state text without assignments", async () => {
    answer({ assignments: { assignments: [] } });
    renderWithTheme(SalonAssignmentsSection, { employeeId: E, canEdit: false });
    await settle();
    expect(document.body.textContent).toContain("Keine Salonzuordnung vorhanden.");
  });
});

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`missing test id ${id}`);
  return found;
}

function salonSelect(): HTMLSelectElement {
  const select = document.querySelector<HTMLSelectElement>(
    '[data-testid="salon-assignment-form"] select',
  );
  if (!select) throw new Error("salon select missing");
  return select;
}

async function pickSalon(id: string) {
  const select = salonSelect();
  select.value = id;
  await fireEvent.change(select);
}

/** The segments of the DatePicker named `label` (day, month, year in the German order). */
function segmentsOf(label: string): HTMLElement[] {
  const field = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!field) throw new Error(`date field ${label} missing`);
  return [...field.querySelectorAll<HTMLElement>('[role="spinbutton"]')];
}

/** The shown ISO day of a DatePicker (`""` while a segment is empty). */
function shownDay(label: string): string {
  const [day, month, year] = segmentsOf(label).map((seg) => seg.textContent?.trim() ?? "");
  return /^\d+$/.test(day + month + year) ? `${year}-${month}-${day}` : "";
}

/** Types an ISO day into the DatePicker named `label` digit by digit, as a person would. */
async function typeDate(label: string, iso: string) {
  const [year, month, day] = iso.split("-");
  for (const [segment, digits] of [
    [segmentsOf(label)[0], day],
    [segmentsOf(label)[1], month],
    [segmentsOf(label)[2], year],
  ] as const) {
    segment.focus();
    for (const key of digits) await fireEvent.keyDown(segment, { key });
  }
  await settle();
}

async function mountEditable() {
  answer();
  renderWithTheme(SalonAssignmentsSection, { employeeId: E, canEdit: true });
  await settle();
}

describe("SalonAssignmentsSection - maintain (Issue #86, AC-86-5)", () => {
  it("offers only ACTIVE salons in the select and no delete control anywhere", async () => {
    await mountEditable();
    await fireEvent.click(byId("salon-assignment-add"));
    await settle();
    const options = [...salonSelect().querySelectorAll<HTMLOptionElement>("option")].map((o) =>
      o.textContent?.trim(),
    );
    expect(options).toEqual(["Bitte wählen", "Salon Nord", "Salon Süd"]);
    for (const el of document.querySelectorAll("button")) {
      expect(el.textContent).not.toMatch(/Löschen|Entfernen/);
    }
  });

  it("posts the Einsatzsalon body exactly and reloads the list", async () => {
    await mountEditable();
    apiPost.mockResolvedValueOnce({ id: "new" });
    await fireEvent.click(byId("salon-assignment-add"));
    await settle();
    expect(byId<HTMLButtonElement>("salon-assignment-submit").disabled).toBe(true);
    await pickSalon("s-nord");
    await typeDate("Gültig ab", "2026-11-02");
    await typeDate("Gültig bis", "2026-12-31");
    await fireEvent.click(byId("salon-assignment-weekday-5"));
    await fireEvent.click(byId("salon-assignment-weekday-1"));
    expect(byId<HTMLButtonElement>("salon-assignment-submit").disabled).toBe(false);
    const getsBefore = apiGet.mock.calls.length;
    await fireEvent.click(byId("salon-assignment-submit"));
    await settle();
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith(`/employees/${E}/salon-assignments`, {
      salonId: "s-nord",
      validFrom: "2026-11-02",
      validUntil: "2026-12-31",
      weekdays: [1, 5],
    });
    expect(apiGet.mock.calls.length).toBeGreaterThan(getsBefore);
    expect(document.querySelector('[data-testid="salon-assignment-form"]')).toBeNull();
  });

  it("omits validUntil and weekdays when they are left empty", async () => {
    await mountEditable();
    apiPost.mockResolvedValueOnce({ id: "new" });
    await fireEvent.click(byId("salon-assignment-add"));
    await settle();
    await pickSalon("s-sued");
    await typeDate("Gültig ab", "2026-11-02");
    await fireEvent.click(byId("salon-assignment-submit"));
    await settle();
    expect(apiPost).toHaveBeenCalledWith(`/employees/${E}/salon-assignments`, {
      salonId: "s-sued",
      validFrom: "2026-11-02",
    });
  });

  it("posts the Stammsalon change to /home with exactly salonId and validFrom", async () => {
    await mountEditable();
    apiPost.mockResolvedValueOnce({ id: "new" });
    await fireEvent.click(byId("salon-assignment-home"));
    await settle();
    expect(document.querySelector('[aria-label="Gültig bis"]')).toBeNull();
    await pickSalon("s-sued");
    await typeDate("Gültig ab", "2026-12-01");
    await fireEvent.click(byId("salon-assignment-submit"));
    await settle();
    expect(apiPost).toHaveBeenCalledWith(`/employees/${E}/salon-assignments/home`, {
      salonId: "s-sued",
      validFrom: "2026-12-01",
    });
  });

  it("ends an open Einsatzsalon through /:id/end; the Stammsalon row has no Beenden", async () => {
    await mountEditable();
    expect(document.querySelector('[data-testid="salon-assignment-end-a1"]')).toBeNull();
    expect(document.querySelector('[data-testid="salon-assignment-end-a3"]')).toBeNull();
    apiPost.mockResolvedValueOnce({ id: "a2" });
    await fireEvent.click(byId("salon-assignment-end-a2"));
    await settle();
    expect(byId<HTMLButtonElement>("salon-assignment-submit").disabled).toBe(true);
    await typeDate("Beendet zum", "2026-11-30");
    await fireEvent.click(byId("salon-assignment-submit"));
    await settle();
    expect(apiPost).toHaveBeenCalledWith(`/employees/${E}/salon-assignments/a2/end`, {
      validUntil: "2026-11-30",
    });
  });

  it("shows a 409 verbatim, keeps the form open with its values and removes no row", async () => {
    await mountEditable();
    const text =
      "Der Mitarbeiter ist an diesen Wochentagen bereits einem anderen Salon zugeordnet.";
    apiPost.mockRejectedValueOnce(new ApiError(409, text));
    await fireEvent.click(byId("salon-assignment-add"));
    await settle();
    await pickSalon("s-nord");
    await typeDate("Gültig ab", "2026-11-02");
    await fireEvent.click(byId("salon-assignment-submit"));
    await settle();
    expect(byId("salon-assignment-error").textContent?.trim()).toBe(text);
    expect(document.querySelector('[data-testid="salon-assignment-form"]')).not.toBeNull();
    expect(salonSelect().value).toBe("s-nord");
    expect(shownDay("Gültig ab")).toBe("2026-11-02");
    expect(rowTexts().length).toBe(4);
    expect(byId<HTMLButtonElement>("salon-assignment-submit").disabled).toBe(false);
  });

  it("shows a 400 verbatim as well", async () => {
    await mountEditable();
    const text = "Der Salon ist deaktiviert.";
    apiPost.mockRejectedValueOnce(new ApiError(400, text));
    await fireEvent.click(byId("salon-assignment-home"));
    await settle();
    await pickSalon("s-nord");
    await typeDate("Gültig ab", "2026-11-02");
    await fireEvent.click(byId("salon-assignment-submit"));
    await settle();
    expect(byId("salon-assignment-error").textContent?.trim()).toBe(text);
  });

  it("disables the submit button while the request runs", async () => {
    await mountEditable();
    let release: (v: unknown) => void = () => {};
    apiPost.mockReturnValueOnce(new Promise((r) => (release = r)));
    await fireEvent.click(byId("salon-assignment-home"));
    await settle();
    await pickSalon("s-nord");
    await typeDate("Gültig ab", "2026-11-02");
    await fireEvent.click(byId("salon-assignment-submit"));
    await settle();
    expect(byId<HTMLButtonElement>("salon-assignment-submit").disabled).toBe(true);
    expect(byId<HTMLButtonElement>("salon-assignment-add").disabled).toBe(true);
    release({});
    await settle();
  });

  it("offers no add button when the caller cannot list salons", async () => {
    answer({ salons: new ApiError(403, "Keine Berechtigung") });
    renderWithTheme(SalonAssignmentsSection, { employeeId: E, canEdit: true });
    await settle();
    expect(document.querySelector('[data-testid="salon-assignment-add"]')).toBeNull();
    expect(document.querySelector('[data-testid="salon-assignment-home"]')).toBeNull();
    // ending a row needs no salon list
    expect(document.querySelector('[data-testid="salon-assignment-end-a2"]')).not.toBeNull();
  });
});
