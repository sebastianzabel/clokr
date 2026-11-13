// Issue #843 (D-843-01 block 10) - EmptyState variants and ErrorState.
import { describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import EmptyState from "../EmptyState.svelte";
import ErrorState from "../ErrorState.svelte";
import errorSource from "../ErrorState.svelte?raw";

describe("EmptyState (843-13)", () => {
  it("renders as before with only its existing props", () => {
    const onaction = vi.fn();
    const { container, getByRole, queryByText } = renderWithTheme(EmptyState, {
      icon: "calendar",
      title: "Keine Einträge",
      description: "Lege den ersten an.",
      actionLabel: "Neu",
      onaction,
    });
    expect(container.querySelector("h3.empty-state-title")?.textContent).toBe("Keine Einträge");
    expect(container.querySelector(".empty-state-description")?.textContent).toBe(
      "Lege den ersten an.",
    );
    expect(getByRole("button", { name: "Neu" })).toBeTruthy();
    expect(queryByText("Keine Treffer")).toBeNull();
  });

  it("noMatches supplies title, sentence and a reset action", async () => {
    const onaction = vi.fn();
    const { container, getByRole } = renderWithTheme(EmptyState, {
      variant: "noMatches",
      onaction,
    });
    expect(container.querySelector(".empty-state-title")?.textContent).toBe("Keine Treffer");
    expect(container.querySelector(".empty-state-description")?.textContent).toBe(
      "Passe die Suche oder die Filter an.",
    );
    await fireEvent.click(getByRole("button", { name: "Filter zurücksetzen" }) as HTMLElement);
    expect(onaction).toHaveBeenCalledTimes(1);
  });

  it("noData supplies the title and no action", () => {
    const { container, queryByRole } = renderWithTheme(EmptyState, {
      variant: "noData",
      onaction: () => {},
    });
    expect(container.querySelector(".empty-state-title")?.textContent).toBe("Noch keine Einträge");
    expect(queryByRole("button")).toBeNull();
  });

  it("an explicit prop wins over the variant default", () => {
    const { container } = renderWithTheme(EmptyState, { variant: "noMatches", title: "Nichts da" });
    expect(container.querySelector(".empty-state-title")?.textContent).toBe("Nichts da");
  });
});

describe("ErrorState (843-13)", () => {
  it("renders a bad note with the default message in an alert region", () => {
    const { container, getByRole } = renderWithTheme(ErrorState, { onRetry: () => {} });
    const alert = getByRole("alert") as HTMLElement;
    expect(alert.querySelector(".note.note-bad")).not.toBeNull();
    expect(alert.textContent).toContain("Das hat nicht geklappt.");
    expect(alert.textContent).toContain("Bitte versuche es noch einmal.");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  it("uses a given message and hint", () => {
    const { getByRole } = renderWithTheme(ErrorState, {
      message: "Die Liste konnte nicht geladen werden.",
      hint: "",
      onRetry: () => {},
    });
    const text = (getByRole("alert") as HTMLElement).textContent ?? "";
    expect(text).toContain("Die Liste konnte nicht geladen werden.");
    expect(text).not.toContain("Bitte versuche");
  });

  it("calls onRetry from the retry button", async () => {
    const onRetry = vi.fn();
    const { getByRole } = renderWithTheme(ErrorState, { onRetry });
    await fireEvent.click(getByRole("button", { name: "Erneut versuchen" }) as HTMLElement);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("disables the button and shows the spinner while retrying", () => {
    const { getByRole } = renderWithTheme(ErrorState, { onRetry: () => {}, retrying: true });
    const button = getByRole("button", { name: /Erneut versuchen/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.querySelector(".spinner")).not.toBeNull();
  });

  it("is built on Note and renders text only", () => {
    expect(errorSource).toContain("<Note");
    expect(errorSource).not.toContain("{@html");
  });
});
