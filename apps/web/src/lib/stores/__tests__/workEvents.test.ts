// @vitest-environment node
// Phase 82 (UI-V19-07 + UI-V19-08) — workEvents store contract test.
//
// The store is the SINGLE entry point for /work-events* GETs across all
// 3 consumer surfaces (/time-entries, /team/time-entries, /dashboard).
// Centralizing the URL strings here makes the v1.8.12 cross-employee leak
// class structurally impossible: loadMine() can never receive an
// ?employeeId= param because the function signature does not accept one.
//
// Tests 1-2: loadMine URL + return shape.
// Tests 3-4: loadByEmployee URL + return shape.
// Test 5: regression — loadMine never sends ?employeeId= (T-82-01).
// Test 6: static — workEvents.ts must not import writable() (NOT a reactive
//   singleton — see 82-RESEARCH.md §Anti-Patterns).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const apiGetMock = vi.fn();
vi.mock("$api/client", () => ({
  api: {
    get: apiGetMock,
  },
}));

// Import AFTER vi.mock so the mock is in scope.
const { workEvents } = await import("../workEvents");
import type { WorkEventListMine, WorkEventListTenant } from "@clokr/types";

beforeEach(() => {
  apiGetMock.mockReset();
});

describe("workEvents.loadMine (UI-V19-07)", () => {
  it("issues GET /work-events/mine?from=&to= with NO employeeId param", async () => {
    apiGetMock.mockResolvedValueOnce([] satisfies WorkEventListMine);
    await workEvents.loadMine("2026-06-01", "2026-06-30");
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    const calledPath = apiGetMock.mock.calls[0][0] as string;
    expect(calledPath).toBe("/work-events/mine?from=2026-06-01&to=2026-06-30");
  });

  it("returns the typed WorkEventListMine value from api.get", async () => {
    const fixture: WorkEventListMine = [
      {
        id: "we-1",
        employeeId: "emp-1",
        type: "VOCATIONAL_SCHOOL",
        source: "PATTERN",
        date: "2026-06-10",
        workedMinutes: 480,
        expectedMinutes: 480,
        payload: { type: "VOCATIONAL_SCHOOL" },
        note: null,
      },
    ];
    apiGetMock.mockResolvedValueOnce(fixture);
    const result = await workEvents.loadMine("2026-06-01", "2026-06-30");
    expect(result).toEqual(fixture);
  });

  // T-82-01 regression: cross-employee leak class.
  it("NEVER sends ?employeeId= on the /mine endpoint", async () => {
    apiGetMock.mockResolvedValueOnce([]);
    await workEvents.loadMine("2026-06-01", "2026-06-30");
    const calledPath = apiGetMock.mock.calls[0][0] as string;
    expect(calledPath).not.toContain("employeeId=");
    expect(calledPath).not.toContain("&employeeId");
  });
});

describe("workEvents.loadByEmployee (UI-V19-08)", () => {
  it("issues GET /work-events?employeeId=&from=&to=", async () => {
    apiGetMock.mockResolvedValueOnce([] satisfies WorkEventListTenant);
    await workEvents.loadByEmployee("emp-uuid-123", "2026-06-01", "2026-06-30");
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    const calledPath = apiGetMock.mock.calls[0][0] as string;
    expect(calledPath).toBe("/work-events?employeeId=emp-uuid-123&from=2026-06-01&to=2026-06-30");
  });

  it("returns the typed WorkEventListTenant value with employee sub-object", async () => {
    const fixture: WorkEventListTenant = [
      {
        id: "we-2",
        employeeId: "emp-uuid-123",
        type: "VOCATIONAL_SCHOOL",
        source: "MANUAL",
        date: "2026-06-15",
        workedMinutes: 480,
        expectedMinutes: 480,
        payload: { type: "VOCATIONAL_SCHOOL" },
        note: null,
        employee: {
          firstName: "Tom",
          lastName: "Azubi",
          employeeNumber: "AZB-001",
        },
      },
    ];
    apiGetMock.mockResolvedValueOnce(fixture);
    const result = await workEvents.loadByEmployee("emp-uuid-123", "2026-06-01", "2026-06-30");
    expect(result).toEqual(fixture);
    expect(result[0].employee.firstName).toBe("Tom");
  });
});

describe("workEvents.ts source — NO reactive singleton (82-RESEARCH.md Anti-Pattern)", () => {
  it("does NOT import from svelte/store (no writable/readable)", () => {
    const src = readFileSync(resolve(__dirname, "../workEvents.ts"), "utf-8");
    expect(src).not.toContain("svelte/store");
    expect(src).not.toContain("writable(");
    expect(src).not.toContain("readable(");
  });
});
