// Issue #835 (WR-07) - the planner deep link preselects only a salon the caller reaches.
import { describe, it, expect } from "vitest";
import { deepLinkSalon } from "../deep-link";

const state = {
  salons: [
    { id: "11111111-1111-4111-8111-111111111111", name: "Mitte" },
    { id: "22222222-2222-4222-8222-222222222222", name: "Nord" },
  ],
};

describe("deepLinkSalon", () => {
  it("names a reachable salon", () => {
    expect(deepLinkSalon("22222222-2222-4222-8222-222222222222", state)).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("ignores a missing, empty or unreachable id", () => {
    expect(deepLinkSalon(null, state)).toBeNull();
    expect(deepLinkSalon("", state)).toBeNull();
    expect(deepLinkSalon("33333333-3333-4333-8333-333333333333", state)).toBeNull();
    expect(deepLinkSalon("ALL", state)).toBeNull();
  });
});
