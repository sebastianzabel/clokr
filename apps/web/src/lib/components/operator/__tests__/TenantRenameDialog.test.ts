// Issue #89 (D-13, D-14) - the rename dialog, mounted. It takes onRename as a prop, so it is
// driven without the operator client. Pinned: nothing can be saved until the trimmed name differs,
// the trimmed name is what is sent, a failure is worded from the error's code and keeps the dialog
// open, and a success closes it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

import { renderWithTheme } from "$tests/test-utils";
import { OperatorApiError } from "$lib/operator/client";
import TenantRenameDialog from "../TenantRenameDialog.svelte";

function el<T extends HTMLElement = HTMLInputElement>(id: string): T {
  const found = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`missing test id ${id}`);
  return found;
}

async function typeName(value: string) {
  const input = el<HTMLInputElement>("op-tenant-rename-input");
  input.value = value;
  await fireEvent.input(input);
}

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
}

function mount(onRename = vi.fn().mockResolvedValue(undefined)) {
  renderWithTheme(
    TenantRenameDialog,
    { open: true, currentName: "Beispiel GmbH", onRename },
    "nacht",
  );
  return { onRename };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("TenantRenameDialog", () => {
  it("opens with the eyebrow, the title, the label, the hint and the current name", () => {
    mount();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toHaveTextContent("Mandant");
    expect(dialog?.querySelector("h3")).toHaveTextContent("Mandant umbenennen");
    expect(dialog).toHaveTextContent("Neuer Name *");
    expect(dialog).toHaveTextContent("Der Kurzname bleibt unverändert.");
    expect(el<HTMLInputElement>("op-tenant-rename-input").value).toBe("Beispiel GmbH");
    expect(el("op-tenant-rename-dialog")).toBeInTheDocument();
  });

  it("keeps the submit disabled while the name is unchanged, empty or only differs by spaces", async () => {
    mount();
    const submit = el<HTMLButtonElement>("op-tenant-rename-submit");
    expect(submit).toBeDisabled();
    await typeName("   Beispiel GmbH  ");
    expect(submit).toBeDisabled();
    await typeName("   ");
    expect(submit).toBeDisabled();
    await typeName("");
    expect(submit).toBeDisabled();
    await typeName("Neuer Name");
    expect(submit).toBeEnabled();
  });

  it("sends the trimmed name and closes on success", async () => {
    const { onRename } = mount();
    await typeName("  Neuer Name  ");
    await fireEvent.click(el("op-tenant-rename-submit"));
    await settle();

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("Neuer Name");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("does not call onRename for an unchanged name even when the form is submitted", async () => {
    const { onRename } = mount();
    const form = document.querySelector("form") as HTMLFormElement;
    await fireEvent.submit(form);
    await settle();
    expect(onRename).not.toHaveBeenCalled();
  });

  it("shows the reason chosen by the error's code and stays open", async () => {
    const onRename = vi
      .fn()
      .mockRejectedValue(new OperatorApiError(409, "TENANT_DEACTIVATED", "irgendein Text"));
    mount(onRename);
    await typeName("Neuer Name");
    await fireEvent.click(el("op-tenant-rename-submit"));
    await settle();

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(el("op-tenant-rename-error")).toHaveTextContent(
      "Der Mandant ist deaktiviert. Änderungen sind erst nach der Reaktivierung möglich.",
    );
    expect(el("op-tenant-rename-error")).not.toHaveTextContent("irgendein Text");
    expect(el("op-tenant-rename-submit")).toBeEnabled();
  });

  it("names a lost connection", async () => {
    mount(vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await typeName("Neuer Name");
    await fireEvent.click(el("op-tenant-rename-submit"));
    await settle();
    expect(el("op-tenant-rename-error")).toHaveTextContent(
      "Keine Verbindung zum Server. Bitte erneut versuchen.",
    );
  });

  it("disables the submit and shows the pending label while the request runs", async () => {
    let resolve!: () => void;
    const onRename = vi.fn().mockReturnValue(
      new Promise<void>((r) => {
        resolve = r;
      }),
    );
    mount(onRename);
    await typeName("Neuer Name");
    await fireEvent.click(el("op-tenant-rename-submit"));
    await settle();

    expect(el("op-tenant-rename-submit")).toBeDisabled();
    expect(el("op-tenant-rename-submit")).toHaveTextContent("Wird gespeichert");
    resolve();
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
