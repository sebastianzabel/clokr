// Issue #89 - SalonTable mounted. The operator components live outside the lint:ui-classes scope,
// so styling is proven here by a control comparison rather than assumed (a class name that matches
// no rule still renders, so visibility alone answers nothing).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/svelte";

import { renderWithTheme } from "$tests/test-utils";
import type { OperatorSalon } from "$lib/operator/types";
import SalonTable from "../SalonTable.svelte";

const HOURS = Array.from({ length: 7 }, (_, day) => ({ day, open: "09:00", close: "18:00" }));

function salon(overrides: Partial<OperatorSalon> & { id: string }): OperatorSalon {
  return {
    name: "Salon Beispiel",
    street: null,
    postalCode: null,
    city: null,
    openingHours: HOURS,
    federalState: "NIEDERSACHSEN",
    isActive: true,
    deactivatedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    isDefault: false,
    coupling: null,
    ...overrides,
  };
}

const SALONS: OperatorSalon[] = [
  salon({
    id: "s-default",
    name: "Hauptsalon",
    street: "Beispielweg 1",
    postalCode: "12345",
    city: "Beispielstadt",
    isDefault: true,
  }),
  salon({
    id: "s-coupled",
    name: "Zweitsalon",
    city: "Nebenstadt",
    federalState: "BADEN_WUERTTEMBERG",
    coupling: { provider: "PHOREST", externalBranchId: "branch-42" },
  }),
  salon({ id: "s-off", name: "Altsalon", isActive: false }),
];

function appCss(): string {
  try {
    return readFileSync(fileURLToPath(new URL("../../../../app.css", import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");
  }
}

/** Typed lookup by test id; the testing-library queries return a union that breaks matcher typing. */
function byId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

beforeAll(() => {
  // vitest does not process global CSS; load the shared recipes so computed styles are real.
  const style = document.createElement("style");
  style.textContent = appCss();
  document.head.appendChild(style);
});

describe("SalonTable", () => {
  it("shows the default badge on the default row only", () => {
    renderWithTheme(SalonTable, { salons: SALONS }, "nacht");
    expect(byId("op-salon-default-badge-s-default")).toHaveTextContent("Standardsalon");
    expect(byId("op-salon-default-badge-s-coupled")).toBeNull();
    expect(byId("op-salon-default-badge-s-off")).toBeNull();
  });

  it("formats the address with missing parts omitted", () => {
    renderWithTheme(SalonTable, { salons: SALONS }, "nacht");
    expect(byId("op-salon-row-s-default")).toHaveTextContent("Beispielweg 1, 12345 Beispielstadt");
    expect(byId("op-salon-row-s-coupled")).toHaveTextContent("Nebenstadt");
    expect(byId("op-salon-row-s-coupled")).not.toHaveTextContent(", Nebenstadt");
  });

  it("shows the muted placeholder when no address part is known", () => {
    renderWithTheme(SalonTable, { salons: SALONS }, "nacht");
    expect(byId("op-salon-row-s-off")).toHaveTextContent("Keine Adresse hinterlegt");
  });

  it("renders the coupling cell in both forms", () => {
    renderWithTheme(SalonTable, { salons: SALONS }, "nacht");
    expect(byId("op-salon-coupling-s-default")).toHaveTextContent("Keine");
    expect(byId("op-salon-coupling-s-coupled")).toHaveTextContent("Phorest · branch-42");
  });

  it("marks the status with a data-state and a text label", () => {
    renderWithTheme(SalonTable, { salons: SALONS }, "nacht");
    expect(byId("op-salon-status-s-default")).toHaveAttribute("data-state", "active");
    expect(byId("op-salon-status-s-default")).toHaveTextContent("Aktiv");
    expect(byId("op-salon-status-s-off")).toHaveAttribute("data-state", "deactivated");
    expect(byId("op-salon-status-s-off")).toHaveTextContent("Deaktiviert");
  });

  it("renders the Bundesland label, not the enum value", () => {
    renderWithTheme(SalonTable, { salons: SALONS }, "nacht");
    expect(byId("op-salon-row-s-coupled")).toHaveTextContent("Baden-Württemberg");
  });

  it("shows the empty-state text for an empty list", () => {
    renderWithTheme(SalonTable, { salons: [] }, "nacht");
    expect(document.body).toHaveTextContent("Keine Salons gefunden.");
    expect(byId("op-salons-table")).toBeNull();
  });

  it("is styled: the table differs from a control element with an invented class", () => {
    renderWithTheme(SalonTable, { salons: SALONS }, "nacht");
    const table = byId("op-salons-table") as HTMLElement;
    const control = document.createElement("table");
    control.className = "no-such-class-89";
    document.body.appendChild(control);

    const styled = getComputedStyle(table);
    const plain = getComputedStyle(control);
    expect(styled.borderCollapse).toBe("collapse");
    expect(plain.borderCollapse).not.toBe("collapse");
    expect(styled.width).not.toBe(plain.width);
  });

  it("gives the badge a real style, not just a class", () => {
    renderWithTheme(SalonTable, { salons: SALONS }, "nacht");
    const badge = byId("op-salon-status-s-default") as HTMLElement;
    const control = document.createElement("span");
    control.className = "no-such-class-89";
    document.body.appendChild(control);
    expect(getComputedStyle(badge).display).toBe("inline-flex");
    expect(getComputedStyle(control).display).not.toBe("inline-flex");
  });
});

describe("SalonTable - edit action", () => {
  it("has no action column without onEdit", () => {
    renderWithTheme(SalonTable, { salons: SALONS }, "nacht");
    expect(byId("op-salon-edit-s-default")).toBeNull();
    expect(document.querySelectorAll("th")).toHaveLength(5);
  });

  it("renders one edit button per row with the salon name in its accessible name", () => {
    renderWithTheme(SalonTable, { salons: SALONS, onEdit: vi.fn() }, "nacht");
    for (const salonRow of SALONS) {
      const button = byId(`op-salon-edit-${salonRow.id}`);
      expect(button).toHaveTextContent("Bearbeiten");
      expect(button).toHaveAttribute("aria-label", `Salon ${salonRow.name} bearbeiten`);
    }
    expect(document.querySelectorAll("th")).toHaveLength(6);
  });

  it("calls onEdit with the salon of the clicked row, deactivated salons included", async () => {
    const onEdit = vi.fn();
    renderWithTheme(SalonTable, { salons: SALONS, onEdit }, "nacht");
    await fireEvent.click(byId("op-salon-edit-s-off") as HTMLElement);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0]?.[0]).toMatchObject({ id: "s-off", name: "Altsalon" });
  });

  it("styles the edit button as a button, not as plain text", () => {
    renderWithTheme(SalonTable, { salons: SALONS, onEdit: vi.fn() }, "nacht");
    const button = byId("op-salon-edit-s-default") as HTMLElement;
    const control = document.createElement("button");
    control.className = "no-such-class-89";
    document.body.appendChild(control);
    expect(getComputedStyle(button).display).toBe("inline-flex");
    expect(getComputedStyle(control).display).not.toBe("inline-flex");
    expect(getComputedStyle(button).cursor).toBe("pointer");
    expect(getComputedStyle(control).cursor).not.toBe("pointer");
  });

  describe("lifecycle actions", () => {
    const actions = (extra: Record<string, unknown> = {}) => ({
      salons: SALONS,
      onEdit: vi.fn(),
      onDeactivate: vi.fn(),
      onActivate: vi.fn(),
      ...extra,
    });

    it("active rows offer Deaktivieren, the inactive row offers Salon aktivieren, never both", () => {
      renderWithTheme(SalonTable, actions(), "nacht");
      for (const id of ["s-default", "s-coupled"]) {
        const deactivate = byId(`op-salon-deactivate-${id}`);
        expect(deactivate).toHaveTextContent("Deaktivieren");
        expect(byId(`op-salon-activate-${id}`)).toBeNull();
      }
      expect(byId("op-salon-deactivate-s-off")).toBeNull();
      expect(byId("op-salon-activate-s-off")).toHaveTextContent("Salon aktivieren");
      expect(byId("op-salon-deactivate-s-default")).toHaveAttribute(
        "aria-label",
        "Salon Hauptsalon deaktivieren",
      );
      expect(byId("op-salon-activate-s-off")).toHaveAttribute(
        "aria-label",
        "Salon Altsalon aktivieren",
      );
    });

    it("calls back with the clicked salon", async () => {
      const props = actions();
      renderWithTheme(SalonTable, props, "nacht");
      await fireEvent.click(byId("op-salon-deactivate-s-coupled") as HTMLElement);
      await fireEvent.click(byId("op-salon-activate-s-off") as HTMLElement);
      expect(props.onDeactivate).toHaveBeenCalledWith(expect.objectContaining({ id: "s-coupled" }));
      expect(props.onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: "s-off" }));
    });

    it("has no delete control, label or menu entry", () => {
      renderWithTheme(SalonTable, actions(), "nacht");
      expect(document.body.textContent).not.toMatch(/löschen|entfernen|delete/i);
      expect(
        document.querySelector('[aria-label*="löschen" i], [data-testid*="delete" i]'),
      ).toBeNull();
    });

    it("with exactly one active salon its Deaktivieren is aria-disabled, silent, and explained by a note", async () => {
      const props = actions({
        salons: [salon({ id: "only", name: "Einziger" }), salon({ id: "off", isActive: false })],
      });
      renderWithTheme(SalonTable, props, "nacht");
      const control = byId("op-salon-deactivate-only") as HTMLElement;
      expect(control).toHaveAttribute("aria-disabled", "true");
      await fireEvent.click(control);
      expect(props.onDeactivate).not.toHaveBeenCalled();
      const note = byId("op-salons-last-active-note");
      expect(note).toHaveTextContent("Der letzte aktive Salon lässt sich nicht deaktivieren.");
      expect(control.getAttribute("aria-describedby")).toBe(note?.id);
      // The inactive salon can still be activated.
      await fireEvent.click(byId("op-salon-activate-off") as HTMLElement);
      expect(props.onActivate).toHaveBeenCalledTimes(1);
    });

    it("with several active salons there is no note and the control is not aria-disabled", () => {
      renderWithTheme(SalonTable, actions(), "nacht");
      expect(byId("op-salons-last-active-note")).toBeNull();
      expect(byId("op-salon-deactivate-s-default")).not.toHaveAttribute("aria-disabled");
    });

    it("frozen disables every action and points at the hint", () => {
      const props = actions({ frozen: true, frozenHintId: "hint-id" });
      renderWithTheme(SalonTable, props, "nacht");
      for (const id of [
        "op-salon-edit-s-default",
        "op-salon-deactivate-s-default",
        "op-salon-activate-s-off",
      ]) {
        const control = byId(id) as HTMLButtonElement;
        expect(control.disabled).toBe(true);
        expect(control.getAttribute("aria-describedby")).toBe("hint-id");
        // HTMLElement.click() honours `disabled` like a real click; a dispatched event would not.
        control.click();
      }
      expect(props.onEdit).not.toHaveBeenCalled();
      expect(props.onDeactivate).not.toHaveBeenCalled();
      expect(props.onActivate).not.toHaveBeenCalled();
    });
  });
});
