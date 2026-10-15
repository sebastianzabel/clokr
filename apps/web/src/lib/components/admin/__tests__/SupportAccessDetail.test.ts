// Issue #93 (Phase 93b-10) — the tenant's detail of one support access, mounted: the facts of the
// grant, every read with its category and person, the anonymised person, and the end action that is
// shown only to a holder of `tenant-settings:update` (the API's 403 stays the authority).
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/svelte";

import { renderWithTheme } from "$tests/test-utils";
import type { SupportAccessDetailResponse } from "$lib/support-access/labels";
import SupportAccessDetail from "../SupportAccessDetail.svelte";

const MAY_END = { permissions: ["audit-log:read:ZUGEWIESEN", "tenant-settings:update:ZUGEWIESEN"] };
const READ_ONLY = { permissions: ["audit-log:read:ZUGEWIESEN"] };

function detail(overrides: Partial<SupportAccessDetailResponse> = {}): SupportAccessDetailResponse {
  return {
    access: {
      id: "sa-1",
      operatorName: "Support-Team",
      reason: "Ticket 4711: Saldo eines Monats prüfen",
      startedAt: "2026-07-01T22:30:00.000Z",
      expiresAt: "2026-07-02T22:30:00.000Z",
      endedAt: null,
      endedBy: null,
      status: "ACTIVE",
      readCount: 4,
    },
    reads: [
      {
        at: "2026-07-01T22:40:00.000Z",
        category: "EMPLOYEES",
        employee: null,
        month: null,
        filters: null,
      },
      {
        at: "2026-07-01T22:41:00.000Z",
        category: "EMPLOYEE_MONTH",
        employee: { id: "emp-1", name: "Erika Beispiel", anonymized: false },
        month: "2026-06",
        filters: null,
      },
      {
        at: "2026-07-01T22:42:00.000Z",
        category: "AUDIT_LOG",
        employee: { id: "emp-2", name: null, anonymized: true },
        month: null,
        filters: { from: "2026-06-01", to: "2026-06-30", page: 1 },
      },
      {
        at: "2026-07-01T22:43:00.000Z",
        category: "CONTRACTS",
        employee: { id: "emp-3", name: null, anonymized: false },
        month: null,
        filters: null,
      },
    ],
    timezone: "Europe/Berlin",
    ...overrides,
  };
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    detail: detail(),
    user: MAY_END,
    onEnd: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function ended(): SupportAccessDetailResponse {
  const base = detail();
  return {
    ...base,
    access: {
      ...base.access,
      status: "ENDED",
      endedBy: "OPERATOR",
      endedAt: "2026-07-01T23:30:00.000Z",
    },
  };
}

describe("SupportAccessDetail — the access", () => {
  it("shows operator, full reason, start, expiry, status and read count in the tenant zone", () => {
    const { container } = renderWithTheme(SupportAccessDetail, props());
    const text = container.textContent ?? "";
    expect(text).toContain("Support-Team");
    expect(text).toContain("Ticket 4711: Saldo eines Monats prüfen");
    expect(text).toContain("02.07.2026, 00:30");
    expect(text).toContain("03.07.2026, 00:30");
    expect(text).toContain("Aktiv");
  });

  it("shows who ended an ended access and when", () => {
    const { container } = renderWithTheme(SupportAccessDetail, props({ detail: ended() }));
    const text = container.textContent ?? "";
    expect(text).toContain("Beendet");
    expect(text).toContain("durch den Betreiber");
    expect(text).toContain("02.07.2026, 01:30");
  });

  it("writes the instants in the zone the API sent", () => {
    const { container } = renderWithTheme(
      SupportAccessDetail,
      props({ detail: detail({ timezone: "America/New_York" }) }),
    );
    expect(container.textContent).toContain("01.07.2026, 18:30");
    expect(container.textContent).not.toContain("02.07.2026, 00:30");
  });

  it("renders the reason as text, never as markup", () => {
    const d = detail();
    d.access.reason = "<b>fett</b>";
    const { container } = renderWithTheme(SupportAccessDetail, props({ detail: d }));
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("<b>fett</b>")).toBeTruthy();
  });

  it("contains no link into the operator console (AC-93-9)", () => {
    const { container } = renderWithTheme(SupportAccessDetail, props());
    expect(container.innerHTML).not.toContain("/betreiber");
  });
});

describe("SupportAccessDetail — the reads", () => {
  it("lists every read with time, category, person and month or window", () => {
    renderWithTheme(SupportAccessDetail, props());
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toContain("02.07.2026, 00:40");
    expect(rows[0].textContent).toContain("Mitarbeitende");
    expect(rows[1].textContent).toContain("Monatsansicht");
    expect(rows[1].textContent).toContain("Erika Beispiel");
    expect(rows[1].textContent).toContain("Juni 2026");
    expect(rows[2].textContent).toContain("Änderungsprotokoll");
    expect(rows[2].textContent).toContain("01.06.2026 – 30.06.2026");
    expect(rows[3].textContent).toContain("Verträge");
  });

  it("names an anonymised person „Gelöschte Person“ and never leaks a name", () => {
    renderWithTheme(SupportAccessDetail, props());
    const rows = screen.getAllByRole("listitem");
    expect(rows[2].textContent).toContain("Gelöschte Person");
    expect(rows[3].textContent).not.toContain("Gelöschte Person");
    expect(rows[3].textContent).toContain("Person nicht mehr vorhanden");
  });

  it("shows an empty note when nothing was read yet", () => {
    renderWithTheme(SupportAccessDetail, props({ detail: detail({ reads: [] }) }));
    expect(screen.getByText("Noch keine Abrufe.")).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("shows an unknown category raw instead of hiding the read", () => {
    const d = detail();
    d.reads = [
      { at: d.reads[0].at, category: "NEW_KIND", employee: null, month: null, filters: null },
    ];
    renderWithTheme(SupportAccessDetail, props({ detail: d }));
    expect(screen.getByText("NEW_KIND")).toBeTruthy();
  });
});

describe("SupportAccessDetail — ending the access", () => {
  it("shows no end button to a user without tenant-settings:update", () => {
    renderWithTheme(SupportAccessDetail, props({ user: READ_ONLY }));
    expect(screen.queryByRole("button", { name: "Zugriff beenden" })).toBeNull();
  });

  it("shows no end button without a user at all", () => {
    renderWithTheme(SupportAccessDetail, props({ user: null }));
    expect(screen.queryByRole("button", { name: "Zugriff beenden" })).toBeNull();
  });

  it("shows the end button to a holder of tenant-settings:update on an active access", () => {
    renderWithTheme(SupportAccessDetail, props());
    expect(screen.getByRole("button", { name: "Zugriff beenden" })).toBeTruthy();
  });

  it("shows no end button on an access that is no longer active, whoever looks", () => {
    renderWithTheme(SupportAccessDetail, props({ detail: ended() }));
    expect(screen.queryByRole("button", { name: "Zugriff beenden" })).toBeNull();
  });

  it("asks before ending and ends nothing until the confirmation", async () => {
    const p = props();
    renderWithTheme(SupportAccessDetail, p);
    await fireEvent.click(screen.getByRole("button", { name: "Zugriff beenden" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Support-Zugriff beenden?")).toBeTruthy();
    expect(
      screen.getByText(
        "Der Betreiber verliert den Zugriff sofort. Für eine weitere Einsicht muss er einen neuen Zugriff mit Begründung anfordern.",
      ),
    ).toBeTruthy();
    expect(p.onEnd).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(p.onEnd).not.toHaveBeenCalled();
  });

  it("ends the access once on confirmation and closes the dialog", async () => {
    const p = props();
    renderWithTheme(SupportAccessDetail, p);
    await fireEvent.click(screen.getByRole("button", { name: "Zugriff beenden" }));
    const dialog = screen.getByRole("dialog");
    const confirm = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Zugriff beenden",
    );
    expect(confirm).toBeTruthy();
    await fireEvent.click(confirm!);
    await waitFor(() => expect(p.onEnd).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the dialog open and shows the server's message when the end is refused", async () => {
    const p = props({
      onEnd: vi.fn().mockRejectedValue(new Error("Der Support-Zugriff ist nicht mehr aktiv.")),
    });
    renderWithTheme(SupportAccessDetail, p);
    await fireEvent.click(screen.getByRole("button", { name: "Zugriff beenden" }));
    const dialog = screen.getByRole("dialog");
    const confirm = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Zugriff beenden",
    );
    await fireEvent.click(confirm!);
    await waitFor(() => expect(p.onEnd).toHaveBeenCalledTimes(1));
    const still = screen.getByRole("dialog");
    expect(still).toBeTruthy();
    await waitFor(() =>
      expect(still.textContent).toContain("Der Support-Zugriff ist nicht mehr aktiv."),
    );
  });
});
