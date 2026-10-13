// Issue #89 (D-03) - the operator header, mounted: badge, session chip with its warning state,
// the polite announcements and the logout callback. The operator components live outside the
// lint:ui-classes scope, so the styling is proven against a control element.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/svelte";

import { renderWithTheme } from "$tests/test-utils";
import OperatorBar from "../OperatorBar.svelte";

function byId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function appCss(): string {
  try {
    return readFileSync(fileURLToPath(new URL("../../../../app.css", import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");
  }
}

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = appCss();
  document.head.appendChild(style);
});

function mount(props: Record<string, unknown> = {}) {
  const onLogout = vi.fn();
  const result = renderWithTheme(
    OperatorBar,
    { remainingMs: 872_000, displayName: "Beispiel Betreiber", onLogout, ...props },
    "nacht",
  );
  return { onLogout, ...result };
}

describe("OperatorBar", () => {
  it("shows the Betreiber badge and no tenant controls", () => {
    mount();
    expect(byId("op-badge")).toHaveTextContent("Betreiber");
    const bar = byId("op-bar") as HTMLElement;
    expect(bar.tagName).toBe("HEADER");
    expect(bar.querySelector("select")).toBeNull();
    expect(bar.querySelector('[aria-label*="Benachrichtigung"]')).toBeNull();
  });

  it("shows the session clock as mm:ss in the normal state", () => {
    mount();
    expect(byId("op-session-chip")).toHaveAttribute("data-state", "normal");
    expect(byId("op-session-chip")).toHaveTextContent("Sitzung endet in 14:32");
    expect(byId("op-session-remaining")).toHaveTextContent("14:32");
    expect(byId("op-session-chip")).not.toHaveClass("badge-yellow");
  });

  it("turns the chip to the warning state at two minutes", () => {
    mount({ remainingMs: 120_000 });
    expect(byId("op-session-chip")).toHaveAttribute("data-state", "warning");
    expect(byId("op-session-chip")).toHaveClass("badge-yellow");
    expect(byId("op-session-remaining")).toHaveTextContent("02:00");
  });

  it("shows the display name when known and omits it otherwise", () => {
    mount();
    expect(byId("op-bar")).toHaveTextContent("Beispiel Betreiber");
  });

  it("omits the display name when the call failed", () => {
    mount({ displayName: null });
    expect(byId("op-bar")).not.toHaveTextContent("Beispiel Betreiber");
  });

  it("calls onLogout from the Abmelden button", async () => {
    const { onLogout } = mount();
    const button = byId("op-logout") as HTMLElement;
    expect(button).toHaveTextContent("Abmelden");
    await fireEvent.click(button);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("announces two minutes politely, once, at the crossing", async () => {
    const { rerender } = mount({ remainingMs: 121_000 });
    const region = byId("op-session-announce") as HTMLElement;
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveTextContent("");

    await rerender({ remainingMs: 120_000 });
    expect(region).toHaveTextContent("Die Sitzung endet in 2 Minuten. Eingaben bitte abschließen.");
  });

  it("announces 30 seconds at its crossing, replacing the earlier sentence", async () => {
    const { rerender } = mount({ remainingMs: 31_000 });
    const region = byId("op-session-announce") as HTMLElement;

    await rerender({ remainingMs: 30_000 });
    expect(region).toHaveTextContent("Die Sitzung endet in 30 Sekunden.");
  });

  it("does not announce at load, even inside the warning window", () => {
    mount({ remainingMs: 90_000 });
    expect(byId("op-session-announce")).toHaveTextContent("");
  });

  it("keeps the announcement region out of sight", () => {
    mount();
    const region = byId("op-session-announce") as HTMLElement;
    expect(region).toHaveClass("sr-only");
  });

  it("is styled: the chip and the logout button differ from a control with an invented class", () => {
    mount();
    const control = document.createElement("span");
    control.className = "no-such-class-89";
    document.body.appendChild(control);
    const plain = getComputedStyle(control);

    const chip = getComputedStyle(byId("op-session-chip") as HTMLElement);
    expect(chip.display).toBe("inline-flex");
    expect(plain.display).not.toBe("inline-flex");

    const logout = getComputedStyle(byId("op-logout") as HTMLElement);
    expect(logout.cursor).toBe("pointer");
    expect(plain.cursor).not.toBe("pointer");
  });
});
