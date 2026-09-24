/**
 * Phase 74b review (WR-02, WR-03): which foreign-key constraint a Prisma `P2003` error names.
 *
 * A route that maps `P2003` onto a domain answer must map only the constraint it means and rethrow
 * every other one. A blanket `P2003` mapping turns an unrelated failure, e.g. the audit insert's
 * `AuditLog_userId_fkey`, into a false, confident answer.
 *
 * Where the name sits, measured on Prisma 7.6 with `@prisma/adapter-pg` (74b-05):
 * `meta.driverAdapterError.cause.constraint.index`, for both a violated reference on insert
 * (`ForeignKeyConstraintViolation`) and a `RESTRICT` on delete (`RestrictViolation`). Prisma's
 * own query engine reports it as `meta.field_name` instead (with an ` (index)` suffix); that shape
 * is read as a fallback.
 */
export function foreignKeyConstraintOf(err: unknown): string | null {
  if (err === null || typeof err !== "object") return null;
  const { code, meta } = err as { code?: unknown; meta?: unknown };
  if (code !== "P2003" || meta === null || typeof meta !== "object") return null;

  const adapterIndex = (
    meta as { driverAdapterError?: { cause?: { constraint?: { index?: unknown } } } }
  ).driverAdapterError?.cause?.constraint?.index;
  if (typeof adapterIndex === "string") return adapterIndex;

  const fieldName = (meta as { field_name?: unknown }).field_name;
  return typeof fieldName === "string" ? fieldName.replace(/\s*\(index\)$/, "") : null;
}
