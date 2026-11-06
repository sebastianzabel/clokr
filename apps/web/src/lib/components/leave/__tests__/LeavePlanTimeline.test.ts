// Issue #835 (D-835-21) — the mounted test of the planner timeline. `lib/components/leave/` is
// outside `lint:ui-classes`, so this file is the safeguard for the component. The component
// imports neither the auth store nor the API client, so nothing needs mocking.
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, within } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import LeavePlanTimeline from "../LeavePlanTimeline.svelte";
import type { PlannerDay, PlannerPerson, PlannerWish } from "$lib/leave-plan/types";

function wish(overrides: Partial<PlannerWish> = {}): PlannerWish {
  return {
    id: "w1",
    planId: "plan-1",
    startDate: "2027-03-08",
    endDate: "2027-03-12",
    halfDay: false,
    foreignPlan: false,
    conflict: false,
    leaveRequestId: null,
    leaveRequestStatus: null,
    refusalCode: null,
    refusalMessage: null,
    editable: true,
    createdAt: "2027-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function person(overrides: Partial<PlannerPerson> = {}): PlannerPerson {
  return {
    employeeId: "e1",
    firstName: "Alex",
    lastName: "Muster",
    homeRanges: [{ from: "2027-01-01", to: "2027-12-31" }],
    rows: [],
    wishes: [],
    forecast: null,
    ...overrides,
  };
}

const twoPersons: PlannerPerson[] = [
  person({
    rows: [
      {
        kind: "LEAVE",
        state: "GESETZT",
        startDate: "2027-02-01",
        endDate: "2027-02-05",
        halfDay: false,
        typeCode: "VACATION",
      },
      {
        kind: "LEAVE",
        state: "BEANTRAGT",
        startDate: "2027-05-03",
        endDate: "2027-05-07",
        halfDay: false,
        typeCode: null,
      },
    ],
    wishes: [wish()],
  }),
  person({ employeeId: "e2", firstName: "Bea", lastName: "Beispiel" }),
];

function render(overrides: Record<string, unknown> = {}) {
  const props = {
    year: 2027,
    view: "year" as const,
    persons: twoPersons,
    holidays: [{ date: "2027-01-01", name: "Neujahr" }],
    dayLoad: [] as PlannerDay[],
    showForecast: false,
    columnWidthPx: 20,
    onMoveWish: vi.fn(),
    onEditWish: vi.fn(),
    onAddWish: vi.fn(),
    ...overrides,
  };
  renderWithTheme(LeavePlanTimeline, props);
  return props;
}

async function drag(target: HTMLElement, fromX: number, toX: number) {
  await fireEvent.pointerDown(target, { clientX: fromX, pointerId: 1, button: 0 });
  await fireEvent.pointerMove(target, { clientX: toX, pointerId: 1 });
  await fireEvent.pointerUp(target, { clientX: toX, pointerId: 1 });
}

describe("rows and bars", () => {
  it("renders one row per person with solid and dashed bars, wishes and holiday columns", () => {
    render();
    expect(screen.getByTestId("plan-row-e1")).toBeTruthy();
    expect(screen.getByTestId("plan-row-e2")).toBeTruthy();
    expect(screen.getByText("Alex Muster")).toBeTruthy();
    expect(screen.getByText("Bea Beispiel")).toBeTruthy();
    expect(screen.getByTestId("plan-bar-gesetzt").classList.contains("plan-bar--gesetzt")).toBe(
      true,
    );
    expect(screen.getByTestId("plan-bar-beantragt").classList.contains("plan-bar--beantragt")).toBe(
      true,
    );
    expect(screen.getByTestId("plan-wish-w1")).toBeTruthy();
    expect(screen.getAllByTestId("plan-holiday-2027-01-01").length).toBe(2);
  });

  it("names a masked type neutrally", () => {
    render();
    expect(screen.getByTestId("plan-bar-beantragt").getAttribute("title")).toContain("abwesend");
  });

  it("month view renders only March's columns", () => {
    render({ view: 2 });
    expect(screen.getByTestId("plan-month-2")).toBeTruthy();
    expect(screen.queryByTestId("plan-month-1")).toBeNull();
    // The February bar and the May bar lie outside; the March wish is shown.
    expect(screen.queryByTestId("plan-bar-gesetzt")).toBeNull();
    expect(screen.queryByTestId("plan-bar-beantragt")).toBeNull();
    expect(screen.getByTestId("plan-wish-w1")).toBeTruthy();
    expect(screen.getByTestId("plan-track-e1").style.width).toBe("620px");
  });
});

describe("drag and resize", () => {
  it("moving an editable wish by +3 columns calls onMoveWish once with the moved range", async () => {
    const props = render();
    await drag(screen.getByTestId("wish-bar-w1"), 100, 160);
    expect(props.onMoveWish).toHaveBeenCalledTimes(1);
    expect(props.onMoveWish).toHaveBeenCalledWith(expect.objectContaining({ id: "w1" }), {
      startDate: "2027-03-11",
      endDate: "2027-03-15",
    });
    expect(props.onEditWish).not.toHaveBeenCalled();
  });

  it("a drag of less than half a column calls nothing", async () => {
    const props = render();
    await drag(screen.getByTestId("wish-bar-w1"), 100, 108);
    expect(props.onMoveWish).not.toHaveBeenCalled();
  });

  it("the end handle by -2 columns moves the end by -2", async () => {
    const props = render();
    await drag(screen.getByTestId("wish-handle-end-w1"), 200, 160);
    expect(props.onMoveWish).toHaveBeenCalledWith(expect.objectContaining({ id: "w1" }), {
      startDate: "2027-03-08",
      endDate: "2027-03-10",
    });
  });

  it("the start handle by +1 column moves the start by +1", async () => {
    const props = render();
    await drag(screen.getByTestId("wish-handle-start-w1"), 100, 120);
    expect(props.onMoveWish).toHaveBeenCalledWith(expect.objectContaining({ id: "w1" }), {
      startDate: "2027-03-09",
      endDate: "2027-03-12",
    });
  });

  it.each([
    ["a foreign plan wish", { foreignPlan: true }],
    ["a taken-over wish", { leaveRequestId: "lr-1" }],
    ["a wish with editable false", { editable: false }],
  ])("%s has no handles and ignores drags", async (_name, patch) => {
    const props = render({ persons: [person({ wishes: [wish(patch)] })] });
    expect(screen.queryByTestId("wish-handle-start-w1")).toBeNull();
    expect(screen.queryByTestId("wish-handle-end-w1")).toBeNull();
    const body = screen.queryByTestId("wish-bar-w1");
    if (body) await drag(body, 100, 200);
    expect(props.onMoveWish).not.toHaveBeenCalled();
  });
});

describe("keyboard and adding", () => {
  it("Enter on a wish bar opens the edit form", async () => {
    const props = render();
    const bar = screen.getByTestId("wish-bar-w1");
    await fireEvent.keyDown(bar, { key: "Enter" });
    expect(props.onEditWish).toHaveBeenCalledTimes(1);
    expect(props.onEditWish).toHaveBeenCalledWith(expect.objectContaining({ id: "w1" }));
    expect(bar.getAttribute("aria-label")).toContain("Mit Enter bearbeiten");
  });

  it("a click on an empty day calls onAddWish with the person and the day", async () => {
    const props = render();
    // clientX 45 with 20 px columns and a rect starting at 0 is column 2 = 3 January.
    await fireEvent.click(screen.getByTestId("plan-track-e2"), { clientX: 45 });
    expect(props.onAddWish).toHaveBeenCalledWith("e2", "2027-01-03");
  });

  it("does not offer a wish where the person may not get one", async () => {
    const props = render({ canAddWishFor: (id: string) => id === "e1" });
    await fireEvent.click(screen.getByTestId("plan-track-e2"), { clientX: 45 });
    expect(props.onAddWish).not.toHaveBeenCalled();
  });

  it("does not offer a wish on a day outside the person's Stammsalon span", async () => {
    const props = render({
      persons: [person({ homeRanges: [{ from: "2027-06-01", to: "2027-12-31" }] })],
    });
    await fireEvent.click(screen.getByTestId("plan-track-e1"), { clientX: 45 });
    expect(props.onAddWish).not.toHaveBeenCalled();
  });
});

describe("day load", () => {
  const load: PlannerDay[] = [
    { day: "2027-03-10", count: 3, limits: null },
    {
      day: "2027-03-11",
      count: 4,
      limits: [
        {
          ruleId: "r1",
          ruleName: null,
          groupKey: "ALL",
          max: 3,
          count: 4,
          exceeded: true,
        },
      ],
    },
    {
      day: "2027-03-12",
      count: 2,
      limits: [
        {
          ruleId: "r1",
          ruleName: null,
          groupKey: "ALL",
          max: 3,
          count: 2,
          exceeded: false,
        },
      ],
    },
  ];

  it("shows the Urlaub count and marks exceeded days only from the API's limits", () => {
    render({ dayLoad: load });
    expect(within(screen.getByTestId("plan-day-load")).getAllByText("Urlaub")).toHaveLength(1);
    const plain = screen.getByTestId("day-load-2027-03-10");
    expect(plain.textContent?.trim()).toBe("3");
    expect(plain.dataset.exceeded).toBe("false");
    expect(screen.getByTestId("day-load-2027-03-11").dataset.exceeded).toBe("true");
    expect(screen.getByTestId("day-load-2027-03-12").dataset.exceeded).toBe("false");
  });

  it("marks nothing when no limits were sent, however high the count", () => {
    render({ dayLoad: [{ day: "2027-03-10", count: 99, limits: null }] });
    expect(screen.getByTestId("day-load-2027-03-10").dataset.exceeded).toBe("false");
  });
});

describe("forecast column", () => {
  it("shows the forecast, the warning when negative, and nothing for a null forecast", () => {
    const forecast = {
      entitlementBasis: "STORED" as const,
      remainingDays: 20,
      pendingDays: 0,
      wishDays: 5,
      forecastDays: 15,
      forecastNegative: false,
    };
    render({
      showForecast: true,
      persons: [
        person({ forecast }),
        person({
          employeeId: "e2",
          forecast: { ...forecast, forecastDays: -2, forecastNegative: true },
        }),
        person({ employeeId: "e3", forecast: null }),
      ],
    });
    expect(screen.getByText("Noch 15 Tage nach Plan")).toBeTruthy();
    expect(screen.getByText("Noch -2 Tage nach Plan")).toBeTruthy();
    expect(screen.getAllByText("Der Plan übersteigt den Anspruch")).toHaveLength(1);
    expect(screen.getByTestId("plan-forecast-e3").textContent?.trim()).toBe("");
  });

  it("renders no forecast column unless asked", () => {
    render({ persons: [person({ forecast: null })] });
    expect(screen.queryByTestId("plan-forecast-e1")).toBeNull();
  });
});
