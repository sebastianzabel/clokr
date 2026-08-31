// Phase 110 (D-05/D-07/D-08/D-10/N-07/N-08) — release-notes store unit tests.
//
// The module under test holds two module-level `writable`s plus a module-level `loaded` guard
// (mirroring `version.ts`, Phase 69, D-08). To exercise the single-shot guard more than once
// across this file, every test calls `vi.resetModules()` and re-imports the module fresh via a
// dynamic `await import(...)` — a plain top-level `import` would share the same module instance
// (and its already-tripped `loaded` flag) across every test in the file.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

const apiGet = vi.fn();
const apiPut = vi.fn();

vi.mock("$api/client", () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    put: (...args: unknown[]) => apiPut(...args),
  },
}));

async function freshModule() {
  vi.resetModules();
  return import("../release-notes");
}

const note = (overrides: Record<string, unknown> = {}) => ({
  version: "1.9.18",
  title: "Krank im Urlaub & Saldo-Korrekturen",
  intro: [],
  sections: [],
  footnote: null,
  ...overrides,
});

describe("release-notes store (Phase 110)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let setItemSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    apiGet.mockReset();
    apiPut.mockReset();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setItemSpy = vi.spyOn(Storage.prototype, "setItem");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loadReleaseNotesData() calls GET /release-notes and GET /me/release-notes-seen exactly once each; a second call issues no further requests", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === "/release-notes") return Promise.resolve({ releases: [note()] });
      if (path === "/me/release-notes-seen") return Promise.resolve({ lastSeenVersion: null });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const mod = await freshModule();

    mod.loadReleaseNotesData();
    mod.loadReleaseNotesData();
    await Promise.resolve();
    await Promise.resolve();

    expect(apiGet.mock.calls.filter((c) => c[0] === "/release-notes")).toHaveLength(1);
    expect(apiGet.mock.calls.filter((c) => c[0] === "/me/release-notes-seen")).toHaveLength(1);
  });

  it("a rejected GET /release-notes leaves releaseNotesStore as [], no toast, no console", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === "/release-notes") return Promise.reject(new Error("boom"));
      return Promise.resolve({ lastSeenVersion: null });
    });
    const mod = await freshModule();

    mod.loadReleaseNotesData();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(get(mod.releaseNotesStore)).toEqual([]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it("a rejected GET /me/release-notes-seen leaves lastSeenStore at null, no toast, no console", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === "/release-notes") return Promise.resolve({ releases: [note()] });
      return Promise.reject(new Error("boom"));
    });
    const mod = await freshModule();

    mod.loadReleaseNotesData();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(get(mod.lastSeenStore)).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it("hasUnreadReleaseNotes is true when the newest release's version differs from lastSeenStore", async () => {
    const mod = await freshModule();
    mod.releaseNotesStore.set([note({ version: "1.9.18" })]);
    mod.lastSeenStore.set("1.9.17");
    expect(get(mod.hasUnreadReleaseNotes)).toBe(true);
  });

  it("hasUnreadReleaseNotes is false when they match", async () => {
    const mod = await freshModule();
    mod.releaseNotesStore.set([note({ version: "1.9.18" })]);
    mod.lastSeenStore.set("1.9.18");
    expect(get(mod.hasUnreadReleaseNotes)).toBe(false);
  });

  it("hasUnreadReleaseNotes is false when releaseNotesStore is empty (AK-06 — no phantom badge)", async () => {
    const mod = await freshModule();
    mod.releaseNotesStore.set([]);
    mod.lastSeenStore.set(null);
    expect(get(mod.hasUnreadReleaseNotes)).toBe(false);
  });

  it("markReleaseNotesSeen() PUTs the newest version and optimistically sets lastSeenStore", async () => {
    apiPut.mockResolvedValue({ lastSeenVersion: "1.9.18" });
    const mod = await freshModule();
    mod.releaseNotesStore.set([note({ version: "1.9.18" }), note({ version: "1.9.17" })]);

    mod.markReleaseNotesSeen();

    expect(get(mod.lastSeenStore)).toBe("1.9.18");
    expect(apiPut).toHaveBeenCalledWith("/me/release-notes-seen", { version: "1.9.18" });
  });

  it("a rejected PUT from markReleaseNotesSeen() does not throw and does not revert lastSeenStore", async () => {
    apiPut.mockRejectedValue(new Error("boom"));
    const mod = await freshModule();
    mod.releaseNotesStore.set([note({ version: "1.9.18" })]);

    expect(() => mod.markReleaseNotesSeen()).not.toThrow();
    expect(get(mod.lastSeenStore)).toBe("1.9.18");

    await Promise.resolve();
    await Promise.resolve();
    // Still 1.9.18 — a failed PUT does not revert the optimistic set within this session.
    expect(get(mod.lastSeenStore)).toBe("1.9.18");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("markReleaseNotesSeen() is a no-op when there is no release to acknowledge", async () => {
    const mod = await freshModule();
    mod.releaseNotesStore.set([]);
    mod.lastSeenStore.set(null);

    mod.markReleaseNotesSeen();

    expect(apiPut).not.toHaveBeenCalled();
    expect(get(mod.lastSeenStore)).toBeNull();
  });

  it("never calls localStorage.setItem (AK-10/D-10 — seen state is server-side only)", async () => {
    apiPut.mockResolvedValue({ lastSeenVersion: "1.9.18" });
    apiGet.mockImplementation((path: string) => {
      if (path === "/release-notes") return Promise.resolve({ releases: [note()] });
      return Promise.resolve({ lastSeenVersion: null });
    });
    const mod = await freshModule();
    mod.releaseNotesStore.set([note({ version: "1.9.18" })]);

    mod.markReleaseNotesSeen();
    mod.loadReleaseNotesData();
    await Promise.resolve();
    await Promise.resolve();

    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it("openWhatsNew() sets whatsNewOpen to true", async () => {
    const mod = await freshModule();
    expect(get(mod.whatsNewOpen)).toBe(false);
    mod.openWhatsNew();
    expect(get(mod.whatsNewOpen)).toBe(true);
  });

  // ── Readiness-gate race fix (110-07 checkpoint follow-up) ─────────────────
  // Reproduced live: the What's-New drawer auto-opened on every login instead of once per
  // release, because `hasUnreadReleaseNotes` read `releaseNotesStore` and `lastSeenStore`
  // independently and the two backing fetches settle at different times. Whichever endpoint
  // answers first left the OTHER store at its untouched initial value for one tick; when
  // `/release-notes` answered first, `lastSeenStore` was still `null`, so
  // `"1.9.18" !== null` made the derived store flip true and latch the layout's auto-open
  // `$effect` before the real seen state ever arrived.
  it("does not flag unread while only GET /release-notes has resolved (notes-before-seen ordering) — proven to fail pre-fix", async () => {
    let resolveSeen!: (v: { lastSeenVersion: string | null }) => void;
    const seenPromise = new Promise<{ lastSeenVersion: string | null }>((resolve) => {
      resolveSeen = resolve;
    });
    apiGet.mockImplementation((path: string) => {
      if (path === "/release-notes")
        return Promise.resolve({ releases: [note({ version: "1.9.18" })] });
      if (path === "/me/release-notes-seen") return seenPromise;
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const mod = await freshModule();

    mod.loadReleaseNotesData();
    // Let only the /release-notes microtask chain settle — /me/release-notes-seen is still
    // pending on `seenPromise`. Without the readiness gate, `releaseNotesStore` already holds
    // the payload here while `lastSeenStore` is still its initial `null`.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(get(mod.releaseNotesStore)).toHaveLength(1); // sanity: the race window is real
    expect(get(mod.hasUnreadReleaseNotes)).toBe(false);

    // Now let the seen fetch settle too, with a genuinely different (older) seen version —
    // the derived store must recompute to the CORRECT final answer, not stay stuck false.
    resolveSeen({ lastSeenVersion: "1.9.17" });
    await Promise.resolve();
    await Promise.resolve();

    expect(get(mod.hasUnreadReleaseNotes)).toBe(true);
  });

  it("does not flag unread while only GET /me/release-notes-seen has resolved (seen-before-notes ordering)", async () => {
    let resolveNotes!: (v: { releases: ReturnType<typeof note>[] }) => void;
    const notesPromise = new Promise<{ releases: ReturnType<typeof note>[] }>((resolve) => {
      resolveNotes = resolve;
    });
    apiGet.mockImplementation((path: string) => {
      if (path === "/release-notes") return notesPromise;
      if (path === "/me/release-notes-seen") return Promise.resolve({ lastSeenVersion: "1.9.17" });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const mod = await freshModule();

    mod.loadReleaseNotesData();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(get(mod.lastSeenStore)).toBe("1.9.17"); // sanity: the race window is real
    expect(get(mod.hasUnreadReleaseNotes)).toBe(false);

    resolveNotes({ releases: [note({ version: "1.9.18" })] });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(get(mod.hasUnreadReleaseNotes)).toBe(true);
  });

  it("a failed GET /me/release-notes-seen never flags unread, even after /release-notes resolves with a new version (fail-silent, not fail-noisy)", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === "/release-notes")
        return Promise.resolve({ releases: [note({ version: "1.9.18" })] });
      if (path === "/me/release-notes-seen") return Promise.reject(new Error("boom"));
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const mod = await freshModule();

    mod.loadReleaseNotesData();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(get(mod.releaseNotesStore)).toHaveLength(1);
    expect(get(mod.lastSeenStore)).toBeNull(); // unchanged by the failed fetch
    // The crux: an unresolved "have they seen it?" must never be treated as "they haven't".
    expect(get(mod.hasUnreadReleaseNotes)).toBe(false);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });
});
