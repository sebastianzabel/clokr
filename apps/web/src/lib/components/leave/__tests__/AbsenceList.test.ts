// Issue #840 (D-840-11) — the mobile list of the same model. The type is named by text, a masked
// bar reads „abwesend“ and never names a type, a requested bar says „beantragt“ in words.
import { describe, it, expect, vi } from "vitest";
import { screen, within, fireEvent } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import AbsenceList from "../timeline/AbsenceList.svelte";
import { periodOf, type TimelineBar, type TimelinePerson } from "$lib/leave/timeline-model";

const NOVEMBER = periodOf("monat", "2026-11-15");

const bar = (over: Partial<TimelineBar>): TimelineBar => ({
  key: "b",
  start: "2026-11-02",
  end: "2026-11-04",
  style: "gesetzt",
  typeCode: "VACATION",
  label: "Urlaub",
  editable: false,
  ...over,
});

const person = (over: Partial<TimelinePerson>): TimelinePerson => ({
  employeeId: "e1",
  name: "Anna Muster",
  isOwn: false,
  bars: [],
  ...over,
});

function render(rows: TimelinePerson[], extra: Record<string, unknown> = {}) {
  const onBarSelect = vi.fn();
  renderWithTheme(AbsenceList, { rows, period: NOVEMBER, onBarSelect, ...extra });
  return { onBarSelect };
}

describe("persons", () => {
  it("lists only persons with at least one bar in the period", () => {
    render([
      person({ employeeId: "in", name: "Anna Muster", bars: [bar({ key: "a" })] }),
      person({ employeeId: "empty", name: "Leer Leute", bars: [] }),
      person({
        employeeId: "later",
        name: "Spaet Dran",
        bars: [bar({ key: "x", start: "2026-12-07", end: "2026-12-08" })],
      }),
    ]);
    expect(screen.getByTestId("absence-list-person-in")).toBeTruthy();
    expect(screen.queryByTestId("absence-list-person-empty")).toBeNull();
    expect(screen.queryByTestId("absence-list-person-later")).toBeNull();
  });

  it("puts the own person first, then the others by name", () => {
    render([
      person({ employeeId: "z", name: "Zora Zeit", bars: [bar({ key: "z" })] }),
      person({ employeeId: "m", name: "Max Mueller", isOwn: true, bars: [bar({ key: "m" })] }),
      person({ employeeId: "a", name: "Anna Abel", bars: [bar({ key: "a" })] }),
    ]);
    const order = screen
      .getAllByTestId(/^absence-list-person-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual([
      "absence-list-person-m",
      "absence-list-person-a",
      "absence-list-person-z",
    ]);
  });

  it("orders the lines of a person by start day", () => {
    render([
      person({
        bars: [
          bar({ key: "late", start: "2026-11-20", end: "2026-11-21" }),
          bar({ key: "early", start: "2026-11-02", end: "2026-11-03" }),
        ],
      }),
    ]);
    const lines = screen.getAllByTestId(/^absence-list-line-/).map((el) => el.dataset.testid);
    expect(lines).toEqual(["absence-list-line-early", "absence-list-line-late"]);
  });
});

describe("lines", () => {
  it("names the German date range and the type by text, with a colour dot", () => {
    render([person({ bars: [bar({ key: "a" })] })]);
    const line = screen.getByTestId("absence-list-line-a");
    expect(within(line).getByText("02.11.2026 – 04.11.2026")).toBeTruthy();
    expect(within(line).getByText("Urlaub")).toBeTruthy();
    const dot = line.querySelector<HTMLElement>(".absence-list-dot");
    expect(dot?.style.background).toContain("--leave-type-vacation");
  });

  it("a single day shows one date, a half day says so", () => {
    render([
      person({ bars: [bar({ key: "a", start: "2026-11-02", end: "2026-11-02", halfDay: true })] }),
    ]);
    expect(screen.getByText("02.11.2026 (halber Tag)")).toBeTruthy();
  });

  it("a requested bar adds „beantragt“ in text", () => {
    render([person({ bars: [bar({ key: "r", style: "beantragt" })] })]);
    expect(within(screen.getByTestId("absence-list-line-r")).getByText("beantragt")).toBeTruthy();
    render([person({ employeeId: "e9", bars: [bar({ key: "s" })] })]);
    expect(within(screen.getByTestId("absence-list-line-s")).queryByText("beantragt")).toBeNull();
  });

  it("a masked bar reads „abwesend“ with the neutral colour and names no type", () => {
    render([
      person({
        bars: [bar({ key: "m", style: "abwesend", typeCode: null, label: "abwesend" })],
      }),
    ]);
    const line = screen.getByTestId("absence-list-line-m");
    expect(within(line).getByText("abwesend")).toBeTruthy();
    expect(line.textContent).not.toMatch(/Urlaub|Krank/);
    expect(line.querySelector<HTMLElement>(".absence-list-dot")?.style.background).toContain(
      "--leave-type-absent",
    );
  });

  it("a wish reads „Wunsch“ and is no selectable line", () => {
    const { onBarSelect } = render([
      person({
        bars: [bar({ key: "w", style: "wunsch", typeCode: null, label: "Wunsch", editable: true })],
      }),
    ]);
    const line = screen.getByTestId("absence-list-line-w");
    expect(within(line).getByText("Wunsch")).toBeTruthy();
    expect(within(line).queryByRole("button")).toBeNull();
    expect(onBarSelect).not.toHaveBeenCalled();
  });
});

describe("selecting", () => {
  it("a click on a non-wish line calls onBarSelect with the bar", async () => {
    const { onBarSelect } = render([person({ bars: [bar({ key: "a" })] })]);
    await fireEvent.click(within(screen.getByTestId("absence-list-line-a")).getByRole("button"));
    expect(onBarSelect).toHaveBeenCalledTimes(1);
    expect(onBarSelect).toHaveBeenCalledWith(expect.objectContaining({ key: "a" }));
  });

  it("without a callback the lines are plain text, not buttons", () => {
    renderWithTheme(AbsenceList, {
      rows: [person({ bars: [bar({ key: "a" })] })],
      period: NOVEMBER,
    });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("empty period", () => {
  it("shows the empty state with a German du-form sentence", () => {
    render([person({ bars: [] })]);
    expect(screen.getByText("Keine Abwesenheiten")).toBeTruthy();
    const text = screen.getByText(/Wähle einen anderen Zeitraum/).textContent ?? "";
    expect(text).toContain("du");
    expect(text).not.toMatch(/\bSie\b|\bIhr/);
  });
});

describe("holidays", () => {
  it("names the holidays of the period above the list", () => {
    render([person({ bars: [bar({ key: "a" })] })], {
      holidays: [
        { day: "2026-11-04", name: "Feiertag Beispiel" },
        { day: "2026-12-25", name: "Weihnachten" },
      ],
    });
    const note = screen.getByTestId("absence-list-holidays").textContent ?? "";
    expect(note).toContain("04.11.2026 Feiertag Beispiel");
    expect(note).not.toContain("Weihnachten");
  });
});
