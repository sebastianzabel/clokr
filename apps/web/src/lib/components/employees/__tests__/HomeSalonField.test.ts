// Issue #86 (AC-86-1) - the Stammsalon field of the create form, mounted: required in a tenant with
// several active salons, absent with one (the server resolves it) and absent when the salon list is
// not available to the caller.
import { describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

import { renderWithTheme } from "$tests/test-utils";
import HomeSalonField from "../HomeSalonField.svelte";

const NORD = { id: "s-nord", name: "Salon Nord", isActive: true };
const OST = { id: "s-ost", name: "Ost", isActive: true };
const ALT = { id: "s-alt", name: "Alt", isActive: false };

function field(): HTMLElement | null {
  return document.querySelector('[data-testid="home-salon-field"]');
}

describe("HomeSalonField (Issue #86, AC-86-1)", () => {
  it("is required, lists active salons sorted by name and starts on 'Bitte wählen' with several active salons", () => {
    renderWithTheme(HomeSalonField, { salons: [NORD, OST, ALT] });
    const select = document.querySelector<HTMLSelectElement>("#c-home-salon");
    expect(select).not.toBeNull();
    expect(select?.required).toBe(true);
    expect(select?.value).toBe("");
    expect([...(select?.options ?? [])].map((o) => o.textContent?.trim())).toEqual([
      "Bitte wählen",
      "Ost",
      "Salon Nord",
    ]);
    expect(document.querySelector('label[for="c-home-salon"]')?.textContent).toBe("Stammsalon");
  });

  it("reports the chosen salon through the bindable value", async () => {
    let chosen = "";
    renderWithTheme(HomeSalonField, {
      salons: [NORD, OST],
      get value() {
        return chosen;
      },
      set value(v: string) {
        chosen = v;
      },
    });
    const select = document.querySelector<HTMLSelectElement>("#c-home-salon");
    if (!select) throw new Error("select missing");
    select.value = "s-ost";
    await fireEvent.change(select);
    await tick();
    expect(chosen).toBe("s-ost");
  });

  it("is not rendered with exactly one active salon (the server resolves it)", () => {
    renderWithTheme(HomeSalonField, { salons: [NORD, ALT] });
    expect(field()).toBeNull();
  });

  it("is not rendered with no salon list (caller without salon:read)", () => {
    renderWithTheme(HomeSalonField, { salons: null });
    expect(field()).toBeNull();
  });
});
