// Issue #840 (D-840-15, AC-11, T-840-25) — the mounted test of „Planung verwalten“. The dialog is
// the one home of open / deadline / takeover. `lib/components/leave/` is outside `lint:ui-classes`,
// so this file is the safeguard for the component. The API module and the toast store are mocked;
// the Modal primitive is the real one.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import ManagePlanDialog from "../ManagePlanDialog.svelte";

vi.mock("$stores/auth", () => ({ authStore: { subscribe: () => () => {} } }));
vi.mock("$api/client", () => ({ api: {} }));

const openPlan = vi.fn();
const setDeadline = vi.fn();
vi.mock("$lib/leave-plan/api", () => ({
  openPlan: (...args: unknown[]) => openPlan(...args),
  setDeadline: (...args: unknown[]) => setDeadline(...args),
}));

const toastSuccess = vi.fn();
vi.mock("$stores/toast", () => ({
  toasts: { success: (...args: unknown[]) => toastSuccess(...args), error: vi.fn() },
}));

/** An ApiError-shaped refusal: the planner error helpers read `status` and `data`. */
function refusal(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, data: { code, error: message } });
}

const OPEN_PLAN = { id: "plan-1", status: "OPEN" as const, deadline: "2027-02-01" };

function render(overrides: Record<string, unknown> = {}) {
  const props = {
    open: true,
    salonId: "salon-1",
    year: 2027,
    plan: OPEN_PLAN as {
      id: string;
      status: "OPEN" | "TAKEN_OVER";
      deadline: string | null;
    } | null,
    openWishCount: 3 as number | null,
    onChanged: vi.fn(async () => {}),
    onTakeover: vi.fn(),
    ...overrides,
  };
  renderWithTheme(ManagePlanDialog, props);
  return props;
}

beforeEach(() => {
  openPlan.mockReset().mockResolvedValue({ id: "plan-1" });
  setDeadline.mockReset().mockResolvedValue({ id: "plan-1" });
  toastSuccess.mockReset();
});

describe("ManagePlanDialog - no plan yet", () => {
  it("shows Plan eröffnen and neither Frist nor Übernehmen", () => {
    render({ plan: null, openWishCount: null });
    expect(screen.getByRole("heading", { name: "Plan eröffnen" })).toBeTruthy();
    expect(screen.getByTestId("leave-plan-open")).toBeTruthy();
    expect(screen.queryByLabelText("Frist für Wünsche")).toBeNull();
    expect(screen.queryByTestId("leave-plan-takeover")).toBeNull();
  });

  it("opens the plan once with the optional deadline, reloads and toasts", async () => {
    const props = render({ plan: null, openWishCount: null });
    await fireEvent.input(screen.getByLabelText("Wünsche bis (optional)"), {
      target: { value: "2027-01-31" },
    });
    await fireEvent.click(screen.getByTestId("leave-plan-open"));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(openPlan).toHaveBeenCalledTimes(1);
    expect(openPlan).toHaveBeenCalledWith({
      salonId: "salon-1",
      year: 2027,
      deadline: "2027-01-31",
    });
    expect(toastSuccess).toHaveBeenCalledWith("Die Urlaubsplanung ist eröffnet.");
  });

  it("sends a null deadline when the field stays empty", async () => {
    const props = render({ plan: null, openWishCount: null });
    await fireEvent.click(screen.getByTestId("leave-plan-open"));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    expect(openPlan).toHaveBeenCalledWith({ salonId: "salon-1", year: 2027, deadline: null });
  });

  it("shows the server message of an already-open answer and stays open", async () => {
    openPlan.mockRejectedValueOnce(
      refusal(409, "LEAVE_PLAN_ALREADY_OPEN", "Für diesen Salon ist die Planung schon eröffnet."),
    );
    const props = render({ plan: null, openWishCount: null });
    await fireEvent.click(screen.getByTestId("leave-plan-open"));
    const alert = await screen.findByTestId("manage-plan-error");
    expect(alert.textContent).toContain("Für diesen Salon ist die Planung schon eröffnet.");
    expect(screen.getByRole("dialog", { name: "Planung verwalten" })).toBeTruthy();
    expect(toastSuccess).not.toHaveBeenCalled();
    // The stored plan is re-read so the dialog does not keep offering a second open.
    expect(props.onChanged).toHaveBeenCalledTimes(1);
  });

  it("shows another server refusal inline and does not reload", async () => {
    openPlan.mockRejectedValueOnce(refusal(403, "FORBIDDEN", "Dazu fehlt dir die Berechtigung."));
    const props = render({ plan: null, openWishCount: null });
    await fireEvent.click(screen.getByTestId("leave-plan-open"));
    const alert = await screen.findByTestId("manage-plan-error");
    expect(alert.textContent).toContain("Dazu fehlt dir die Berechtigung.");
    expect(props.onChanged).not.toHaveBeenCalled();
  });
});

describe("ManagePlanDialog - open plan", () => {
  it("shows the status and the open-wish count from the server", () => {
    render();
    expect(screen.getByTestId("manage-plan-status").textContent).toContain("Offen");
    expect(screen.getByTestId("manage-plan-open-count").textContent).toContain("3 offene Wünsche");
  });

  it("prefills the date field with the stored deadline", () => {
    render();
    expect((screen.getByLabelText("Frist für Wünsche") as HTMLInputElement).value).toBe(
      "2027-02-01",
    );
  });

  it("writes nothing when a date is typed and the field is left", async () => {
    render();
    const input = screen.getByLabelText("Frist für Wünsche");
    await fireEvent.input(input, { target: { value: "2027-03-01" } });
    await fireEvent.change(input, { target: { value: "2027-03-01" } });
    await fireEvent.blur(input);
    expect(setDeadline).not.toHaveBeenCalled();
  });

  it("saves the deadline once through the section button", async () => {
    const props = render();
    await fireEvent.input(screen.getByLabelText("Frist für Wünsche"), {
      target: { value: "2027-03-01" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Frist speichern" }));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(setDeadline).toHaveBeenCalledTimes(1);
    expect(setDeadline).toHaveBeenCalledWith("plan-1", "2027-03-01");
    expect(toastSuccess).toHaveBeenCalledWith("Die Frist ist gespeichert.");
  });

  it("does not offer Frist speichern while the field equals the stored deadline", () => {
    render();
    expect(
      (screen.getByRole("button", { name: "Frist speichern" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("removes the deadline with null", async () => {
    const props = render();
    await fireEvent.click(screen.getByRole("button", { name: "Frist entfernen" }));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(setDeadline).toHaveBeenCalledWith("plan-1", null);
    expect(toastSuccess).toHaveBeenCalledWith("Die Frist ist entfernt.");
  });

  it("offers no Frist entfernen for a plan without a deadline", () => {
    render({ plan: { ...OPEN_PLAN, deadline: null } });
    expect(screen.queryByRole("button", { name: "Frist entfernen" })).toBeNull();
  });

  it("shows a refused deadline inline and keeps the dialog open", async () => {
    setDeadline.mockRejectedValueOnce(
      refusal(409, "LEAVE_PLAN_CLOSED", "Die Planung ist bereits übernommen."),
    );
    const props = render();
    await fireEvent.input(screen.getByLabelText("Frist für Wünsche"), {
      target: { value: "2027-03-01" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Frist speichern" }));
    const alert = await screen.findByTestId("manage-plan-error");
    expect(alert.textContent).toContain("Die Planung ist bereits übernommen.");
    expect(props.onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Planung verwalten" })).toBeTruthy();
  });

  it("Übernehmen closes the dialog and calls onTakeover without opening another modal", async () => {
    const props = render();
    await fireEvent.click(screen.getByTestId("leave-plan-takeover"));
    expect(props.onTakeover).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("disables Übernehmen without open wishes", () => {
    render({ openWishCount: 0 });
    expect((screen.getByTestId("leave-plan-takeover") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ManagePlanDialog - taken-over plan", () => {
  it("shows the status and neither Frist editing nor Übernehmen", () => {
    render({
      plan: { id: "plan-1", status: "TAKEN_OVER", deadline: "2027-02-01" },
      openWishCount: null,
    });
    expect(screen.getByTestId("manage-plan-status").textContent).toContain("Übernommen");
    expect(screen.queryByLabelText("Frist für Wünsche")).toBeNull();
    expect(screen.queryByTestId("leave-plan-takeover")).toBeNull();
    expect(screen.queryByTestId("leave-plan-open")).toBeNull();
  });
});

describe("ManagePlanDialog - source pin (T-840-25)", () => {
  // The vitest cwd is apps/web (the module URL is not a file URL in this environment).
  const SOURCE = readFileSync(
    resolve(process.cwd(), "src/lib/components/leave/ManagePlanDialog.svelte"),
    "utf8",
  );
  const markup = SOURCE.slice(SOURCE.indexOf("</script>"));

  it("[vacuity gate] reads the component source", () => {
    expect(SOURCE.length).toBeGreaterThan(3_000);
    expect(markup).toContain("<Modal");
  });

  it("has no blur handler and no handler on a date input; every write sits behind a button", () => {
    expect(markup).not.toMatch(/onblur\s*=/);
    for (const tag of markup.match(/<input[^>]*>/g) ?? []) {
      expect(tag).not.toMatch(/\bon(blur|change|input|keydown)\s*=/);
    }
    // Both API writes are called only from the two functions bound to buttons.
    const calls = [...SOURCE.matchAll(/\b(openPlan|setDeadline)\(/g)].map((m) => m[1]);
    expect(calls.sort()).toEqual(["openPlan", "setDeadline"]);
    expect(markup).toContain("onclick={doOpenPlan}");
    expect(markup).toContain("onclick={() => saveDeadline(deadlineInput)}");
    expect(markup).toContain("onclick={() => saveDeadline(null)}");
  });

  it("opens no second modal and registers nothing with the unsaved-changes guard", () => {
    expect(SOURCE.match(/<Modal\b/g)?.length).toBe(1);
    expect(SOURCE).not.toMatch(/ConfirmDialog|ReasonDialog|\$stores\/unsaved/);
  });
});
