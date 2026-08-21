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
