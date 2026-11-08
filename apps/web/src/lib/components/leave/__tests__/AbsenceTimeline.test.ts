// Issue #840 (D-840-07/10) — the mounted test of the absence timeline (tracer subset). The
// component imports neither the auth store nor the API client, so nothing needs mocking.
// `lib/components/leave/` is outside `lint:ui-classes`, so this file is its safeguard.
import { describe, it, expect, vi } from "vitest";
import { screen, within, fireEvent } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import AbsenceTimeline from "../timeline/AbsenceTimeline.svelte";
import { periodOf, type TimelineBar, type TimelinePerson } from "$lib/leave/timeline-model";

const NOVEMBER = periodOf("monat", "2026-11-15");

const rows: TimelinePerson[] = [
  {
    employeeId: "e1",
    name: "Anna Muster",
    isOwn: false,
    bars: [
      {
        key: "r-approved",
        start: "2026-11-02",
        end: "2026-11-04",
        style: "gesetzt",
        typeCode: "VACATION",
        label: "Urlaub",
        editable: false,
        requestId: "r-approved",
      },
      {
        key: "r-pending",
        start: "2026-11-16",
        end: "2026-11-17",
        style: "beantragt",
        typeCode: "VACATION",
        label: "Urlaub",
        editable: false,
        requestId: "r-pending",
      },
    ],
  },
  {
    employeeId: "e2",
    name: "Bernd Beispiel",
    isOwn: false,
    bars: [
      {
        key: "masked:e2:2026-11-09",
        start: "2026-11-09",
        end: "2026-11-09",
        style: "abwesend",
        typeCode: null,
        label: "abwesend",
        editable: false,
      },
    ],
  },
];

function render(overrides: Record<string, unknown> = {}) {
  renderWithTheme(AbsenceTimeline, {
    rows,
    period: NOVEMBER,
    holidays: [{ day: "2026-11-01", name: "Allerheiligen" }],
    columnWidthPx: 24,
    today: "2026-11-10",
    ...overrides,
  });
}

describe("rows and names", () => {
  it("renders one track per person with the name in the name column", () => {
    render();
    expect(screen.getByTestId("absence-timeline")).toBeTruthy();
    expect(screen.getByTestId("plan-track-e1")).toBeTruthy();
    expect(screen.getByTestId("plan-track-e2")).toBeTruthy();
    expect(screen.getByText("Anna Muster")).toBeTruthy();
    expect(screen.getByText("Bernd Beispiel")).toBeTruthy();
  });

  it("the track is one column wide per day of the period", () => {
    render();
    // 30 days of November at 24 px.
    expect(screen.getByTestId("plan-track-e1").style.width).toBe("720px");
  });

  it("the name column is 160 px wide", () => {
    render();
    expect(screen.getByTestId("absence-timeline").style.getPropertyValue("--tl-name-w")).toBe(
      "160px",
    );
  });
});

describe("bars", () => {
  it("every bar carries its style; the pending one has the dashed class", () => {
    render();
    const approved = screen.getByTestId("absence-bar-r-approved");
    const pending = screen.getByTestId("absence-bar-r-pending");
    expect(approved.getAttribute("data-bar-style")).toBe("gesetzt");
    expect(pending.getAttribute("data-bar-style")).toBe("beantragt");
    expect(pending.classList.contains("absence-bar--beantragt")).toBe(true);
    expect(approved.classList.contains("absence-bar--gesetzt")).toBe(true);
    expect(approved.classList.contains("absence-bar--beantragt")).toBe(false);
  });

  it("a masked bar reads abwesend and shows no type anywhere", () => {
    render();
    const bar = screen.getByTestId("absence-bar-masked:e2:2026-11-09");
    expect(bar.getAttribute("data-bar-style")).toBe("abwesend");
    expect(bar.getAttribute("title")).toContain("abwesend");
    expect(bar.getAttribute("aria-label")).toContain("abwesend");
    expect(bar.getAttribute("aria-label")).not.toMatch(/Urlaub|Krank/);
  });

  it("every bar is focusable and names person, label and dates in German", () => {
    render();
    const bar = screen.getByTestId("absence-bar-r-approved");
    bar.focus();
    expect(document.activeElement).toBe(bar);
    const label = bar.getAttribute("aria-label") ?? "";
    expect(label).toContain("Anna Muster");
    expect(label).toContain("Urlaub");
    expect(label).toContain("02.11.2026");
    expect(label).toContain("04.11.2026");
    expect(bar.getAttribute("title")).toBeTruthy();
  });

  it("a pending bar says so in its accessible name", () => {
    render();
    expect(screen.getByTestId("absence-bar-r-pending").getAttribute("aria-label")).toContain(
      "beantragt",
    );
  });

  it("prints the text label only at 56 px and wider", () => {
    render();
    // 3 days at 24 px = 72 px: label; 1 day = 24 px: none.
    expect(screen.getByTestId("absence-bar-r-approved").textContent).toContain("Urlaub");
    expect(screen.getByTestId("absence-bar-masked:e2:2026-11-09").textContent?.trim()).toBe("");
  });

  it("positions a bar by its first day and spans its days", () => {
    render();
    const bar = screen.getByTestId("absence-bar-r-approved");
    // 2 Nov is the second column: left 24 px, three days wide.
    expect(bar.style.left).toBe("24px");
    expect(bar.style.width).toBe("72px");
  });

  it("clips a bar that crosses the period and drops one that lies outside", () => {
    render({
      rows: [
        {
          ...rows[0],
          bars: [
            { ...rows[0].bars[0], key: "cross", start: "2026-10-28", end: "2026-11-02" },
            { ...rows[0].bars[0], key: "outside", start: "2026-12-01", end: "2026-12-03" },
          ],
        },
      ],
    });
    const cross = screen.getByTestId("absence-bar-cross");
    expect(cross.style.left).toBe("0px");
    expect(cross.style.width).toBe("48px");
    expect(screen.queryByTestId("absence-bar-outside")).toBeNull();
  });

  it("two overlapping bars of one person take two lanes", () => {
    render({
      rows: [
        {
          ...rows[0],
          bars: [
            { ...rows[0].bars[0], key: "a", start: "2026-11-02", end: "2026-11-06" },
            { ...rows[0].bars[0], key: "b", start: "2026-11-04", end: "2026-11-09" },
          ],
        },
      ],
    });
    expect(screen.getByTestId("absence-bar-a").style.top).not.toBe(
      screen.getByTestId("absence-bar-b").style.top,
    );
  });
});

describe("header", () => {
  it("shows the weekday letter and the day number per day, weekends shaded", () => {
    render();
    // 2026-11-02 is a Monday, 2026-11-07 a Saturday.
    const monday = screen.getByTestId("absence-day-2026-11-02");
    expect(within(monday).getByText("M")).toBeTruthy();
    expect(within(monday).getByText("2")).toBeTruthy();
    expect(monday.classList.contains("absence-day--weekend")).toBe(false);
    expect(
      screen.getByTestId("absence-day-2026-11-07").classList.contains("absence-day--weekend"),
    ).toBe(true);
    expect(
      screen.getByTestId("absence-day-2026-11-08").classList.contains("absence-day--weekend"),
    ).toBe(true);
  });

  it("a holiday column carries its name in the title", () => {
    render();
    expect(screen.getByTestId("absence-day-2026-11-01").getAttribute("title")).toBe(
      "Allerheiligen",
    );
    expect(screen.getByTestId("absence-day-2026-11-02").getAttribute("title")).toBeNull();
  });

  it("names the month above the days", () => {
    render();
    expect(screen.getByText("November")).toBeTruthy();
  });
});

// ── Plan 840-05 ─────────────────────────────────────────────────────────────────────────────
//
// Port of every case of `LeavePlanTimeline.test.ts` (the planner keeps its component until
// 840-08): the case list and its counterpart are in the SUMMARY. The testids `plan-bar-gesetzt`
// and `plan-bar-beantragt` became `absence-bar-<key>` (+ `data-bar-style`).

function wishBar(overrides: Partial<TimelineBar> = {}): TimelineBar {
  return {
    key: "w1",
    start: "2027-03-08",
    end: "2027-03-12",
    style: "wunsch",
    typeCode: null,
    label: "Wunsch",
    editable: true,
    conflict: false,
    hint: null,
    ...overrides,
  };
}

function planPerson(overrides: Partial<TimelinePerson> = {}): TimelinePerson {
  return {
    employeeId: "e1",
    name: "Alex Muster",
    isOwn: true,
    outsideRanges: [],
    forecast: null,
    bars: [],
    ...overrides,
  };
}

const Q1_2027 = periodOf("quartal", "2027-03-10");
const YEAR_2027 = periodOf("jahr", "2027-03-10");

const planRows: TimelinePerson[] = [
  planPerson({
    bars: [
      {
        key: "set",
        start: "2027-02-01",
        end: "2027-02-05",
        style: "gesetzt",
        typeCode: "VACATION",
        label: "Urlaub",
        editable: false,
      },
      {
        key: "req",
        start: "2027-03-22",
        end: "2027-03-26",
        style: "beantragt",
        typeCode: null,
        label: "abwesend",
        editable: false,
      },
      wishBar(),
    ],
  }),
  planPerson({ employeeId: "e2", name: "Bea Beispiel", isOwn: false }),
];

function renderPlan(overrides: Record<string, unknown> = {}) {
  const props = {
    rows: planRows,
    period: Q1_2027,
    holidays: [{ day: "2027-01-01", name: "Neujahr" }],
    today: "2027-03-01",
    columnWidthPx: 20,
    onMoveWish: vi.fn(),
    onEditWish: vi.fn(),
    onAddWish: vi.fn(),
    onBarSelect: vi.fn(),
    ...overrides,
  };
  renderWithTheme(AbsenceTimeline, props);
  return props;
}

async function drag(target: HTMLElement, fromX: number, toX: number) {
  await fireEvent.pointerDown(target, { clientX: fromX, pointerId: 1, button: 0 });
  await fireEvent.pointerMove(target, { clientX: toX, pointerId: 1 });
  await fireEvent.pointerUp(target, { clientX: toX, pointerId: 1 });
}

describe("planner rows and bars (ported)", () => {
  it("renders one row per person with solid and dashed bars, wishes and holiday columns", () => {
    renderPlan();
    expect(screen.getByTestId("plan-row-e1")).toBeTruthy();
    expect(screen.getByTestId("plan-row-e2")).toBeTruthy();
    expect(screen.getByText("Alex Muster")).toBeTruthy();
    expect(screen.getByText("Bea Beispiel")).toBeTruthy();
    expect(screen.getByTestId("absence-bar-set").classList.contains("absence-bar--gesetzt")).toBe(
      true,
    );
    expect(screen.getByTestId("absence-bar-req").classList.contains("absence-bar--beantragt")).toBe(
      true,
    );
    expect(screen.getByTestId("leave-plan-wish-w1")).toBeTruthy();
    // One backdrop column per person row.
    expect(screen.getAllByTestId("plan-holiday-2027-01-01").length).toBe(2);
  });

  it("names a masked type neutrally", () => {
    renderPlan();
    expect(screen.getByTestId("absence-bar-req").getAttribute("title")).toContain("abwesend");
  });

  it("month view renders only the columns of that month", () => {
    renderPlan({ period: periodOf("monat", "2027-03-10") });
    expect(screen.getByTestId("absence-month-2")).toBeTruthy();
    expect(screen.queryByTestId("absence-month-1")).toBeNull();
    // The February bar lies outside; the March bars and the wish are shown.
    expect(screen.queryByTestId("absence-bar-set")).toBeNull();
    expect(screen.getByTestId("absence-bar-req")).toBeTruthy();
    expect(screen.getByTestId("leave-plan-wish-w1")).toBeTruthy();
    expect(screen.getByTestId("plan-track-e1").style.width).toBe("620px");
  });
});

describe("drag and resize (ported)", () => {
  it("moving an editable wish by +3 columns calls onMoveWish once with the moved range", async () => {
    const props = renderPlan();
    await drag(screen.getByTestId("wish-bar-w1"), 100, 160);
    expect(props.onMoveWish).toHaveBeenCalledTimes(1);
    expect(props.onMoveWish).toHaveBeenCalledWith(expect.objectContaining({ key: "w1" }), {
      startDate: "2027-03-11",
      endDate: "2027-03-15",
    });
    expect(props.onEditWish).not.toHaveBeenCalled();
  });

  it("a drag of less than half a column calls nothing", async () => {
    const props = renderPlan();
    await drag(screen.getByTestId("wish-bar-w1"), 100, 108);
    expect(props.onMoveWish).not.toHaveBeenCalled();
  });

  it("the end handle by -2 columns moves the end by -2", async () => {
    const props = renderPlan();
    await drag(screen.getByTestId("leave-plan-wish-handle-end-w1"), 200, 160);
    expect(props.onMoveWish).toHaveBeenCalledWith(expect.objectContaining({ key: "w1" }), {
      startDate: "2027-03-08",
      endDate: "2027-03-10",
    });
  });

  it("the start handle by +1 column moves the start by +1", async () => {
    const props = renderPlan();
    await drag(screen.getByTestId("leave-plan-wish-handle-start-w1"), 100, 120);
    expect(props.onMoveWish).toHaveBeenCalledWith(expect.objectContaining({ key: "w1" }), {
      startDate: "2027-03-09",
      endDate: "2027-03-12",
    });
  });

  it.each([
    ["a foreign plan wish", { foreignPlan: true, editable: false }],
    ["a taken-over wish", { editable: false, hint: "Übernommen – nicht mehr änderbar" }],
    ["a wish with editable false", { editable: false }],
  ])("%s has no handles and ignores drags", async (_name, patch) => {
    const props = renderPlan({ rows: [planPerson({ bars: [wishBar(patch)] })] });
    expect(screen.queryByTestId("leave-plan-wish-handle-start-w1")).toBeNull();
    expect(screen.queryByTestId("leave-plan-wish-handle-end-w1")).toBeNull();
    const body = screen.queryByTestId("wish-bar-w1");
    if (body) await drag(body, 100, 200);
    expect(props.onMoveWish).not.toHaveBeenCalled();
  });

  it("captures the pointer so a drag survives leaving the bar", async () => {
    renderPlan();
    const body = screen.getByTestId("wish-bar-w1");
    const capture = vi.fn();
    (body as unknown as { setPointerCapture: typeof capture }).setPointerCapture = capture;
    await fireEvent.pointerDown(body, { clientX: 10, pointerId: 7, button: 0 });
    expect(capture).toHaveBeenCalledWith(7);
  });

  it("a drag is clamped to the year, never out of it", async () => {
    const props = renderPlan({
      rows: [planPerson({ bars: [wishBar({ start: "2027-03-29", end: "2027-03-31" })] })],
    });
    // +500 columns would leave the year; the range ends on 31 December at the latest.
    await drag(screen.getByTestId("wish-bar-w1"), 0, 10_000);
    const range = props.onMoveWish.mock.calls[0][1];
    expect(range.endDate <= "2027-12-31").toBe(true);
    expect(range.startDate <= range.endDate).toBe(true);
  });
});

describe("keyboard and adding (ported)", () => {
  it("Enter on a wish bar opens the edit callback", async () => {
    const props = renderPlan();
    const bar = screen.getByTestId("wish-bar-w1");
    await fireEvent.keyDown(bar, { key: "Enter" });
    expect(props.onEditWish).toHaveBeenCalledTimes(1);
    expect(props.onEditWish).toHaveBeenCalledWith(expect.objectContaining({ key: "w1" }));
    expect(bar.getAttribute("aria-label")).toContain("Mit Enter bearbeiten");
  });

  it("a click on an empty day calls onAddWish with the person and the day", async () => {
    const props = renderPlan();
    // clientX 45 with 20 px columns and a rect starting at 0 is column 2 = 3 January.
    await fireEvent.click(screen.getByTestId("plan-track-e2"), { clientX: 45 });
    expect(props.onAddWish).toHaveBeenCalledWith("e2", "2027-01-03");
  });

  it("does not offer a wish where the person may not get one", async () => {
    const props = renderPlan({ canAddWishFor: (id: string) => id === "e1" });
    await fireEvent.click(screen.getByTestId("plan-track-e2"), { clientX: 45 });
    expect(props.onAddWish).not.toHaveBeenCalled();
  });

  it("does not offer a wish on a day outside the person's Stammsalon span", async () => {
    const props = renderPlan({
      rows: [planPerson({ outsideRanges: [{ start: "2027-01-01", end: "2027-05-31" }] })],
    });
    await fireEvent.click(screen.getByTestId("plan-track-e1"), { clientX: 45 });
    expect(props.onAddWish).not.toHaveBeenCalled();
    expect(screen.getByTestId("plan-track-e1").querySelectorAll(".tl-away")).toHaveLength(1);
  });

  it("without an onAddWish callback a click on an empty day does nothing", async () => {
    renderPlan({ onAddWish: undefined });
    await fireEvent.click(screen.getByTestId("plan-track-e2"), { clientX: 45 });
    expect(screen.getByTestId("plan-track-e2").classList.contains("tl-track--addable")).toBe(false);
  });

  it("a click or Enter on a non-wish bar calls onBarSelect with the bar", async () => {
    const props = renderPlan();
    const bar = screen.getByTestId("absence-bar-set");
    await fireEvent.click(bar);
    await fireEvent.keyDown(bar, { key: "Enter" });
    expect(props.onBarSelect).toHaveBeenCalledTimes(2);
    expect(props.onBarSelect).toHaveBeenCalledWith(expect.objectContaining({ key: "set" }));
  });
});

describe("conflict and hints", () => {
  it("a conflicting wish has the conflict class and its hint in title and aria-label", () => {
    renderPlan({
      rows: [
        planPerson({
          bars: [wishBar({ conflict: true, hint: "Überschneidet sich mit einem Antrag" })],
        }),
      ],
    });
    expect(
      screen.getByTestId("leave-plan-wish-w1").classList.contains("absence-wish--conflict"),
    ).toBe(true);
    const body = screen.getByTestId("wish-bar-w1");
    expect(body.getAttribute("title")).toContain("Überschneidet sich");
    expect(body.getAttribute("aria-label")).toContain("Überschneidet sich");
  });

  it("a wish of another plan is a static, read-only element", () => {
    renderPlan({
      rows: [
        planPerson({
          bars: [
            wishBar({
              foreignPlan: true,
              editable: false,
              hint: "Wunsch aus einer anderen Planung",
            }),
          ],
        }),
      ],
    });
    expect(screen.queryByTestId("wish-bar-w1")).toBeNull();
    expect(screen.getByTestId("leave-plan-wish-w1").getAttribute("data-bar-style")).toBe("wunsch");
  });
});

describe("load row", () => {
  const loadDay = {
    kind: "day" as const,
    counts: new Map([
      ["2027-03-10", 3],
      ["2027-03-11", 4],
      ["2027-03-12", 2],
    ]),
    exceeded: new Map([["2027-03-11", "Grenze 3 für alle Mitarbeitenden"]]),
  };

  it("is labelled „Abwesend (Personen)“ and shows the count per day", () => {
    renderPlan({ load: loadDay });
    expect(
      within(screen.getByTestId("plan-day-load")).getByText("Abwesend (Personen)"),
    ).toBeTruthy();
    expect(screen.getByTestId("day-load-2027-03-10").textContent?.trim()).toBe("3");
  });

  it("marks only the keys of `exceeded`, with their tooltip", () => {
    renderPlan({ load: loadDay });
    expect(screen.getByTestId("day-load-2027-03-10").dataset.exceeded).toBe("false");
    const over = screen.getByTestId("day-load-2027-03-11");
    expect(over.dataset.exceeded).toBe("true");
    expect(over.classList.contains("tl-load-cell--exceeded")).toBe(true);
    expect(over.getAttribute("title")).toContain("Grenze 3 für alle Mitarbeitenden");
    expect(screen.getByTestId("day-load-2027-03-12").dataset.exceeded).toBe("false");
  });

  it("marks nothing when no limits were sent, however high the count", () => {
    renderPlan({ load: { kind: "day", counts: new Map([["2027-03-10", 99]]) } });
    expect(screen.getByTestId("day-load-2027-03-10").dataset.exceeded).toBe("false");
  });

  it("shows no row without load data", () => {
    renderPlan();
    expect(screen.queryByTestId("plan-day-load")).toBeNull();
  });

  it("in Jahr the row counts per week, keyed by the Monday", () => {
    renderPlan({
      period: YEAR_2027,
      widthPx: 1144,
      columnWidthPx: undefined,
      load: {
        kind: "week",
        counts: new Map([["2027-03-08", 5]]),
        exceeded: new Map([["2027-03-08", "Grenze"]]),
      },
    });
    const cell = screen.getByTestId("day-load-2027-03-08");
    expect(cell.textContent?.trim()).toBe("5");
    expect(cell.dataset.exceeded).toBe("true");
  });

  it("a load of the wrong kind for the zoom draws nothing", () => {
    renderPlan({ period: YEAR_2027, widthPx: 1144, columnWidthPx: undefined, load: loadDay });
    expect(screen.queryByTestId("day-load-2027-03-10")).toBeNull();
  });
});

describe("forecast column (ported)", () => {
  it("shows the forecast, the warning when negative, and nothing for a null forecast", () => {
    renderPlan({
      showForecast: true,
      rows: [
        planPerson({ forecast: { forecastDays: 15, forecastNegative: false } }),
        planPerson({ employeeId: "e2", forecast: { forecastDays: -2, forecastNegative: true } }),
        planPerson({ employeeId: "e3", forecast: null }),
      ],
    });
    expect(screen.getByText("Noch 15 Tage nach Plan")).toBeTruthy();
    expect(screen.getByText("Noch -2 Tage nach Plan")).toBeTruthy();
    expect(screen.getAllByText("Der Plan übersteigt den Anspruch")).toHaveLength(1);
    expect(screen.getByTestId("plan-forecast-e3").textContent?.trim()).toBe("");
    expect(screen.getByText("Anspruch")).toBeTruthy();
  });

  it("renders no forecast column unless asked", () => {
    renderPlan({ rows: [planPerson()] });
    expect(screen.queryByTestId("plan-forecast-e1")).toBeNull();
  });
});

describe("Jahr: the ISO week grid", () => {
  const person = planPerson({
    isOwn: false,
    bars: [
      {
        key: "set",
        start: "2026-11-02",
        end: "2026-11-06",
        style: "gesetzt",
        typeCode: "VACATION",
        label: "Urlaub",
        editable: false,
      },
      {
        key: "req",
        start: "2026-11-16",
        end: "2026-11-16",
        style: "beantragt",
        typeCode: "VACATION",
        label: "Urlaub",
        editable: false,
      },
      wishBar({ start: "2026-11-23", end: "2026-11-25" }),
      {
        key: "masked",
        start: "2026-12-07",
        end: "2026-12-08",
        style: "abwesend",
        typeCode: null,
        label: "abwesend",
        editable: false,
      },
    ],
  });

  function renderYear(overrides: Record<string, unknown> = {}) {
    const onWeekSelect = vi.fn();
    renderPlan({
      rows: [person],
      period: periodOf("jahr", "2026-06-01"),
      today: "2026-11-10",
      widthPx: 1144,
      columnWidthPx: undefined,
      onWeekSelect,
      ...overrides,
    });
    return { onWeekSelect };
  }

  it("draws 53 week columns of (container − 160 px) / 53, never wider than the container", () => {
    renderYear();
    const cells = screen
      .getByTestId("plan-track-e1")
      .querySelectorAll<HTMLElement>("[data-testid^='week-cell-']");
    expect(cells).toHaveLength(53);
    const width = (1144 - 160) / 53;
    for (const cell of cells) expect(parseFloat(cell.style.width)).toBeCloseTo(width, 5);
    expect(parseFloat(screen.getByTestId("plan-track-e1").style.width)).toBeLessThanOrEqual(
      1144 - 160 + 0.001,
    );
    expect(
      screen.getByTestId("absence-timeline").querySelector<HTMLElement>(".tl-inner")?.style
        .minWidth,
    ).toBe(`${160 + 53 * width}px`);
    expect(screen.queryByTestId("timeline-overflow-hint")).toBeNull();
  });

  it("2040 has 54 columns and still fits", () => {
    renderYear({ period: periodOf("jahr", "2040-06-01"), rows: [planPerson({ bars: [] })] });
    expect(
      screen.getByTestId("plan-track-e1").querySelectorAll("[data-testid^='week-cell-']"),
    ).toHaveLength(54);
    expect(screen.queryByTestId("timeline-overflow-hint")).toBeNull();
  });

  it("a week cell is a button named by week, dates and share; click and Enter select its Monday", async () => {
    const props = renderYear();
    const cell = screen.getByTestId("week-cell-e1-2026-11-02");
    expect(cell.tagName).toBe("BUTTON");
    const label = cell.getAttribute("aria-label") ?? "";
    expect(label).toContain("KW 45");
    expect(label).toContain("02.11.");
    expect(label).toContain("08.11.2026");
    expect(label).toContain("83 %");
    expect(label).toContain("Urlaub");
    expect(cell.getAttribute("title")).toBeTruthy();
    await fireEvent.click(cell);
    await fireEvent.keyDown(cell, { key: "Enter" });
    expect(props.onWeekSelect).toHaveBeenCalledTimes(2);
    expect(props.onWeekSelect).toHaveBeenCalledWith("2026-11-02");
  });

  it("fills the cell by the share of absent Werktage", () => {
    renderYear();
    const fill = screen
      .getByTestId("week-cell-e1-2026-11-02")
      .querySelector<HTMLElement>(".tl-week-fill");
    expect(parseFloat(fill?.style.height ?? "0")).toBeCloseTo((5 / 6) * 100, 3);
    expect(screen.getByTestId("week-cell-e1-2026-11-09").querySelector(".tl-week-fill")).toBeNull();
  });

  it("a masked week reads neutrally and leaks no type", () => {
    renderYear();
    const label = screen.getByTestId("week-cell-e1-2026-12-07").getAttribute("aria-label") ?? "";
    expect(label).toContain("abwesend");
    expect(label).not.toMatch(/Urlaub|Krank/);
  });

  it("an out-of-year part of an edge week is hatched; a requested week is dashed; a wish week is striped", () => {
    renderYear();
    const first = screen.getByTestId("week-cell-e1-2025-12-29");
    expect(first.querySelector(".tl-week-out")).not.toBeNull();
    expect(first.classList.contains("tl-week--edge")).toBe(true);
    expect(
      screen.getByTestId("week-cell-e1-2026-11-16").classList.contains("tl-week--beantragt"),
    ).toBe(true);
    expect(screen.getByTestId("week-cell-e1-2026-11-23").classList.contains("tl-week--wish")).toBe(
      true,
    );
    expect(
      screen.getByTestId("week-cell-e1-2026-11-02").classList.contains("tl-week--beantragt"),
    ).toBe(false);
  });

  it("bars are not draggable: no bar elements and no handles", () => {
    renderYear({
      rows: [planPerson({ bars: [wishBar({ start: "2026-11-23", end: "2026-11-25" })] })],
    });
    expect(screen.queryByTestId("wish-bar-w1")).toBeNull();
    expect(screen.queryByTestId("leave-plan-wish-handle-start-w1")).toBeNull();
  });

  it("names the months above the weeks and marks the current week", () => {
    renderYear();
    expect(screen.getByText("November")).toBeTruthy();
    expect(
      screen.getByTestId("week-head-2026-11-09").classList.contains("tl-weekhead--today"),
    ).toBe(true);
  });
});

describe("Quartal: day columns that fit or scroll", () => {
  const Q4 = periodOf("quartal", "2026-11-10");

  it("Q4 (92 days) fits 1144 px at a column of at least 10 px without overflow", () => {
    renderPlan({ period: Q4, widthPx: 1144, columnWidthPx: undefined, today: "2026-11-10" });
    const width = parseFloat(screen.getByTestId("plan-track-e1").style.width);
    expect(width / 92).toBeGreaterThanOrEqual(10);
    expect(160 + width).toBeLessThanOrEqual(1144);
    expect(screen.queryByTestId("timeline-overflow-hint")).toBeNull();
  });

  it("in 900 px it overflows: fade and „weiter →“ hint, month labels sticky", () => {
    renderPlan({ period: Q4, widthPx: 900, columnWidthPx: undefined, today: "2026-11-10" });
    expect(screen.getByTestId("timeline-overflow-hint").textContent).toContain("weiter →");
    expect(screen.getByTestId("timeline-overflow-fade")).toBeTruthy();
    expect(screen.getByTestId("absence-month-9").classList.contains("tl-month--sticky")).toBe(true);
    // The column never drops below 10 px.
    expect(parseFloat(screen.getByTestId("plan-track-e1").style.width) / 92).toBeGreaterThanOrEqual(
      10,
    );
  });

  it("the hint goes away once the content is scrolled to its end", async () => {
    renderPlan({ period: Q4, widthPx: 900, columnWidthPx: undefined, today: "2026-11-10" });
    const scroller = screen
      .getByTestId("absence-timeline")
      .querySelector<HTMLElement>(".tl-scroll");
    if (!scroller) throw new Error("no scroller");
    Object.defineProperty(scroller, "scrollLeft", { configurable: true, value: 500 });
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 900 });
    Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: 1400 });
    await fireEvent.scroll(scroller);
    expect(screen.queryByTestId("timeline-overflow-hint")).toBeNull();
  });
});

describe("Monat: markings", () => {
  function renderMonth(overrides: Record<string, unknown> = {}) {
    return renderPlan({
      rows: rows,
      period: NOVEMBER,
      holidays: [{ day: "2026-11-04", name: "Feiertag Beispiel" }],
      closedWeekdays: new Set([0]),
      today: "2026-11-10",
      widthPx: 600,
      columnWidthPx: undefined,
      ...overrides,
    });
  }

  it("keeps day columns at least 28 px wide", () => {
    renderMonth();
    expect(
      parseFloat(screen.getByTestId("absence-day-2026-11-02").style.width),
    ).toBeGreaterThanOrEqual(28);
  });

  it("marks weekend, closed weekday, holiday and today on the header cells", () => {
    renderMonth();
    const cls = (day: string) => screen.getByTestId(`absence-day-${day}`).classList;
    expect(cls("2026-11-07").contains("absence-day--weekend")).toBe(true);
    expect(cls("2026-11-02").contains("absence-day--closed")).toBe(true);
    expect(cls("2026-11-03").contains("absence-day--closed")).toBe(false);
    expect(cls("2026-11-04").contains("absence-day--holiday")).toBe(true);
    expect(cls("2026-11-10").contains("absence-day--today")).toBe(true);
    expect(cls("2026-11-11").contains("absence-day--today")).toBe(false);
  });

  it("a holiday header cell is focusable and names the holiday in title and aria-label", () => {
    renderMonth();
    const cell = screen.getByTestId("absence-day-2026-11-04");
    cell.focus();
    expect(document.activeElement).toBe(cell);
    expect(cell.getAttribute("title")).toBe("Feiertag Beispiel");
    expect(cell.getAttribute("aria-label")).toContain("Feiertag Beispiel");
  });

  it("draws closed days and the today marker behind the bars", () => {
    renderMonth();
    const track = screen.getByTestId("plan-track-e1");
    // November 2026 has five Mondays.
    expect(track.querySelectorAll(".tl-closed")).toHaveLength(5);
    expect(track.querySelector(".tl-today")).not.toBeNull();
  });

  it("without a single salon (null) nothing is closed", () => {
    renderMonth({ closedWeekdays: null });
    expect(screen.getByTestId("plan-track-e1").querySelectorAll(".tl-closed")).toHaveLength(0);
  });
});
