// Issue #612 — Modal gains `size: "md" | "wide"`. Default stays exactly as before.

import { describe, it, expect } from "vitest";
import { createRawSnippet } from "svelte";
import { renderWithTheme } from "$tests/test-utils";
import Modal from "../Modal.svelte";
import modalSource from "../Modal.svelte?raw";

const children = createRawSnippet(() => ({ render: () => "<p>Inhalt</p>" }));

describe("Modal — size", () => {
  it("renders `.modal` without `modal--wide` by default", () => {
    renderWithTheme(Modal, { open: true, title: "Test", children });
    const modal = document.querySelector(".modal");
    expect(modal).toBeTruthy();
    expect(modal!.classList.contains("modal--wide")).toBe(false);
  });

  it('`size="md"` is the default look', () => {
    renderWithTheme(Modal, { open: true, title: "Test", size: "md", children });
    expect(document.querySelector(".modal")!.classList.contains("modal--wide")).toBe(false);
  });

  it('`size="wide"` adds `modal--wide`', () => {
    renderWithTheme(Modal, { open: true, title: "Test", size: "wide", children });
    const modal = document.querySelector(".modal");
    expect(modal!.classList.contains("modal--wide")).toBe(true);
    expect(modal!.classList.contains("modal")).toBe(true);
  });

  it("declares `.modal--wide` in the component's own <style> with the 880 px width", () => {
    const style = modalSource.slice(modalSource.lastIndexOf("<style>"));
    expect(style).toMatch(/\.modal--wide\s*\{[^}]*width:\s*min\(880px,\s*calc\(100vw - 32px\)\)/);
  });
});
