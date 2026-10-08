// Issue #80 (D-02, D-05, D-08, D-11) — the action path for a multi-entry day. The route page
// cannot be mounted, so the panel is the unit that carries the contract: what it shows for a
// full and a redacted day, and which actions it offers from the SERVER's flags.

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import DayBreakPanel from "../DayBreakPanel.svelte";
import type { DayCheck } from "$lib/breaks/day-break-violation";

function check(over: Partial<DayCheck> = {}): DayCheck {
  return {
    date: "2026-03-10",
    detail: "full",
    crossSalon: true,
    netWorkedMinutes: 480,
    totalBreakMinutes: 10,
    requiredBreakMinutes: 30,
    breakShortfall: true,
    maxDailyExceeded: false,
    acknowledged: false,
    locked: false,
    mayAcknowledge: false,
    mayRecordDayBreak: false,
    acknowledgement: null,
    entries: [
      {
        id: "e1",
        startTime: "2026-03-10T08:00:00",
        endTime: "2026-03-10T12:00:00",
        salonId: "s1",
      },
      {
        id: "e2",
        startTime: "2026-03-10T12:30:00",
        endTime: "2026-03-10T16:30:00",
        salonId: "s2",
      },
    ],
    gaps: [
      {
        startTime: "2026-03-10T12:00:00",
        endTime: "2026-03-10T12:30:00",
        crossSalon: true,
        countsAsBreak: false,
      },
    ],
    dayBreaks: [],
    ...over,
  };
}

const redacted = (over: Partial<DayCheck> = {}) =>
  check({ detail: "redacted", entries: null, gaps: null, dayBreaks: null, ...over });

describe("DayBreakPanel", () => {
  it("renders nothing without a cross-salon finding and without a recorded day break", () => {
    renderWithTheme(DayBreakPanel, {
      check: check({ crossSalon: false, breakShortfall: false, dayBreaks: [] }),
    });
    expect(screen.queryByTestId("day-break-panel")).toBeNull();
  });

  it("renders the badge, the § 4 prose and the totals line for a cross-salon shortfall", () => {
    const { container } = renderWithTheme(DayBreakPanel, { check: check() });
    expect(screen.getByTestId("day-break-panel")).toBeTruthy();
    const text = container.textContent ?? "";
    expect(text).toContain("Salonübergreifend: Pause fehlt");
    expect(text).toContain("§ 4 ArbZG");
    expect(text).toContain("Fahrzeit");
    expect(text).toContain("Arbeitszeit");
    expect(text).toContain(
      "Insgesamt 8,0 h gearbeitet, 10 Min Pause erfasst (vorgeschrieben: 30 Min).",
    );
  });

  it("shows one row per entry and per gap on a full day", () => {
    renderWithTheme(DayBreakPanel, { check: check() });
    expect(screen.getAllByTestId("day-break-entry")).toHaveLength(2);
    expect(screen.getAllByTestId("day-break-gap")).toHaveLength(1);
  });

  it("shows no entry or gap rows on a redacted day, only the note and the totals", () => {
    const { container } = renderWithTheme(DayBreakPanel, { check: redacted() });
    expect(screen.queryByTestId("day-break-entry")).toBeNull();
    expect(screen.queryByTestId("day-break-gap")).toBeNull();
    const text = container.textContent ?? "";
    expect(text).toContain(
      "Einträge außerhalb Ihres Zuständigkeitsbereichs werden nicht angezeigt.",
    );
    expect(text).toContain("Insgesamt 8,0 h gearbeitet");
  });

  it("the redacted variant's rendered text contains no HH:MM pattern", () => {
    const { container } = renderWithTheme(DayBreakPanel, {
      check: redacted({ mayAcknowledge: true }),
      onAcknowledge: vi.fn(),
    });
    expect(container.textContent ?? "").not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("offers the add form only when the server allows recording and submits the two times", async () => {
    const onAddBreak = vi.fn().mockResolvedValue(undefined);
    renderWithTheme(DayBreakPanel, {
      check: check({ mayRecordDayBreak: true }),
      onAddBreak,
    });
    const start = screen.getByLabelText("Pause von") as HTMLInputElement;
    const end = screen.getByLabelText("Pause bis") as HTMLInputElement;
    await fireEvent.input(start, { target: { value: "12:05" } });
    await fireEvent.input(end, { target: { value: "12:25" } });
    await fireEvent.click(screen.getByTestId("day-break-add"));
    await waitFor(() => expect(onAddBreak).toHaveBeenCalledTimes(1));
    expect(onAddBreak).toHaveBeenCalledWith({ startLocal: "12:05", endLocal: "12:25" });
  });

  it("offers no add form when the server does not allow recording", () => {
    renderWithTheme(DayBreakPanel, {
      check: check({ mayRecordDayBreak: false }),
      onAddBreak: vi.fn(),
    });
    expect(screen.queryByTestId("day-break-add")).toBeNull();
  });

  it("keeps the add form closed on an inverted interval and shows an inline error", async () => {
    const onAddBreak = vi.fn();
    renderWithTheme(DayBreakPanel, { check: check({ mayRecordDayBreak: true }), onAddBreak });
    await fireEvent.input(screen.getByLabelText("Pause von"), { target: { value: "12:25" } });
    await fireEvent.input(screen.getByLabelText("Pause bis"), { target: { value: "12:05" } });
    await fireEvent.click(screen.getByTestId("day-break-add"));
    expect(onAddBreak).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toContain("nach");
  });

  it("deleting a recorded day break asks for a reason and passes the trimmed reason on", async () => {
    const onDeleteBreak = vi.fn().mockResolvedValue(undefined);
    renderWithTheme(DayBreakPanel, {
      check: check({
        mayRecordDayBreak: true,
        dayBreaks: [
          { id: "db1", startTime: "2026-03-10T12:05:00", endTime: "2026-03-10T12:25:00" },
        ],
      }),
      onDeleteBreak,
    });
    await fireEvent.click(screen.getByTestId("day-break-delete-db1"));
    await fireEvent.input(await screen.findByPlaceholderText("Bitte kurz begründen."), {
      target: { value: "  falsch erfasst  " },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(onDeleteBreak).toHaveBeenCalledWith("db1", "falsch erfasst"));
  });

  it("offers the acknowledge button when allowed and passes the reason on", async () => {
    const onAcknowledge = vi.fn().mockResolvedValue(undefined);
    renderWithTheme(DayBreakPanel, { check: check({ mayAcknowledge: true }), onAcknowledge });
    await fireEvent.click(screen.getByTestId("day-break-ack"));
    await fireEvent.input(await screen.findByPlaceholderText("Bitte kurz begründen."), {
      target: { value: "Pause am Telefon bestätigt" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Quittieren" }));
    await waitFor(() => expect(onAcknowledge).toHaveBeenCalledWith("Pause am Telefon bestätigt"));
  });

  it("offers revoke for an acknowledged day and passes ack id and reason on", async () => {
    const onRevoke = vi.fn().mockResolvedValue(undefined);
    renderWithTheme(DayBreakPanel, {
      check: check({
        mayAcknowledge: true,
        acknowledged: true,
        acknowledgement: { id: "ack1", createdAt: "2026-03-11T08:00:00Z", reason: "ok" },
      }),
      onRevoke,
    });
    expect(screen.queryByTestId("day-break-ack")).toBeNull();
    expect(screen.getByText("Salonübergreifend: quittiert")).toBeTruthy();
    await fireEvent.click(screen.getByTestId("day-break-revoke"));
    await fireEvent.input(await screen.findByPlaceholderText("Bitte kurz begründen."), {
      target: { value: "Irrtum" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Widerrufen" }));
    await waitFor(() => expect(onRevoke).toHaveBeenCalledWith("ack1", "Irrtum"));
  });

  it("offers neither acknowledge nor revoke when the server does not allow it", () => {
    renderWithTheme(DayBreakPanel, {
      check: check({ mayAcknowledge: false }),
      onAcknowledge: vi.fn(),
      onRevoke: vi.fn(),
    });
    expect(screen.queryByTestId("day-break-ack")).toBeNull();
    expect(screen.queryByTestId("day-break-revoke")).toBeNull();
  });
});
