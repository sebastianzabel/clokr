// Issue #86 (AC-86-5) - the "Salons" section of the employee detail page, mounted. The directory
// `lib/components/employees/` is outside lint:ui-classes, so this test is its gate. Only the server
// answers (`$api/client`) are mocked.
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
    expect(document.querySelector(".callout.error")).toBeNull();
  });

  it("shows one German error callout when the assignments cannot be read", async () => {
    answer({ assignments: new ApiError(500, "Interner Serverfehler") });
    renderWithTheme(SalonAssignmentsSection, { employeeId: E, canEdit: false });
    await settle();
    const callouts = document.querySelectorAll(".callout.error");
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

async function pickSalon(id: string) {
  const select = document.querySelector<HTMLSelectElement>("#sa-salon");
  if (!select) throw new Error("salon select missing");
  select.value = id;
  await fireEvent.change(select);
}

async function typeDate(inputId: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`#${inputId}`);
  if (!input) throw new Error(`input ${inputId} missing`);
  input.value = value;
  await fireEvent.input(input);
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
    const options = [...document.querySelectorAll<HTMLOptionElement>("#sa-salon option")].map((o) =>
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
    await typeDate("sa-from", "2026-11-02");
    await typeDate("sa-until", "2026-12-31");
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
    await typeDate("sa-from", "2026-11-02");
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
    expect(document.querySelector("#sa-until")).toBeNull();
    await pickSalon("s-sued");
    await typeDate("sa-from", "2026-12-01");
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
    await typeDate("sa-end", "2026-11-30");
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
    await typeDate("sa-from", "2026-11-02");
    await fireEvent.click(byId("salon-assignment-submit"));
    await settle();
    expect(byId("salon-assignment-error").textContent?.trim()).toBe(text);
    expect(document.querySelector('[data-testid="salon-assignment-form"]')).not.toBeNull();
    expect(document.querySelector<HTMLSelectElement>("#sa-salon")?.value).toBe("s-nord");
    expect(document.querySelector<HTMLInputElement>("#sa-from")?.value).toBe("2026-11-02");
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
    await typeDate("sa-from", "2026-11-02");
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
    await typeDate("sa-from", "2026-11-02");
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
