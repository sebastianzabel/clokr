// Issue #588 (AC-588-1, AC-588-2, AC-588-3, D-588-1, D-588-5, D-588-7, P-07, P-11, P-12) - the dashboard
// card "Salden", mounted. chart.js is replaced by a stub class that records the config it was
// built with and every `destroy` call, so the bar chart is asserted on its configuration (jsdom has
// no canvas). Rows are shaped like the answer of GET /dashboard/overtime-overview.
/* eslint-disable @typescript-eslint/no-explicit-any -- the recorded chart.js config is asserted as-is */
const charts: Array<{ config: any; destroyed: boolean }> = [];

vi.mock("chart.js", () => {
  class Chart {
    static register = vi.fn();
    config: any;
    destroyed = false;
    constructor(_canvas: unknown, config: any) {
      this.config = config;
      charts.push(this as unknown as { config: any; destroyed: boolean });
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const stub = class {};
  return {
    Chart,
    BarController: stub,
    BarElement: stub,
    CategoryScale: stub,
    LinearScale: stub,
    Tooltip: stub,
  };
});

// page-scope (the shared salon wording) pulls in the api client; a stand-in keeps this file free of
// the auth store bootstrap, as in SalonScopeLabel.test.ts. The card itself requests nothing.
vi.mock("$api/client", () => ({
  api: { get: vi.fn() },
  ApiError: class ApiError extends Error {},
}));
vi.mock("$lib/utils/logger", () => ({ clientLogger: { warn: vi.fn(), error: vi.fn() } }));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import TeamSaldoCard from "../TeamSaldoCard.svelte";
import type { TeamSaldoRow } from "$lib/reports/team-saldo";
import { CHART_UNIT_TITLE } from "$lib/utils/chart-theme";
import { PERSON_SALDO_NOT_SPLIT_LABEL, SALON_HOME_PERSONS_NOTE } from "$lib/salons/page-scope";

function row(n: number, totalMinutes: number, extra: Partial<TeamSaldoRow> = {}): TeamSaldoRow {
  return {
    id: `id-${n}`,
    name: `Person ${String.fromCharCode(64 + n)}`,
    balanceHours: totalMinutes / 60,
    confirmedMinutes: totalMinutes,
    openMonthMinutes: 0,
    hasClosedMonth: true,
    hasRecordedTime: true,
    trackOnly: false,
    unconfirmedMonths: 1,
    ...extra,
  };
}

// Totals +2:00, +0:30, -1:00 -> median +0:30 (the tracer rows of 588-01).
const ROWS: TeamSaldoRow[] = [row(1, 120), row(2, 30), row(3, -60)];
const href = (id: string) => `/team/time-entries?employeeId=${id}`;

function mountCard(props: Record<string, unknown> = {}) {
  return renderWithTheme(TeamSaldoCard, {
    rows: ROWS,
    loading: false,
    salonFiltered: false,
    personHref: href,
    onOpenPerson: vi.fn(),
    ...props,
  });
}

beforeEach(() => {
  charts.length = 0;
  document.documentElement.style.setProperty("--good", "rgb(0, 128, 0)");
  document.documentElement.style.setProperty("--bad", "rgb(200, 0, 0)");
  document.documentElement.style.setProperty("--text-muted", "rgb(90, 90, 90)");
  document.documentElement.style.setProperty("--border", "rgb(220, 220, 220)");
});

afterEach(() => {
  cleanup();
});

describe("TeamSaldoCard (Issue #588)", () => {
  it("shows the heading and the team median as +-H:MM with its label and the counted persons", () => {
    mountCard();
    expect(screen.getByText("Salden")).toBeInTheDocument();
    const median = screen.getByTestId("team-saldo-median");
    expect(median).toHaveTextContent("Team-Median");
    expect(median).toHaveTextContent("+0:30");
    expect(median).toHaveTextContent("3 Personen");
  });

  it("lists the persons in the diverging order: plus largest first, minus with the most negative last", () => {
    mountCard({
      rows: [row(1, 120), row(2, 30), row(3, -60), row(4, -300), row(5, 600)],
    });
    const items = screen.getAllByRole("listitem").filter((li) => li.closest("ol") !== null);
    const texts = items.map((li) => li.textContent?.replace(/\s+/g, " ").trim());
    expect(texts).toEqual([
      "Person E +10:00",
      "Person A +2:00",
      "Person B +0:30",
      "Person C −1:00",
      "Person D −5:00",
    ]);
  });

  it("links every name to Team-Zeiten when personHref gives a target", () => {
    mountCard();
    const link = screen.getByRole("link", { name: "Person A" });
    expect(link).toHaveAttribute("href", "/team/time-entries?employeeId=id-1");
    expect(screen.getAllByRole("link")).toHaveLength(3);
  });

  it("renders plain names and no anchor when personHref gives null", () => {
    const { container } = mountCard({ personHref: () => null });
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("Person A")).toBeInTheDocument();
  });

  it("builds one horizontal bar chart with hours, theme colours and a titled hour axis", () => {
    mountCard();
    expect(charts).toHaveLength(1);
    const { config } = charts[0];
    expect(config.type).toBe("bar");
    expect(config.options.indexAxis).toBe("y");
    expect(config.data.labels).toEqual(["Person A", "Person B", "Person C"]);
    expect(config.data.datasets).toHaveLength(1);
    expect(config.data.datasets[0].data).toEqual([2, 0.5, -1]);
    expect(config.data.datasets[0].backgroundColor).toEqual([
      "rgb(0, 128, 0)",
      "rgb(0, 128, 0)",
      "rgb(200, 0, 0)",
    ]);
    expect(config.options.scales.x.title.text).toBe(CHART_UNIT_TITLE.hours);
    expect(config.options.scales.x.title.text).toBe("Stunden (h)");
    expect(config.options.plugins.legend.display).toBe(false);
    expect(config.options.maintainAspectRatio).toBe(false);
    expect(config.options.animation).toBe(false);
    expect(JSON.stringify(config)).not.toContain("tension");
    // The tooltip words a bar as +-H:MM, never as a decimal number.
    expect(config.options.plugins.tooltip.callbacks.label({ dataIndex: 2 })).toBe("−1:00");
    // The zero line is emphasised through the grid colour callback on tick value 0.
    const gridColor = config.options.scales.x.grid.color;
    expect(gridColor({ tick: { value: 0 } })).not.toBe(gridColor({ tick: { value: 1 } }));
  });

  it("labels the canvas with the chart type and unit it draws", () => {
    const { container } = mountCard();
    expect(container.querySelector("canvas")).toHaveAttribute(
      "aria-label",
      "Balkendiagramm: höchste Plus- und Minus-Salden im Team, in Stunden",
    );
  });

  it("opens the person of the clicked bar through onOpenPerson", () => {
    const onOpenPerson = vi.fn();
    mountCard({ onOpenPerson });
    charts[0].config.options.onClick({}, [{ index: 1 }]);
    expect(onOpenPerson).toHaveBeenCalledWith("/team/time-entries?employeeId=id-2");
    charts[0].config.options.onClick({}, []);
    expect(onOpenPerson).toHaveBeenCalledTimes(1);
  });

  it("does not call onOpenPerson for a bar whose href is null", () => {
    const onOpenPerson = vi.fn();
    mountCard({ onOpenPerson, personHref: () => null });
    charts[0].config.options.onClick({}, [{ index: 0 }]);
    expect(onOpenPerson).not.toHaveBeenCalled();
  });

  it("lists excluded persons with their reason, the first five and then 'und N weitere'", () => {
    const excluded = Array.from({ length: 7 }, (_, i) =>
      row(10 + i, 0, { trackOnly: true, openMonthMinutes: 0 }),
    );
    mountCard({ rows: [...ROWS, ...excluded] });
    const section = screen.getByTestId("team-saldo-excluded");
    expect(section).toHaveTextContent("Nicht in der Kennzahl");
    expect(section.querySelectorAll("li")).toHaveLength(5);
    expect(section).toHaveTextContent("nur Zeiterfassung");
    expect(section).toHaveTextContent("und 2 weitere");
  });

  it("names the reason of each excluded person", () => {
    mountCard({
      rows: [
        ...ROWS,
        row(20, 0, { openMonthMinutes: null }),
        row(21, 0, { hasRecordedTime: false }),
      ],
    });
    const section = screen.getByTestId("team-saldo-excluded");
    expect(section).toHaveTextContent("Saldo nicht verfügbar");
    expect(section).toHaveTextContent("ohne Erfassung");
    expect(section).not.toHaveTextContent("und");
  });

  it("shows the salon note built from the shared constants only when the request was salon-filtered", () => {
    const { unmount } = mountCard({ salonFiltered: true });
    expect(
      screen.getByText(`${SALON_HOME_PERSONS_NOTE} · ${PERSON_SALDO_NOT_SPLIT_LABEL}`),
    ).toBeInTheDocument();
    expect(`${SALON_HOME_PERSONS_NOTE} · ${PERSON_SALDO_NOT_SPLIT_LABEL}`).toBe(
      "Personen nach Stammsalon · Personensaldo, nicht nach Salon aufgeteilt",
    );
    unmount();
    mountCard({ salonFiltered: false });
    expect(screen.queryByText(/Personen nach Stammsalon/)).toBeNull();
  });

  it("shows an empty text and no chart when no row is in reach", () => {
    mountCard({ rows: [] });
    expect(screen.getByText("Keine Salden in Ihrer Reichweite")).toBeInTheDocument();
    expect(charts).toHaveLength(0);
    expect(screen.queryByTestId("team-saldo-values")).toBeNull();
  });

  it("shows a dash median and no chart when every person is excluded", () => {
    mountCard({ rows: [row(1, 0, { trackOnly: true })] });
    expect(screen.getByTestId("team-saldo-median")).toHaveTextContent("Team-Median: —");
    expect(charts).toHaveLength(0);
    expect(screen.getByTestId("team-saldo-excluded")).toBeInTheDocument();
  });

  it("shows the skeleton and no chart while loading", () => {
    const { container } = mountCard({ loading: true });
    expect(container.querySelector(".saldo-skeleton")).not.toBeNull();
    expect(screen.getByText("Salden")).toBeInTheDocument();
    expect(charts).toHaveLength(0);
    expect(screen.queryByText("Keine Salden in Ihrer Reichweite")).toBeNull();
  });

  it("destroys the chart on unmount and replaces it when the rows change", async () => {
    const { unmount, rerender } = mountCard();
    expect(charts).toHaveLength(1);
    await rerender({ rows: [row(1, 300), row(2, -120)] });
    expect(charts).toHaveLength(2);
    expect(charts[0].destroyed).toBe(true);
    expect(charts[1].config.data.datasets[0].data).toEqual([5, -2]);
    unmount();
    expect(charts[1].destroyed).toBe(true);
  });
});
