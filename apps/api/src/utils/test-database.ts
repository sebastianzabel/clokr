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
 * The anchored test-database namespace (Phase 106, D-06; widened by Phase 132, D-03/D-04).
 *
 * `clokr_test` is the TEMPLATE — migrated once per `test:setup`, never connected to by a test.
 * `clokr_test_1` … `clokr_test_<n>` are the per-worker databases cloned from it.
 *
 * Anchored and numeric on purpose. An UNANCHORED prefix (`clokr_test_`) was explicitly rejected
 * in D-06 because it would also accept `clokr_test_kopie_von_prod`, at which point the name says
 * nothing about who created the database. The name is convenience; POSSESSION of
 * TEST_DATABASE_MARKER (see below) is the mechanism — see scripts/test-database-guard.ts.
 *
 * Phase 132 adds exactly ONE optional segment: `_[0-9a-f]{8}`, the per-working-directory
 * namespace (D-03) that lets two linked git worktrees run the integration suite concurrently
 * without colliding on `clokr_test`/`clokr_test_<n>`. Its alphabet (8 lowercase hex characters,
 * fixed length) is just as narrow as the numeric worker segment — which is exactly why
 * `clokr_test_kopie_von_prod` is STILL rejected: `kopie_von_prod` is neither 8 hex characters nor
 * a bare integer. The pattern remains anchored on both sides. This is still the one canonical
 * copy — nothing anywhere may restate this regex.
 */
export const TEST_DATABASE_NAME_PATTERN = /^clokr_test(_[0-9a-f]{8})?(_\d+)?$/;

/**
 * The result of structurally parsing a test-database name against
 * `TEST_DATABASE_NAME_PATTERN` — the ONLY consumer of that regex. Every predicate below is
 * derived from this parser so that no second regex ever exists in this file (D-05).
 */
export interface ParsedTestDatabaseName {
  /** The 8-hex working-directory namespace, or "" for the main working tree (D-06). */
  namespace: string;
  /** The 1-based worker index, or null for the TEMPLATE. */
  workerIndex: number | null;
}

/** Structurally parses a test-database name, or returns `null` if it does not match at all. */
export function parseTestDatabaseName(name: string): ParsedTestDatabaseName | null {
  const m = TEST_DATABASE_NAME_PATTERN.exec(name);
  if (m === null) return null;
  return {
    namespace: m[1] === undefined ? "" : m[1].slice(1),
    workerIndex: m[2] === undefined ? null : Number(m[2].slice(1)),
  };
}

/** True for the template and for any worker database in the namespace. */
export function isTestDatabaseName(name: string): boolean {
  return parseTestDatabaseName(name) !== null;
}

/**
 * True only for a per-worker database — i.e. a name carrying a numeric worker segment. This
 * property is now STRUCTURAL (Phase 132), not a not-equal-to-one-literal comparison: the old form
 * (`isTestDatabaseName(name) && name !== TEST_DATABASE_NAME`) becomes WRONG once a namespace
 * exists, because in a linked worktree the TEMPLATE is `clokr_test_<ns>`, which is not equal to
 * `TEST_DATABASE_NAME` — the old check would misclassify a namespaced TEMPLATE as a worker
 * database. That would silently disarm two protections at once: `vitest.worker-setup.ts`'s "a
 * worker must never connect to the template" check, and `mayDropDatabase`'s template exclusion in
 * `reset-test-databases.ts`. Deriving from `parseTestDatabaseName` keeps this correct regardless
 * of namespace.
 */
export function isWorkerDatabaseName(name: string): boolean {
  return parseTestDatabaseName(name)?.workerIndex != null;
}

/** "" (the main working tree, D-06) or exactly 8 lowercase hex characters (D-03). */
export function isValidTestNamespace(namespace: string): boolean {
  if (namespace === "") return true;
  const parsed = parseTestDatabaseName(`${TEST_DATABASE_NAME}_${namespace}`);
  return parsed !== null && parsed.namespace === namespace && parsed.workerIndex === null;
}

/**
 * The TEMPLATE database name for `namespace` — `clokr_test` for the main working tree (`""`,
 * D-06), `clokr_test_<namespace>` for a linked worktree. Throws rather than returning a malformed
 * name — a silently wrong name here would send tooling at an unprovisioned target.
 */
export function templateDatabaseName(namespace: string = resolveTestNamespace()): string {
  if (!isValidTestNamespace(namespace)) {
    throw new Error(
      `templateDatabaseName: "${namespace}" is not a valid test namespace ` +
        `(expected "" for the main working tree, or exactly 8 lowercase hex characters).`,
    );
  }
  return namespace === "" ? TEST_DATABASE_NAME : `${TEST_DATABASE_NAME}_${namespace}`;
}

/**
 * The database name for a 1-based worker index (`VITEST_POOL_ID`) within `namespace`. Throws
 * rather than returning a malformed name — a silently wrong name here would send a worker at an
 * unprovisioned target.
 */
export function workerDatabaseName(
  index: number | string,
  namespace: string = resolveTestNamespace(),
): string {
  const n = typeof index === "string" ? Number(index) : index;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `workerDatabaseName: expected a 1-based integer worker index, got ${JSON.stringify(index)}.`,
    );
  }
  return `${templateDatabaseName(namespace)}_${n}`;
}

/**
 * The pinned number of parallel Vitest workers, and therefore of per-worker test databases
 * (Phase 106, D-02; per-namespace since Phase 132, D-13). ONE number, identical in CI and locally
 * — never a percentage, never `os.availableParallelism()`. A machine with more cores deliberately
 * leaves performance on the table so that CI and local runs are the same run.
 *
 * Derived in 106-MEASUREMENTS.md from the runner's MEASURED nproc and MEASURED memory headroom
 * (D-10 forbids assuming the documented spec). Changing it requires re-running that measurement
 * AND re-running `test:setup`, which provisions exactly this many databases.
 */
export const TEST_DATABASE_WORKER_COUNT = 4;

/**
 * `clokr_test_1` … `clokr_test_<TEST_DATABASE_WORKER_COUNT>` for `namespace`, in worker-index
 * order. A FUNCTION, not a frozen const (Phase 132) — a module-level const would call
 * `resolveTestNamespace()` at module-evaluation time, and this module is reached from
 * `vitest.worker-setup.ts`, a `setupFiles` entry that Vitest re-imports once per test FILE (~200x
 * per run under `isolate: true`). A module-level derivation would therefore become a per-file cost
 * on the suite's already-dominant bootstrap. See 132-RESEARCH.md § "Vitest Setup/Worker
 * Lifecycle".
 */
export function workerDatabaseNames(namespace: string = resolveTestNamespace()): readonly string[] {
  return Object.freeze(
    Array.from({ length: TEST_DATABASE_WORKER_COUNT }, (_, i) =>
      workerDatabaseName(i + 1, namespace),
    ),
  );
}

/**
 * Returns a COPY of `url` whose database name is moved into `namespace`, preserving the worker
 * index (or the template-ness) of the original. Host, port, credentials and every query parameter
 * are untouched. With the empty namespace the result is byte-identical to the input — that is what
 * makes CI's `clokr_test` stay literally `clokr_test` (D-06, AC-6).
 */
export function namespacedDatabaseUrl(url: URL, namespace: string = resolveTestNamespace()): URL {
  const current = databaseNameOf(url);
  const parsed = parseTestDatabaseName(current);
  if (parsed === null) {
    throw new Error(
      `namespacedDatabaseUrl: "${current}" is not a test-namespace database name, so it cannot ` +
        `be re-namespaced. Target: ${describeTarget(url.toString())}.`,
    );
  }
  const next = new URL(url.toString());
  next.pathname = `/${
    parsed.workerIndex === null
      ? templateDatabaseName(namespace)
      : workerDatabaseName(parsed.workerIndex, namespace)
  }`;
  return next;
}

/**
 * Stamped as a `COMMENT ON DATABASE` by ensure-test-database.ts. A database-level comment survives
 * `prisma db push` (which reconciles objects *inside* a schema, never `pg_shdescription`) and cannot
 * be confused with an application table — see the TI-03 guard in plan 02, which checks for its
 * presence before allowing the app to boot against a given target.
 */
export const TEST_DATABASE_MARKER = "clokr-test-database:v1";

const MARKER_PROVENANCE_PREFIX = " from ";
const MARKER_SUFFIX = ". Contents are disposable.";

/**
 * The full `COMMENT ON DATABASE` text (Phase 132, D-12). `provenancePath` is the absolute git-dir
 * path of the working directory that provisioned this database — it is what makes an orphaned
 * namespace answerable from the database itself rather than from a side ledger. Always starts with
 * `TEST_DATABASE_MARKER`, so every existing `startsWith` possession check keeps working unchanged.
 * `TEST_DATABASE_MARKER` itself is NOT extended with the namespace (D-08) — that would create a
 * second truth about ownership next to possession.
 */
export function buildMarkerComment(scriptPath: string, provenancePath: string): string {
  return (
    `${TEST_DATABASE_MARKER} — provisioned by ${scriptPath} (Phase 132)` +
    `${MARKER_PROVENANCE_PREFIX}${provenancePath}${MARKER_SUFFIX}`
  );
}

/**
 * The provisioning path recorded by `buildMarkerComment`, or `null` when the comment carries none
 * (every database stamped before Phase 132). `null` means UNKNOWN, never "orphaned" — the prune
 * path in `reset-test-databases.ts` refuses to act on an unknown provenance.
 */
export function markerProvenancePath(marker: string): string | null {
  if (!marker.startsWith(TEST_DATABASE_MARKER)) return null;
  const start = marker.indexOf(MARKER_PROVENANCE_PREFIX);
  if (start === -1) return null;
  const from = start + MARKER_PROVENANCE_PREFIX.length;
  const end = marker.endsWith(MARKER_SUFFIX) ? marker.length - MARKER_SUFFIX.length : marker.length;
  const path = marker.slice(from, end).trim();
  return path === "" ? null : path;
}

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
