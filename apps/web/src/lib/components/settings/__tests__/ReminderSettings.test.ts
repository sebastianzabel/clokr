// Issue #609 (D-02, D-10): the profile section "Erinnerungen", mounted. One switch per occasion
// the tenant enabled; each switch saves at once and rolls back on failure. `lint:ui-classes`
// does not scan this directory, so this mount test is the component's gate.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/svelte";

import type { MyReminders } from "$lib/api/reminders";
import { renderWithTheme } from "$tests/test-utils";

const api = vi.hoisted(() => ({ getMyReminders: vi.fn(), updateMyReminders: vi.fn() }));
const toast = vi.hoisted(() => ({
  toasts: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
const errors = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("$lib/api/reminders", () => api);
vi.mock("$stores/toast", () => toast);
vi.mock("$api/client", () => ({ ApiError: errors.ApiError }));

import ReminderSettings from "../ReminderSettings.svelte";

function reminders(over: {
  tenant?: Partial<MyReminders["tenant"]>;
  own?: Partial<MyReminders["own"]>;
}): MyReminders {
  return {
    tenant: {
      shiftStartEnabled: true,
      shiftEndEnabled: false,
      dayCloseEnabled: true,
      offsetMinutes: 15,
      dayCloseTime: "20:00",
      ...over.tenant,
    },
    own: { shiftStartOff: false, shiftEndOff: false, dayCloseOff: false, ...over.own },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getMyReminders.mockResolvedValue(reminders({}));
});

async function mounted() {
  const view = renderWithTheme(ReminderSettings, {});
  await waitFor(() => expect(api.getMyReminders).toHaveBeenCalled());
  return view;
}

describe("ReminderSettings", () => {
  it("shows one switch per enabled occasion and not the disabled one", async () => {
    await mounted();
    expect(await screen.findByText("Erinnerungen")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Bei Schichtbeginn erinnern" })).toBeChecked();
    expect(
      screen.getByRole("switch", { name: "Abends erinnern, wenn deine Zeit fehlt" }),
    ).toBeChecked();
    expect(screen.queryByRole("switch", { name: "Bei Schichtende erinnern" })).toBeNull();
  });

  it("a switch is unchecked when the person opted out", async () => {
    api.getMyReminders.mockResolvedValue(reminders({ own: { shiftStartOff: true } }));
    await mounted();
    expect(
      await screen.findByRole("switch", { name: "Bei Schichtbeginn erinnern" }),
    ).not.toBeChecked();
  });

  it("names the offset and the evening time in the hint", async () => {
    api.getMyReminders.mockResolvedValue(
      reminders({ tenant: { offsetMinutes: 30, dayCloseTime: "21:30" } }),
    );
    await mounted();
    expect(await screen.findByText(/30 Minuten nach Schichtbeginn/)).toBeInTheDocument();
    expect(screen.getByText(/um 21:30/)).toBeInTheDocument();
    expect(
      screen.getByText(/Gestempelt wird nur, wenn du es in der App bestätigst/),
    ).toBeInTheDocument();
  });

  it("names start and end when both are enabled", async () => {
    api.getMyReminders.mockResolvedValue(
      reminders({ tenant: { shiftEndEnabled: true, dayCloseEnabled: false } }),
    );
    await mounted();
    expect(
      await screen.findByText(/15 Minuten nach Schichtbeginn bzw. Schichtende/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/um 20:00/)).toBeNull();
  });

  it("renders nothing when the tenant enabled no occasion", async () => {
    api.getMyReminders.mockResolvedValue(
      reminders({
        tenant: { shiftStartEnabled: false, shiftEndEnabled: false, dayCloseEnabled: false },
      }),
    );
    await mounted();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Erinnerungen")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(toast.toasts.error).not.toHaveBeenCalled();
  });

  it("renders nothing and no toast when the GET answers 400 (no employee profile)", async () => {
    api.getMyReminders.mockRejectedValue(
      new errors.ApiError(400, "Kein Mitarbeiterprofil vorhanden"),
    );
    await mounted();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Erinnerungen")).toBeNull();
    expect(toast.toasts.error).not.toHaveBeenCalled();
  });

  it("renders nothing and shows one error toast for any other load error", async () => {
    api.getMyReminders.mockRejectedValue(new errors.ApiError(500, "Interner Serverfehler"));
    await mounted();
    await waitFor(() => expect(toast.toasts.error).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Erinnerungen")).toBeNull();
  });

  it("unchecking a switch PATCHes the opt-out once and toasts", async () => {
    api.updateMyReminders.mockResolvedValue(reminders({ own: { shiftStartOff: true } }));
    await mounted();
    const sw = await screen.findByRole("switch", { name: "Bei Schichtbeginn erinnern" });
    await fireEvent.click(sw);
    await waitFor(() => expect(toast.toasts.success).toHaveBeenCalledWith("Gespeichert"));
    expect(api.updateMyReminders).toHaveBeenCalledTimes(1);
    expect(api.updateMyReminders).toHaveBeenCalledWith({ shiftStartOff: true });
    expect(sw).not.toBeChecked();
  });

  it("checking an opted-out switch sends the opt-out as false", async () => {
    api.getMyReminders.mockResolvedValue(reminders({ own: { dayCloseOff: true } }));
    api.updateMyReminders.mockResolvedValue(reminders({}));
    await mounted();
    const sw = await screen.findByRole("switch", {
      name: "Abends erinnern, wenn deine Zeit fehlt",
    });
    await fireEvent.click(sw);
    await waitFor(() => expect(api.updateMyReminders).toHaveBeenCalledWith({ dayCloseOff: false }));
  });

  it("rolls the switch back and shows the server message when the save fails", async () => {
    api.updateMyReminders.mockRejectedValue(new Error("Speichern nicht möglich"));
    await mounted();
    const sw = await screen.findByRole("switch", { name: "Bei Schichtbeginn erinnern" });
    await fireEvent.click(sw);
    await waitFor(() => expect(toast.toasts.error).toHaveBeenCalledWith("Speichern nicht möglich"));
    expect(sw).toBeChecked();
    expect(toast.toasts.success).not.toHaveBeenCalled();
  });

  it("disables the switches while a save runs, so a double click sends one PATCH", async () => {
    let release: (v: MyReminders) => void = () => {};
    api.updateMyReminders.mockImplementation(
      () => new Promise<MyReminders>((resolve) => (release = resolve)),
    );
    await mounted();
    const sw = await screen.findByRole("switch", { name: "Bei Schichtbeginn erinnern" });
    await fireEvent.click(sw);
    await waitFor(() => expect(sw).toBeDisabled());
    await fireEvent.click(sw);
    expect(api.updateMyReminders).toHaveBeenCalledTimes(1);
    release(reminders({ own: { shiftStartOff: true } }));
    await waitFor(() => expect(sw).toBeEnabled());
  });
});
