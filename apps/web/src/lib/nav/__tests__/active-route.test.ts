import { describe, expect, it } from "vitest";
import { activeNavHref, matchesRoute } from "../active-route";

describe("matchesRoute", () => {
  it("matches the exact path", () => {
    expect(matchesRoute("/leave", "/leave")).toBe(true);
  });

  it("matches a child path below the href", () => {
    expect(matchesRoute("/leave", "/leave/123")).toBe(true);
  });

  it("does not match a sibling that merely shares the prefix characters", () => {
    expect(matchesRoute("/leave", "/leavex")).toBe(false);
  });

  it("does not match the team variant of a personal page", () => {
    expect(matchesRoute("/leave", "/team/leave")).toBe(false);
    expect(matchesRoute("/time-entries", "/team/time-entries")).toBe(false);
  });
});

describe("activeNavHref", () => {
  it("picks the longest matching href, independent of the list order", () => {
    expect(activeNavHref(["/admin", "/admin/employees"], "/admin/employees/5")).toBe(
      "/admin/employees",
    );
    expect(activeNavHref(["/admin/employees", "/admin"], "/admin/employees/5")).toBe(
      "/admin/employees",
    );
  });

  it("returns null when nothing matches", () => {
    expect(activeNavHref(["/dashboard", "/leave"], "/nowhere")).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(activeNavHref([], "/x")).toBeNull();
  });

  it("keeps /dashboard and /time-entries apart from their team counterparts", () => {
    expect(activeNavHref(["/time-entries", "/team/time-entries"], "/team/time-entries")).toBe(
      "/team/time-entries",
    );
  });
});
