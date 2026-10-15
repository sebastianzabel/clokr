// Paths of the support area of the operator console (Issue #93, D-09, D-21). One place, so the
// layout, the pages and the components that link into the area never spell a path twice.

/** `/betreiber/mandanten/<id>` - the tenant page, where a refused or expired view returns to. */
export function tenantPagePath(tenantId: string): string {
  return `/betreiber/mandanten/${encodeURIComponent(tenantId)}`;
}

/** The tenant page with the notice code of why the support view was left (`?hinweis=`). */
export function supportLeavePath(tenantId: string, code: string): string {
  return `${tenantPagePath(tenantId)}?hinweis=${encodeURIComponent(code)}`;
}

/** `/betreiber/mandanten/<id>/support` - the employee list. */
export function supportBasePath(tenantId: string): string {
  return `${tenantPagePath(tenantId)}/support`;
}

/** The month view of one employee, optionally for a given `YYYY-MM`. */
export function supportMonthPath(tenantId: string, employeeId: string, month?: string): string {
  const path = `${supportBasePath(tenantId)}/mitarbeitende/${encodeURIComponent(employeeId)}`;
  return month === undefined ? path : `${path}?monat=${encodeURIComponent(month)}`;
}

/** The contracts view of one employee. */
export function supportContractsPath(tenantId: string, employeeId: string): string {
  return `${supportBasePath(tenantId)}/mitarbeitende/${encodeURIComponent(employeeId)}/vertraege`;
}

/** The change-log view of the tenant. */
export function supportProtocolPath(tenantId: string): string {
  return `${supportBasePath(tenantId)}/protokoll`;
}
