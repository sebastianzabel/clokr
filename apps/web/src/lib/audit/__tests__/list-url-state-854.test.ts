// Issue #583 (Phase 854, T-854-59) - the allow-list URL schema of the Protokoll filters and the query of
// the list and the export.
import { describe, expect, it } from "vitest";

import { parseUrlState, serialiseUrlState } from "$lib/table/url-state";

import { AUDIT_ENTITY_CODES } from "../labels";
import {
  addDays,
  auditExportQuery,
  auditQuery,
  defaultFrom,
  effectiveFilters,
  exportProblem,
  inclusiveDays,
  isRealDay,
  listUrlSchema,
  localDay,
  periodProblem,
  type AuditListState,
} from "../list-url-state";

const UUID = "0b9b9d0e-2f56-4c1a-9a5f-3a6f6f0f2a11";
const parse = (query: string) => parseUrlState(listUrlSchema, new URLSearchParams(query));
const EMPTY: AuditListState = { from: "", to: "", employeeId: "", entity: "", page: 1 };

describe("listUrlSchema", () => {
  it("the vocabulary offers entity codes (anti-vacuity)", () => {
    expect(AUDIT_ENTITY_CODES.length).toBeGreaterThan(0);
  });

  it("reads a valid URL", () => {
    expect(
      parse(`from=2026-03-01&to=2026-03-31&employeeId=${UUID}&entity=TimeEntry&page=3`),
    ).toEqual({
      from: "2026-03-01",
      to: "2026-03-31",
      employeeId: UUID,
      entity: "TimeEntry",
      page: 3,
    });
  });

  it("drops unknown keys", () => {
    const state = parse("evil=1&from=2026-03-01") as Record<string, unknown>;
    expect(state).not.toHaveProperty("evil");
  });

  it("rejects a malformed or impossible date", () => {
    expect(parse("from=2026-3-1").from).toBe("");
    expect(parse("from=2026-02-31").from).toBe("");
    expect(parse("to=<script>").to).toBe("");
    expect(parse("from=2026-03-01T00:00:00Z").from).toBe("");
  });

  it("rejects a malformed uuid", () => {
    expect(parse("employeeId=not-a-uuid").employeeId).toBe("");
    expect(parse("employeeId=1' OR 1=1").employeeId).toBe("");
  });

  it("accepts only entity codes the vocabulary knows", () => {
    expect(parse("entity=TimeEntry").entity).toBe("TimeEntry");
    expect(parse("entity=NoSuchModel").entity).toBe("");
    expect(parse("entity=constructor").entity).toBe("");
  });

  it("bounds the page number", () => {
    expect(parse("page=0").page).toBe(1);
    expect(parse("page=-4").page).toBe(1);
    expect(parse("page=abc").page).toBe(1);
  });

  it("writes only non-default values and keeps foreign keys", () => {
    expect(serialiseUrlState(listUrlSchema, EMPTY, "salonId=x")).toBe("salonId=x");
    expect(serialiseUrlState(listUrlSchema, { ...EMPTY, from: "2026-03-01", page: 2 }, "")).toBe(
      "from=2026-03-01&page=2",
    );
  });
});

describe("the default period", () => {
  it("an empty from is today minus 29 days (30 days incl. today)", () => {
    expect(defaultFrom("2026-03-31")).toBe("2026-03-02");
    expect(effectiveFilters(EMPTY, "2026-03-31").from).toBe("2026-03-02");
  });

  it("a from in the URL is kept", () => {
    expect(effectiveFilters({ ...EMPTY, from: "2025-01-01" }, "2026-03-31").from).toBe(
      "2025-01-01",
    );
  });
});

describe("day helpers", () => {
  it("isRealDay", () => {
    expect(isRealDay("2026-02-28")).toBe(true);
    expect(isRealDay("2026-02-29")).toBe(false);
    expect(isRealDay("2028-02-29")).toBe(true);
  });

  it("addDays and inclusiveDays cross month and year ends", () => {
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(inclusiveDays("2026-03-01", "2026-03-01")).toBe(1);
    expect(inclusiveDays("2025-12-31", "2026-01-02")).toBe(3);
  });

  it("localDay formats the local calendar day", () => {
    expect(localDay(new Date(2026, 2, 5, 23, 59))).toBe("2026-03-05");
  });
});

describe("period problems", () => {
  it("names an end before the start", () => {
    expect(periodProblem({ from: "2026-03-10", to: "2026-03-01" })).toMatch(/Enddatum/);
    expect(periodProblem({ from: "2026-03-01", to: "2026-03-10" })).toBeNull();
    expect(periodProblem({ from: "", to: "2026-03-10" })).toBeNull();
  });

  it("refuses an export above 366 days, accepts exactly 366", () => {
    expect(exportProblem({ from: "2025-01-01", to: "2026-03-31" }, "2026-03-31")).toMatch(/366/);
    expect(exportProblem({ from: "2025-03-31", to: "2026-03-31" }, "2026-03-31")).toBeNull();
    // 2025-03-31 .. 2026-03-31 is 366 inclusive days; one day earlier is 367.
    expect(exportProblem({ from: "2025-03-30", to: "2026-03-31" }, "2026-03-31")).toMatch(/366/);
  });

  it("an open end counts up to today", () => {
    expect(exportProblem({ from: "2020-01-01", to: "" }, "2026-03-31")).toMatch(/366/);
  });
});

describe("auditQuery", () => {
  const today = "2026-03-31";

  it("the list carries the default from, no to, and the paging", () => {
    const q = new URLSearchParams(auditQuery(EMPTY, { today, paging: { page: 2, limit: 25 } }));
    expect(q.get("from")).toBe("2026-03-02");
    expect(q.has("to")).toBe(false);
    expect(q.get("page")).toBe("2");
    expect(q.get("limit")).toBe("25");
  });

  it("the filters are sent as codes", () => {
    const q = new URLSearchParams(
      auditQuery(
        { ...EMPTY, employeeId: UUID, entity: "LeaveRequest", to: "2026-03-20" },
        { today },
      ),
    );
    expect(q.get("employeeId")).toBe(UUID);
    expect(q.get("entity")).toBe("LeaveRequest");
    expect(q.get("to")).toBe("2026-03-20");
  });

  it("the export is the same filter with a bounded period and no paging", () => {
    const filters = { ...EMPTY, employeeId: UUID, entity: "Employee" };
    const list = new URLSearchParams(
      auditQuery(filters, { today, paging: { page: 1, limit: 25 } }),
    );
    const file = new URLSearchParams(auditExportQuery(filters, today));
    expect(file.get("to")).toBe(today);
    expect(file.has("page")).toBe(false);
    expect(file.has("limit")).toBe(false);
    for (const key of ["from", "employeeId", "entity"]) expect(file.get(key)).toBe(list.get(key));
  });
});
