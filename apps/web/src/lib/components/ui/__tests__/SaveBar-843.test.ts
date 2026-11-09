// Issue #843 (D-843-01 block 7) - SaveBar is the §3.2.1 section-button rule as code: hidden
// without changes, German summary, save disabled while errors > 0 or saving.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import SaveBar from "../SaveBar.svelte";
import { canSave, changesPhrase, errorsPhrase, saveBarSummary } from "../save-bar";
import barSource from "../SaveBar.svelte?raw";

afterEach(() => cleanup());

describe("save-bar helpers", () => {
  it.each([
    [1, "1 Änderung"],
    [2, "2 Änderungen"],
    [10, "10 Änderungen"],
  ])("changesPhrase(%i)", (n, text) => expect(changesPhrase(n)).toBe(text));

  it.each([
    [1, "1 Fehler"],
    [3, "3 Fehler"],
  ])("errorsPhrase(%i)", (n, text) => expect(errorsPhrase(n)).toBe(text));

  it("summary joins the parts with a middle dot and omits a zero error part", () => {
    expect(saveBarSummary(1, 0)).toBe("Nicht gespeichert · 1 Änderung");
    expect(saveBarSummary(2, 1)).toBe("Nicht gespeichert · 2 Änderungen · 1 Fehler");
    expect(saveBarSummary(5, 3)).toBe("Nicht gespeichert · 5 Änderungen · 3 Fehler");
  });

  it("canSave only with changes, no errors and no running save", () => {
    expect(canSave({ changes: 1, errors: 0 })).toBe(true);
    expect(canSave({ changes: 1, errors: 0, saving: false })).toBe(true);
    expect(canSave({ changes: 0, errors: 0 })).toBe(false);
    expect(canSave({ changes: 2, errors: 1 })).toBe(false);
    expect(canSave({ changes: 2, errors: 0, saving: true })).toBe(false);
  });
});

describe("SaveBar", () => {
  function mount(extra: Record<string, unknown> = {}) {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    const result = renderWithTheme(SaveBar, {
      changes: 2,
      errors: 0,
      saveLabel: "Vertrag speichern",
      onSave,
      onDiscard,
      ...extra,
    });
    return { onSave, onDiscard, ...result };
  }

  it("renders nothing without changes", () => {
    const { container } = mount({ changes: 0 });
    expect(container.querySelector('[role="region"]')).toBeNull();
    expect(screen.queryByText("Verwerfen")).toBeNull();
  });

  it("renders a labelled region with the summary, discard and the save label", () => {
    mount({ errors: 1 });
    const region = screen.getByRole("region", { name: "Speicherleiste" });
    expect(region.textContent).toContain("Nicht gespeichert");
    expect(region.textContent).toContain("2 Änderungen");
    expect(region.textContent).toContain("1 Fehler");
    expect(screen.getByRole("button", { name: "Verwerfen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Vertrag speichern" })).toBeTruthy();
  });

  it("save is enabled without errors and calls onSave; discard calls onDiscard", async () => {
    const { onSave, onDiscard } = mount();
    const save = screen.getByRole("button", { name: "Vertrag speichern" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await fireEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole("button", { name: "Verwerfen" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("save is disabled while errors > 0", async () => {
    const { onSave } = mount({ errors: 2 });
    const save = screen.getByRole("button", { name: "Vertrag speichern" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("while saving the label stays, a spinner sits inside the button and save is disabled", () => {
    mount({ saving: true });
    const save = screen.getByRole("button", { name: /Vertrag speichern/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.textContent).toContain("Vertrag speichern");
    expect(save.querySelector(".spinner")).toBeTruthy();
  });

  it("no spinner when not saving", () => {
    mount();
    expect(document.querySelector(".spinner")).toBeNull();
  });

  it("uses tokens only: no colour literal, italic, uppercase or letter-spacing", () => {
    const style = barSource.slice(barSource.lastIndexOf("<style>"));
    const rules = style.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(rules).not.toMatch(/italic|oblique|uppercase|letter-spacing/);
    expect(rules).toMatch(/var\(--bad\)/);
    expect(rules).toMatch(/var\(--h-control\)/);
    expect(barSource).not.toContain("{@html");
  });
});
