// Issue #835 (D-835-26/27, AC-7) — the mounted test of the takeover flow. `lib/components/leave/`
// is outside `lint:ui-classes`, so this file is the safeguard for the component. The API module
// is mocked; the dialog primitives (ConfirmDialog, Modal, ReasonDialog) are the real ones.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import LeavePlanTakeoverDialog from "../LeavePlanTakeoverDialog.svelte";
import type { PlannerPerson, PlannerWish, TakeoverResult } from "$lib/leave-plan/types";

vi.mock("$stores/auth", () => ({ authStore: { subscribe: () => () => {} } }));
vi.mock("$api/client", () => ({ api: {} }));

const takeOver = vi.fn();
vi.mock("$lib/leave-plan/api", () => ({
  takeOver: (...args: unknown[]) => takeOver(...args),
}));

function wish(id: string, startDate: string, endDate: string): PlannerWish {
  return {
    id,
    planId: "plan-1",
    startDate,
    endDate,
    halfDay: false,
    foreignPlan: false,
    conflict: false,
    leaveRequestId: null,
    leaveRequestStatus: null,
    refusalCode: null,
    refusalMessage: null,
    editable: true,
    createdAt: "2027-01-01T00:00:00.000Z",
  };
}

function person(employeeId: string, firstName: string, lastName: string, wishes: PlannerWish[]) {
  return {
    employeeId,
    firstName,
    lastName,
    homeRanges: [],
    rows: [],
    wishes,
    forecast: null,
  } satisfies PlannerPerson;
}

const personsById: Record<string, PlannerPerson> = {
  e1: person("e1", "Alex", "Muster", [wish("w1", "2027-03-08", "2027-03-12")]),
  e2: person("e2", "Bea", "Beispiel", [wish("w2", "2027-04-05", "2027-04-05")]),
  e3: person("e3", "Cem", "Check", [wish("w3", "2027-05-03", "2027-05-07")]),
  e4: person("e4", "Dana", "Dach", [wish("w4", "2027-06-07", "2027-06-11")]),
};

const LIMIT = "LEAVE_LIMIT_EXCEPTION_REQUIRED";

function resultOf(overrides: Partial<TakeoverResult> = {}): TakeoverResult {
  return {
    created: [{ wishId: "w1", employeeId: "e1", leaveRequestId: "r1" }],
    pending: [{ wishId: "w2", employeeId: "e2", leaveRequestId: "r2", reason: "OWN_WISH" }],
    refused: [
      { wishId: "w3", employeeId: "e3", code: LIMIT, error: "Urlaubsgrenze überschritten." },
      { wishId: "w4", employeeId: "e4", code: LIMIT, error: "Urlaubsgrenze überschritten." },
    ],
    planStatus: "OPEN",
    ...overrides,
  };
}

function render(overrides: Record<string, unknown> = {}) {
  const props = {
    open: true,
    planId: "plan-1",
    openWishCount: 4,
    personsById,
    onDone: vi.fn(),
    ...overrides,
  };
  renderWithTheme(LeavePlanTakeoverDialog, props);
  return props;
}

const dialogs = () => screen.queryAllByRole("dialog");
const clickConfirm = () => fireEvent.click(screen.getByRole("button", { name: /Übernehmen/ }));

beforeEach(() => {
  takeOver.mockReset();
});

describe("confirm step", () => {
  it("shows the number of open wishes and the four-eyes sentence", () => {
    render();
    expect(screen.getByTestId("takeover-count").textContent).toContain("4 offene Wünsche");
    expect(
      screen.getByText(
        "Deine eigenen Wünsche werden als Antrag zur Genehmigung durch eine andere Person angelegt.",
      ),
    ).toBeTruthy();
    expect(dialogs()).toHaveLength(1);
  });

  it("uses the singular for one wish", () => {
    render({ openWishCount: 1 });
    expect(screen.getByTestId("takeover-count").textContent).toContain("1 offener Wunsch");
  });

  it("calls takeOver(planId) exactly once on confirm, without exceptions", async () => {
    takeOver.mockResolvedValue(resultOf({ refused: [] }));
    render();
    await clickConfirm();
    await screen.findByTestId("takeover-result");
    expect(takeOver).toHaveBeenCalledTimes(1);
    expect(takeOver).toHaveBeenCalledWith("plan-1");
  });

  it("shows a busy state while the takeover runs and never two dialogs at once", async () => {
    let finish!: (value: TakeoverResult) => void;
    takeOver.mockReturnValue(new Promise<TakeoverResult>((resolve) => (finish = resolve)));
    render();
    await clickConfirm();
    const confirm = screen.getByRole("button", { name: /Übernehmen/ }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(dialogs()).toHaveLength(1);
    finish(resultOf({ refused: [] }));
    await screen.findByTestId("takeover-result");
    expect(dialogs()).toHaveLength(1);
    expect(screen.queryByTestId("takeover-confirm")).toBeNull();
  });

  it("keeps the dialog open with the server's message on an API error", async () => {
    const err = Object.assign(new Error("Fehler"), {
      status: 409,
      data: { error: "Die Planung wurde bereits übernommen.", code: "LEAVE_PLAN_CLOSED" },
    });
    takeOver.mockRejectedValue(err);
    const props = render();
    await clickConfirm();
    const text = await screen.findByTestId("takeover-error");
    expect(text.textContent).toBe("Die Planung wurde bereits übernommen.");
    expect(screen.getByTestId("takeover-confirm")).toBeTruthy();
    expect(screen.queryByTestId("takeover-result")).toBeNull();
    expect(props.onDone).not.toHaveBeenCalled();
  });

  it("does not call onDone when cancelled before a takeover ran", async () => {
    const props = render();
    await fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(dialogs()).toHaveLength(0));
    expect(takeOver).not.toHaveBeenCalled();
    expect(props.onDone).not.toHaveBeenCalled();
  });
});

describe("result step", () => {
  it("lists created, pending (with its reason label) and refused wishes by person and dates", async () => {
    takeOver.mockResolvedValue(resultOf());
    render();
    await clickConfirm();
    const created = await screen.findByTestId("takeover-created");
    expect(created.textContent).toContain("Alex Muster");
    expect(created.textContent).toContain("08.03.2027 – 12.03.2027");
    const pending = screen.getByTestId("takeover-pending");
    expect(pending.textContent).toContain("Bea Beispiel");
    expect(pending.textContent).toContain("05.04.2027");
    expect(pending.textContent).toContain("Eigener Wunsch – wartet auf eine zweite Genehmigung");
    const refused = screen.getByTestId("takeover-refused");
    expect(refused.textContent).toContain("Cem Check");
    expect(refused.textContent).toContain("Urlaubsgrenze überschritten.");
  });

  it("states whether the plan is now Übernommen or still Offen", async () => {
    takeOver.mockResolvedValue(resultOf({ refused: [], planStatus: "TAKEN_OVER" }));
    render();
    await clickConfirm();
    expect((await screen.findByTestId("takeover-plan-status")).textContent).toContain("Übernommen");
  });

  it("shows Offen while a refusal keeps the plan open", async () => {
    takeOver.mockResolvedValue(resultOf());
    render();
    await clickConfirm();
    expect((await screen.findByTestId("takeover-plan-status")).textContent).toContain("Offen");
  });

  it("calls onDone after the dialog closed", async () => {
    takeOver.mockResolvedValue(resultOf({ refused: [], planStatus: "TAKEN_OVER" }));
    const props = render();
    await clickConfirm();
    await fireEvent.click(await screen.findByTestId("takeover-done"));
    await waitFor(() => expect(dialogs()).toHaveLength(0));
    expect(props.onDone).toHaveBeenCalledTimes(1);
  });

  it("offers 'Ausnahme begründen' only when a limit refusal exists", async () => {
    takeOver.mockResolvedValue(
      resultOf({
        refused: [{ wishId: "w3", employeeId: "e3", code: "OTHER_CODE", error: "Nein." }],
      }),
    );
    render();
    await clickConfirm();
    await screen.findByTestId("takeover-result");
    expect(screen.queryByTestId("takeover-explain")).toBeNull();
  });
});

describe("limit exception reason", () => {
  async function toReason() {
    takeOver.mockResolvedValueOnce(resultOf());
    const props = render();
    await clickConfirm();
    await fireEvent.click(await screen.findByTestId("takeover-explain"));
    await screen.findByLabelText(/Begründung der Ausnahme/);
    return props;
  }

  it("closes the result dialog first and opens exactly one ReasonDialog", async () => {
    await toReason();
    expect(dialogs()).toHaveLength(1);
    expect(screen.queryByTestId("takeover-result")).toBeNull();
  });

  it("sends nothing for a reason under 10 characters and shows the validation text", async () => {
    await toReason();
    await fireEvent.input(screen.getByLabelText(/Begründung der Ausnahme/), {
      target: { value: "zu kurz" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Trotzdem übernehmen" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Die Begründung der Ausnahme muss 10 bis 500 Zeichen lang sein.",
    );
    expect(takeOver).toHaveBeenCalledTimes(1);
  });

  it("sends the reason for every limit-refused wish id and shows the new result", async () => {
    await toReason();
    takeOver.mockResolvedValueOnce(
      resultOf({
        created: [
          { wishId: "w1", employeeId: "e1", leaveRequestId: "r1" },
          { wishId: "w3", employeeId: "e3", leaveRequestId: "r3" },
          { wishId: "w4", employeeId: "e4", leaveRequestId: "r4" },
        ],
        pending: [],
        refused: [],
        planStatus: "TAKEN_OVER",
      }),
    );
    await fireEvent.input(screen.getByLabelText(/Begründung der Ausnahme/), {
      target: { value: "  Saisonspitze, Vertretung ist geklärt.  " },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Trotzdem übernehmen" }));
    await waitFor(() => expect(takeOver).toHaveBeenCalledTimes(2));
    expect(takeOver).toHaveBeenLastCalledWith("plan-1", [
      { wishId: "w3", reason: "Saisonspitze, Vertretung ist geklärt." },
      { wishId: "w4", reason: "Saisonspitze, Vertretung ist geklärt." },
    ]);
    expect((await screen.findByTestId("takeover-plan-status")).textContent).toContain("Übernommen");
    expect(dialogs()).toHaveLength(1);
  });

  it("returns to the result when the reason dialog is cancelled", async () => {
    await toReason();
    await fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    await screen.findByTestId("takeover-result");
    expect(takeOver).toHaveBeenCalledTimes(1);
    expect(dialogs()).toHaveLength(1);
  });
});
