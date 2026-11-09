// Issue #843 (D-843-01 block 1, D-843-14, D-843-22) - PageHeader is the one Seitenkopf. Since
// D-843-22 (owner request 10.11., design concept 3/4) it renders title, subtitle and actions only:
// no accent rule, no eyebrow line and no colour-set accent word. The byte-compat cases against the
// old PageHead DOM are replaced by assertions of that contract; the legacy `eyebrow` / `accent`
// props are still accepted (50+ callers) but inert.
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

const NEW_PLAIN =
  '<header class="page-head"><div class="page-head-text"><h1 translate="no">Team-Zeiten</h1> </div> </header>';
const NEW_SUB_ACTIONS =
  '<header class="page-head"><div class="page-head-text"><h1 translate="no">Zeiterfassung</h1> <p class="sub">Unterzeile</p></div> <div class="page-head-actions"><button>Neu</button></div></header>';

describe("PageHeader - the D-843-22 contract (no rule, no eyebrow, no accent word)", () => {
  it("renders the title as plain text in an h1, with no rule, eyebrow or em", () => {
    const { container } = renderWithTheme(PageHeader, { title: "Team-Zeiten" });
    expect(normalise(container.innerHTML)).toBe(NEW_PLAIN);
    expect(container.querySelector("h1")!.textContent).toBe("Team-Zeiten");
    expect(container.querySelector(".brand-rule")).toBeNull();
    expect(container.querySelector(".eyebrow")).toBeNull();
    expect(container.querySelector("em")).toBeNull();
  });

  // #843 D-843-14 -> D-843-22 (owner 10.11.): was a byte-compat case for the eyebrow + rule DOM.
  it("the legacy eyebrow prop is accepted and renders nothing", () => {
    const { container } = renderWithTheme(PageHeader, {
      eyebrow: "Mein Bereich",
      title: "Team-Zeiten",
    });
    expect(normalise(container.innerHTML)).toBe(NEW_PLAIN);
    expect(container.textContent).not.toContain("Mein Bereich");
    expect(container.querySelector(".brand-rule")).toBeNull();
  });

  // #843 D-843-14 -> D-843-22 (owner 10.11.): was the explicit-accent <em> case.
  it("the legacy accent prop is accepted and sets no word apart", () => {
    const { container } = renderWithTheme(PageHeader, {
      eyebrow: "Mein Bereich",
      title: "Urlaub & Abwesenheit",
      accent: "Urlaub",
    });
    expect(container.querySelector("em")).toBeNull();
    expect(container.querySelector("h1")!.innerHTML).toBe("Urlaub &amp; Abwesenheit");
  });

  it("renders the subtitle and the actions container to the right of the title block", () => {
    const { container } = renderWithTheme(PageHeader, {
      title: "Zeiterfassung",
      subtitle: "Unterzeile",
      actions,
    });
    expect(normalise(container.innerHTML)).toBe(NEW_SUB_ACTIONS);
    const text = container.querySelector(".page-head-text")!;
    const actionBox = container.querySelector(".page-head-actions")!;
    expect(text.querySelector("p.sub")!.textContent).toBe("Unterzeile");
    expect(text.compareDocumentPosition(actionBox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(actionBox.querySelector("button")!.textContent).toBe("Neu");
  });

  it("renders no subtitle and no actions container when neither is given", () => {
    const { container } = renderWithTheme(PageHeader, { title: "Zeiterfassung" });
    expect(container.querySelector("p.sub")).toBeNull();
    expect(container.querySelector(".page-head-actions")).toBeNull();
  });

  it("the legacy PageHead renders the identical markup through the same block", () => {
    const { container } = renderWithTheme(PageHead, {
      eyebrow: "E",
      title: "Zeiterfassung",
      accent: "Zeit",
      sub: "Unterzeile",
      actions,
    });
    expect(normalise(container.innerHTML)).toBe(NEW_SUB_ACTIONS);
  });

  it("takes the title size, weight and subtitle colour from the tokens", () => {
    const css = headerSource.slice(headerSource.indexOf("<style>"));
    expect(css).toMatch(/font-size:\s*var\(--fs-h1\)/);
    expect(css).toMatch(/font-weight:\s*600/);
    expect(css).toMatch(/\.sub\s*\{[^}]*font-size:\s*var\(--fs-base\)[^}]*\}/);
    expect(css).toMatch(/\.sub\s*\{[^}]*color:\s*var\(--text-2\)/);
    expect(css).not.toMatch(/brand-rule|\.eyebrow|:global\(em\)/);
  });
});

describe("PageHeader - the title is element text only (T-843-03)", () => {
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
