// Issue #89 (AC-89-04, D-11, D-12b) - the coupling fields, mounted. Pinned: exactly the options
// Keine and Phorest, the Filialkennung only for Phorest, the removal hint before an existing
// coupling is dropped, a deactivated salon cannot be coupled, and the static credentials hint.
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

import { renderWithTheme } from "$tests/test-utils";
import type { CouplingProvider } from "$lib/operator/types";
import CouplingFields from "../CouplingFields.svelte";

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`);
}

function must<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = byId<T>(id);
  if (!found) throw new Error(`missing test id ${id}`);
  return found;
}

interface MountProps {
  provider?: CouplingProvider;
  externalBranchId?: string;
  initialProvider?: CouplingProvider;
  salonActive?: boolean;
  fieldError?: { code: string; serverError?: string } | null;
  showRequired?: boolean;
}

function mount(props: MountProps = {}) {
  renderWithTheme(
    CouplingFields,
    { provider: "NONE", externalBranchId: "", ...props } as never,
    "nacht",
  );
}

async function choose(value: CouplingProvider) {
  const select = must<HTMLSelectElement>("op-salon-coupling-provider");
  select.value = value;
  await fireEvent.change(select);
  await tick();
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("CouplingFields", () => {
  it("offers exactly Keine and Phorest", () => {
    mount();
    const options = Array.from(
      must<HTMLSelectElement>("op-salon-coupling-provider").querySelectorAll("option"),
    ).map((option) => option.textContent?.trim());
    expect(options).toEqual(["Keine", "Phorest"]);
    expect(document.querySelector("legend")).toHaveTextContent("Externe Kopplung");
    expect(document.querySelector("label[for='op-salon-coupling-provider']")).toHaveTextContent(
      "System",
    );
  });

  it("shows no Filialkennung and no Phorest hint while the choice is Keine", () => {
    mount();
    expect(byId("op-salon-coupling-branch")).toBeNull();
    expect(byId("op-salon-coupling-phorest-hint")).toBeNull();
    expect(byId("op-salon-coupling-remove-hint")).toBeNull();
  });

  it("shows the Filialkennung field and the static credentials hint for Phorest", async () => {
    mount();
    await choose("PHOREST");
    const branch = must<HTMLInputElement>("op-salon-coupling-branch");
    expect(document.querySelector("label[for='op-salon-coupling-branch']")).toHaveTextContent(
      "Filialkennung *",
    );
    expect(branch).toHaveAttribute("autocomplete", "off");
    expect(branch).toHaveAttribute("spellcheck", "false");
    expect(branch).toHaveClass("mono");
    expect(must("op-salon-coupling-phorest-hint")).toHaveTextContent(
      "Die Zugangsdaten zu Phorest pflegt der Mandant selbst. Ohne sie findet kein Abgleich statt.",
    );
  });

  it("asks for a Filialkennung only after blur or an attempted submit", async () => {
    mount({ provider: "PHOREST" });
    expect(byId("op-salon-coupling-branch-error")).toBeNull();
    await fireEvent.blur(must("op-salon-coupling-branch"));
    await tick();
    expect(must("op-salon-coupling-branch-error")).toHaveTextContent("Filialkennung angeben.");
    expect(must("op-salon-coupling-branch")).toHaveAttribute("aria-invalid", "true");
  });

  it("asks for a Filialkennung when the parent reports an attempted submit", () => {
    mount({ provider: "PHOREST", showRequired: true });
    expect(must("op-salon-coupling-branch-error")).toHaveAttribute("data-code", "BRANCH_REQUIRED");
  });

  it("treats a blank Filialkennung as missing", () => {
    mount({ provider: "PHOREST", externalBranchId: "   ", showRequired: true });
    expect(byId("op-salon-coupling-branch-error")).not.toBeNull();
  });

  it("shows no missing-Filialkennung problem once one is typed", () => {
    mount({ provider: "PHOREST", externalBranchId: "branch-1", showRequired: true });
    expect(byId("op-salon-coupling-branch-error")).toBeNull();
  });

  it("shows the removal hint when an existing coupling is switched to Keine", async () => {
    mount({ provider: "PHOREST", externalBranchId: "branch-1", initialProvider: "PHOREST" });
    expect(byId("op-salon-coupling-remove-hint")).toBeNull();
    await choose("NONE");
    const hint = must("op-salon-coupling-remove-hint");
    expect(hint).toHaveClass("callout", "brand");
    expect(hint).toHaveTextContent(
      "Beim Speichern des Salons wird die Kopplung entfernt. Der Abgleich mit Phorest endet für diesen Salon.",
    );
    await choose("PHOREST");
    expect(byId("op-salon-coupling-remove-hint")).toBeNull();
  });

  it("shows no removal hint for a salon that was never coupled", async () => {
    mount({ provider: "PHOREST", externalBranchId: "x", initialProvider: "NONE" });
    await choose("NONE");
    expect(byId("op-salon-coupling-remove-hint")).toBeNull();
  });

  it("disables the select of a deactivated salon and says why", () => {
    mount({ salonActive: false });
    expect(must("op-salon-coupling-provider")).toBeDisabled();
    expect(must("op-salon-coupling-inactive-hint")).toHaveTextContent(
      "Deaktivierte Salons können nicht gekoppelt werden.",
    );
  });

  it("leaves the select enabled for an active salon", () => {
    mount();
    expect(must("op-salon-coupling-provider")).not.toBeDisabled();
    expect(byId("op-salon-coupling-inactive-hint")).toBeNull();
  });

  it("puts BRANCH_ALREADY_COUPLED under the Filialkennung, by code", () => {
    mount({
      provider: "PHOREST",
      externalBranchId: "branch-1",
      fieldError: { code: "BRANCH_ALREADY_COUPLED", serverError: "Branch exists" },
    });
    const error = must("op-salon-coupling-branch-error");
    expect(error).toHaveAttribute("data-code", "BRANCH_ALREADY_COUPLED");
    expect(error).toHaveTextContent(
      "Diese Filialkennung ist bereits einem anderen Salon zugeordnet.",
    );
    expect(error).not.toHaveTextContent("Branch exists");
    expect(must("op-salon-coupling-branch")).toHaveAttribute("aria-invalid", "true");
    expect(must("op-salon-coupling-branch").getAttribute("aria-describedby")).toContain(error.id);
  });

  it("puts SALON_INACTIVE under the select and does not repeat it as a hint", () => {
    mount({ salonActive: false, fieldError: { code: "SALON_INACTIVE" } });
    const error = must("op-salon-coupling-provider-error");
    expect(error).toHaveAttribute("data-code", "SALON_INACTIVE");
    expect(error).toHaveTextContent("Deaktivierte Salons können nicht gekoppelt werden.");
    expect(byId("op-salon-coupling-inactive-hint")).toBeNull();
  });

  it("ignores a code that belongs to no field", () => {
    mount({
      provider: "PHOREST",
      externalBranchId: "b",
      fieldError: { code: "SALON_ALREADY_COUPLED" },
    });
    expect(byId("op-salon-coupling-branch-error")).toBeNull();
    expect(byId("op-salon-coupling-provider-error")).toBeNull();
  });

  it("never mentions a second provider", () => {
    mount({ provider: "PHOREST", externalBranchId: "b", initialProvider: "PHOREST" });
    expect(document.body.textContent?.toLowerCase()).not.toContain("studio");
  });
});
