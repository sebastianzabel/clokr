// Issue #93 (D-05(4), D-17, T-93b-37/-38/-39) - the redacted change log of one tenant, mounted: the
// filter row with its client-side 92-day refusal (no request, the server stays the authority), rows
// with action, entity, actor label and old/new values as key/value lists, the redaction marker styled
// but never decided on in the browser, the pagination from 51 rows on, and the load states.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/svelte";

import { renderWithTheme } from "$tests/test-utils";
import type { SupportAuditItem, SupportAuditPage, SupportEmployee } from "$lib/operator/types";
import SupportAuditLog from "../SupportAuditLog.svelte";

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`);
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = byId<T>(id);
  if (!found) throw new Error(`missing test id ${id}`);
  return found;
}

function item(overrides: Partial<SupportAuditItem> & { id: string }): SupportAuditItem {
  return {
    createdAt: "2026-10-02T08:15:00.000Z",
    action: "UPDATE",
    entity: "TimeEntry",
    entityId: "entry-1",
    userId: "user-1",
    oldValue: { breakMinutes: 30, note: "[ausgeblendet]" },
    newValue: { breakMinutes: 45, note: "[ausgeblendet]", locked: false },
    ...overrides,
  };
}

function auditPage(
  items: SupportAuditItem[],
  overrides: Partial<SupportAuditPage> = {},
): SupportAuditPage {
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 50,
    from: "2026-09-15",
    to: "2026-10-15",
    ...overrides,
  };
}

const EMPLOYEES: SupportEmployee[] = [
  {
    id: "emp-1",
    employeeNumber: "1001",
    firstName: "Vorname",
    lastName: "Nachname",
    hireDate: "2024-03-01",
    exitDate: null,
    status: "ACTIVE",
    homeSalon: null,
    scheduleType: "FIXED_SCHEDULE",
  },
  {
    id: "emp-2",
    employeeNumber: "1002",
    firstName: "Anna",
    lastName: "Beispiel",
    hireDate: "2024-03-01",
    exitDate: null,
    status: "ACTIVE",
    homeSalon: null,
    scheduleType: null,
  },
];

interface MountOptions {
  audit?: SupportAuditPage | null;
  loading?: boolean;
  errorText?: string;
  from?: string;
  to?: string;
  employeeId?: string;
}

function mount(options: MountOptions = {}) {
  const onApply = vi.fn();
  const onPage = vi.fn();
  const onRetry = vi.fn();
  renderWithTheme(
    SupportAuditLog,
    {
      employees: EMPLOYEES,
      from: options.from ?? "2026-09-15",
      to: options.to ?? "2026-10-15",
      employeeId: options.employeeId ?? "",
      audit: options.audit === undefined ? auditPage([item({ id: "a-1" })]) : options.audit,
      loading: options.loading ?? false,
      errorText: options.errorText ?? "",
      onApply,
      onPage,
      onRetry,
    },
    "nacht",
  );
  return { onApply, onPage, onRetry };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SupportAuditLog rows", () => {
  it("renders newest first as sent with action, entity, entity id and the actor", () => {
    mount({
      audit: auditPage([
        item({ id: "a-new", createdAt: "2026-10-03T08:00:00.000Z", action: "CREATE" }),
        item({ id: "a-old", createdAt: "2026-10-01T08:00:00.000Z", entity: "LeaveRequest" }),
      ]),
    });
    const ids = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="op-support-audit-row-"]'),
    ).map((row) => row.dataset.testid);
    expect(ids).toEqual(["op-support-audit-row-a-new", "op-support-audit-row-a-old"]);
    const first = el("op-support-audit-row-a-new");
    expect(first).toHaveTextContent("CREATE");
    expect(first).toHaveTextContent("TimeEntry");
    expect(first).toHaveTextContent("entry-1");
    expect(first).toHaveTextContent("Benutzer");
    expect(el("op-support-audit-row-a-old")).toHaveTextContent("LeaveRequest");
  });

  it("labels an operator row Betreiber and a row without anyone System", () => {
    mount({
      audit: auditPage([
        item({
          id: "a-op",
          userId: null,
          newValue: { actor: { type: "OPERATOR", operatorId: "op-1" }, reason: "[ausgeblendet]" },
        }),
        item({ id: "a-sys", userId: null, newValue: { minutes: 3 } }),
      ]),
    });
    expect(el("op-support-audit-row-a-op")).toHaveTextContent("Betreiber");
    expect(el("op-support-audit-row-a-sys")).toHaveTextContent("System");
  });

  it("lists old and new values as key/value pairs", () => {
    mount();
    const row = el("op-support-audit-row-a-1");
    expect(row).toHaveTextContent("Vorher");
    expect(row).toHaveTextContent("Nachher");
    expect(row).toHaveTextContent("breakMinutes");
    expect(row).toHaveTextContent("30");
    expect(row).toHaveTextContent("45");
    expect(row).toHaveTextContent("locked");
    expect(row).toHaveTextContent("Nein");
  });

  it("marks every redacted value with the marker, muted, with a screen-reader hint", () => {
    mount();
    const row = el("op-support-audit-row-a-1");
    const redacted = row.querySelectorAll('[data-testid="op-support-audit-redacted"]');
    expect(redacted).toHaveLength(2);
    for (const marker of Array.from(redacted)) {
      expect(marker).toHaveTextContent("[ausgeblendet]");
      expect(marker.querySelector(".sr-only")).toHaveTextContent("ausgeblendet");
      expect(marker.classList.contains("redacted")).toBe(true);
    }
  });

  it("renders a value that looks like markup as text", () => {
    mount({
      audit: auditPage([item({ id: "a-x", newValue: { code: "<img src=x onerror=alert(1)>" } })]),
    });
    expect(el("op-support-audit-row-a-x")).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img")).toBeNull();
  });

  it("says Kein Wert where the old value is missing", () => {
    mount({ audit: auditPage([item({ id: "a-c", oldValue: null, newValue: { minutes: 3 } })]) });
    const row = el("op-support-audit-row-a-c");
    expect(row).toHaveTextContent("Nachher");
    expect(row).toHaveTextContent("minutes");
    expect(row).toHaveTextContent("Kein Wert");
  });

  it("says when the window holds no change", () => {
    mount({ audit: auditPage([]) });
    expect(el("op-support-audit")).toHaveTextContent("Keine Änderungen im gewählten Zeitraum.");
    expect(document.querySelectorAll('[data-testid^="op-support-audit-row-"]')).toHaveLength(0);
  });
});

describe("SupportAuditLog filters", () => {
  it("is prefilled and offers every person of the list", () => {
    mount({ employeeId: "emp-2" });
    expect(el<HTMLInputElement>("op-support-audit-from").value).toBe("2026-09-15");
    expect(el<HTMLInputElement>("op-support-audit-to").value).toBe("2026-10-15");
    const select = el<HTMLSelectElement>("op-support-audit-person");
    expect(select.value).toBe("emp-2");
    const options = Array.from(select.options).map((option) => option.textContent?.trim());
    expect(options).toEqual(["Alle Personen", "Nachname, Vorname (1001)", "Beispiel, Anna (1002)"]);
  });

  it("applies a valid window with the chosen person", async () => {
    const { onApply } = mount();
    await fireEvent.input(el("op-support-audit-from"), { target: { value: "2026-10-01" } });
    await fireEvent.input(el("op-support-audit-to"), { target: { value: "2026-10-10" } });
    await fireEvent.change(el("op-support-audit-person"), { target: { value: "emp-1" } });
    await fireEvent.click(el("op-support-audit-apply"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({
      from: "2026-10-01",
      to: "2026-10-10",
      employeeId: "emp-1",
    });
    expect(byId("op-support-audit-window-error")).toBeNull();
  });

  it("refuses a window above 92 days before any request", async () => {
    const { onApply } = mount();
    await fireEvent.input(el("op-support-audit-from"), { target: { value: "2026-01-01" } });
    await fireEvent.input(el("op-support-audit-to"), { target: { value: "2026-10-15" } });
    await fireEvent.click(el("op-support-audit-apply"));
    expect(onApply).not.toHaveBeenCalled();
    const error = el("op-support-audit-window-error");
    expect(error).toHaveTextContent("Der Zeitraum darf höchstens 92 Tage umfassen.");
    expect(error).toHaveAttribute("role", "alert");
  });

  it("refuses an end before the beginning and clears the refusal on the next valid apply", async () => {
    const { onApply } = mount();
    await fireEvent.input(el("op-support-audit-from"), { target: { value: "2026-10-10" } });
    await fireEvent.input(el("op-support-audit-to"), { target: { value: "2026-10-01" } });
    await fireEvent.click(el("op-support-audit-apply"));
    expect(onApply).not.toHaveBeenCalled();
    expect(el("op-support-audit-window-error")).toHaveTextContent("Das Ende liegt vor dem Beginn.");

    await fireEvent.input(el("op-support-audit-to"), { target: { value: "2026-10-12" } });
    await fireEvent.click(el("op-support-audit-apply"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(byId("op-support-audit-window-error")).toBeNull();
  });

  it("accepts the 92-day boundary", async () => {
    const { onApply } = mount();
    await fireEvent.input(el("op-support-audit-from"), { target: { value: "2026-07-01" } });
    await fireEvent.input(el("op-support-audit-to"), { target: { value: "2026-09-30" } });
    await fireEvent.click(el("op-support-audit-apply"));
    expect(onApply).toHaveBeenCalledTimes(1);
  });
});

describe("SupportAuditLog pagination", () => {
  it("shows no pagination for one page", () => {
    mount({ audit: auditPage([item({ id: "a-1" })], { total: 50 }) });
    expect(byId("op-support-audit-pagination")).toBeNull();
  });

  it("pages forward from the second page on 51 rows", async () => {
    const { onPage } = mount({ audit: auditPage([item({ id: "a-1" })], { total: 120 }) });
    expect(el("op-support-audit-pagination")).toBeInTheDocument();
    const next = el("op-support-audit-pagination").querySelector<HTMLButtonElement>(
      'button[aria-label="Nächste Seite"]',
    );
    expect(next).not.toBeNull();
    await fireEvent.click(next as HTMLButtonElement);
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledWith(2);
  });
});

describe("SupportAuditLog states", () => {
  it("shows a busy skeleton while loading and no rows", () => {
    mount({ audit: null, loading: true });
    expect(el("op-support-audit-loading")).toHaveAttribute("aria-busy", "true");
    expect(document.querySelectorAll('[data-testid^="op-support-audit-row-"]')).toHaveLength(0);
  });

  it("shows the failure text with a retry", async () => {
    const { onRetry } = mount({ audit: null, errorText: "Der Server hat einen Fehler gemeldet." });
    const alert = el("op-support-audit-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("Der Server hat einen Fehler gemeldet.");
    await fireEvent.click(el("op-support-audit-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps the filter row while loading and on a failure", () => {
    mount({ audit: null, loading: true });
    expect(el("op-support-audit-apply")).toBeInTheDocument();
    document.body.innerHTML = "";
    mount({ audit: null, errorText: "Fehler" });
    expect(el("op-support-audit-apply")).toBeInTheDocument();
  });
});
