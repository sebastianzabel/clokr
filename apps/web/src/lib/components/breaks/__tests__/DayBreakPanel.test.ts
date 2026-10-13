// Issue #80 (D-02, D-05, D-08, D-11) + Issue #511 (D-12, D-18) — the action path for a day with a
// break finding. The route page
// cannot be mounted, so the panel is the unit that carries the contract: what it shows for a
// full and a redacted day, and which actions it offers from the SERVER's flags.

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import DayBreakPanel from "../DayBreakPanel.svelte";
import type {
  FullDayCheck,
  WithheldDayCheck,
  DayCheckWarning,
} from "$lib/breaks/day-break-violation";

function check(over: Partial<FullDayCheck> = {}): FullDayCheck {
  return {
    date: "2026-03-10",
    detail: "full",
    crossSalon: true,
    netWorkedMinutes: 480,
    totalBreakMinutes: 10,
    requiredBreakMinutes: 30,
    breakShortfall: true,
    maxDailyExceeded: false,
    breakFinding: true,
    positionUnknown: false,
    warnings: [],
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

// Issue #85 D-07: the shape the API returns for a partially covered day (85b-06) — every number
// and the finding flags are null, one neutral hint is the only content.
const HINT_TEXT =
  "Für diesen Tag liegt ein Prüfhinweis vor; die Klärung erfolgt über den Stammsalon.";
const redacted = (over: Partial<WithheldDayCheck> = {}): WithheldDayCheck => ({
  date: "2026-03-10",
  detail: "redacted",
  crossSalon: true,
  netWorkedMinutes: null,
  totalBreakMinutes: null,
  requiredBreakMinutes: null,
  breakShortfall: null,
  maxDailyExceeded: null,
  breakFinding: null,
  positionUnknown: null,
  warnings: [{ code: "FINDING_WITHHELD", severity: "warning", message: HINT_TEXT, hint: true }],
  acknowledged: null,
  locked: false,
  mayAcknowledge: false,
  mayRecordDayBreak: false,
  acknowledgement: null,
  entries: null,
  gaps: null,
  dayBreaks: null,
  ...over,
});

describe("DayBreakPanel", () => {
  it("renders nothing without a cross-salon finding and without a recorded day break", () => {
    renderWithTheme(DayBreakPanel, {
      check: check({
        crossSalon: false,
        breakShortfall: false,
        breakFinding: false,
        dayBreaks: [],
      }),
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

  // Issue #85 D-07 (amended; the former expectation pinned "Insgesamt 8,0 h gearbeitet" for a
  // redacted day): a redacted day carries no totals, only the date, the neutral hint and the note.
  it("shows a redacted day as date, neutral hint and out-of-scope note only", () => {
    const { container } = renderWithTheme(DayBreakPanel, { check: redacted() });
    expect(screen.getByTestId("day-break-panel")).toBeTruthy();
    expect(screen.queryByTestId("day-break-entry")).toBeNull();
    expect(screen.queryByTestId("day-break-gap")).toBeNull();
    const text = container.textContent ?? "";
    expect(text).toContain("10.03.2026");
    expect(screen.getByTestId("day-break-hint").textContent).toContain(HINT_TEXT);
    expect(text).toContain(
      "Einträge außerhalb des eigenen Zuständigkeitsbereichs werden nicht angezeigt.",
    );
    expect(text).not.toContain("Insgesamt");
    expect(text).not.toContain("§");
    expect(screen.queryByTestId("day-break-warning")).toBeNull();
    expect(container.querySelector(".badge")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders a redacted day without any figure, also with every action flag set", () => {
    const { container } = renderWithTheme(DayBreakPanel, {
      check: redacted({ mayAcknowledge: true, mayRecordDayBreak: true, crossSalon: false }),
      onAcknowledge: vi.fn(),
      onAddBreak: vi.fn(),
      onDeleteBreak: vi.fn(),
    });
    // Not vacuous: the panel is there, the text scan below looks at something.
    expect(screen.getByTestId("day-break-panel")).toBeTruthy();
    expect(screen.getByTestId("day-break-hint").textContent).toContain(HINT_TEXT);
    const text = container.textContent ?? "";
    // The date itself is written dd.mm.yyyy; hour, minute and clock figures must be absent.
    expect(text).not.toMatch(/\d{1,2}:\d{2}/);
    expect(text).not.toMatch(/\d+([.,]\d)?\s?(h|Min)\b/);
    expect(screen.queryByTestId("day-break-ack")).toBeNull();
    expect(screen.queryByTestId("day-break-add")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
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

  // ── Issue #511 (D-12 / D-18): every finding day, server-built warnings ─────────────────────────

  const warning = (over: Partial<DayCheckWarning> = {}): DayCheckWarning => ({
    code: "BREAK_TOO_LATE",
    severity: "warning",
    message: "SERVER § 4 Satz 3 ArbZG: 6:10 Std. am Stück ohne Ruhepause",
    certainty: "VIOLATION",
    ...over,
  });

  /** One entry in one salon, a Satz-2/3 finding, nothing else. */
  const single = (over: Partial<FullDayCheck> = {}) =>
    check({
      crossSalon: false,
      breakShortfall: false,
      breakFinding: true,
      warnings: [warning()],
      entries: [
        {
          id: "e1",
          startTime: "2026-03-10T08:00:00",
          endTime: "2026-03-10T16:30:00",
          salonId: "s1",
        },
      ],
      gaps: [],
      ...over,
    });

  it("renders a single-entry finding day for a manager: badge, totals, server warnings, acknowledge", () => {
    const { container } = renderWithTheme(DayBreakPanel, {
      check: single({ mayAcknowledge: true }),
      onAcknowledge: vi.fn(),
    });
    expect(screen.getByTestId("day-break-panel")).toBeTruthy();
    const badge = screen.getByText("Pausenregel verletzt");
    expect(badge.className).toContain("badge-yellow");
    const text = container.textContent ?? "";
    expect(text).toContain("Insgesamt 8,0 h gearbeitet");
    expect(screen.getAllByTestId("day-break-warning").map((li) => li.textContent?.trim())).toEqual([
      "SERVER § 4 Satz 3 ArbZG: 6:10 Std. am Stück ohne Ruhepause",
    ]);
    expect(screen.getByTestId("day-break-ack")).toBeTruthy();
    // A one-salon day must not claim that times lie in several salons.
    expect(text).not.toContain("mehreren Salons");
  });

  it("does not render the employee's own single-entry finding day (calendar marker only)", () => {
    renderWithTheme(DayBreakPanel, {
      check: single({ mayAcknowledge: false, mayRecordDayBreak: false }),
      onAcknowledge: vi.fn(),
    });
    expect(screen.queryByTestId("day-break-panel")).toBeNull();
  });

  it("renders an acknowledged single-entry day with the gray badge, and revoke only where allowed", () => {
    const acknowledged = {
      acknowledged: true,
      acknowledgement: { id: "ack9", createdAt: "2026-03-11T08:00:00Z", reason: "ok" },
    };
    const own = renderWithTheme(DayBreakPanel, {
      check: single({ ...acknowledged, mayAcknowledge: false }),
      onRevoke: vi.fn(),
    });
    expect(screen.getByTestId("day-break-panel")).toBeTruthy();
    expect(screen.getByText("Pausenverstoß: quittiert").className).toContain("badge-gray");
    expect(screen.queryByTestId("day-break-revoke")).toBeNull();
    own.unmount();

    renderWithTheme(DayBreakPanel, {
      check: single({ ...acknowledged, mayAcknowledge: true }),
      onRevoke: vi.fn(),
    });
    expect(screen.getByTestId("day-break-revoke")).toBeTruthy();
  });

  it("asks for clarification on an UNCLEAR finding", () => {
    renderWithTheme(DayBreakPanel, {
      check: single({
        mayAcknowledge: true,
        warnings: [warning({ code: "BREAK_SEGMENT_TOO_SHORT", certainty: "UNCLEAR" })],
      }),
      onAcknowledge: vi.fn(),
    });
    expect(screen.getByText("Pause: Klärung nötig").className).toContain("badge-yellow");
  });

  it("shows a hint as a muted note only when the panel renders, and a hint never renders it", () => {
    const hint = warning({
      code: "BREAK_POSITION_UNKNOWN",
      message: "HINT Lage der Pause nicht erfasst",
      certainty: undefined,
      hint: true,
    });
    // Panel renders (finding + manager): hint appears as a note, not in the warning list.
    const shown = renderWithTheme(DayBreakPanel, {
      check: single({ mayAcknowledge: true, warnings: [warning(), hint] }),
      onAcknowledge: vi.fn(),
    });
    expect(screen.getAllByTestId("day-break-warning")).toHaveLength(1);
    const note = screen.getByTestId("day-break-hint");
    expect(note.textContent).toContain("HINT Lage der Pause nicht erfasst");
    expect(note.className).toContain("text-muted");
    shown.unmount();

    // Hint only (no finding): even a manager with every flag gets no panel.
    renderWithTheme(DayBreakPanel, {
      check: single({
        breakFinding: false,
        positionUnknown: true,
        mayAcknowledge: true,
        mayRecordDayBreak: true,
        warnings: [hint],
      }),
    });
    expect(screen.queryByTestId("day-break-panel")).toBeNull();
  });

  it("does not repeat the 10-hour sentence when the server already sent its § 3 warning", () => {
    const { container } = renderWithTheme(DayBreakPanel, {
      check: check({
        maxDailyExceeded: true,
        warnings: [
          warning({
            code: "MAX_DAILY_EXCEEDED",
            severity: "error",
            message: "SERVER § 3 ArbZG zehn Stunden",
            certainty: undefined,
          }),
        ],
      }),
    });
    const text = container.textContent ?? "";
    expect(text).toContain("SERVER § 3 ArbZG zehn Stunden");
    expect(text).not.toContain("Die Tagessumme liegt über der Höchstarbeitszeit");
  });
  // Issue #511 (Sichtprüfung 11.10.): on a placement finding a break was taken but does not count,
  // so "durchgearbeitet" would put a false statement into the acknowledgement.
  it("names a placement acknowledgement „Pausenverstoß quittieren“, never „durchgearbeitet“", async () => {
    renderWithTheme(DayBreakPanel, {
      check: single({ mayAcknowledge: true }),
      onAcknowledge: vi.fn().mockResolvedValue(undefined),
    });
    const button = screen.getByTestId("day-break-ack");
    expect(button.textContent?.trim()).toBe("Pausenverstoß quittieren");
    await fireEvent.click(button);
    expect(await screen.findByText("Pausenverstoß quittieren?")).toBeTruthy();
    expect(screen.queryByText(/durchgearbeitet/)).toBeNull();
  });

  it("keeps „durchgearbeitet“ for the cross-salon Satz-1 day without a placement finding", () => {
    renderWithTheme(DayBreakPanel, {
      check: check({ mayAcknowledge: true, warnings: [] }),
      onAcknowledge: vi.fn(),
    });
    expect(screen.getByTestId("day-break-ack").textContent?.trim()).toBe(
      "Als „durchgearbeitet“ quittieren",
    );
  });
});
