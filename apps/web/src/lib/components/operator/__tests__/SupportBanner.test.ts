// Issue #93 (D-09, D-21, AC-93-3) - the persistent banner of every support read view, mounted. It
// names the end of the access, the reason and the protocol notice, derives the remaining time from
// the absolute expiry (never a counter) and reports the expiry exactly once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";

import { renderWithTheme } from "$tests/test-utils";
import SupportBanner from "../SupportBanner.svelte";

const NOW = new Date("2026-10-15T10:00:00.000Z").getTime();
const HOUR = 3_600_000;

function byId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function el(id: string): HTMLElement {
  const found = byId(id);
  if (!found) throw new Error(`missing test id ${id}`);
  return found;
}

function mount(overrides: { expiresAt?: string; reason?: string } = {}) {
  const onExpired = vi.fn();
  const view = renderWithTheme(
    SupportBanner,
    {
      expiresAt: overrides.expiresAt ?? new Date(NOW + 2 * HOUR).toISOString(),
      reason: overrides.reason ?? "Ticket zur Saldo-Abweichung prüfen",
      onExpired,
    },
    "nacht",
  );
  return { onExpired, unmount: () => view.unmount() };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("SupportBanner", () => {
  it("states the end time, the reason and that every read is logged", () => {
    mount();
    const banner = el("op-support-banner");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveTextContent("Support-Zugriff aktiv bis");
    expect(el("op-support-banner-until").textContent).toMatch(/^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/);
    expect(el("op-support-banner-reason")).toHaveTextContent(
      "Grund: Ticket zur Saldo-Abweichung prüfen",
    );
    expect(banner).toHaveTextContent("Jeder Abruf wird protokolliert");
    expect(el("op-support-banner-remaining")).toHaveTextContent("Noch 2 Std. 0 Min.");
  });

  it("renders the reason as text, never as markup", () => {
    mount({ reason: "<img src=x onerror=alert(1)> Ticket" });
    expect(el("op-support-banner-reason").querySelector("img")).toBeNull();
    expect(el("op-support-banner-reason")).toHaveTextContent("<img src=x onerror=alert(1)> Ticket");
  });

  it("derives the remaining time from the expiry on the clock after a jump", async () => {
    mount();
    vi.advanceTimersByTime(90 * 60_000);
    await tick();
    expect(el("op-support-banner-remaining")).toHaveTextContent("Noch 30 Min.");
  });

  it("calls onExpired exactly once when the remaining time reaches zero", async () => {
    const { onExpired } = mount({ expiresAt: new Date(NOW + 5000).toISOString() });
    expect(onExpired).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4000);
    await tick();
    expect(onExpired).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    await tick();
    expect(onExpired).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10 * 60_000);
    await tick();
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("reports an access that is already over at mount", async () => {
    const { onExpired } = mount({ expiresAt: new Date(NOW - 1000).toISOString() });
    await tick();
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("stops its tick when the component is removed", async () => {
    const { onExpired, unmount } = mount({ expiresAt: new Date(NOW + 5000).toISOString() });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    await tick();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    await tick();
    expect(onExpired).not.toHaveBeenCalled();
  });
});
