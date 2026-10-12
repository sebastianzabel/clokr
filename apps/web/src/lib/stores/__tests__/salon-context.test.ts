// Issue #82 (D-07..D-10) — the salon-context store: selection rules, persistence per device and
// person, storage failures, the fail-closed fetch, stale responses and the navigation throttle.
//
// Every test re-imports the module fresh (`vi.resetModules()` + dynamic import, as in
// release-notes.test.ts) so the module-level store starts from its initial state. This jsdom has
// no localStorage — a memory storage is stubbed per test (auth-boot-hydration.test.ts precedent).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiGet = vi.fn();
const loggerWarn = vi.fn();

class FakeApiError extends Error {
  constructor(
    public status: number,
    message = "err",
  ) {
    super(message);
  }
}

vi.mock("$api/client", () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
  ApiError: FakeApiError,
}));

vi.mock("$lib/utils/logger", () => ({
  clientLogger: { warn: (...args: unknown[]) => loggerWarn(...args), error: vi.fn() },
}));

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

async function freshModule() {
  vi.resetModules();
  return import("../salon-context");
}

const S1 = { id: "s1", name: "Salon Nord" };
const S2 = { id: "s2", name: "Salon Ost" };
const FOREIGN_UUID = "9b2f6a8e-3c1d-4e5f-8a7b-0c1d2e3f4a5b";

function response(salons = [S1, S2], overrides: Record<string, unknown> = {}) {
  return {
    tenant: { id: "t1", name: "Kette" },
    isMultiSalon: true,
    homeSalonId: "s1",
    salons,
    ...overrides,
  };
}

const KEY_T1_U1 = "clokr.salonContext.t1.u1";

beforeEach(() => {
  apiGet.mockReset();
  loggerWarn.mockReset();
  vi.stubGlobal("localStorage", memoryStorage());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("salon-context — tracer", () => {
  it("load() fetches /me/context once and holds tenant, salons and the resolved selection", async () => {
    const { salonContext } = await freshModule();
    apiGet.mockResolvedValue(response());
    await salonContext.load("u1", { force: true });
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledWith("/me/context");
    expect(salonContext.peek()).toEqual({
      loaded: true,
      tenant: { id: "t1", name: "Kette" },
      salons: [S1, S2],
      isMultiSalon: true,
      homeSalonId: "s1",
      selection: "ALL",
    });
  });

  it("copies only id and name from the answer", async () => {
    const { salonContext } = await freshModule();
    apiGet.mockResolvedValue(
      response([{ ...S1, address: "x" } as never, S2], {
        tenant: { id: "t1", name: "Kette", slug: "k" },
      }),
    );
    await salonContext.load("u1", { force: true });
    expect(salonContext.peek().salons).toEqual([S1, S2]);
    expect(salonContext.peek().tenant).toEqual({ id: "t1", name: "Kette" });
  });
});

describe("salon-context — pure rules", () => {
  const multi = { isMultiSalon: true, salons: [S1, S2] };

  it.each([
    ["ALL", "ALL"],
    ["s2", "s2"],
    [null, "ALL"],
    ["s9", "ALL"], // stale: deactivated or scope removed
    [FOREIGN_UUID, "ALL"], // manipulated: a uuid that is not listed
    ["", "ALL"],
    ["null", "ALL"],
    ["undefined", "ALL"],
    ["<script>", "ALL"],
  ])("resolveSelection with options shown: stored %s → %s", async (stored, expected) => {
    const { resolveSelection } = await freshModule();
    expect(resolveSelection(stored, multi)).toBe(expected);
  });

  it.each([["ALL"], ["s2"], [null]])(
    "exactly one reachable salon wins over stored %s",
    async (stored) => {
      const { resolveSelection } = await freshModule();
      expect(resolveSelection(stored, { isMultiSalon: true, salons: [S1] })).toBe("s1");
      expect(resolveSelection(stored, { isMultiSalon: false, salons: [S1] })).toBe("s1");
    },
  );

  it("zero salons and an inconsistent single-salon tenant with two listed resolve to null", async () => {
    const { resolveSelection } = await freshModule();
    expect(resolveSelection("ALL", { isMultiSalon: true, salons: [] })).toBeNull();
    expect(resolveSelection("s1", { isMultiSalon: false, salons: [S1, S2] })).toBeNull();
  });

  it.each([
    [true, 2, true],
    [true, 1, false],
    [false, 1, false],
    [false, 2, false],
    [true, 0, false],
  ])("showSalonOptions(isMultiSalon %s, %i salons) → %s", async (isMultiSalon, n, expected) => {
    const { showSalonOptions } = await freshModule();
    expect(showSalonOptions({ isMultiSalon, salons: [S1, S2].slice(0, n) })).toBe(expected);
  });

  it.each([
    ["ALL", null],
    ["s2", "s2"],
    ["s9", null],
    [null, null],
  ])("selectedSalonId(selection %s) → %s", async (selection, expected) => {
    const { selectedSalonId } = await freshModule();
    expect(selectedSalonId({ salons: [S1, S2], selection })).toBe(expected);
  });
});

describe("salon-context — persistence (D-09)", () => {
  it("a stale stored value is overwritten with ALL; a choice survives a reload", async () => {
    localStorage.setItem(KEY_T1_U1, "s9");
    let mod = await freshModule();
    apiGet.mockResolvedValue(response());
    await mod.salonContext.load("u1", { force: true });
    expect(localStorage.getItem(KEY_T1_U1)).toBe("ALL");

    mod.salonContext.setSelection("s2");
    expect(localStorage.getItem(KEY_T1_U1)).toBe("s2");
    expect(mod.salonContext.peek().selection).toBe("s2");

    mod = await freshModule(); // a page reload
    await mod.salonContext.load("u1", { force: true });
    expect(mod.salonContext.peek().selection).toBe("s2");
  });

  it("another person and another tenant get their own key — no inheritance", async () => {
    localStorage.setItem(KEY_T1_U1, "s2");
    let mod = await freshModule();
    apiGet.mockResolvedValue(response());
    await mod.salonContext.load("u2", { force: true });
    expect(mod.salonContext.peek().selection).toBe("ALL");
    expect(localStorage.getItem("clokr.salonContext.t1.u2")).toBe("ALL");

    mod = await freshModule();
    apiGet.mockResolvedValue(response([S1, S2], { tenant: { id: "t2", name: "Andere" } }));
    await mod.salonContext.load("u1", { force: true });
    expect(mod.salonContext.peek().selection).toBe("ALL");
    expect(localStorage.getItem("clokr.salonContext.t2.u1")).toBe("ALL");
    expect(localStorage.getItem(KEY_T1_U1)).toBe("s2");
  });

  it("setSelection ignores unlisted ids, and any value while options are hidden", async () => {
    let mod = await freshModule();
    apiGet.mockResolvedValue(response());
    await mod.salonContext.load("u1", { force: true });
    mod.salonContext.setSelection(FOREIGN_UUID);
    expect(mod.salonContext.peek().selection).toBe("ALL");
    expect(localStorage.getItem(KEY_T1_U1)).toBe("ALL");

    localStorage.clear();
    mod = await freshModule();
    apiGet.mockResolvedValue(response([S1]));
    await mod.salonContext.load("u1", { force: true });
    mod.salonContext.setSelection("ALL");
    mod.salonContext.setSelection("s2");
    expect(mod.salonContext.peek().selection).toBe("s1");
    expect(localStorage.length).toBe(0);
  });

  it("a single-salon answer writes nothing; load(null) neither reads nor writes", async () => {
    let mod = await freshModule();
    apiGet.mockResolvedValue(response([S1], { isMultiSalon: false }));
    await mod.salonContext.load("u1", { force: true });
    expect(localStorage.length).toBe(0);

    const getItem = vi.spyOn(localStorage, "getItem");
    mod = await freshModule();
    apiGet.mockResolvedValue(response());
    await mod.salonContext.load(null, { force: true });
    expect(mod.salonContext.peek().selection).toBe("ALL");
    expect(getItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it("missing or throwing storage never breaks load or setSelection", async () => {
    vi.stubGlobal("localStorage", undefined);
    let mod = await freshModule();
    apiGet.mockResolvedValue(response());
    await mod.salonContext.load("u1", { force: true });
    mod.salonContext.setSelection("s2");
    expect(mod.salonContext.peek().selection).toBe("s2");

    const throwing = memoryStorage();
    throwing.getItem = () => {
      throw new Error("denied");
    };
    throwing.setItem = () => {
      throw new Error("quota");
    };
    vi.stubGlobal("localStorage", throwing);
    mod = await freshModule();
    await mod.salonContext.load("u1", { force: true });
    expect(mod.salonContext.peek().selection).toBe("ALL");
    expect(() => mod.salonContext.setSelection("s1")).not.toThrow();
    expect(mod.salonContext.peek().selection).toBe("s1");
  });
});

describe("salon-context — failures, transitions, races (D-10)", () => {
  it("a 500 without a previous answer fails closed and is reported once", async () => {
    localStorage.setItem(KEY_T1_U1, "s2");
    const { salonContext } = await freshModule();
    apiGet.mockRejectedValue(new FakeApiError(500));
    await salonContext.load("u1", { force: true });
    expect(salonContext.peek()).toEqual({
      loaded: true,
      tenant: null,
      salons: [],
      isMultiSalon: false,
      homeSalonId: null,
      selection: null,
    });
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn.mock.calls[0][1]).toEqual({ status: 500 });
    expect(localStorage.getItem(KEY_T1_U1)).toBe("s2");
  });

  it.each([[new FakeApiError(401)], [new TypeError("Failed to fetch")]])(
    "a 401 or a network error without a previous answer fails closed silently (%s)",
    async (error) => {
      const { salonContext } = await freshModule();
      apiGet.mockRejectedValue(error);
      await salonContext.load("u1", { force: true });
      expect(salonContext.peek().loaded).toBe(true);
      expect(salonContext.peek().salons).toEqual([]);
      expect(loggerWarn).not.toHaveBeenCalled();
    },
  );

  it("a transient failure after a good answer keeps the last good state; a 401 does not", async () => {
    const { salonContext } = await freshModule();
    apiGet.mockResolvedValueOnce(response());
    await salonContext.load("u1", { force: true });
    salonContext.setSelection("s2");

    apiGet.mockRejectedValueOnce(new FakeApiError(503));
    await salonContext.load("u1", { force: true });
    expect(salonContext.peek().selection).toBe("s2");
    expect(salonContext.peek().salons).toEqual([S1, S2]);

    apiGet.mockRejectedValueOnce(new TypeError("offline"));
    await salonContext.load("u1", { force: true });
    expect(salonContext.peek().selection).toBe("s2");

    apiGet.mockRejectedValueOnce(new FakeApiError(401));
    await salonContext.load("u1", { force: true });
    expect(salonContext.peek().salons).toEqual([]);
    expect(salonContext.peek().selection).toBeNull();
  });

  it("1 → 2 → 1 active salons: options appear and vanish again (#64)", async () => {
    const { salonContext, showSalonOptions } = await freshModule();
    apiGet.mockResolvedValueOnce(response([S1], { isMultiSalon: false }));
    await salonContext.load("u1", { force: true });
    expect([salonContext.peek().selection, showSalonOptions(salonContext.peek())]).toEqual([
      "s1",
      false,
    ]);
    apiGet.mockResolvedValueOnce(response());
    await salonContext.load("u1", { force: true });
    expect([salonContext.peek().selection, showSalonOptions(salonContext.peek())]).toEqual([
      "ALL",
      true,
    ]);
    apiGet.mockResolvedValueOnce(response([S1], { isMultiSalon: false }));
    await salonContext.load("u1", { force: true });
    expect([salonContext.peek().selection, showSalonOptions(salonContext.peek())]).toEqual([
      "s1",
      false,
    ]);
  });

  it("two overlapping loads answered in reverse order: the later-started one wins", async () => {
    const { salonContext } = await freshModule();
    let resolveFirst: (v: unknown) => void = () => {};
    apiGet.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)));
    apiGet.mockResolvedValueOnce(response([S1], { isMultiSalon: false }));
    const first = salonContext.load("u1", { force: true });
    await salonContext.load("u1", { force: true });
    resolveFirst(response());
    await first;
    expect(salonContext.peek().salons).toEqual([S1]);
  });

  it("navigation loads are skipped while one is in flight or within 30 s of a success", async () => {
    const { salonContext } = await freshModule();
    let resolveFirst: (v: unknown) => void = () => {};
    apiGet.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)));
    const first = salonContext.load("u1", { force: true });
    await salonContext.load("u1"); // in flight → skipped
    expect(apiGet).toHaveBeenCalledTimes(1);
    resolveFirst(response());
    await first;

    vi.setSystemTime(new Date("2026-06-15T10:00:29.000Z"));
    apiGet.mockResolvedValue(response());
    await salonContext.load("u1"); // 29 s after the success → skipped
    expect(apiGet).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-06-15T10:00:31.000Z"));
    await salonContext.load("u1"); // 31 s → reloads
    expect(apiGet).toHaveBeenCalledTimes(2);

    await salonContext.load("u1", { force: true }); // force bypasses the window
    expect(apiGet).toHaveBeenCalledTimes(3);
  });

  it("reset() removes every stored selection, returns to the initial state and drops a late answer", async () => {
    localStorage.setItem(KEY_T1_U1, "s1");
    localStorage.setItem("clokr.salonContext.t2.u9", "ALL");
    localStorage.setItem("theme", "wald");
    const { salonContext } = await freshModule();
    let resolveLate: (v: unknown) => void = () => {};
    apiGet.mockImplementationOnce(() => new Promise((r) => (resolveLate = r)));
    const late = salonContext.load("u1", { force: true });
    salonContext.reset();
    resolveLate(response());
    await late;
    expect(salonContext.peek().loaded).toBe(false);
    expect(salonContext.peek().salons).toEqual([]);
    expect(localStorage.getItem(KEY_T1_U1)).toBeNull();
    expect(localStorage.getItem("clokr.salonContext.t2.u9")).toBeNull();
    expect(localStorage.getItem("theme")).toBe("wald");
  });
});
