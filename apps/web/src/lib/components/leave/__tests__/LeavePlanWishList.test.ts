// Issue #835 (D-835-21) — the mounted test of the mobile wish list.
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, within } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import LeavePlanWishList from "../LeavePlanWishList.svelte";
import type { PlannerPerson, PlannerWish } from "$lib/leave-plan/types";

function wish(id: string, overrides: Partial<PlannerWish> = {}): PlannerWish {
  return {
    id,
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

function person(id: string, first: string, last: string, wishes: PlannerWish[]): PlannerPerson {
  return {
    employeeId: id,
    firstName: first,
    lastName: last,
    homeRanges: [{ from: "2027-01-01", to: "2027-12-31" }],
    rows: [],
    wishes,
    forecast: null,
  };
}

const persons = [
  person("e3", "Zoe", "Zander", [wish("w3")]),
  person("e1", "Alex", "Muster", [
    wish("w2", { startDate: "2027-07-01", endDate: "2027-07-01", halfDay: true }),
    wish("w1", { conflict: true }),
  ]),
  person("e2", "Bea", "Beispiel", [wish("w4", { editable: false })]),
  person("e4", "Ohne", "Wunsch", []),
];

function render(overrides: Record<string, unknown> = {}) {
  const props = {
    persons,
    ownEmployeeId: "e1",
    onEdit: vi.fn(),
    onRemove: vi.fn(),
    onAdd: vi.fn(),
    ...overrides,
  };
  renderWithTheme(LeavePlanWishList, props);
  return props;
}

describe("order and content", () => {
  it("shows the own person first, then colleagues with wishes by name", () => {
    render();
    const groups = screen
      .getAllByTestId(/^wish-group-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(groups).toEqual(["wish-group-e1", "wish-group-e2", "wish-group-e3"]);
    expect(screen.queryByTestId("wish-group-e4")).toBeNull();
    expect(screen.getByText("Meine Wünsche")).toBeTruthy();
  });

  it("lists a person's wishes by start date with dates, half day and conflict hint", () => {
    render();
    const own = within(screen.getByTestId("wish-group-e1"));
    const items = own.getAllByTestId(/^wish-item-/).map((el) => el.getAttribute("data-testid"));
    expect(items).toEqual(["wish-item-w1", "wish-item-w2"]);
    expect(own.getByText(/08\.03\.2027 – 12\.03\.2027/)).toBeTruthy();
    expect(own.getByText("halber Tag")).toBeTruthy();
    expect(screen.getByTestId("wish-conflict-w1").textContent).toBe(
      "Überschneidet sich mit einem Antrag",
    );
    expect(screen.queryByTestId("wish-conflict-w2")).toBeNull();
  });

  it("shows the own person with a calm empty state when there are no wishes", () => {
    render({ persons: [person("e1", "Alex", "Muster", [])] });
    expect(screen.getByText("Noch keine Wünsche")).toBeTruthy();
  });
});

describe("actions", () => {
  it("offers edit and remove only for an editable wish", async () => {
    const props = render();
    expect(screen.getByTestId("wish-edit-w1")).toBeTruthy();
    expect(screen.queryByTestId("wish-edit-w4")).toBeNull();
    expect(screen.queryByTestId("wish-remove-w4")).toBeNull();

    await fireEvent.click(screen.getByTestId("wish-edit-w1"));
    expect(props.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "w1" }));
    await fireEvent.click(screen.getByTestId("wish-remove-w2"));
    expect(props.onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: "w2" }));
  });

  it("offers no actions for a taken-over or foreign-plan wish even if editable says so", () => {
    render({
      persons: [
        person("e1", "Alex", "Muster", [
          wish("w1", { leaveRequestId: "lr-1" }),
          wish("w2", { foreignPlan: true }),
        ]),
      ],
    });
    expect(screen.queryByTestId("wish-edit-w1")).toBeNull();
    expect(screen.queryByTestId("wish-edit-w2")).toBeNull();
    expect(screen.getByText("Übernommen – nicht mehr änderbar")).toBeTruthy();
  });

  it("„Wunsch hinzufügen“ calls onAdd with the own employee id and can be hidden", async () => {
    const props = render();
    await fireEvent.click(screen.getByText("Wunsch hinzufügen"));
    expect(props.onAdd).toHaveBeenCalledWith("e1");
  });

  it("hides the add button when adding is not possible", () => {
    render({ canAdd: false });
    expect(screen.queryByTestId("wish-add")).toBeNull();
  });
});
