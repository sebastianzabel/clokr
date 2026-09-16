/**
 * Phase 99 Plan 02 (OB-02) — DB-free unit proof of getCarryOverBase()'s precedence:
 *     prevSnapshot?.carryOver ?? openingBalance?.minutes ?? 0
 *
 * Pure unit test against a hand-rolled stub reader — no getTestApp(), no database
 * connection, must run in milliseconds. Locked decision D-07 (99-CONTEXT.md): the
 * opening balance applies ONLY at the head of the chain, never mid-chain.
 *
 * No PII — no fixture data beyond synthetic ids/numbers.
 */
import { describe, it, expect, vi } from "vitest";
import { getCarryOverBase, type OpeningBalanceReader } from "../carry-over-base";

function makeStub(findFirstResult: { minutes: number } | null): {
  reader: OpeningBalanceReader;
  findFirst: ReturnType<typeof vi.fn>;
} {
  const findFirst = vi.fn().mockResolvedValue(findFirstResult);
  return {
    reader: { openingBalance: { findFirst } },
    findFirst,
  };
}

describe("getCarryOverBase — chain-head resolution precedence (DB-free)", () => {
  it("Test 1: prevSnapshot present → returns prevSnapshot.carryOver, OpeningBalance never queried", async () => {
    const { reader, findFirst } = makeStub({ minutes: 999 });

    const result = await getCarryOverBase(reader, "emp-1", { carryOver: 420 });

    expect(result).toBe(420);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("Test 2: prevSnapshot null + active OpeningBalance exists → returns openingBalance.minutes (including negative)", async () => {
    const { reader } = makeStub({ minutes: -1080 });

    const result = await getCarryOverBase(reader, "emp-2", null);

    expect(result).toBe(-1080);
  });

  it("Test 3: prevSnapshot null + no OpeningBalance row → returns 0 (provable no-op half of OB-02)", async () => {
    const { reader } = makeStub(null);

    const result = await getCarryOverBase(reader, "emp-3", null);

    expect(result).toBe(0);
  });

  it("Test 4: the query filter is exactly { employeeId, superseded: false } — superseded rows never resolved", async () => {
    const { reader, findFirst } = makeStub({ minutes: 600 });

    await getCarryOverBase(reader, "emp-4", undefined);

    expect(findFirst).toHaveBeenCalledWith({
      where: { employeeId: "emp-4", superseded: false },
    });
  });
});
