// Issue #541 (WR-02) — the optimistic save of a terminal key's salon, with a fake `patch`.
import { describe, expect, it, vi } from "vitest";
import { saveTerminalSalon, type TerminalSalonFields } from "../terminal-salon-save";

interface Row extends TerminalSalonFields {
  name: string;
}

const salons = [
  { id: "s1", name: "Salon Nord" },
  { id: "s2", name: "Salon Süd" },
];

function setup(patch: (id: string, salonId: string | null) => Promise<Row>) {
  let rows: Row[] = [
    { id: "t1", name: "Eingang", salonId: "s1", salonName: "Salon Nord", salonActive: true },
    { id: "t2", name: "Lager", salonId: null, salonName: null, salonActive: null },
  ];
  const history: Row[][] = [];
  const events: string[] = [];
  const deps = {
    getRows: () => rows,
    setRows: (next: Row[]) => {
      rows = next;
      history.push(next);
    },
    salons,
    patch,
    onSaved: vi.fn(() => events.push("saved")),
    onFailed: vi.fn((_err: unknown) => {
      // The row must already be back when the failure is reported (revert BEFORE the toast).
      events.push(`failed:${rows[0].salonId}`);
    }),
  };
  return { deps, events, history, rows: () => rows };
}

describe("saveTerminalSalon", () => {
  it("success: updates optimistically, then replaces the row by the server row", async () => {
    let seenDuringPatch: Row | undefined;
    const server: Row = {
      id: "t1",
      name: "Eingang",
      salonId: "s2",
      salonName: "Salon Süd",
      salonActive: true,
    };
    const ctx = setup(async () => {
      seenDuringPatch = ctx.rows()[0];
      return server;
    });
    const ok = await saveTerminalSalon({ ...ctx.deps, id: "t1", salonId: "s2" });
    expect(ok).toBe(true);
    expect(seenDuringPatch).toMatchObject({
      salonId: "s2",
      salonName: "Salon Süd",
      salonActive: true,
    });
    expect(ctx.rows()[0]).toBe(server);
    expect(ctx.rows()[1].id).toBe("t2");
    expect(ctx.deps.onSaved).toHaveBeenCalledTimes(1);
    expect(ctx.deps.onFailed).not.toHaveBeenCalled();
  });

  it("removing the binding is optimistic with null name and active flag", async () => {
    let seenDuringPatch: Row | undefined;
    const ctx = setup(async (id, salonId) => {
      seenDuringPatch = ctx.rows()[0];
      return { id, name: "Eingang", salonId, salonName: null, salonActive: null };
    });
    expect(await saveTerminalSalon({ ...ctx.deps, id: "t1", salonId: null })).toBe(true);
    expect(seenDuringPatch).toMatchObject({ salonId: null, salonName: null, salonActive: null });
  });

  it("patches the given id with the chosen salon", async () => {
    const patch = vi.fn(async (id: string, salonId: string | null) => ({
      id,
      name: "Lager",
      salonId,
      salonName: "Salon Nord",
      salonActive: true,
    }));
    const ctx = setup(patch);
    await saveTerminalSalon({ ...ctx.deps, id: "t2", salonId: "s1" });
    expect(patch).toHaveBeenCalledWith("t2", "s1");
  });

  it("failure: restores the previous row BEFORE onFailed, returns false", async () => {
    const original = setup(async () => {
      throw new Error("boom");
    });
    const before = original.rows()[0];
    const ok = await saveTerminalSalon({ ...original.deps, id: "t1", salonId: "s2" });
    expect(ok).toBe(false);
    expect(original.rows()[0]).toBe(before);
    expect(original.deps.onSaved).not.toHaveBeenCalled();
    expect(original.deps.onFailed).toHaveBeenCalledTimes(1);
    expect(original.deps.onFailed.mock.calls[0][0]).toBeInstanceOf(Error);
    // onFailed observed the already-reverted row (salonId "s1"), not the optimistic "s2".
    expect(original.events).toEqual(["failed:s1"]);
    // The optimistic row really was written in between.
    expect(original.history[0][0].salonId).toBe("s2");
  });

  it("an unknown id changes nothing and never patches", async () => {
    const patch = vi.fn();
    const ctx = setup(patch);
    expect(await saveTerminalSalon({ ...ctx.deps, id: "nope", salonId: "s1" })).toBe(false);
    expect(patch).not.toHaveBeenCalled();
    expect(ctx.history).toHaveLength(0);
  });
});
