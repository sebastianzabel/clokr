// Issue #86 (AC-86-5) - the "Salons" section of the employee detail page, mounted. The directory
// `lib/components/employees/` is outside lint:ui-classes, so this test is its gate. Only the server
// answers (`$api/client`) are mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";

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
