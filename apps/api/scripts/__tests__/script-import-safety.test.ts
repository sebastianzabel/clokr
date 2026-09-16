/**
 * Regression test for GH #203 (ci-worker-test-database-vanishes).
 *
 * Both `reset-test-databases.ts` and `ensure-test-database.ts` end with an unconditional
 * `main().catch(...)` at module top level. Until this fix, that call ran as a side effect of the
 * module simply being IMPORTED — `scripts/__tests__/reset-test-databases.test.ts` imports the pure
 * gate functions (`mayDropDatabase`/`mayRollbackDrop`/`mayPruneDatabase`) from that same file, and
 * because ES-module evaluation runs the WHOLE module body, that import dragged the real `main()`
 * into every single vitest run — a genuine `DROP DATABASE ... WITH (FORCE)` against the live
 * per-worker databases (`clokr_test_1`…`_N`) while the other workers were actively using them
 * (correlated millisecond-for-millisecond against a captured CI failure, PR #217; see
 * `.planning/debug/resolved/ci-worker-test-database-vanishes.md`).
 *
 * The fix guards each trailing `main().catch(...)` with
 * `import.meta.url === pathToFileURL(process.argv[1]).href` — true only when the file is the
 * process entry point (`tsx scripts/xxx.ts`), false when some other module (a test, the other
 * script) imports it.
 *
 * `pg` is mocked here so that even if this guard regresses, `main()` cannot open a real network
 * connection — this test's "red" state is `clientCtor` having been called, never a live DROP or
 * CREATE. `process.exit` is spied for the same reason: a would-be REFUSED/FATAL branch inside
 * `main()` calls it, and letting that really exit would kill the whole worker process running this
 * test file, along with every other test sharing it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const clientCtor = vi.fn();

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
  },
}));

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clientCtor.mockClear();
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`unexpected process.exit(${code}) during script import`);
  }) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
});

describe.each([
  ["reset-test-databases.ts", () => import("../reset-test-databases")],
  ["ensure-test-database.ts", () => import("../ensure-test-database")],
])("importing %s for its exports (GH #203 regression)", (label, importModule) => {
  it(`never constructs a pg.Client as a side effect of import (${label})`, async () => {
    await importModule();
    // A fire-and-forget, unguarded main() reaches its first pg.Client construction entirely
    // synchronously (before its first `await`) — see the debug session for the trace — but this
    // tick is kept as insurance against a future implementation that defers it.
    await new Promise((resolve) => setImmediate(resolve));

    expect(clientCtor).not.toHaveBeenCalled();
  });
});

/**
 * Phase 204 Plan 04 — `lint-tenant-scoping.ts` (GH #204) is DB-free (it touches `@clokr/db` only
 * for the generated Prisma DMMF, never a live connection), so the `pg` mock above is irrelevant to
 * it. It gets its own registration here rather than joining the `describe.each` table above,
 * because its import-safety proof is different: not "no pg.Client constructed" but "no scan ran
 * and no report was printed" — the guarded `main()` for THIS script walks the filesystem and
 * writes to stdout, not a database.
 */
describe("importing lint-tenant-scoping.ts for its exports (GH #203 regression)", () => {
  it("never scans the repository or prints a report as a side effect of import", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      const mod = await import("../lint-tenant-scoping");
      await new Promise((resolve) => setImmediate(resolve));

      expect(typeof mod.runLint).toBe("function");
      expect(typeof mod.formatFinding).toBe("function");
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(previousExitCode);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = previousExitCode;
    }
  });
});
