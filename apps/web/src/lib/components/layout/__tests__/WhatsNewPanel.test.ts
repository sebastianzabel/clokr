// Phase 110 (N-07/AK-06/AK-13) — WhatsNewPanel rendering + two adversarial pins.
//
// The N-07 pin exists because `Modal.svelte:42-53` would mark every sibling `<body>` child
// non-interactive while open, and `/dashboard` is the post-login landing route that carries the
// time clock ("Einstempeln"). If WhatsNewPanel ever regressed toward Modal's mechanism, the
// panel being open and the user being able to clock in would stop being simultaneously true —
// so that is asserted here directly against a mounted sibling button, not assumed from the
// component's source.
//
// Both `releaseNotesStore` and `whatsNewOpen` are module singletons (see
// `apps/web/src/lib/stores/release-notes.ts`), so every test resets them in `afterEach` —
// otherwise state would leak into unrelated test files sharing the same vitest worker
// (T-110-28).
//
// Mounting WhatsNewPanel transitively imports `$stores/auth` (via `$stores/release-notes` ->
// `$api/client` -> `$stores/auth` -> `$app/environment`), which `apps/web/vitest.config.ts`
// deliberately does not alias. Mocking `$stores/auth` directly (the nearest real,
// alias-resolvable module in the chain) unblocks the mount — the same precedent established in
// `apps/web/src/lib/components/layout/__tests__/version-line.test.ts` (Plan 01).
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { releaseNotesStore, whatsNewOpen } from "$stores/release-notes";
import WhatsNewPanel from "../WhatsNewPanel.svelte";

vi.mock("$stores/auth", () => ({ authStore: { subscribe: () => () => {} } }));

function note(overrides: Record<string, unknown> = {}) {
  return {
    version: "1.9.18",
    title: "Krank im Urlaub & Saldo-Korrekturen",
    intro: ["Feature- und Fix-Release."],
    sections: [
      {
        heading: "Neue Funktionen",
        bullets: [
          {
            spans: [
              { text: "Etwas ", bold: false },
              { text: "Neues", bold: true },
            ],
          },
        ],
      },
    ],
    footnote: null,
    ...overrides,
  };
}

afterEach(() => {
  releaseNotesStore.set([]);
  whatsNewOpen.set(false);
});

describe("WhatsNewPanel — rendering", () => {
  it("renders the release title, every section heading and every bullet when open", () => {
    releaseNotesStore.set([note()]);
    whatsNewOpen.set(true);
    renderWithTheme(WhatsNewPanel, {});

    expect(screen.getByText("Krank im Urlaub & Saldo-Korrekturen")).toBeTruthy();
    expect(screen.getByText("Neue Funktionen")).toBeTruthy();
    expect(screen.getByText("Etwas")).toBeTruthy();
    expect(screen.getByText("Neues")).toBeTruthy();
  });

  it("a bullet's bold span renders inside <strong>; the plain span renders as text", () => {
    releaseNotesStore.set([note()]);
    whatsNewOpen.set(true);
    const { container } = renderWithTheme(WhatsNewPanel, {});

    const strong = container.querySelector("strong");
    expect(strong?.textContent).toBe("Neues");
  });

  it("renders nothing when whatsNewOpen is false", () => {
    releaseNotesStore.set([note()]);
    whatsNewOpen.set(false);
    const { container } = renderWithTheme(WhatsNewPanel, {});

    expect(container.querySelector(".whats-new")).toBeNull();
  });

  it("renders nothing when the store is empty, even if whatsNewOpen is true (AK-06)", () => {
    releaseNotesStore.set([]);
    whatsNewOpen.set(true);
    const { container } = renderWithTheme(WhatsNewPanel, {});

    expect(container.querySelector(".whats-new")).toBeNull();
  });

  it("close button sets whatsNewOpen to false", async () => {
    releaseNotesStore.set([note()]);
    whatsNewOpen.set(true);
    renderWithTheme(WhatsNewPanel, {});

    await fireEvent.click(screen.getByLabelText("Schließen"));

    let open = true;
    whatsNewOpen.subscribe((v) => (open = v))();
    expect(open).toBe(false);
  });

  it("Escape closes the panel the same way", async () => {
    releaseNotesStore.set([note()]);
    whatsNewOpen.set(true);
    renderWithTheme(WhatsNewPanel, {});

    await fireEvent.keyDown(window, { key: "Escape" });

    let open = true;
    whatsNewOpen.subscribe((v) => (open = v))();
    expect(open).toBe(false);
  });

  it("'Alle Versionen' switches to a history view listing every release, newest first", async () => {
    releaseNotesStore.set([
      note({ version: "1.9.18", title: "Neueste" }),
      note({ version: "1.9.17", title: "Vorherige" }),
    ]);
    whatsNewOpen.set(true);
    renderWithTheme(WhatsNewPanel, {});

    await fireEvent.click(screen.getByText("Alle Versionen"));

    const titles = Array.from(document.querySelectorAll(".whats-new-release-hd h3")).map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(["Neueste", "Vorherige"]);
  });

  it("renders intro paragraphs and a footnote when present", () => {
    releaseNotesStore.set([
      note({ intro: ["Erster Absatz.", "Zweiter Absatz."], footnote: "Danke fürs Lesen." }),
    ]);
    whatsNewOpen.set(true);
    renderWithTheme(WhatsNewPanel, {});

    expect(screen.getByText("Erster Absatz.")).toBeTruthy();
    expect(screen.getByText("Zweiter Absatz.")).toBeTruthy();
    expect(screen.getByText("Danke fürs Lesen.")).toBeTruthy();
  });

  it("the history view offers a way back to the newest-release view", async () => {
    releaseNotesStore.set([note({ version: "1.9.18" }), note({ version: "1.9.17" })]);
    whatsNewOpen.set(true);
    renderWithTheme(WhatsNewPanel, {});

    await fireEvent.click(screen.getByText("Alle Versionen"));
    expect(screen.getByText("Nur neueste Version")).toBeTruthy();

    await fireEvent.click(screen.getByText("Nur neueste Version"));
    expect(screen.getByText("Alle Versionen")).toBeTruthy();
    // Back to newest-only: only one release header rendered.
    expect(document.querySelectorAll(".whats-new-release").length).toBe(1);
  });
});

describe("AK-13 — foreign text never becomes markup", () => {
  it("an <img onerror> payload renders as visible literal text, not an element", () => {
    releaseNotesStore.set([
      note({
        sections: [
          {
            heading: "Fehlerbehebungen",
            bullets: [{ spans: [{ text: "<img src=x onerror=alert(1)>", bold: false }] }],
          },
        ],
      }),
    ]);
    whatsNewOpen.set(true);
    const { container } = renderWithTheme(WhatsNewPanel, {});

    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("a <script> payload produces no <script> element", () => {
    releaseNotesStore.set([
      note({
        sections: [
          {
            heading: "Sicherheit",
            bullets: [{ spans: [{ text: "<script>alert(1)</script>", bold: true }] }],
          },
        ],
      }),
    ]);
    whatsNewOpen.set(true);
    const { container } = renderWithTheme(WhatsNewPanel, {});

    expect(screen.getByText("<script>alert(1)</script>")).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
  });
});

describe("N-07 — the panel must not block the clock-in path", () => {
  it("a sibling clock-in button stays non-inert, non-covered and clickable while the panel is open", async () => {
    const clockIn = document.createElement("button");
    clockIn.dataset.testid = "einstempeln";
    const onClick = vi.fn();
    clockIn.addEventListener("click", onClick);
    document.body.appendChild(clockIn);

    try {
      releaseNotesStore.set([note()]);
      whatsNewOpen.set(true);
      renderWithTheme(WhatsNewPanel, {});

      expect(clockIn.hasAttribute("inert")).toBe(false);
      expect(clockIn.closest("[inert]")).toBeNull();

      await fireEvent.click(clockIn);
      expect(onClick).toHaveBeenCalledTimes(1);

      expect(document.body.style.overflow).toBe("");
    } finally {
      clockIn.remove();
    }
  });
});
