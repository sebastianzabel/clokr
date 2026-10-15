// Issue #93 (Phase 93b-10) — the tenant's list of support accesses, mounted. `lint:ui-classes` does
// not scan this directory, so the mount test is the component's gate: rows, tenant-zone instants,
// states (loading / error / empty), escaping of the operator's free-text reason and the absence of a
// console link in the tenant app.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/svelte";

import { renderWithTheme } from "$tests/test-utils";
import type { SupportAccessItem } from "$lib/support-access/labels";
import SupportAccessList from "../SupportAccessList.svelte";

function item(overrides: Partial<SupportAccessItem> = {}): SupportAccessItem {
  return {
    id: "sa-1",
    operatorName: "Support-Team",
    reason: "Ticket 4711: Saldo eines Monats prüfen",
    startedAt: "2026-07-01T22:30:00.000Z",
    expiresAt: "2026-07-02T22:30:00.000Z",
    endedAt: null,
    endedBy: null,
    status: "ACTIVE",
    readCount: 3,
    ...overrides,
  };
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    items: [item()],
    total: 1,
    timezone: "Europe/Berlin",
    loading: false,
    loadError: "",
    page: 1,
    pageSize: 25,
    onPageChange: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
}

describe("SupportAccessList", () => {
  it("explains the page in the Sie form", () => {
    renderWithTheme(SupportAccessList, props());
    expect(
      screen.getByText(
        "Hier sehen Sie, wann der Betreiber im Rahmen des Supports auf Ihre Daten zugegriffen hat, mit welcher Begründung und welche Daten abgerufen wurden. Einen laufenden Zugriff können Sie jederzeit beenden.",
      ),
    ).toBeTruthy();
  });

  it("shows operator, reason, window, status and read count of a row and links to the detail", () => {
    renderWithTheme(SupportAccessList, props());
    const link = screen.getByRole("link", { name: /Support-Team/ });
    expect(link.getAttribute("href")).toBe("/admin/support-access/sa-1");
    expect(link.textContent).toContain("Ticket 4711: Saldo eines Monats prüfen");
    expect(link.textContent).toContain("Aktiv");
    expect(link.textContent).toContain("3 Abrufe");
    // an access that is still running shows the instant it runs out
    expect(link.textContent).toContain("02.07.2026, 00:30");
    expect(link.textContent).toContain("03.07.2026, 00:30");
  });

  it("writes the instants in the tenant zone from the API, not the browser's", () => {
    const { unmount } = renderWithTheme(SupportAccessList, props());
    const berlin = screen.getByRole("link", { name: /Support-Team/ }).textContent;
    unmount();
    renderWithTheme(SupportAccessList, props({ timezone: "America/New_York" }));
    const newYork = screen.getByRole("link", { name: /Support-Team/ }).textContent;
    expect(berlin).not.toBe(newYork);
    expect(newYork).toContain("01.07.2026, 18:30");
  });

  it("says who ended an access and when, and counts one read in the singular", () => {
    renderWithTheme(
      SupportAccessList,
      props({
        items: [
          item({
            id: "sa-2",
            status: "ENDED",
            endedBy: "TENANT",
            endedAt: "2026-07-01T23:30:00.000Z",
            readCount: 1,
          }),
        ],
      }),
    );
    const link = screen.getByRole("link", { name: /Support-Team/ });
    expect(link.textContent).toContain("Beendet");
    expect(link.textContent).toContain("durch Ihre Verwaltung");
    expect(link.textContent).toContain("1 Abruf");
    expect(link.textContent).not.toContain("1 Abrufe");
    // the end of an ended access is the instant it was ended, not the planned expiry
    expect(link.textContent).toContain("02.07.2026, 01:30");
    expect(link.textContent).not.toContain("03.07.2026, 00:30");
  });

  it("shows an expired access without an ended-by note", () => {
    renderWithTheme(SupportAccessList, props({ items: [item({ id: "sa-3", status: "EXPIRED" })] }));
    const link = screen.getByRole("link", { name: /Support-Team/ });
    expect(link.textContent).toContain("Abgelaufen");
    expect(link.textContent).not.toContain("durch ");
  });

  it("renders the reason as text, never as markup", () => {
    const { container } = renderWithTheme(
      SupportAccessList,
      props({ items: [item({ reason: "<b>fett</b><img src=x onerror=alert(1)>" })] }),
    );
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<b>fett</b><img src=x onerror=alert(1)>")).toBeTruthy();
  });

  it("shows the empty state when nobody has accessed the data", () => {
    renderWithTheme(SupportAccessList, props({ items: [], total: 0 }));
    expect(
      screen.getByText("Bisher hat der Betreiber nicht auf Ihre Daten zugegriffen."),
    ).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("does not claim emptiness while loading", () => {
    renderWithTheme(SupportAccessList, props({ items: [], total: 0, loading: true }));
    expect(
      screen.queryByText("Bisher hat der Betreiber nicht auf Ihre Daten zugegriffen."),
    ).toBeNull();
    expect(screen.getByRole("status", { name: "Support-Zugriffe werden geladen" })).toBeTruthy();
  });

  it("shows a load error with a retry that calls onRetry", async () => {
    const p = props({ items: [], total: 0, loadError: "Fehler beim Laden der Support-Zugriffe." });
    renderWithTheme(SupportAccessList, p);
    expect(screen.getByRole("alert").textContent).toContain(
      "Fehler beim Laden der Support-Zugriffe.",
    );
    expect(
      screen.queryByText("Bisher hat der Betreiber nicht auf Ihre Daten zugegriffen."),
    ).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Erneut laden" }));
    expect(p.onRetry).toHaveBeenCalledTimes(1);
  });

  it("offers paging only above one page", () => {
    const { unmount } = renderWithTheme(SupportAccessList, props());
    expect(screen.queryByRole("navigation", { name: "Seitennavigation" })).toBeNull();
    unmount();
    renderWithTheme(SupportAccessList, props({ total: 60 }));
    expect(screen.getByRole("navigation", { name: "Seitennavigation" })).toBeTruthy();
  });

  it("contains no link into the operator console (AC-93-9)", () => {
    const { container } = renderWithTheme(SupportAccessList, props());
    expect(container.innerHTML).not.toContain("/betreiber");
  });
});
