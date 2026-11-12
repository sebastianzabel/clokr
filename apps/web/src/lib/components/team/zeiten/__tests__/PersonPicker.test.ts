// Issue #853 (D-853-10) - PersonPicker: the FormField label names the combobox, the items are the
// options, a name or a Personalnummer finds a person and Enter picks it (S-32).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { personOptions } from "$lib/team/person-options";
import PersonPicker from "../PersonPicker.svelte";
import source from "../PersonPicker.svelte?raw";

afterEach(() => cleanup());

const items = personOptions([
  { id: "p1", firstName: "Anna", lastName: "Meier", employeeNumber: "101" },
  { id: "p2", firstName: "Berta", lastName: "Schulz", employeeNumber: "202" },
  { id: "p3", firstName: "Cem", lastName: "Öztürk", employeeNumber: "303" },
]);

function input(): HTMLInputElement {
  return screen.getByRole("combobox") as HTMLInputElement;
}

describe("PersonPicker", () => {
  it("names the combobox through the FormField label (default „Person“)", () => {
    renderWithTheme(PersonPicker, { items });
    expect(screen.getByLabelText("Person")).toBe(input());
    expect(input().getAttribute("placeholder")).toBe("Name oder Personalnummer");
  });

  it("takes another label", () => {
    renderWithTheme(PersonPicker, { items, label: "Mitarbeiter" });
    expect(screen.getByLabelText("Mitarbeiter")).toBe(input());
  });

  it("lists every item as an option once the list is opened with the keyboard", async () => {
    renderWithTheme(PersonPicker, { items });
    await fireEvent.keyDown(input(), { key: "ArrowDown" });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    expect(screen.getByRole("option", { name: "Meier, Anna · Nr. 101" })).toBeTruthy();
  });

  it("finds a person by the Personalnummer and picks it with Enter", async () => {
    const onValueChange = vi.fn();
    renderWithTheme(PersonPicker, { items, onValueChange });
    await fireEvent.keyDown(input(), { key: "ArrowDown" });
    await fireEvent.input(input(), { target: { value: "202" } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    await fireEvent.keyDown(input(), { key: "ArrowDown" });
    await fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(onValueChange).toHaveBeenCalledWith("p2"));
    await waitFor(() => expect(input().value).toBe("Schulz, Berta · Nr. 202"));
  });

  it("shows the label of the value it was given", () => {
    renderWithTheme(PersonPicker, { items, value: "p3" });
    expect(input().value).toBe("Öztürk, Cem · Nr. 303");
  });

  it("is template only: no $app, store or request import", () => {
    expect(source).not.toMatch(/\$app\//);
    expect(source).not.toMatch(/\$stores\//);
    expect(source).not.toMatch(/\bapi\./);
    expect(source).not.toContain("{@html");
  });
});
