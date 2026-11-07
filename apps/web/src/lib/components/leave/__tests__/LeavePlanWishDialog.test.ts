// Issue #835 (D-835-21) — the mounted test of the wish form. `lib/components/leave/` is outside
// `lint:ui-classes`, so this file is the safeguard for the component.
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import LeavePlanWishDialog from "../LeavePlanWishDialog.svelte";
import type { PlannerWish } from "$lib/leave-plan/types";

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

function render(overrides: Record<string, unknown> = {}) {
  const props = {
    open: true,
    year: 2027,
    persons: null,
    wish: null,
    onSave: vi.fn().mockResolvedValue(undefined),
    onRemove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  renderWithTheme(LeavePlanWishDialog, props);
  return props;
}

const input = (id: string) => screen.getByTestId(id) as HTMLInputElement;

async function setDates(from: string, to: string) {
  await fireEvent.input(input("wish-start"), { target: { value: from } });
  await fireEvent.input(input("wish-end"), { target: { value: to } });
}

describe("person field", () => {
  it("is absent for an own wish", () => {
    render();
    expect(screen.queryByTestId("wish-person")).toBeNull();
  });

  it("is a select for a manager, preselected from defaults.employeeId", () => {
    render({
      persons: [
        { employeeId: "e1", label: "Alex Muster" },
        { employeeId: "e2", label: "Bea Beispiel" },
      ],
      defaults: { employeeId: "e2", startDate: "2027-04-05" },
    });
    expect((screen.getByTestId("wish-person") as HTMLSelectElement).value).toBe("e2");
    expect(input("wish-start").value).toBe("2027-04-05");
    expect(input("wish-end").value).toBe("2027-04-05");
  });
});

describe("half day", () => {
  it("is offered only when Von equals Bis and is unticked and hidden when Bis changes", async () => {
    render({ defaults: { startDate: "2027-04-05" } });
    const half = input("wish-half-day");
    await fireEvent.click(half);
    expect(half.checked).toBe(true);

    await fireEvent.input(input("wish-end"), { target: { value: "2027-04-07" } });
    await waitFor(() => expect(screen.queryByTestId("wish-half-day")).toBeNull());

    await fireEvent.input(input("wish-end"), { target: { value: "2027-04-05" } });
    const again = await screen.findByTestId("wish-half-day");
    expect((again as HTMLInputElement).checked).toBe(false);
  });

  it("is not offered for a range", () => {
    render({ wish: wish() });
    expect(screen.queryByTestId("wish-half-day")).toBeNull();
  });
});

describe("saving", () => {
  it("calls onSave with the payload", async () => {
    const props = render();
    await setDates("2027-06-01", "2027-06-04");
    await fireEvent.click(screen.getByTestId("wish-save"));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(1));
    expect(props.onSave).toHaveBeenCalledWith({
      startDate: "2027-06-01",
      endDate: "2027-06-04",
      halfDay: false,
    });
  });

  it("names the chosen person for a manager and sends halfDay for a single day", async () => {
    const props = render({
      persons: [{ employeeId: "e2", label: "Bea Beispiel" }],
      defaults: { employeeId: "e2", startDate: "2027-06-01" },
    });
    await fireEvent.click(input("wish-half-day"));
    await fireEvent.click(screen.getByTestId("wish-save"));
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    expect(props.onSave).toHaveBeenCalledWith({
      employeeId: "e2",
      startDate: "2027-06-01",
      endDate: "2027-06-01",
      halfDay: true,
    });
  });

  it("stays open and shows the server's German message on LEAVE_PLAN_WISH_OVERLAP", async () => {
    const message = "Überschneidung mit einem anderen Urlaubswunsch";
    const onSave = vi.fn().mockRejectedValue(
      Object.assign(new Error("Fehler"), {
        status: 409,
        data: { error: message, code: "LEAVE_PLAN_WISH_OVERLAP" },
      }),
    );
    render({ onSave });
    await setDates("2027-06-01", "2027-06-04");
    await fireEvent.click(screen.getByTestId("wish-save"));
    const error = await screen.findByTestId("wish-error");
    expect(error.textContent).toContain(message);
    expect(screen.getByTestId("leave-plan-wish-form")).toBeTruthy();
  });

  it("does not call onSave for an incomplete or inverted range", async () => {
    const props = render();
    await fireEvent.click(screen.getByTestId("wish-save"));
    expect((await screen.findByTestId("wish-error")).textContent).toContain("Von und Bis");
    await setDates("2027-06-05", "2027-06-01");
    await fireEvent.click(screen.getByTestId("wish-save"));
    expect(props.onSave).not.toHaveBeenCalled();
  });
});

describe("year bounds", () => {
  it("bounds the date inputs to the plan year", () => {
    render();
    for (const id of ["wish-start", "wish-end"]) {
      expect(input(id).max).toBe("2027-12-31");
    }
    expect(input("wish-start").min).toBe("2027-01-01");
  });
});

describe("edit mode", () => {
  it("prefills the wish and removes it through onRemove", async () => {
    const props = render({ wish: wish() });
    expect(input("wish-start").value).toBe("2027-03-08");
    expect(input("wish-end").value).toBe("2027-03-12");
    await fireEvent.click(screen.getByTestId("wish-remove"));
    await waitFor(() => expect(props.onRemove).toHaveBeenCalledTimes(1));
    expect(props.onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: "w1" }));
  });

  it("opens a taken-over wish read-only with the hint and without save or remove", () => {
    render({ wish: wish({ leaveRequestId: "lr-1", editable: false }) });
    expect(screen.getByTestId("wish-read-only-hint").textContent).toContain("Übernommen");
    expect(input("wish-start").disabled).toBe(true);
    expect(screen.queryByTestId("wish-save")).toBeNull();
    expect(screen.queryByTestId("wish-remove")).toBeNull();
  });

  it("offers no remove button without onRemove", () => {
    render({ wish: wish(), onRemove: undefined });
    expect(screen.queryByTestId("wish-remove")).toBeNull();
  });
});
