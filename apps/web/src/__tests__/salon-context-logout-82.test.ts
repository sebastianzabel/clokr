// Issue #82 (D-09) — logout forgets the salon context: real `$stores/auth` and
// `$stores/salon-context` (no module mocks), `fetch` and `localStorage` stubbed BEFORE a fresh
// import, as in auth-boot-hydration.test.ts. A shared salon device keeps no selection residue.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/utils/logger", () => ({ clientLogger: { warn: vi.fn(), error: vi.fn() } }));

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

const CONTEXT = {
  tenant: { id: "t1", name: "Kette" },
  isMultiSalon: true,
  homeSalonId: "s1",
  salons: [
    { id: "s1", name: "Salon Nord" },
    { id: "s2", name: "Salon Ost" },
  ],
};

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function freshModules() {
  vi.resetModules();
  const { authStore } = await import("$stores/auth");
  const { salonContext } = await import("$stores/salon-context");
  return { authStore, salonContext };
}

describe("Issue #82 — logout forgets the salon context", () => {
  it("removes every stored selection, keeps the theme, and returns the store to its initial state", async () => {
    localStorage.setItem("clokr.salonContext.t1.u1", "s1");
    localStorage.setItem("clokr.salonContext.t2.u9", "ALL");
    localStorage.setItem("theme", "wald");
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(CONTEXT)));
    const { authStore, salonContext } = await freshModules();

    await salonContext.load("u1", { force: true });
    expect(salonContext.peek().loaded).toBe(true);
    expect(salonContext.peek().selection).toBe("s1");

    authStore.logout();
    expect(localStorage.getItem("clokr.salonContext.t1.u1")).toBeNull();
    expect(localStorage.getItem("clokr.salonContext.t2.u9")).toBeNull();
    expect(localStorage.getItem("theme")).toBe("wald");
    expect(salonContext.peek()).toEqual({
      loaded: false,
      tenant: null,
      salons: [],
      isMultiSalon: false,
      homeSalonId: null,
      selection: null,
      // Phase 566: the booked-package display state is forgotten on logout like everything else.
      packages: null,
    });
  });

  it("a load that resolves after logout leaves the store at the initial state", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (resolveFetch = r)));
    const { authStore, salonContext } = await freshModules();

    const pending = salonContext.load("u1", { force: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    authStore.logout();
    resolveFetch(jsonResponse(CONTEXT));
    await pending;
    expect(salonContext.peek().loaded).toBe(false);
    expect(salonContext.peek().salons).toEqual([]);
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    expect(keys.filter((k) => k?.startsWith("clokr.salonContext."))).toEqual([]);
  });
});
