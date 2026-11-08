// Issue #840 (D-840-14/15/16/23, E-03, T-840-23/24/26) - the mounted test of the planner panel.
// `lib/components/leave/` is outside `lint:ui-classes`, so this file is the safeguard for the
// component. The leave-plan API module, the auth store and the toast store are mocked; the
// timeline, legend, dialogs and wish list are the real ones.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import LeavePlanningPanel from "../LeavePlanningPanel.svelte";
import { periodOf } from "$lib/leave/timeline-model";
import type {
  LeavePlanListItem,
  PlannerPerson,
  PlannerReadDto,
  PlannerWish,
} from "$lib/leave-plan/types";

let permissions: string[] = [];
vi.mock("$stores/auth", () => ({
  authStore: {
    subscribe: (run: (value: unknown) => void) => {
      run({ user: { permissions } });
      return () => {};
    },
  },
}));

vi.mock("$api/client", () => {
  class ApiError extends Error {
    status: number;
    data: unknown;
    constructor(status: number, message: string, data?: unknown) {
      super(message);
      this.status = status;
      this.data = data;
    }
  }
  return { api: {}, ApiError };
});

const listPlans = vi.fn();
const getPlan = vi.fn();
const createWish = vi.fn();
const updateWish = vi.fn();
const removeWish = vi.fn();
vi.mock("$lib/leave-plan/api", () => ({
  listPlans: (...args: unknown[]) => listPlans(...args),
  getPlan: (...args: unknown[]) => getPlan(...args),
  createWish: (...args: unknown[]) => createWish(...args),
  updateWish: (...args: unknown[]) => updateWish(...args),
  removeWish: (...args: unknown[]) => removeWish(...args),
  openPlan: vi.fn(),
  setDeadline: vi.fn(),
  takeOver: vi.fn(),
}));

const toastError = vi.fn();
vi.mock("$stores/toast", () => ({
  toasts: { success: vi.fn(), error: (...args: unknown[]) => toastError(...args) },
}));

const FEB = periodOf("monat", "2027-02-10");
const Q1 = periodOf("quartal", "2027-02-10");
const YEAR = periodOf("jahr", "2027-02-10");

function wish(id: string, overrides: Partial<PlannerWish> = {}): PlannerWish {
  return {
    id,
    planId: "plan-1",
    startDate: "2027-02-08",
    endDate: "2027-02-10",
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

function person(
  employeeId: string,
  firstName: string,
  lastName: string,
  overrides: Partial<PlannerPerson> = {},
): PlannerPerson {
  return {
    employeeId,
    firstName,
    lastName,
    homeRanges: [{ from: "2027-01-01", to: "2027-12-31" }],
    rows: [],
    wishes: [],
    forecast: null,
    ...overrides,
  };
}

function dto(overrides: Partial<PlannerReadDto> = {}): PlannerReadDto {
  return {
    plan: {
      id: "plan-1",
      salonId: "salon-1",
      year: 2027,
      deadline: null,
      status: "OPEN",
      openedAt: "2026-11-01T00:00:00.000Z",
      takenOverAt: null,
      deadlinePassed: false,
      deadlineLocksWishes: false,
      partiallyTakenOver: false,
      openWishCount: 1,
    },
    salon: { id: "salon-1", name: "Salon A", openingHours: [{ day: 6, closed: true }] },
    viewer: { employeeId: "e1", canManage: false, canWishOwn: true, ownEditLocked: false },
    persons: [
      person("e1", "Alex", "Muster", {
        rows: [
          {
            kind: "LEAVE",
            state: "GESETZT",
            startDate: "2027-02-15",
            endDate: "2027-02-16",
            halfDay: false,
            typeCode: "VACATION",
          },
        ],
        wishes: [wish("w1")],
      }),
      person("e2", "Bea", "Beispiel", {
        rows: [
          {
            kind: "MASKED",
            state: "ABWESEND",
            startDate: "2027-02-22",
            endDate: "2027-02-23",
            halfDay: false,
            typeCode: null,
          },
        ],
      }),
    ],
    holidays: [{ date: "2027-02-01", name: "Testfeiertag" }],
    dayLoad: [
      { day: "2027-02-15", count: 1, limits: null },
      {
        day: "2027-02-08",
        count: 2,
        limits: [
          {
            ruleId: "r1",
            ruleName: "Wochenregel",
            groupKey: "ALL",
            max: 1,
            count: 2,
            exceeded: true,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function listItem(id: string, status: "OPEN" | "TAKEN_OVER" = "OPEN"): LeavePlanListItem {
  return {
    id,
    salonId: "salon-1",
    year: 2027,
    deadline: null,
    status,
    openedAt: "2026-11-01T00:00:00.000Z",
    takenOverAt: null,
  };
}

/** An ApiError-shaped refusal (the mocked class keeps `status` and `data`). */
function refusal(status: number, message: string): Error {
  return Object.assign(new Error(message), { status, data: { error: message } });
}

function render(overrides: Record<string, unknown> = {}) {
  const props = {
    mode: "team" as "team" | "own",
    salonId: "salon-1" as string | null,
    period: Q1,
    today: "2027-02-01",
    onViewer: vi.fn(),
    ...overrides,
  };
  const result = renderWithTheme(LeavePlanningPanel, props);
  return { props, ...result };
}

function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

beforeEach(() => {
  permissions = [];
  listPlans.mockReset().mockResolvedValue([listItem("plan-1")]);
  getPlan.mockReset().mockResolvedValue(dto());
  createWish.mockReset().mockResolvedValue({});
  updateWish.mockReset().mockResolvedValue({});
  removeWish.mockReset().mockResolvedValue(undefined);
  toastError.mockReset();
  // jsdom has no matchMedia: the panel guards for it, a desktop width is the default here.
  Reflect.deleteProperty(window, "matchMedia");
});

afterEach(() => {
  Reflect.deleteProperty(window, "matchMedia");
});

describe("LeavePlanningPanel - load", () => {
  it("shows the salon empty state and loads nothing without a salon", () => {
    render({ salonId: null });
    expect(screen.getByText("Wähle oben einen Salon, um seine Planung zu sehen.")).toBeTruthy();
    expect(listPlans).not.toHaveBeenCalled();
    expect(getPlan).not.toHaveBeenCalled();
  });

  it("reads the plan once in team mode without a view flag and draws one row per person", async () => {
    render();
    await screen.findByTestId("plan-row-e1");
    expect(listPlans).toHaveBeenCalledWith("salon-1", 2027);
    expect(getPlan).toHaveBeenCalledTimes(1);
    expect(getPlan.mock.calls[0]).toEqual(["plan-1"]);
    expect(screen.getByTestId("plan-row-e2")).toBeTruthy();
    expect(screen.getAllByTestId(/^plan-row-/)).toHaveLength(2);
  });

  it("draws the legend above the timeline", async () => {
    render();
    const timeline = await screen.findByTestId("leave-plan-timeline-host");
    const legend = screen.getByTestId("leave-plan-legend");
    expect(legend.querySelector('[data-testid="leave-legend"]')).toBeTruthy();
    // The wish style is named although this plan has an open wish only in the answer.
    expect(screen.getByTestId("legend-style-wunsch")).toBeTruthy();
    expect(
      legend.compareDocumentPosition(timeline) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("drops a stale answer: the older request never overwrites the newer view (T-840-26)", async () => {
    let releaseFirst: (items: LeavePlanListItem[]) => void = () => {};
    listPlans.mockImplementation((salon: string) =>
      salon === "salon-old"
        ? new Promise<LeavePlanListItem[]>((resolve) => (releaseFirst = resolve))
        : Promise.resolve([listItem("plan-new")]),
    );
    getPlan.mockImplementation((id: string) =>
      Promise.resolve(
        id === "plan-old"
          ? dto({ persons: [person("o1", "Alt", "Person")] })
          : dto({ persons: [person("n1", "Neu", "Person")] }),
      ),
    );
    const { rerender, props } = render({ salonId: "salon-old" });
    await rerender({ ...props, salonId: "salon-new" });
    await screen.findByTestId("plan-row-n1");
    releaseFirst([listItem("plan-old")]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("plan-row-o1")).toBeNull();
    expect(screen.getByTestId("plan-row-n1")).toBeTruthy();
  });

  it("reloads the plan when the period crosses New Year", async () => {
    const { rerender, props } = render();
    await screen.findByTestId("plan-row-e1");
    await rerender({ ...props, period: periodOf("quartal", "2028-01-10") });
    await waitFor(() => expect(listPlans).toHaveBeenCalledWith("salon-1", 2028));
  });

  it("shows a calm empty state when no plan exists and the reader cannot manage", async () => {
    listPlans.mockResolvedValue([]);
    const { props } = render();
    expect(
      await screen.findByText("Für dieses Jahr ist noch keine Planung eröffnet."),
    ).toBeTruthy();
    expect(getPlan).not.toHaveBeenCalled();
    expect(props.onViewer).toHaveBeenLastCalledWith({ canManage: false });
  });

  it("offers Planung verwalten while no plan exists only through the permission hint", async () => {
    listPlans.mockResolvedValue([]);
    permissions = ["leave-plan:manage:ZUGEWIESEN"];
    const { props } = render();
    expect(await screen.findByText(/Öffne sie über „Planung verwalten“/)).toBeTruthy();
    await waitFor(() => expect(props.onViewer).toHaveBeenLastCalledWith({ canManage: true }));
  });

  it("shows the no-access state for a 403 and the calm hint for the salon 404", async () => {
    listPlans.mockRejectedValueOnce(refusal(403, "nope"));
    render();
    expect(await screen.findByText("Kein Zugriff")).toBeTruthy();
  });

  it("shows a calm hint when the server rejects the chosen salon", async () => {
    const { ApiError } = await import("$api/client");
    listPlans.mockRejectedValueOnce(
      new (ApiError as new (s: number, m: string) => Error)(404, "x"),
    );
    render();
    expect(await screen.findByTestId("leave-plan-salon-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("salon-scope-label")).toBeNull();
  });

  it("shows a load error", async () => {
    getPlan.mockRejectedValueOnce(new Error("boom"));
    render();
    expect(await screen.findByTestId("leave-plan-error")).toBeTruthy();
  });
});

describe("LeavePlanningPanel - manage rights", () => {
  it("team mode reports the server's canManage and opens Planung verwalten on manageOpen", async () => {
    getPlan.mockResolvedValue(
      dto({
        viewer: { employeeId: "e1", canManage: true, canWishOwn: true, ownEditLocked: false },
      }),
    );
    const { props, rerender } = render();
    await screen.findByTestId("plan-row-e1");
    await waitFor(() => expect(props.onViewer).toHaveBeenLastCalledWith({ canManage: true }));
    expect(screen.queryByRole("dialog", { name: "Planung verwalten" })).toBeNull();
    await rerender({ ...props, manageOpen: true });
    expect(await screen.findByRole("dialog", { name: "Planung verwalten" })).toBeTruthy();
    // The admin controls are in the dialog, none on the work surface.
    expect(screen.getAllByTestId("leave-plan-takeover")).toHaveLength(1);
    expect(
      screen.getByTestId("manage-plan-dialog").contains(screen.getByTestId("leave-plan-takeover")),
    ).toBe(true);
  });

  it("own mode never mounts the manage dialog and never reports a manage right", async () => {
    getPlan.mockResolvedValue(
      dto({
        viewer: { employeeId: "e1", canManage: true, canWishOwn: true, ownEditLocked: false },
      }),
    );
    permissions = ["leave-plan:manage:ZUGEWIESEN"];
    const { props } = render({ mode: "own", manageOpen: true });
    await screen.findByTestId("plan-row-e1");
    expect(screen.queryByRole("dialog", { name: "Planung verwalten" })).toBeNull();
    expect(props.onViewer).not.toHaveBeenCalledWith({ canManage: true });
  });

  it("a non-manager sees the deadline as read-only text", async () => {
    getPlan.mockResolvedValue(
      dto({
        plan: { ...dto().plan, deadline: "2027-02-01", deadlineLocksWishes: true },
      }),
    );
    render();
    const text = await screen.findByTestId("leave-plan-deadline-text");
    expect(text.textContent).toContain("01.02.2027");
    expect(screen.queryByTestId("leave-plan-deadline")).toBeNull();
    expect(screen.queryByLabelText("Frist für Wünsche")).toBeNull();
    expect(screen.getByTestId("leave-plan-lock-hint")).toBeTruthy();
  });

  it("shows the own-edit lock after the deadline", async () => {
    getPlan.mockResolvedValue(
      dto({
        plan: { ...dto().plan, deadline: "2027-01-10", deadlinePassed: true },
        viewer: { employeeId: "e1", canManage: false, canWishOwn: true, ownEditLocked: true },
      }),
    );
    render();
    expect(await screen.findByTestId("leave-plan-locked")).toBeTruthy();
    expect(screen.queryByTestId("leave-plan-add-wish")).toBeNull();
  });
});

describe("LeavePlanningPanel - own mode (E-03)", () => {
  it("asks for the neutral reading with view=own (T-840-24)", async () => {
    render({ mode: "own" });
    await screen.findByTestId("plan-row-e1");
    expect(getPlan).toHaveBeenCalledTimes(1);
    expect(getPlan).toHaveBeenCalledWith("plan-1", { view: "own" });
  });

  it("renders a colleague's masked row as abwesend", async () => {
    render({ mode: "own", period: FEB });
    const bar = await screen.findByTestId("absence-bar-row:e2:0");
    expect(bar.getAttribute("aria-label")).toContain("abwesend");
    expect(bar.getAttribute("aria-label")).not.toContain("Urlaub");
  });

  it("offers no person choice in the wish dialog, even to a manager", async () => {
    getPlan.mockResolvedValue(
      dto({
        viewer: { employeeId: "e1", canManage: true, canWishOwn: true, ownEditLocked: false },
      }),
    );
    render({ mode: "own" });
    await fireEvent.click(await screen.findByTestId("leave-plan-add-wish"));
    expect(await screen.findByTestId("leave-plan-wish-form")).toBeTruthy();
    expect(screen.queryByTestId("wish-person")).toBeNull();
  });

  it("allows adding a wish only on the caller's own row", async () => {
    render({ mode: "own", period: FEB });
    await screen.findByTestId("plan-track-e1");
    expect(screen.getByTestId("plan-track-e1").classList.contains("tl-track--addable")).toBe(true);
    expect(screen.getByTestId("plan-track-e2").classList.contains("tl-track--addable")).toBe(false);
  });

  it("offers no drag, edit, status, forecast or rule data for a colleague's wish (WR-02)", async () => {
    // An answer that still carries a colleague's editable wish, status, forecast and rule data (an
    // older server): the personal planner narrows it on the display side.
    getPlan.mockResolvedValue(
      dto({
        persons: [
          person("e1", "Alex", "Muster", { wishes: [wish("w1")] }),
          person("e2", "Bea", "Beispiel", {
            wishes: [
              wish("w2", {
                editable: true,
                leaveRequestStatus: "REJECTED",
                refusalCode: "X",
                refusalMessage: "Kein Resturlaub mehr",
                conflict: true,
              }),
            ],
            forecast: {
              entitlementBasis: "STORED",
              remainingDays: 3,
              pendingDays: 0,
              wishDays: 2,
              forecastDays: 1,
              forecastNegative: false,
            },
          }),
        ],
      }),
    );
    render({ mode: "own", period: FEB });
    await screen.findByTestId("wish-bar-w1");
    // The caller's own wish keeps its handles; the colleague's has neither a handle nor edit rights.
    expect(screen.getByTestId("leave-plan-wish-handle-end-w1")).toBeTruthy();
    expect(
      screen.getByTestId("leave-plan-wish-w2").classList.contains("absence-wish--readonly"),
    ).toBe(true);
    expect(screen.queryByTestId("leave-plan-wish-handle-end-w2")).toBeNull();
    expect(screen.queryByTestId("leave-plan-wish-handle-start-w2")).toBeNull();
    expect(screen.getByTestId("wish-bar-w2").getAttribute("aria-label") ?? "").not.toContain(
      "bearbeiten",
    );
    // No forecast column for a colleague, no exceeded-limit marker in the load row.
    expect(screen.queryByTestId("plan-forecast-e2")).toBeNull();
    expect(screen.getByTestId("day-load-2027-02-08").getAttribute("data-exceeded")).toBe("false");
    expect(document.body.textContent).not.toContain("Kein Resturlaub mehr");
  });

  it("team mode lets a manager choose the person", async () => {
    getPlan.mockResolvedValue(
      dto({
        viewer: { employeeId: "e1", canManage: true, canWishOwn: true, ownEditLocked: false },
      }),
    );
    render();
    await fireEvent.click(await screen.findByTestId("leave-plan-add-wish"));
    expect(await screen.findByTestId("wish-person")).toBeTruthy();
  });
});

describe("LeavePlanningPanel - wishes", () => {
  /** Drags the end handle of w1 to the right by roughly three day columns (month zoom). */
  async function dragWishBy(px: number) {
    const body = await screen.findByTestId("wish-bar-w1");
    await fireEvent.pointerDown(body, { clientX: 100, pointerId: 1, button: 0 });
    await fireEvent.pointerMove(body, { clientX: 100 + px, pointerId: 1 });
    await fireEvent.pointerUp(body, { clientX: 100 + px, pointerId: 1 });
  }

  it("a drag calls updateWish once and reloads the plan", async () => {
    render({ period: FEB });
    await dragWishBy(106);
    await waitFor(() => expect(getPlan).toHaveBeenCalledTimes(2));
    expect(updateWish).toHaveBeenCalledTimes(1);
    expect(updateWish).toHaveBeenCalledWith("plan-1", "w1", {
      startDate: "2027-02-11",
      endDate: "2027-02-13",
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("a refused drag shows the server message and still reloads", async () => {
    updateWish.mockRejectedValueOnce(refusal(409, "Die Planung ist bereits übernommen."));
    render({ period: FEB });
    await dragWishBy(106);
    await waitFor(() => expect(getPlan).toHaveBeenCalledTimes(2));
    expect(updateWish).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("Die Planung ist bereits übernommen.");
  });

  it("creates a wish through the dialog and reloads", async () => {
    render({ period: FEB });
    await fireEvent.click(await screen.findByTestId("leave-plan-add-wish"));
    await fireEvent.input(await screen.findByTestId("wish-start"), {
      target: { value: "2027-02-24" },
    });
    await fireEvent.input(screen.getByTestId("wish-end"), { target: { value: "2027-02-25" } });
    await fireEvent.click(screen.getByTestId("wish-save"));
    await waitFor(() => expect(createWish).toHaveBeenCalledTimes(1));
    expect(createWish).toHaveBeenCalledWith(
      "plan-1",
      expect.objectContaining({ startDate: "2027-02-24", endDate: "2027-02-25" }),
    );
    await waitFor(() => expect(getPlan).toHaveBeenCalledTimes(2));
  });
});

describe("LeavePlanningPanel - load row", () => {
  it("Quartal and Monat use the server's day load and mark only the exceeded day", async () => {
    render({ period: Q1 });
    await screen.findByTestId("plan-day-load");
    const busy = screen.getByTestId("day-load-2027-02-08");
    expect(busy.getAttribute("data-exceeded")).toBe("true");
    expect(busy.getAttribute("aria-label")).toContain("Wochenregel: 2 von höchstens 1");
    expect(screen.getByTestId("day-load-2027-02-15").getAttribute("data-exceeded")).toBe("false");
    expect(screen.getByText("Abwesend (Personen)").getAttribute("title")).toContain(
      "Genehmigt, beantragt und gewünscht",
    );
  });

  it("Jahr uses the week load of the model, keyed by Monday", async () => {
    render({ period: YEAR });
    await screen.findByTestId("plan-day-load");
    expect(screen.getByTestId("day-load-2027-02-15")).toBeTruthy();
    // The server's per-day key does not appear in the week view.
    expect(screen.queryByTestId("day-load-2027-02-08")).toBeNull();
  });
});

describe("LeavePlanningPanel - mobile", () => {
  it("shows the wish list and the add button instead of the timeline below 768 px", async () => {
    stubMatchMedia(true);
    render();
    expect(await screen.findByTestId("leave-plan-wish-list")).toBeTruthy();
    expect(screen.getByTestId("leave-plan-add-wish")).toBeTruthy();
    expect(screen.queryByTestId("leave-plan-timeline-host")).toBeNull();
  });

  it("shows the timeline on a desktop width", async () => {
    stubMatchMedia(false);
    render();
    expect(await screen.findByTestId("leave-plan-timeline-host")).toBeTruthy();
    expect(screen.queryByTestId("leave-plan-wish-list")).toBeNull();
  });
});
