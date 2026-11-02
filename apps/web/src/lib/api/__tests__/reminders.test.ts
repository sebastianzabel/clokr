// Issue #609 (D-02): pins the URL and the body the profile puts on the wire.
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock("$api/client", () => ({ api }));

import { getMyReminders, updateMyReminders, type MyReminders } from "../reminders";

const SHAPE: MyReminders = {
  tenant: {
    shiftStartEnabled: true,
    shiftEndEnabled: false,
    dayCloseEnabled: true,
    offsetMinutes: 15,
    dayCloseTime: "20:00",
  },
  own: { shiftStartOff: false, shiftEndOff: false, dayCloseOff: true },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reminders client", () => {
  it("getMyReminders GETs /employees/me/reminders and returns the typed shape", async () => {
    api.get.mockResolvedValue(SHAPE);
    await expect(getMyReminders()).resolves.toEqual(SHAPE);
    expect(api.get).toHaveBeenCalledWith("/employees/me/reminders");
  });

  it("updateMyReminders PATCHes the same path with exactly the given body", async () => {
    api.patch.mockResolvedValue(SHAPE);
    await expect(updateMyReminders({ shiftStartOff: true })).resolves.toEqual(SHAPE);
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch).toHaveBeenCalledWith("/employees/me/reminders", { shiftStartOff: true });
  });

  it("a rejected call stays rejected (the caller decides about the toast)", async () => {
    api.patch.mockRejectedValue(new Error("boom"));
    await expect(updateMyReminders({ dayCloseOff: false })).rejects.toThrow("boom");
  });
});
