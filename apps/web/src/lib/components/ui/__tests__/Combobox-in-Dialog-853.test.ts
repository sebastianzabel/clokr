// Issue #853 (repairs a #843 block): bits-ui's Combobox opens its list on keydown only, so text that
// arrives without a key press (paste, IME composition, autofill, Playwright's fill) filtered a list
// nobody could see - the e2e leave-area-840 case 8 ("Für wen?") failure. The Combobox now opens on
// input too. The case runs inside an open Dialog, the form's real shape: the Dialog makes every other
// child of <body> inert (D-843-16) and the portaled list must stay out of that.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import DialogWithCombobox from "./fixtures/DialogWithCombobox.svelte";

afterEach(() => {
  cleanup();
  document.querySelectorAll("#app-root").forEach((e) => e.remove());
});

describe("Combobox inside a Dialog", () => {
  it("opens on input without a key press, outside the inert page, selectable by role", async () => {
    const app = document.createElement("div");
    app.id = "app-root";
    document.body.appendChild(app);
    const onValueChange = vi.fn();
    renderWithTheme(DialogWithCombobox, { onValueChange });
    await waitFor(() => expect(app.hasAttribute("inert")).toBe(true));

    const input = screen.getByRole("combobox");
    // A paste: an input event with no keydown before it.
    await fireEvent.input(input, { target: { value: "Zeile" } });
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(1));
    const option = screen.getByRole("option", { name: "Zeile, Formular" });
    expect(option.closest("[inert]"), "the option list is not inert").toBeNull();
    // Positive control: the page behind the dialog is.
    expect(app.closest("[inert]")).not.toBeNull();

    await fireEvent.pointerDown(option);
    await fireEvent.pointerUp(option);
    await fireEvent.click(option);
    await waitFor(() => expect(onValueChange).toHaveBeenCalledWith("a"));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
