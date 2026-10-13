// Issue #89 (D-13, D-14a) - the reason callout renders the sentence of the reasons module for a
// code, the server's string only for an unknown code, and nothing without a code.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { renderWithTheme } from "$tests/test-utils";
import { REASON_TEXTS } from "$lib/operator/reasons";
import ReasonCallout from "../ReasonCallout.svelte";

function appCss(): string {
  try {
    return readFileSync(fileURLToPath(new URL("../../../../app.css", import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");
  }
}

beforeAll(() => {
  // vitest does not process global CSS; load the shared recipes so computed styles are real.
  const style = document.createElement("style");
  style.textContent = appCss();
  document.head.appendChild(style);
});

function callout(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="op-reason-callout"]');
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ReasonCallout", () => {
  it("renders the brand callout with the code and the console's sentence", () => {
    renderWithTheme(ReasonCallout, { code: "FEDERAL_STATE_IN_USE" }, "nacht");
    const node = callout();
    expect(node).toHaveClass("callout", "brand");
    expect(node).toHaveAttribute("data-code", "FEDERAL_STATE_IN_USE");
    expect(node).toHaveAttribute("role", "alert");
    expect(node).toHaveTextContent(
      "Das Bundesland ist durch Zeiteinträge oder Zuordnungen festgelegt. Ein Umzug ist ein neuer Salon.",
    );
  });

  it("chooses the text by code: a known code ignores the server's string", () => {
    renderWithTheme(
      ReasonCallout,
      { code: "LAST_ACTIVE_SALON", serverError: "Letzter aktiver Salon" },
      "nacht",
    );
    expect(callout()).toHaveTextContent(REASON_TEXTS["LAST_ACTIVE_SALON"] as string);
    expect(callout()).not.toHaveTextContent("Letzter aktiver Salon.");
  });

  it("falls back to the server's string for an unknown code", () => {
    renderWithTheme(
      ReasonCallout,
      { code: "SOMETHING_NEW", serverError: "Server sagt X" },
      "nacht",
    );
    expect(callout()).toHaveTextContent("Server sagt X");
    expect(callout()).toHaveAttribute("data-code", "SOMETHING_NEW");
  });

  it("names the salon in a page-level notice", () => {
    renderWithTheme(ReasonCallout, { code: "ALREADY_INACTIVE", subject: "Hauptsalon" }, "nacht");
    expect(callout()).toHaveTextContent("Salon „Hauptsalon“: Der Salon ist bereits deaktiviert.");
  });

  it("renders every salon code without a digit", () => {
    for (const code of [
      "FEDERAL_STATE_IN_USE",
      "HOME_SALON_IN_USE",
      "LAST_ACTIVE_SALON",
      "ALREADY_INACTIVE",
      "ALREADY_ACTIVE",
      "SALON_ALREADY_COUPLED",
      "BRANCH_ALREADY_COUPLED",
      "SALON_INACTIVE",
      "SALON_NOT_FOUND",
    ]) {
      document.body.innerHTML = "";
      renderWithTheme(ReasonCallout, { code }, "nacht");
      expect(callout()?.textContent, code).not.toMatch(/\d/);
      expect(callout()?.textContent?.trim().length, code).toBeGreaterThan(5);
    }
  });

  it("is styled: it differs from a control element with an invented class", () => {
    renderWithTheme(ReasonCallout, { code: "FEDERAL_STATE_IN_USE" }, "nacht");
    const control = document.createElement("div");
    control.className = "callout-that-does-not-exist";
    document.body.appendChild(control);
    const styled = getComputedStyle(callout() as HTMLElement);
    const plain = getComputedStyle(control);
    expect(styled.display).toBe("flex");
    expect(plain.display).not.toBe("flex");
    expect(styled.padding).not.toBe(plain.padding);
  });

  it("passes an id through for aria-describedby", () => {
    renderWithTheme(ReasonCallout, { code: "FEDERAL_STATE_IN_USE", id: "reason-1" }, "nacht");
    expect(callout()?.id).toBe("reason-1");
  });

  it("renders nothing without a code", () => {
    renderWithTheme(ReasonCallout, {}, "nacht");
    expect(callout()).toBeNull();
    document.body.innerHTML = "";
    renderWithTheme(ReasonCallout, { code: null, serverError: "x" }, "nacht");
    expect(callout()).toBeNull();
  });
});
