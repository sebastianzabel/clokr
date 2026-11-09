// Issue #580 — Escape closes only the top-most open Modal (the role draft dialog over the employee
// create dialog must close alone).
import { describe, expect, it } from "vitest";
import { createRawSnippet, flushSync } from "svelte";
import { fireEvent, screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import Modal from "../Modal.svelte";

const children = createRawSnippet(() => ({ render: () => "<p>Inhalt</p>" }));

async function escape() {
  await fireEvent.keyDown(window, { key: "Escape" });
  flushSync();
}

describe("Modal — stacking", () => {
  it("one Escape closes the top-most of two open dialogs, the next one the other", async () => {
    renderWithTheme(Modal, { open: true, title: "Unten", children });
    renderWithTheme(Modal, { open: true, title: "Oben", children });
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    await escape();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Unten" })).toBeInTheDocument();
    await escape();
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
  });

  it("a single open dialog still closes on Escape", async () => {
    renderWithTheme(Modal, { open: true, title: "Allein", children });
    await escape();
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
  });

  it("a closed dialog does not block the open one", async () => {
    renderWithTheme(Modal, { open: false, title: "Zu", children });
    renderWithTheme(Modal, { open: true, title: "Offen", children });
    await escape();
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
  });
});
