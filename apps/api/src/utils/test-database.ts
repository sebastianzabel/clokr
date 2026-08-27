/**
 * Single source of truth for every test-database code path (Phase 101, D-01).
 *
 * D-01 (owner-locked): the integration suite connects to a SEPARATE PostgreSQL DATABASE
 * (`clokr_test`), not a schema inside the dev database. The retired `?schema=` connection-string
 * parameter is a Prisma-only convention that `pg.Pool` silently ignores — that silent ignore is
 * exactly the defect this phase closes. Nothing in this file threads a `schema` option anywhere;
 * doing so was explicitly rejected as "every future connection path would have to remember it".
 *
 * Plain module: no side effects, no CLI behaviour. Every error message emitted anywhere in the
 * Phase 101 test-DB code path MUST go through `describeTarget` or `redactDatabaseUrl` below —
 * never print a raw connection string (it carries a password, even if only a local placeholder one).
 *
 * Lives under `src/utils/` (not `apps/api/scripts/`, where `ensure-test-database.ts` lives)
 * because `apps/api/tsconfig.json` pins `rootDir` to `./src` — a file under `src` (the TI-01 proof
 * test) cannot import a sibling outside that root (TS6059), while files under `scripts` are
 * outside the tsc-compiled program entirely (tsconfig.json's `include` covers only `src`) and can
 * freely import inward. This is the one canonical copy; nothing restates these constants.
 */

/** The one and only name the integration suite is allowed to connect to. */
export const TEST_DATABASE_NAME = "clokr_test";

/**
 * The anchored test-database namespace (Phase 106, D-06).
 *
 * `clokr_test` is the TEMPLATE — migrated once per `test:setup`, never connected to by a test.
 * `clokr_test_1` … `clokr_test_<n>` are the per-worker databases cloned from it.
 *
 * Anchored and numeric on purpose. An UNANCHORED prefix (`clokr_test_`) was explicitly rejected
 * in D-06 because it would also accept `clokr_test_kopie_von_prod`, at which point the name says
 * nothing about who created the database. The name is convenience; POSSESSION of
 * TEST_DATABASE_MARKER (see below) is the mechanism — see scripts/test-database-guard.ts.
 *
 * This is the one canonical copy. Nothing anywhere may restate this regex.
 */
export const TEST_DATABASE_NAME_PATTERN = /^clokr_test(_\d+)?$/;

/** True for the template and for any worker database in the namespace. */
export function isTestDatabaseName(name: string): boolean {
  return TEST_DATABASE_NAME_PATTERN.test(name);
}

/**
 * True only for a per-worker database — i.e. in the namespace but NOT the template. Derived from
 * `isTestDatabaseName` on purpose: a second regex here would be a restatement.
 */
export function isWorkerDatabaseName(name: string): boolean {
  return isTestDatabaseName(name) && name !== TEST_DATABASE_NAME;
}

/**
 * The database name for a 1-based worker index (`VITEST_POOL_ID`). Throws rather than returning a
 * malformed name — a silently wrong name here would send a worker at an unprovisioned target.
 */
export function workerDatabaseName(index: number | string): string {
  const n = typeof index === "string" ? Number(index) : index;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `workerDatabaseName: expected a 1-based integer worker index, got ${JSON.stringify(index)}.`,
    );
  }
  return `${TEST_DATABASE_NAME}_${n}`;
}

/**
 * The pinned number of parallel Vitest workers, and therefore of per-worker test databases
 * (Phase 106, D-02). ONE number, identical in CI and locally — never a percentage, never
 * `os.availableParallelism()`. A machine with more cores deliberately leaves performance on the
 * table so that CI and local runs are the same run.
 *
 * Derived in 106-MEASUREMENTS.md from the runner's MEASURED nproc and MEASURED memory headroom
 * (D-10 forbids assuming the documented spec). Changing it requires re-running that measurement
 * AND re-running `test:setup`, which provisions exactly this many databases.
 */
export const TEST_DATABASE_WORKER_COUNT = 4;

/** `clokr_test_1` … `clokr_test_<TEST_DATABASE_WORKER_COUNT>`, in worker-index order. */
export const WORKER_DATABASE_NAMES: readonly string[] = Object.freeze(
  Array.from({ length: TEST_DATABASE_WORKER_COUNT }, (_, i) => workerDatabaseName(i + 1)),
);

/**
 * Stamped as a `COMMENT ON DATABASE` by ensure-test-database.ts. A database-level comment survives
 * `prisma db push` (which reconciles objects *inside* a schema, never `pg_shdescription`) and cannot
 * be confused with an application table — see the TI-03 guard in plan 02, which checks for its
 * presence before allowing the app to boot against a given target.
 */
export const TEST_DATABASE_MARKER = "clokr-test-database:v1";

/**
 * Parses a database connection string, throwing an `Error` that names `source` (e.g.
 * `"TEST_DATABASE_URL"`) when the value is missing, empty, whitespace-only, unparseable, or does
 * not use the `postgres:`/`postgresql:` protocol. Never returns a partially-valid result.
 */
export function parseDatabaseUrl(raw: string | undefined, source: string): URL {
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      `${source} is not set (or is empty/whitespace-only). A postgres:// database URL is required.`,
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${source} is not a valid URL and could not be parsed.`);
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(
      `${source} must use the postgres: or postgresql: protocol — got "${url.protocol}"`,
    );
  }

  return url;
}

/** The database name a connection URL points at, i.e. its pathname without the leading slash. */
export function databaseNameOf(url: URL): string {
  return url.pathname.replace(/^\//, "");
}

/**
 * `host:port/database` — deliberately credential-free. This is the ONLY form a Phase 101 error
 * message or log line may use to describe where a connection points. Falls back to a safe
 * placeholder instead of throwing, since it is itself used FROM error-handling paths.
 */
export function describeTarget(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "<unparseable database URL>";
  }
  const port = url.port || "5432";
  return `${url.hostname}:${port}/${databaseNameOf(url)}`;
}

/** The full URL with its password (if any) replaced by `***`. Still not for casual logging. */
export function redactDatabaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "<unparseable database URL>";
  }
  if (url.password) {
    url.password = "***";
  }
  return url.toString();
}

/**
 * Pure shape assertion — no network I/O. Throws for: an unset/empty/whitespace-only value, a
 * non-URL string, a non-`postgres(ql):` protocol, a database name outside the test namespace (see
 * `TEST_DATABASE_NAME_PATTERN`, Phase 106 D-06), or a URL carrying a `schema` query parameter (the
 * retired Prisma-only isolation mechanism `pg` silently ignores — D-01). Returns the parsed `URL`
 * only when every check passes. Every thrown message names `source` and includes
 * `describeTarget(raw)` (credential-free); none of them can contain a password, because
 * `describeTarget` never emits one.
 *
 * Moved here from `apps/api/scripts/test-database-guard.ts` (Phase 106, plan 02): this function is
 * imported by `vitest.worker-setup.ts`, a `setupFiles` entry evaluated once per test FILE (197
 * files). `test-database-guard.ts` imports `pg`, so keeping this function there meant loading the
 * whole `pg` package 197 times purely to reach a function that performs no I/O. This module has
 * zero imports and stays that way — see the header comment above.
 */
export function assertTestDatabaseUrlShape(raw: string | undefined, source: string): URL {
  let url: URL;
  try {
    url = parseDatabaseUrl(raw, source);
  } catch (err) {
    // parseDatabaseUrl already covers "unset/empty/whitespace", "not a valid URL", and "wrong
    // protocol" with a source-labelled message. Re-wrap so describeTarget(raw) is present on
    // EVERY rejection this function throws, not just the two it adds below.
    const target = describeTarget(raw ?? "");
    throw new Error(`${(err as Error).message} Target: ${target}.`, { cause: err });
  }

  const target = describeTarget(raw as string);
  const dbName = databaseNameOf(url);

  if (!isTestDatabaseName(dbName)) {
    throw new Error(
      `${source} must point at a database in the test namespace ` +
        `(${TEST_DATABASE_NAME} — the template — or ${TEST_DATABASE_NAME}_<n> for worker <n>) ` +
        `— got "${dbName}". Refusing to run against any database other than one this project's ` +
        `own tooling provisioned. Target: ${target}. Remedy: pnpm --filter @clokr/api run ` +
        `test:setup, then point ${source} at a database in that namespace.`,
    );
  }

  if (url.searchParams.has("schema")) {
    throw new Error(
      `${source} carries a "schema" query parameter ("${url.searchParams.get("schema")}"). ` +
        `"?schema=" is a Prisma-only connection-string convention — the "pg" driver this app ` +
        `actually connects with silently ignores it. That silent ignore is the exact ` +
        `misconfiguration Phase 101 removed (D-01): every test run was landing in the dev database ` +
        `while ?schema=test was believed to isolate it. The fix is a SEPARATE DATABASE, not a ` +
        `schema parameter — remove "?schema=" from ${source}. Target: ${target}.`,
    );
  }

  return url;
}
