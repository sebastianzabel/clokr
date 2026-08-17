/**
 * Phase 98 Plan 03 — GT-98aa..GT-98aj tests for the audit script's pure helpers.
 *
 * DB-free: imports ONLY the exported Part A helpers. The run-guard
 * (`import.meta.url === pathToFileURL(process.argv[1]).href`) is what makes this import
 * side-effect-free — if that guard is ever removed this test will hang or fail on a missing
 * DATABASE_URL, which is intentional.
 */
import { describe, it, expect } from "vitest";
import {
  EXIT_OK,
  EXIT_ERROR,
  EXIT_FINDINGS,
  exitCodeFor,
  truncId,
  formatFindingLine,
} from "../audit-saldo-chain-integrity";

describe("GT-98 audit-saldo-chain-integrity pure helpers (DB-free)", () => {
  it("exit code constants are 0/1/2", () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_ERROR).toBe(1);
    expect(EXIT_FINDINGS).toBe(2);
  });

  it("GT-98aa exitCodeFor({ unexplained: 0, duplicateMonth: 0 }) returns 0", () => {
    expect(exitCodeFor({ unexplained: 0, duplicateMonth: 0 })).toBe(0);
  });

  it("GT-98ab exitCodeFor({ unexplained: 1, duplicateMonth: 0 }) returns 2", () => {
    expect(exitCodeFor({ unexplained: 1, duplicateMonth: 0 })).toBe(2);
  });

  it("GT-98ac exitCodeFor({ unexplained: 0, duplicateMonth: 1 }) returns 2", () => {
    expect(exitCodeFor({ unexplained: 0, duplicateMonth: 1 })).toBe(2);
  });

  it("GT-98ad exitCodeFor({ unexplained: 3, duplicateMonth: 2 }) returns 2", () => {
    expect(exitCodeFor({ unexplained: 3, duplicateMonth: 2 })).toBe(2);
  });

  it('GT-98ae truncId("e1d8e99f-1234-5678-9abc-def012345678") returns "e1d8e99f"', () => {
    const id = truncId("e1d8e99f-1234-5678-9abc-def012345678");
    expect(id).toBe("e1d8e99f");
    expect(id.length).toBe(8);
  });

  it("GT-98af formatFindingLine for the 6129 prod case renders [UNEXPLAINED]/delta=+6129/month=2026-04/kind=normal/matched=-", () => {
    const line = formatFindingLine({
      classification: "unexplained",
      employeeId: "e1d8e99f-1111-2222-3333-444444444444",
      monthLabel: "2026-04",
      rowId: "dfc15765-1111-2222-3333-444444444444",
      carryOverIn: -1016,
      balanceMinutes: 0,
      expectedCarryOver: -1016,
      storedCarryOver: 5113,
      delta: 6129,
      kind: "normal",
      workedMinutes: 900,
      expectedMinutes: 900,
      auditReasonCount: 2,
      rule: "none",
      matchedReason: null,
    });
    expect(line).toContain("[UNEXPLAINED]");
    expect(line).toContain("delta=+6129");
    expect(line).toContain("month=2026-04");
    expect(line).toContain("kind=normal");
    expect(line).toContain("matched=-");
  });

  it("GT-98ag formatFindingLine for a documented bridge renders [documented ]/delta=-1080/rule=bridge-at-chain-start", () => {
    const line = formatFindingLine({
      classification: "documented",
      employeeId: "aaaaaaaa-1111-2222-3333-444444444444",
      monthLabel: "2026-01",
      rowId: "bbbbbbbb-1111-2222-3333-444444444444",
      carryOverIn: 0,
      balanceMinutes: 0,
      expectedCarryOver: 0,
      storedCarryOver: -1080,
      delta: -1080,
      kind: "bridge",
      workedMinutes: 0,
      expectedMinutes: 0,
      auditReasonCount: 0,
      rule: "bridge-at-chain-start",
      matchedReason: null,
    });
    expect(line).toContain("[documented ]");
    expect(line).toContain("delta=-1080");
    expect(line).toContain("rule=bridge-at-chain-start");
  });

  it('GT-98ah formatFindingLine with a matchedReason renders matched="Vor-Tracking-Leistung +100h restore"', () => {
    const line = formatFindingLine({
      classification: "documented",
      employeeId: "cccccccc-1111-2222-3333-444444444444",
      monthLabel: "2026-05",
      rowId: "dddddddd-1111-2222-3333-444444444444",
      carryOverIn: 0,
      balanceMinutes: 0,
      expectedCarryOver: 0,
      storedCarryOver: 6000,
      delta: 6000,
      kind: "normal",
      workedMinutes: 900,
      expectedMinutes: 900,
      auditReasonCount: 1,
      rule: "allowlist:Vor-Tracking-Leistung",
      matchedReason: "Vor-Tracking-Leistung +100h restore",
    });
    expect(line).toContain('matched="Vor-Tracking-Leistung +100h restore"');
  });

  it("GT-98ai output contains no name-like fields: matches /^\\[(UNEXPLAINED|documented )\\] emp=[0-9a-f]{8} /", () => {
    const line = formatFindingLine({
      classification: "unexplained",
      employeeId: "e1d8e99f-1111-2222-3333-444444444444",
      monthLabel: "2026-04",
      rowId: "dfc15765-1111-2222-3333-444444444444",
      carryOverIn: -1016,
      balanceMinutes: 0,
      expectedCarryOver: -1016,
      storedCarryOver: 5113,
      delta: 6129,
      kind: "normal",
      workedMinutes: 900,
      expectedMinutes: 900,
      auditReasonCount: 2,
      rule: "none",
      matchedReason: null,
    });
    expect(line).toMatch(/^\[(UNEXPLAINED|documented )\] emp=[0-9a-f]{8} /);
  });

  it("GT-98aj importing the script module performs no I/O (module-scope import completes without a DB connection)", () => {
    // The mere fact that this test file executed at all (imports resolved at module scope
    // above) proves the run-guard prevented run() from firing under vitest — no
    // DATABASE_URL is set in this test environment and no connection was attempted.
    expect(typeof exitCodeFor).toBe("function");
    expect(typeof truncId).toBe("function");
    expect(typeof formatFindingLine).toBe("function");
  });
});
