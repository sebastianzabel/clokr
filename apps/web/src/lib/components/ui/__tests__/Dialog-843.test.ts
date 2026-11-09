// Issue #843 (D-843-01 block 11, D-843-16) - the bits-ui Dialog keeps the legacy DOM contract:
// role=dialog in <body> (portal), the old class names, Escape on `document`, an overlay click that
// closes only when the overlay itself is the target, and [data-autofocus] on open.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { renderWithTheme } from "$tests/test-utils";
import Dialog from "../Dialog.svelte";
import dialogSource from "../Dialog.svelte?raw";

const children = createRawSnippet(() => ({ render: () => "<p>Inhalt</p>" }));
const footer = createRawSnippet(() => ({
  render: () =>
    '<span><button type="button">Abbrechen</button><button type="button" data-autofocus>Speichern</button></span>',
}));

afterEach(() => cleanup());

function open(props: Record<string, unknown> = {}) {
  const onOpenChange = vi.fn();
  const result = renderWithTheme(Dialog, {
    open: true,
    title: "Test",
    children,
    onOpenChange,
    ...props,
  });
  return { ...result, onOpenChange };
}

describe("Dialog - portal and roles", () => {
  it("renders nothing while closed", () => {
    renderWithTheme(Dialog, { open: false, title: "Test", children });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".scrim")).toBeNull();
  });

  it("renders role=dialog with aria-modal in <body>, outside the render container", () => {
    const { container } = open();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.body.contains(dialog)).toBe(true);
    expect(container.contains(dialog)).toBe(false);
  });

  it("names the dialog by its title, or by ariaLabel when given", () => {
    open();
    expect(screen.getByRole("dialog", { name: "Test" })).toBeTruthy();
    cleanup();
    open({ ariaLabel: "Eigener Name" });
    expect(screen.getByRole("dialog", { name: "Eigener Name" })).toBeTruthy();
  });
});

describe("Dialog - legacy class names", () => {
  it("emits scrim, modal, modal-hd, modal-body and modal-foot", () => {
    open({ footer });
    expect(document.querySelector(".scrim")).toBeTruthy();
    const modal = document.querySelector(".modal");
    expect(modal).toBeTruthy();
    expect(modal!.querySelector(".modal-hd h3")?.textContent).toBe("Test");
    expect(modal!.querySelector(".modal-body")?.textContent).toContain("Inhalt");
    expect(modal!.querySelector(".modal-foot")).toBeTruthy();
  });

  it("emits modal-foot only with a footer and modal-eyebrow only with an eyebrow", () => {
    open();
    expect(document.querySelector(".modal-foot")).toBeNull();
    expect(document.querySelector(".modal-eyebrow")).toBeNull();
    cleanup();
    open({ eyebrow: "Beispiel", footer });
    expect(document.querySelector(".modal-eyebrow")?.textContent).toBe("Beispiel");
    expect(document.querySelector(".modal-foot")).toBeTruthy();
  });

  it("emits modal--wide only for size wide", () => {
    open();
    expect(document.querySelector(".modal")!.classList.contains("modal--wide")).toBe(false);
    cleanup();
    open({ size: "wide" });
    expect(document.querySelector(".modal")!.classList.contains("modal--wide")).toBe(true);
  });
});

describe("Dialog - closing and focus", () => {
  it("closes on Escape dispatched on document", async () => {
    const { onOpenChange } = open();
    await fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes on a click whose target is the overlay itself", async () => {
    const { onOpenChange } = open();
    await fireEvent.click(document.querySelector(".scrim")!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stays open for a click inside the content", async () => {
    const { onOpenChange } = open({ footer });
    await fireEvent.click(document.querySelector(".modal-body")!);
    await fireEvent.click(document.querySelector(".modal")!);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("focuses the [data-autofocus] element on open", async () => {
    open({ footer });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Speichern" })),
    );
  });
});

// The CSS shapes are pinned on the source: jsdom computes no layout. They are the shapes
// Modal.size-612.test.ts applies to Modal.svelte today (the Modal becomes a Dialog wrapper later).
describe("Dialog - sizes and the sheet (CSS shapes)", () => {
  const style = dialogSource.slice(dialogSource.lastIndexOf("<style>"));

  it("declares the wide size with the 880 px width, capped to the viewport", () => {
    expect(style).toMatch(/\.modal--wide\s*\{[^}]*width:\s*min\(880px,\s*calc\(100vw - 32px\)\)/);
  });

  it("lets the footer of the wide dialog wrap, and sets no bare .modal-foot rule", () => {
    expect(style).toMatch(/\.modal--wide\s+\.modal-foot\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(style).not.toMatch(/(^|\n)\s*\.modal-foot\s*\{/);
  });

  it("centres the 520 px dialog without a transform (#570)", () => {
    const rule = /\n\s*\.modal\s*\{([^}]*)\}/.exec(style)?.[1] ?? "";
    expect(rule).toMatch(/width:\s*min\(520px,\s*calc\(100vw - 32px\)\)/);
    expect(rule).toMatch(/position:\s*fixed/);
    expect(rule).toMatch(/margin:\s*auto/);
    expect(style).not.toMatch(/transform\s*:/);
  });

  it("becomes a bottom sheet below a 760 px viewport", () => {
    const sheet = /@media\s*\(max-width:\s*759\.98px\)\s*\{([\s\S]*)\}\s*$/.exec(
      style.replace("</style>", "").trimEnd(),
    )?.[1];
    expect(sheet, "the sheet media query").toBeTruthy();
    expect(sheet).toMatch(/width:\s*100%/);
    expect(sheet).toMatch(/inset:\s*auto 0 0 0/);
    expect(sheet).toMatch(/max-height:\s*85vh/);
    expect(sheet).toMatch(/border-radius:\s*var\(--r-card\) var\(--r-card\) 0 0/);
    expect(sheet).toMatch(/overflow-y:\s*auto/);
    expect(sheet).toMatch(/\.btn[^{]*\{[^}]*width:\s*100%/);
  });

  it("is the only viewport media query besides reduced motion", () => {
    const queries = [...style.matchAll(/@media\s*([^{]+)\{/g)].map((m) => m[1].trim());
    expect(queries.length).toBeGreaterThanOrEqual(1);
    for (const q of queries) expect(q).toMatch(/max-width:\s*759\.98px|prefers-reduced-motion/);
  });
});

// D-843-16 (#636): the page behind an open dialog is inert, toast regions stay interactive.
describe("Dialog - inert page", () => {
  function fixture(tag: string, attrs: Record<string, string> = {}) {
    const el = document.createElement("div");
    el.id = tag;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.appendChild(el);
    return el;
  }

  afterEach(() => {
    document.querySelectorAll("#app-root, #toast-fixture, #pre-inert").forEach((e) => e.remove());
  });

  it("sets inert on the page sibling only, not on the toast root or the portal container", async () => {
    const app = fixture("app-root");
    const toast = fixture("toast-fixture", { "data-toast-root": "" });
    open();
    await waitFor(() => expect(app.hasAttribute("inert")).toBe(true));
    expect(toast.hasAttribute("inert")).toBe(false);
    const portal = screen.getByRole("dialog").closest("body > *")!;
    expect(portal.hasAttribute("inert")).toBe(false);
  });

  it("removes exactly what it set on close and keeps a node that was inert before", async () => {
    const app = fixture("app-root");
    const pre = fixture("pre-inert", { inert: "" });
    open();
    await waitFor(() => expect(app.hasAttribute("inert")).toBe(true));
    await fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(app.hasAttribute("inert")).toBe(false));
    expect(pre.hasAttribute("inert")).toBe(true);
  });

  it("restores when an open dialog is destroyed", async () => {
    const app = fixture("app-root");
    open();
    await waitFor(() => expect(app.hasAttribute("inert")).toBe(true));
    cleanup();
    expect(app.hasAttribute("inert")).toBe(false);
  });

  it("keeps the page inert until the outer of two nested dialogs closes", async () => {
    const app = fixture("app-root");
    const outer = renderWithTheme(Dialog, { open: true, title: "Außen", children });
    await waitFor(() => expect(app.hasAttribute("inert")).toBe(true));
    renderWithTheme(Dialog, { open: true, title: "Innen", children });
    await waitFor(() => expect(screen.getAllByRole("dialog").length).toBe(2));
    await fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.getAllByRole("dialog").length).toBe(1));
    expect(app.hasAttribute("inert")).toBe(true);
    outer.unmount();
    await waitFor(() => expect(app.hasAttribute("inert")).toBe(false));
  });
});
