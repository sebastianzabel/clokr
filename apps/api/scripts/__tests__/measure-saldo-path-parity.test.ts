/**
 * Unit tests for `scripts/measure-saldo-path-parity.ts` (Phase 113b, plan 02).
 *
 * Covers every bullet of the script's `<behavior>` contract for its Part-A pure helpers
 * (`stableStringify`, `buildBaselineDocument`, `withFixedNow`, `resolveTargetDatabaseUrl`) plus
 * the #203 import-safety assertion for the module as a whole.
 *
 * `pg` is mocked with BOTH `Pool` AND `Client` spied — unlike
 * `script-import-safety.test.ts`, which only spies `Client` because the two DROP-capable
 * scripts it covers (`reset-test-databases.ts`, `ensure-test-database.ts`) reach Postgres
 * through `pg.Client` alone. This script's own guard call
 * (`test-database-guard.ts`'s `assertTestDatabaseMarker`) also goes through `pg.Client`, but the
 * app this script boots (`getTestApp()` -> `buildApp()` -> `plugins/prisma.ts`) reaches Postgres
 * through a `pg.Pool` via `@prisma/adapter-pg` — a `Client`-only spy would leave that path
 * completely unobserved and the "importing this module opens no connection" assertion would be
 * vacuous for exactly the surface that actually matters here (D-13: a gate nobody has seen fire
 * is not a gate). `process.exit` is spied the same way `script-import-safety.test.ts` does, so a
 * regression in the run-guard cannot kill this test's own worker process.
 *
 * This assertion is added as its own file rather than appended to `script-import-safety.test.ts`
 * for the same reason: that file is scoped to the two DROP-capable scripts it was written for
 * (its own header names them explicitly), and keeping this test here lets plan 113B-02 and plan
 * 113B-04 (which will need its own script-level test file) own disjoint files instead of both
 * editing one shared one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const clientCtor = vi.fn();
const poolCtor = vi.fn();

vi.mock("pg", () => ({
  default: {
    Client: class {
      constructor(...args: unknown[]) {
        clientCtor(...args);
      }
      connect() {
        return Promise.resolve();
      }
      query() {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      end() {
        return Promise.resolve();
      }
    },
    Pool: class {
      constructor(...args: unknown[]) {
        poolCtor(...args);
      }
      connect() {
        return Promise.resolve({ release: () => undefined });
      }
      query() {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      end() {
        return Promise.resolve();
      }
      on() {
        return this;
      }
    },
  },
}));

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clientCtor.mockClear();
  poolCtor.mockClear();
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`unexpected process.exit(${code}) during script import`);
  }) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
});

describe("importing measure-saldo-path-parity.ts (GH #203-style import safety)", () => {
  it("never constructs a pg.Client or pg.Pool, and never calls process.exit, as a side effect of import", async () => {
    await import("../measure-saldo-path-parity");
    // A fire-and-forget, unguarded run() would reach its first pg construction entirely
    // synchronously in the common case, but this tick is kept as insurance against a future
    // implementation that defers it — same precedent as script-import-safety.test.ts.
    await new Promise((resolve) => setImmediate(resolve));

    expect(clientCtor).not.toHaveBeenCalled();
    expect(poolCtor).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("stableStringify", () => {
  it("serializes structurally equal inputs to the identical string regardless of key insertion order", async () => {
    const { stableStringify } = await import("../measure-saldo-path-parity");

    const a = {
      schemaVersion: "113b-1",
      scenarios: { z: { balanceMinutes: 1, carryOver: 2 }, a: { carryOver: 2, balanceMinutes: 1 } },
    };
    const b = {
      scenarios: { a: { balanceMinutes: 1, carryOver: 2 }, z: { carryOver: 2, balanceMinutes: 1 } },
      schemaVersion: "113b-1",
    };

    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("sorts keys at every nesting depth, not just the top level", async () => {
    const { stableStringify } = await import("../measure-saldo-path-parity");

    const nested = { b: { d: 1, c: 2 }, a: 3 };
    const out = stableStringify(nested);
    // "a" (top-level) sorts before "b"; inside "b", "c" sorts before "d".
    expect(out.indexOf('"a"')).toBeLessThan(out.indexOf('"b"'));
    expect(out.indexOf('"c"')).toBeLessThan(out.indexOf('"d"'));
  });

  it("ends with a trailing newline and 2-space indentation", async () => {
    const { stableStringify } = await import("../measure-saldo-path-parity");
    const out = stableStringify({ a: 1 });
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain('{\n  "a": 1\n}\n');
  });
});

describe("buildBaselineDocument", () => {
  it("produces a document whose leaves are numbers/labels only — no e-mail-shaped or cuid-shaped value", async () => {
    const { buildBaselineDocument, stableStringify, SCHEMA_VERSION } =
      await import("../measure-saldo-path-parity");

    const doc = buildBaselineDocument({
      "golden-azubi-jan2026": {
        cron: { workedMinutes: 9768, expectedMinutes: 8664, balanceMinutes: 1104, carryOver: 1104 },
        manualClose: {
          workedMinutes: 9768,
          expectedMinutes: 8664,
          balanceMinutes: 1104,
          carryOver: 1104,
        },
        recalc: {
          workedMinutes: 9768,
          expectedMinutes: 8664,
          balanceMinutes: 1104,
          carryOver: 1104,
        },
        pureCore: {
          workedMinutes: 9768,
          expectedMinutes: 8664,
          balanceMinutes: 1104,
          carryOver: 1104,
        },
        live: { balanceHours: 18.4 },
      },
    });

    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);

    const serialized = stableStringify(doc);
    // e-mail-shaped
    expect(serialized).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/);
    // cuid-shaped (bare 20+ char lowercase-alnum string literal)
    expect(serialized).not.toMatch(/"[a-z0-9]{20,}"/);
  });
});

describe("withFixedNow", () => {
  it("shifts new Date() and Date.now() to the given instant for the duration of the callback", async () => {
    const { withFixedNow } = await import("../measure-saldo-path-parity");
    const iso = "2026-02-16T06:00:00.000Z";

    let insideNowMs = 0;
    let insideCtorIso = "";
    await withFixedNow(iso, async () => {
      insideNowMs = Date.now();
      insideCtorIso = new Date().toISOString();
    });

    expect(insideNowMs).toBe(new Date(iso).getTime());
    expect(insideCtorIso).toBe(iso);
  });

  it("restores the real Date afterward, including when the callback throws", async () => {
    const { withFixedNow } = await import("../measure-saldo-path-parity");
    const RealDateCtor = Date;

    await expect(
      withFixedNow("2026-02-16T06:00:00.000Z", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(globalThis.Date).toBe(RealDateCtor);
  });

  it("never touches setTimeout/setInterval", async () => {
    const { withFixedNow } = await import("../measure-saldo-path-parity");
    const realSetTimeout = globalThis.setTimeout;
    const realSetInterval = globalThis.setInterval;

    await withFixedNow("2026-02-16T06:00:00.000Z", async () => {
      expect(globalThis.setTimeout).toBe(realSetTimeout);
      expect(globalThis.setInterval).toBe(realSetInterval);
    });
  });
});

describe("resolveTargetDatabaseUrl", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws when TEST_DATABASE_URL is unset", async () => {
    const { resolveTargetDatabaseUrl } = await import("../measure-saldo-path-parity");
    delete process.env.TEST_DATABASE_URL;
    expect(() => resolveTargetDatabaseUrl()).toThrow(/TEST_DATABASE_URL/);
  });

  it("throws when TEST_DATABASE_URL names a database outside the test namespace", async () => {
    const { resolveTargetDatabaseUrl } = await import("../measure-saldo-path-parity");
    process.env.TEST_DATABASE_URL = "postgresql://user:pass@localhost:5432/clokr";
    expect(() => resolveTargetDatabaseUrl()).toThrow(/test namespace/);
  });

  it("throws when TEST_DATABASE_URL carries a ?schema= parameter", async () => {
    const { resolveTargetDatabaseUrl } = await import("../measure-saldo-path-parity");
    process.env.TEST_DATABASE_URL = "postgresql://user:pass@localhost:5432/clokr_test?schema=test";
    expect(() => resolveTargetDatabaseUrl()).toThrow(/schema/);
  });

  it("resolves worker database 1 for a valid TEST_DATABASE_URL", async () => {
    const { resolveTargetDatabaseUrl } = await import("../measure-saldo-path-parity");
    process.env.TEST_DATABASE_URL = "postgresql://user:pass@localhost:5432/clokr_test";
    const url = resolveTargetDatabaseUrl();
    expect(url.pathname).toMatch(/_1$/);
  });
});
