/**
 * Issue #567: which unique index a Prisma `P2002` error names, read from structured metadata only.
 *
 * Returns `null` when `err` is not a `P2002`; otherwise the space-joined structured parts, in this
 * order: `meta.target` (string or array, Prisma's own query-engine shape), the driver-adapter
 * `meta.driverAdapterError.cause.constraint.index` and `.fields`, and `cause.originalMessage` (the
 * database's own text, which names the constraint). A caller classifies the violated constraint by
 * matching the index or field name in the returned string; a P2002 with no metadata at all yields a
 * blank string, never `null`, so "not a unique violation" and "unidentifiable one" stay apart.
 *
 * Why `err.message` is NOT read: Prisma fills it with an echo of the failed invocation, including
 * the argument names and values the caller passed. A substring search there can name the wrong
 * index (Plan 89-07 saw a salon collision read as a branch collision because the invocation
 * carried `externalBranchId`; Issue #567 saw a first-admin e-mail collision read as a slug
 * collision because the invocation carried `slug`). Driver detail text that carries the colliding
 * values is not read either.
 *
 * Where the name sits, measured on Prisma 7.6 with `@prisma/adapter-pg` (quick 261013-smt, real
 * `Tenant_slug_key` and `User_email_key` collisions): `meta.target` is absent;
 * `meta.driverAdapterError.cause.constraint.index` holds the index name (`Tenant_slug_key`,
 * `User_email_key`), `constraint.fields` is absent, and `cause.originalMessage` repeats it
 * (`duplicate key value violates unique constraint "<index>"`). The `meta.target` and `fields`
 * reads stay for Prisma's own query-engine shape.
 *
 * A technical helper: it owns no model and carries no business rule.
 */
export function uniqueViolationTarget(err: unknown): string | null {
  if (err === null || typeof err !== "object" || (err as { code?: unknown }).code !== "P2002") {
    return null;
  }
  const meta = (err as { meta?: Record<string, unknown> }).meta ?? {};
  const cause = (meta.driverAdapterError as { cause?: Record<string, unknown> } | undefined)?.cause;
  const constraint = cause?.constraint as { index?: unknown; fields?: unknown } | undefined;
  return [meta.target, constraint?.index, constraint?.fields, cause?.originalMessage]
    .map((part) => String(part ?? ""))
    .join(" ");
}
