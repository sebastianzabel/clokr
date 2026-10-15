// Issue #89 (AC-89-02/03/04, D-07a, D-10, D-13, D-14a) - the salon dialog, mounted.
//
// The dialog takes the API call as `onSubmit`, so it is driven without the operator client. Pinned
// here: nothing preselected for the Bundesland on create, the hours prefilled and always sent, a
// save that stays disabled until the form is valid (and, on edit, differs), the exact bodies
// (`{ name }`, `{ coupling: null }`), the absence of any tenant-settings hint (Issue #563), and
// every refusal attached to its field by CODE with the dialog still open.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

import { renderWithTheme } from "$tests/test-utils";
import { OperatorApiError } from "$lib/operator/client";
import { defaultOpeningHours } from "$lib/operator/opening-hours";
import type { OperatorSalon } from "$lib/operator/types";
import SalonDialog from "../SalonDialog.svelte";

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`);
}

function el<T extends HTMLElement = HTMLInputElement>(id: string): T {
  const found = byId<T>(id);
  if (!found) throw new Error(`missing test id ${id}`);
  return found;
}

async function typeInto(id: string, value: string) {
  const input = el<HTMLInputElement>(id);
  input.value = value;
  await fireEvent.input(input);
}

async function choose(id: string, value: string) {
  const select = el<HTMLSelectElement>(id);
  select.value = value;
  await fireEvent.change(select);
}

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
}

async function submit() {
  await fireEvent.click(el("op-salon-submit"));
  await settle();
}

function salon(overrides: Partial<OperatorSalon> = {}): OperatorSalon {
  return {
    id: "s1",
    name: "Salon Beispiel",
    street: "Beispielweg 1",
    postalCode: "12345",
    city: "Beispielstadt",
    openingHours: defaultOpeningHours(),
    federalState: "NIEDERSACHSEN",
    isActive: true,
    deactivatedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    isDefault: true,
    coupling: null,
    ...overrides,
  };
}

interface MountOptions {
  mode?: "create" | "edit";
  salon?: OperatorSalon | null;
  defaultSalon?: OperatorSalon | null;
  onSubmit?: ReturnType<typeof vi.fn>;
}

function mount(options: MountOptions = {}) {
  const onSubmit = options.onSubmit ?? vi.fn().mockResolvedValue(undefined);
  renderWithTheme(
    SalonDialog,
    {
      open: true,
      mode: options.mode ?? "create",
      salon: options.salon ?? null,
      defaultSalon: options.defaultSalon ?? null,
      onSubmit,
    },
    "nacht",
  );
  return { onSubmit };
}

function lastBody(onSubmit: ReturnType<typeof vi.fn>): unknown {
  return onSubmit.mock.calls.at(-1)?.[0];
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SalonDialog - create", () => {
  it("opens with the eyebrow, the title and every field", () => {
    mount();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toHaveTextContent("Salon");
    expect(dialog?.querySelector("h3")).toHaveTextContent("Salon anlegen");
    for (const id of [
      "op-salon-name",
      "op-salon-street",
      "op-salon-postal-code",
      "op-salon-city",
      "op-salon-federal-state",
      "op-salon-coupling-provider",
    ]) {
      expect(byId(id), id).not.toBeNull();
    }
    expect(document.body).toHaveTextContent("Öffnungszeiten");
    expect(el("op-salon-submit")).toHaveTextContent("Salon anlegen");
  });

  it("preselects no Bundesland and keeps the submit disabled until it is chosen", async () => {
    mount();
    const select = el<HTMLSelectElement>("op-salon-federal-state");
    expect(select.value).toBe("");
    expect(select.selectedOptions[0]).toHaveTextContent("Bundesland wählen");
    await typeInto("op-salon-name", "Salon Neu");
    expect(el("op-salon-submit")).toBeDisabled();
    await choose("op-salon-federal-state", "BAYERN");
    expect(el("op-salon-submit")).not.toBeDisabled();
  });

  it("gives the PLZ field its numeric attributes", () => {
    mount();
    const plz = el<HTMLInputElement>("op-salon-postal-code");
    expect(plz).toHaveAttribute("inputmode", "numeric");
    expect(plz).toHaveAttribute("maxlength", "5");
    expect(plz).toHaveAttribute("autocomplete", "postal-code");
  });

  it("prefills the hours from the Standardsalon", () => {
    const standard = salon({
      openingHours: defaultOpeningHours().map((d) => ({ ...d, open: "10:00", close: "16:00" })),
    });
    mount({ defaultSalon: standard });
    expect(el<HTMLInputElement>("op-salon-hours-0-from").value).toBe("10:00");
    expect(el<HTMLInputElement>("op-salon-hours-0-to").value).toBe("16:00");
  });

  it("sends the explicit body: seven days, the Bundesland, no coupling key for Keine", async () => {
    const { onSubmit } = mount();
    await typeInto("op-salon-name", " Salon Neu ");
    await typeInto("op-salon-street", "Weg 2");
    await typeInto("op-salon-postal-code", "01067");
    await typeInto("op-salon-city", "Stadt");
    await choose("op-salon-federal-state", "SACHSEN");
    await submit();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(lastBody(onSubmit)).toEqual({
      name: "Salon Neu",
      street: "Weg 2",
      postalCode: "01067",
      city: "Stadt",
      openingHours: defaultOpeningHours(),
      federalState: "SACHSEN",
    });
  });

  it("sends a Phorest coupling with the Filialkennung", async () => {
    const { onSubmit } = mount();
    await typeInto("op-salon-name", "Salon Neu");
    await choose("op-salon-federal-state", "SACHSEN");
    await choose("op-salon-coupling-provider", "PHOREST");
    expect(el("op-salon-submit")).toBeDisabled();
    await typeInto("op-salon-coupling-branch", " b-1 ");
    await submit();
    expect((lastBody(onSubmit) as { coupling?: unknown }).coupling).toEqual({
      externalBranchId: "b-1",
    });
  });

  it("keeps the submit disabled for a bad PLZ and for open >= close", async () => {
    mount();
    await typeInto("op-salon-name", "Salon Neu");
    await choose("op-salon-federal-state", "SACHSEN");
    await typeInto("op-salon-postal-code", "123");
    expect(el("op-salon-submit")).toBeDisabled();
    await fireEvent.blur(el("op-salon-postal-code"));
    expect(el("op-salon-field-error-postal-code")).toHaveTextContent("PLZ: 5 Ziffern.");
    await typeInto("op-salon-postal-code", "");
    expect(el("op-salon-submit")).not.toBeDisabled();

    await typeInto("op-salon-hours-1-to", "07:00");
    expect(el("op-salon-submit")).toBeDisabled();
    expect(el("op-salon-hours-1-error")).toHaveTextContent(
      "Die Öffnungszeit muss vor der Schließzeit liegen.",
    );
  });

  it("the dialog never claims that tenant settings overwrite the salon's hours (Issue #563)", () => {
    // The tenant-settings mirror is retired; with exactly one active salon the dialog
    // used to promise it. Assert the absence in both modes.
    mount({ mode: "create", defaultSalon: salon() });
    expect(byId("op-salon-single-salon-hint")).toBeNull();
    expect(document.body.textContent).not.toContain("Mandanten-Einstellungen");
    document.body.innerHTML = "";
    mount({ mode: "edit", salon: salon() });
    expect(byId("op-salon-single-salon-hint")).toBeNull();
    expect(document.body.textContent).not.toContain("Mandanten-Einstellungen");
  });

  it("shows the pending label and disables the buttons while the call runs", async () => {
    let finish: () => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    mount({ onSubmit });
    await typeInto("op-salon-name", "Salon Neu");
    await choose("op-salon-federal-state", "SACHSEN");
    await fireEvent.click(el("op-salon-submit"));
    await tick();
    expect(el("op-salon-submit")).toHaveTextContent("Wird angelegt …");
    expect(el("op-salon-submit")).toBeDisabled();
    expect(el("op-salon-cancel")).toBeDisabled();
    finish();
    await settle();
  });

  it("closes after a successful save", async () => {
    mount();
    await typeInto("op-salon-name", "Salon Neu");
    await choose("op-salon-federal-state", "SACHSEN");
    await submit();
    expect(byId("op-salon-dialog")).toBeNull();
  });
});

describe("SalonDialog - edit", () => {
  it("opens filled with the salon and a disabled save", () => {
    mount({ mode: "edit", salon: salon() });
    expect(document.querySelector("h3")).toHaveTextContent("Salon bearbeiten");
    expect(el<HTMLInputElement>("op-salon-name").value).toBe("Salon Beispiel");
    expect(el<HTMLInputElement>("op-salon-street").value).toBe("Beispielweg 1");
    expect(el<HTMLInputElement>("op-salon-postal-code").value).toBe("12345");
    expect(el<HTMLInputElement>("op-salon-city").value).toBe("Beispielstadt");
    expect(el<HTMLSelectElement>("op-salon-federal-state").value).toBe("NIEDERSACHSEN");
    expect(el("op-salon-submit")).toHaveTextContent("Salon speichern");
    expect(el("op-salon-submit")).toBeDisabled();
  });

  it("enables the save on a change and disables it again when the change is undone", async () => {
    mount({ mode: "edit", salon: salon() });
    await typeInto("op-salon-name", "Anders");
    expect(el("op-salon-submit")).not.toBeDisabled();
    await typeInto("op-salon-name", "Salon Beispiel");
    expect(el("op-salon-submit")).toBeDisabled();
  });

  it("does not save on blur", async () => {
    const { onSubmit } = mount({ mode: "edit", salon: salon() });
    await typeInto("op-salon-name", "Anders");
    await fireEvent.blur(el("op-salon-name"));
    await settle();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("sends exactly { name } for a name-only change", async () => {
    const { onSubmit } = mount({ mode: "edit", salon: salon() });
    await typeInto("op-salon-name", "Anders");
    await submit();
    expect(lastBody(onSubmit)).toEqual({ name: "Anders" });
  });

  it("sends exactly { coupling: null } when an existing coupling is removed", async () => {
    const coupled = salon({ coupling: { provider: "PHOREST", externalBranchId: "branch-1" } });
    const { onSubmit } = mount({ mode: "edit", salon: coupled });
    expect(el<HTMLSelectElement>("op-salon-coupling-provider").value).toBe("PHOREST");
    expect(el<HTMLInputElement>("op-salon-coupling-branch").value).toBe("branch-1");
    expect(byId("op-salon-coupling-remove-hint")).toBeNull();
    await choose("op-salon-coupling-provider", "NONE");
    expect(el("op-salon-coupling-remove-hint")).not.toBeNull();
    await submit();
    expect(lastBody(onSubmit)).toEqual({ coupling: null });
  });

  it("sends the new branch when the coupling is replaced, and nothing else", async () => {
    const coupled = salon({ coupling: { provider: "PHOREST", externalBranchId: "branch-1" } });
    const { onSubmit } = mount({ mode: "edit", salon: coupled });
    await typeInto("op-salon-coupling-branch", "branch-2");
    await submit();
    expect(lastBody(onSubmit)).toEqual({ coupling: { externalBranchId: "branch-2" } });
  });

  it("omits the coupling key when it did not change", async () => {
    const coupled = salon({ coupling: { provider: "PHOREST", externalBranchId: "branch-1" } });
    const { onSubmit } = mount({ mode: "edit", salon: coupled });
    await typeInto("op-salon-city", "Anderswo");
    await submit();
    expect(lastBody(onSubmit)).toEqual({ city: "Anderswo" });
  });

  it("disables the coupling select of a deactivated salon", () => {
    mount({ mode: "edit", salon: salon({ isActive: false }) });
    expect(el("op-salon-coupling-provider")).toBeDisabled();
  });

  it("starts from the new salon each time it is opened", () => {
    mount({ mode: "edit", salon: salon({ name: "Erster" }) });
    expect(el<HTMLInputElement>("op-salon-name").value).toBe("Erster");
  });
});

describe("SalonDialog - refusals", () => {
  async function failWith(code: string | undefined, status: number, message = "Fehler") {
    const onSubmit = vi.fn().mockRejectedValue(new OperatorApiError(status, code, message));
    mount({ mode: "edit", salon: salon(), onSubmit });
    await choose("op-salon-federal-state", "BAYERN");
    await submit();
    return onSubmit;
  }

  it("FEDERAL_STATE_IN_USE: callout on top, Bundesland invalid and pointing at it, dialog open", async () => {
    await failWith("FEDERAL_STATE_IN_USE", 409);
    const reason = el("op-salon-reason");
    expect(reason).toHaveAttribute("data-code", "FEDERAL_STATE_IN_USE");
    expect(reason).toHaveTextContent(
      "Das Bundesland ist durch Zeiteinträge oder Zuordnungen festgelegt. Ein Umzug ist ein neuer Salon.",
    );
    const select = el("op-salon-federal-state");
    expect(select).toHaveAttribute("aria-invalid", "true");
    const calloutId = reason.querySelector("[id]")?.id ?? "";
    expect(calloutId).not.toBe("");
    expect(select.getAttribute("aria-describedby")?.split(" ")).toContain(calloutId);
    expect(byId("op-salon-error")).toBeNull();
    expect(byId("op-salon-dialog")).not.toBeNull();
  });

  it("the reason carries no number", async () => {
    await failWith("FEDERAL_STATE_IN_USE", 409);
    expect(el("op-salon-reason").textContent).not.toMatch(/\d/);
  });

  it("BRANCH_ALREADY_COUPLED attaches to the Filialkennung", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(new OperatorApiError(409, "BRANCH_ALREADY_COUPLED", "x"));
    mount({ mode: "create", onSubmit });
    await typeInto("op-salon-name", "Salon Neu");
    await choose("op-salon-federal-state", "SACHSEN");
    await choose("op-salon-coupling-provider", "PHOREST");
    await typeInto("op-salon-coupling-branch", "b-1");
    await submit();
    const message = el("op-salon-coupling-branch-error");
    expect(message).toHaveAttribute("data-code", "BRANCH_ALREADY_COUPLED");
    expect(message).toHaveTextContent("Diese Filialkennung ist bereits einem anderen Salon");
    expect(el("op-salon-coupling-branch")).toHaveAttribute("aria-invalid", "true");
    expect(byId("op-salon-reason")).toBeNull();
    expect(byId("op-salon-error")).toBeNull();
    expect(byId("op-salon-dialog")).not.toBeNull();
  });

  it("SALON_INACTIVE attaches to the coupling select", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new OperatorApiError(422, "SALON_INACTIVE", "x"));
    mount({ mode: "edit", salon: salon(), onSubmit });
    await choose("op-salon-coupling-provider", "PHOREST");
    await typeInto("op-salon-coupling-branch", "b-1");
    await submit();
    expect(el("op-salon-coupling-provider-error")).toHaveAttribute("data-code", "SALON_INACTIVE");
    expect(el("op-salon-coupling-provider")).toHaveAttribute("aria-invalid", "true");
    expect(byId("op-salon-error")).toBeNull();
  });

  it("any other code is a dialog alert with the count-free sentence", async () => {
    await failWith("SALON_ALREADY_COUPLED", 409);
    const alert = el("op-salon-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("Der Salon ist bereits gekoppelt.");
    expect(byId("op-salon-reason")).toBeNull();
    expect(byId("op-salon-dialog")).not.toBeNull();
  });

  it("a code-less 404 reads as a missing salon, not a missing tenant", async () => {
    await failWith(undefined, 404, "Salon nicht gefunden");
    expect(el("op-salon-error")).toHaveTextContent("Salon nicht gefunden.");
    expect(el("op-salon-error")).not.toHaveTextContent("Mandant");
  });

  it("a network failure is a dialog alert", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    mount({ mode: "edit", salon: salon(), onSubmit });
    await typeInto("op-salon-name", "Anders");
    await submit();
    expect(el("op-salon-error")).toHaveTextContent("Keine Verbindung zum Server");
  });

  it("lets the operator retry after a refusal and clears the reason on the next attempt", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new OperatorApiError(409, "FEDERAL_STATE_IN_USE", "x"))
      .mockResolvedValueOnce(undefined);
    mount({ mode: "edit", salon: salon(), onSubmit });
    await choose("op-salon-federal-state", "BAYERN");
    await submit();
    expect(byId("op-salon-reason")).not.toBeNull();
    await choose("op-salon-federal-state", "NIEDERSACHSEN");
    expect(byId("op-salon-reason")).toBeNull();
    await typeInto("op-salon-name", "Anders");
    await submit();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(byId("op-salon-dialog")).toBeNull();
  });
});
