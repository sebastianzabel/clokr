/**
 * Phase 98 Plan 01 — calibration against the 2026-08-17 v1.9.14 prod dry-run.
 *
 * The executor MUST NOT query production. This test reproduces the prod SHAPE
 * and COUNTS as synthetic in-memory fixtures. Baseline (verbatim, from
 * 98-CONTEXT.md): 95 active MONTHLY snapshots across 19 employees in 1 tenant;
 * 89 links with delta === 0; exactly 6 non-zero — five bridge rows at
 * -1080, 90, 540, 600, 750 and one real-activity row at 6129
 * (workedMinutes === 900, expectedMinutes === 900, balanceMinutes === 0).
 *
 * Pure-function, DB-free: this is a fixture-driven reproduction, not a live
 * database query. No @clokr/db import, no test-app bootstrap.
 */
import { describe, it, expect } from "vitest";
import {
  walkSaldoChain,
  selectChainViolations,
  selectDuplicateMonthLinks,
  type ChainRow,
} from "../saldo-chain-integrity";

/** First day (UTC) of the month at `offset` (0 => 2026-01-01). */
function periodStartFor(offset: number): Date {
  return new Date(Date.UTC(2026, offset, 1));
}

/** Last day (UTC) of the month at `offset` (0 => 2026-01-31). */
function periodEndFor(offset: number): Date {
  return new Date(Date.UTC(2026, offset + 1, 0));
}

function mkRow(
  id: string,
  offset: number,
  workedMinutes: number,
  expectedMinutes: number,
  balanceMinutes: number,
  carryOver: number,
): ChainRow {
  return {
    id,
    periodStart: periodStartFor(offset),
    periodEnd: periodEndFor(offset),
    workedMinutes,
    expectedMinutes,
    balanceMinutes,
    carryOver,
  };
}

const BRIDGE_CARRY_OVERS = [-1080, 90, 540, 600, 750];

/**
 * Employees 0-4 (5 chains x 5 links = 25 links): link 0 is a bridge
 * (worked = expected = balance = 0) carrying carryOver from BRIDGE_CARRY_OVERS
 * by employee index; links 1-4 are well-behaved (carryOver = previous
 * carryOver + balanceMinutes).
 */
function buildBridgeStartChain(employeeIndex: number): ChainRow[] {
  const rows: ChainRow[] = [];
  let carry = BRIDGE_CARRY_OVERS[employeeIndex];
  rows.push(mkRow(`emp${employeeIndex}-l0`, 0, 0, 0, 0, carry));

  for (let i = 1; i <= 4; i++) {
    const balance = 100 + i * 10; // deterministic, no randomness
    carry = carry + balance;
    rows.push(mkRow(`emp${employeeIndex}-l${i}`, i, 9600, 9600 - balance, balance, carry));
  }
  return rows;
}

/**
 * Employee 5 (6 links): links 0-2 and 4-5 well-behaved; link 3 has
 * workedMinutes=900, expectedMinutes=900, balanceMinutes=0 and
 * carryOver = carryOverIn + 0 + 6129 (the hard case — real activity with an
 * injected correction on top, undetectable by shape alone). Every LATER link
 * continues from that stored value, so only link 3 is a violation.
 */
function buildEmployee5Chain(): ChainRow[] {
  const rows: ChainRow[] = [];
  let carry = 0;

  for (let i = 0; i <= 2; i++) {
    const balance = 50 + i * 20;
    carry = carry + balance;
    rows.push(mkRow(`emp5-l${i}`, i, 9600, 9600 - balance, balance, carry));
  }

  // Link 3: real activity (worked = expected = 900, balance = 0) plus an
  // injected +6129 correction on top of the chain-implied carry.
  const balance3 = 0;
  carry = carry + balance3 + 6129;
  rows.push(mkRow("emp5-l3", 3, 900, 900, balance3, carry));

  for (let i = 4; i <= 5; i++) {
    const balance = 30 + i * 5;
    carry = carry + balance;
    rows.push(mkRow(`emp5-l${i}`, i, 9600, 9600 - balance, balance, carry));
  }
  return rows;
}

/** Employees 6-17 (12 chains x 5 links) and employee 18 (4 links): all well-behaved. */
function buildWellBehavedChain(employeeIndex: number, linkCount: number): ChainRow[] {
  const rows: ChainRow[] = [];
  let carry = 0;
  for (let i = 0; i < linkCount; i++) {
    const balance = 20 + (employeeIndex + i) * 7;
    carry = carry + balance;
    rows.push(mkRow(`emp${employeeIndex}-l${i}`, i, 9600, 9600 - balance, balance, carry));
  }
  return rows;
}

describe("Phase 98 calibration — reproduces the 2026-08-17 v1.9.14 prod dry-run split", () => {
  const chains: ChainRow[][] = [];
  for (let e = 0; e <= 4; e++) chains.push(buildBridgeStartChain(e));
  chains.push(buildEmployee5Chain());
  for (let e = 6; e <= 17; e++) chains.push(buildWellBehavedChain(e, 5));
  chains.push(buildWellBehavedChain(18, 4));

  it("builds 19 employee chains totaling 95 links", () => {
    expect(chains).toHaveLength(19);
    const linksPerChain = chains.map((rows) => walkSaldoChain(rows));
    const totalLinks = linksPerChain.reduce((sum, links) => sum + links.length, 0);
    expect(totalLinks).toBe(95);
  });

  it("reproduces 89 zero-delta links and exactly 6 non-zero deltas", () => {
    const linksPerChain = chains.map((rows) => walkSaldoChain(rows));
    const allLinks = linksPerChain.flat();
    expect(allLinks).toHaveLength(95);

    const zeroDeltaLinks = allLinks.filter((l) => l.delta === 0);
    expect(zeroDeltaLinks.length).toBe(89);

    const violations = linksPerChain.flatMap((links) => selectChainViolations(links));
    expect(violations).toHaveLength(6);
  });

  it("the violation delta multiset (sorted ascending) equals the prod baseline exactly", () => {
    const linksPerChain = chains.map((rows) => walkSaldoChain(rows));
    const violations = linksPerChain.flatMap((links) => selectChainViolations(links));
    const sortedDeltas = violations.map((v) => v.delta).sort((a, b) => a - b);
    expect(sortedDeltas).toEqual([-1080, 90, 540, 600, 750, 6129]);
  });

  it("classifies exactly 5 bridge violations and 1 normal violation", () => {
    const linksPerChain = chains.map((rows) => walkSaldoChain(rows));
    const violations = linksPerChain.flatMap((links) => selectChainViolations(links));

    const bridgeViolations = violations.filter((v) => v.kind === "bridge");
    const normalViolations = violations.filter((v) => v.kind === "normal");
    expect(bridgeViolations).toHaveLength(5);
    expect(normalViolations).toHaveLength(1);
  });

  it("the kind=normal violation is the hard case: worked=expected=900, balance=0, delta=6129", () => {
    const linksPerChain = chains.map((rows) => walkSaldoChain(rows));
    const violations = linksPerChain.flatMap((links) => selectChainViolations(links));
    const normalViolation = violations.find((v) => v.kind === "normal");

    expect(normalViolation).toBeDefined();
    expect(normalViolation!.workedMinutes).toBe(900);
    expect(normalViolation!.expectedMinutes).toBe(900);
    expect(normalViolation!.balanceMinutes).toBe(0);
    expect(normalViolation!.delta).toBe(6129);
  });

  it("no duplicate_month links across any chain in this fixture", () => {
    const linksPerChain = chains.map((rows) => walkSaldoChain(rows));
    const duplicates = linksPerChain.flatMap((links) => selectDuplicateMonthLinks(links));
    expect(duplicates).toEqual([]);
  });
});

// An implementation reporting a different split is wrong — see 98-CONTEXT.md.
// Owner-side confirmation against real prod data is the manual step in Plan 04.
