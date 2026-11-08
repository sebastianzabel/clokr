// Issue #840 (D-840-07/10) — the mounted test of the absence timeline (tracer subset). The
// component imports neither the auth store nor the API client, so nothing needs mocking.
// `lib/components/leave/` is outside `lint:ui-classes`, so this file is its safeguard.
import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import AbsenceTimeline from "../timeline/AbsenceTimeline.svelte";
import { periodOf, type TimelinePerson } from "$lib/leave/timeline-model";

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
