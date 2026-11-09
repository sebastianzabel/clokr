// Issue #843 (D-843-01 block 1, D-843-14) - PageHeader is the one Seitenkopf. The expected markup
// below was captured from layout/PageHead.svelte BEFORE it became a delegate, so the block is
// proven byte-compatible with what every page rendered until now (scope-hash classes and the
// empty Svelte block markers are stripped on both sides; nothing else is normalised).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { renderWithTheme } from "$tests/test-utils";
import PageHeader from "../PageHeader.svelte";
import PageHead from "../../layout/PageHead.svelte";
import headerSource from "../PageHeader.svelte?raw";

afterEach(() => cleanup());

const actions = createRawSnippet(() => ({ render: () => "<button>Neu</button>" }));
const panel = createRawSnippet((value: () => string) => ({
  render: () => `<p>Inhalt ${value()}</p>`,
}));

/** Scope-hash classes and Svelte's empty block markers carry no information about the markup. */
function normalise(html: string): string {
  return html
    .replace(/ class="svelte-[a-z0-9]+"/g, "")
    .replace(/ svelte-[a-z0-9]+/g, "")
    .replace(/<!---->/g, "")
    .replace(/ class=""/g, "");
}

// Captured from the pre-delegate PageHead (see the file header); since Phase 851 (owner acceptance
// 09.11.2026) without the accent rule and the eyebrow line.
const LEGACY_PLAIN =
  '<header class="page-head"><div class="page-head-text"><h1 translate="no">Team-<em>Zeiten</em></h1> </div> </header>';
const LEGACY_ACCENT =
  '<header class="page-head"><div class="page-head-text"><h1 translate="no"><em>Urlaub</em> &amp; Abwesenheit</h1> </div> </header>';
const LEGACY_SUB_ACTIONS =
  '<header class="page-head"><div class="page-head-text"><h1 translate="no">Zeiterfassung</h1> <p class="sub">Unterzeile</p></div> <div class="page-head-actions"><button>Neu</button></div></header>';

describe("PageHeader - byte-compatible with the legacy PageHead", () => {
  it("plain title: autoAccent on the last token", () => {
    const { container } = renderWithTheme(PageHeader, {
      eyebrow: "Mein Bereich",
      title: "Team-Zeiten",
    });
    expect(normalise(container.innerHTML)).toBe(LEGACY_PLAIN);
  });

  it("explicit accent", () => {
    const { container } = renderWithTheme(PageHeader, {
      eyebrow: "Mein Bereich",
      title: "Urlaub & Abwesenheit",
      accent: "Urlaub",
    });
    expect(normalise(container.innerHTML)).toBe(LEGACY_ACCENT);
  });

  it("subtitle and actions (subtitle is PageHead's sub)", () => {
    const { container } = renderWithTheme(PageHeader, {
      eyebrow: "E",
      title: "Zeiterfassung",
      subtitle: "Unterzeile",
      actions,
    });
    expect(normalise(container.innerHTML)).toBe(LEGACY_SUB_ACTIONS);
  });

  it("the legacy PageHead renders the identical markup through the same block", () => {
    const { container } = renderWithTheme(PageHead, {
      eyebrow: "E",
      title: "Zeiterfassung",
      sub: "Unterzeile",
      actions,
    });
    expect(normalise(container.innerHTML)).toBe(LEGACY_SUB_ACTIONS);
  });
});

describe("PageHeader - accent split is element text only (T-843-03)", () => {
  it("never interprets a title as HTML", () => {
    const { container } = renderWithTheme(PageHeader, {
      title: '<img src=x onerror="alert(1)"> Zeiten',
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("h1")!.textContent).toBe(
      '<img src=x onerror="alert(1)"> Zeiten',
    );
    expect(headerSource).not.toMatch(/\{@html\s/);
  });

  it("an accent that is not part of the title renders plain", () => {
    const { container } = renderWithTheme(PageHeader, { title: "Zeiten", accent: "Urlaub" });
    expect(container.querySelector("em")).toBeNull();
  });

  it("a single word renders without an accent", () => {
    const { container } = renderWithTheme(PageHeader, { title: "Zeiterfassung" });
    expect(container.querySelector("em")).toBeNull();
  });
});

describe("PageHeader - heading level", () => {
  it("renders h1 by default and h2 for headingLevel 2", () => {
    const { container } = renderWithTheme(PageHeader, { title: "Titel" });
    expect(container.querySelector("h1")).toBeTruthy();
    expect(container.querySelector("h2")).toBeNull();
    cleanup();
    const second = renderWithTheme(PageHeader, { title: "Titel", headingLevel: 2 });
    expect(second.container.querySelector("h1")).toBeNull();
    expect(second.container.querySelector("h2")?.textContent).toBe("Titel");
  });
});

describe("PageHeader - page tabs", () => {
  const tabs = [
    { value: "overview", label: "Übersicht" },
    { value: "requests", label: "Anträge" },
    { value: "planning", label: "Planung" },
  ];

  function renderTabs(extra: Record<string, unknown> = {}) {
    return renderWithTheme(PageHeader, { title: "Titel", tabs, panel, ...extra });
  }

  it("renders a tablist after the head with one trigger per tab", () => {
    const { container } = renderTabs();
    const head = container.querySelector("header.page-head");
    const list = screen.getByRole("tablist");
    expect(head).toBeTruthy();
    expect(head!.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Übersicht",
      "Anträge",
      "Planung",
    ]);
  });

  it("selects the first tab while nothing is bound", () => {
    renderTabs();
    expect(screen.getByRole("tab", { name: "Übersicht" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("every trigger's aria-controls points at a rendered tabpanel", () => {
    renderTabs();
    const triggers = screen.getAllByRole("tab");
    expect(triggers).toHaveLength(3);
    for (const trigger of triggers) {
      const id = trigger.getAttribute("aria-controls");
      expect(id).toBeTruthy();
      const target = document.getElementById(id!);
      expect(target).toBeTruthy();
      expect(target!.getAttribute("role")).toBe("tabpanel");
    }
    expect(screen.getByRole("tabpanel").textContent).toContain("Inhalt overview");
  });

  it("ArrowRight selects the next tab and ArrowLeft the previous", async () => {
    const onTabChange = vi.fn();
    renderTabs({ onTabChange });
    const first = screen.getByRole("tab", { name: "Übersicht" });
    first.focus();
    await fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Anträge" }).getAttribute("aria-selected")).toBe("true");
    expect(onTabChange).toHaveBeenLastCalledWith("requests");
    expect(screen.getByRole("tabpanel").textContent).toContain("Inhalt requests");
    await fireEvent.keyDown(screen.getByRole("tab", { name: "Anträge" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Übersicht" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("the arrows loop at both ends", async () => {
    renderTabs();
    const first = screen.getByRole("tab", { name: "Übersicht" });
    first.focus();
    await fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Planung" }).getAttribute("aria-selected")).toBe("true");
    await fireEvent.keyDown(screen.getByRole("tab", { name: "Planung" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Übersicht" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("a click selects a tab", async () => {
    renderTabs();
    await fireEvent.click(screen.getByRole("tab", { name: "Planung" }));
    expect(screen.getByRole("tabpanel").textContent).toContain("Inhalt planning");
  });

  it("renders no tablist without tabs", () => {
    renderWithTheme(PageHeader, { title: "Titel" });
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});
