// Issue #835 — one client function per endpoint, ids and query values encoded.
const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();
const apiDelete = vi.fn();
vi.mock("$api/client", () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
    patch: (...a: unknown[]) => apiPatch(...a),
    delete: (...a: unknown[]) => apiDelete(...a),
  },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createWish,
  getPlan,
  listPlans,
  openPlan,
  removeWish,
  setDeadline,
  takeOver,
  updateWish,
} from "../api";

const plan = { id: "p1" };

beforeEach(() => {
  for (const fn of [apiGet, apiPost, apiPatch, apiDelete]) fn.mockReset();
});

describe("leave plan client", () => {
  it("lists plans of a salon and year with encoded query values", async () => {
    apiGet.mockResolvedValue({ plans: [plan] });
    expect(await listPlans("a b", 2027)).toEqual([plan]);
    expect(apiGet).toHaveBeenCalledWith("/leave/plans?salonId=a%20b&year=2027");
    await listPlans("s1");
    expect(apiGet).toHaveBeenLastCalledWith("/leave/plans?salonId=s1");
  });

  it("reads one plan by encoded id", async () => {
    apiGet.mockResolvedValue({});
    await getPlan("x/y");
    expect(apiGet).toHaveBeenCalledWith("/leave/plans/x%2Fy");
  });

  it("opens a plan and sets a deadline, unwrapping the plan", async () => {
    apiPost.mockResolvedValue({ plan });
    expect(await openPlan({ salonId: "s", year: 2027, deadline: null })).toEqual(plan);
    expect(apiPost).toHaveBeenCalledWith("/leave/plans", {
      salonId: "s",
      year: 2027,
      deadline: null,
    });
    apiPatch.mockResolvedValue({ plan });
    expect(await setDeadline("p1", "2027-02-01")).toEqual(plan);
    expect(apiPatch).toHaveBeenCalledWith("/leave/plans/p1", { deadline: "2027-02-01" });
  });

  it("creates, updates and removes wishes", async () => {
    const wish = { id: "w1" };
    apiPost.mockResolvedValue({ wish });
    const input = { startDate: "2027-03-01", endDate: "2027-03-02", halfDay: false };
    expect(await createWish("p1", input)).toEqual(wish);
    expect(apiPost).toHaveBeenCalledWith("/leave/plans/p1/wishes", input);
    apiPatch.mockResolvedValue({ wish });
    expect(await updateWish("p1", "w1", { endDate: "2027-03-03" })).toEqual(wish);
    expect(apiPatch).toHaveBeenCalledWith("/leave/plans/p1/wishes/w1", { endDate: "2027-03-03" });
    apiDelete.mockResolvedValue(undefined);
    await removeWish("p1", "w1");
    expect(apiDelete).toHaveBeenCalledWith("/leave/plans/p1/wishes/w1");
  });

  it("takes over with or without limit exceptions", async () => {
    apiPost.mockResolvedValue({ created: [] });
    await takeOver("p1");
    expect(apiPost).toHaveBeenLastCalledWith("/leave/plans/p1/takeover", {});
    await takeOver("p1", [{ wishId: "w1", reason: "Notwendig wegen Messe" }]);
    expect(apiPost).toHaveBeenLastCalledWith("/leave/plans/p1/takeover", {
      limitExceptions: [{ wishId: "w1", reason: "Notwendig wegen Messe" }],
    });
  });
});
