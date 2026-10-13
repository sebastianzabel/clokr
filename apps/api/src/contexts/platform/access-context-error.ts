/**
 * Phase 77b (Issue #77) — the failure class of a missing tenant frame, and the one tenant check
 * every fail-closed entry point runs.
 *
 * Why this is a separate leaf with ZERO imports: both `./access-context.ts` (the two
 * `AccessContext` constructors and `employeeScopeFor`) and `./facade/employee-scope.ts`
 * (`employeeScopeWhere`) need the same error and the same check. `access-context.ts` already
 * imports the `EmployeeScope` type from `facade/employee-scope.ts`; had the error lived in either
 * of the two, the other direction would close an import cycle. The cycle gate
 * (`scripts/measure-context-boundary-imports.ts --cycles --check 22`) counts every
 * `ImportDeclaration` as a graph edge — type-only imports included — so even a type import back
 * would turn CI red. A leaf both sides import from cannot form a cycle.
 *
 * The message of an `AccessContextError` is internal. `app.ts`'s global error handler maps the
 * class to HTTP 500 `{ error: "Interner Serverfehler" }` and logs the message together with the
 * route; the text never reaches a client.
 */
export class AccessContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessContextError";
  }
}

/**
 * The ONE blank-tenant rule (Issue #551, D-04): a tenant id is blank when it is not a string, or when
 * the string is empty after removing surrounding whitespace. It lives in this zero-import leaf so that
 * `requireTenantId` below, `requireAuth` (through the tenant-status plugin) and the credential paths
 * (through `./tenant-status`, which re-exports it) all decide it in the same place.
 */
export function isBlankTenantId(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

/**
 * Return `value` if it is a tenant id that can bind a query — a string with non-whitespace
 * content — and throw {@link AccessContextError} otherwise (`undefined`, `null`, a non-string, an
 * empty or whitespace-only string). `site` names the caller so the log entry says which guard
 * tripped.
 *
 * There is deliberately no fallback value: a missing tenant is a programming error that must fail
 * technically, never degrade into an empty filter (DSGVO Art. 32).
 */
export function requireTenantId(value: unknown, site: string): string {
  if (typeof value === "string" && !isBlankTenantId(value)) {
    return value;
  }
  const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
  throw new AccessContextError(`${site}: missing tenant (got ${shown})`);
}
