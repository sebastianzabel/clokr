// Adversarial fixture (CR-02 finding 1, 204-REVIEW.md): the not-found guard on `existing` sits
// inside a `.forEach()` callback, where a `return` only exits the CALLBACK, not the handler —
// the update below still runs unconditionally on every call. Verbatim from the reviewer's own
// reproduction against the real coverageRule idiom (mirrors shape6c-guard-fetch.ts, with the
// guard moved into a nested closure): `hasNotFoundGuard`'s `visit` previously walked the whole
// handler with an unrestricted `ts.forEachChild`, crossing function/closure boundaries, so this
// was wrongly accepted as `{ scoped: true, via: "guard-fetch", ... }`.
declare const app: {
  prisma: {
    coverageRule: {
      findFirst: (args: unknown) => Promise<{ id: string; tenantId: string } | null>;
      update: (args: unknown) => unknown;
    };
  };
};

export async function guardInsideForEachHandler(req: {
  params: unknown;
  user: { tenantId: string };
}) {
  const { id } = req.params as { id: string };
  const existing = await app.prisma.coverageRule.findFirst({
    where: { id, tenantId: req.user.tenantId },
  });
  [1, 2, 3].forEach((x) => {
    if (!existing) return; // only exits the forEach callback, NOT the handler
  });
  const updated = await app.prisma.coverageRule.update({ where: { id }, data: {} });
  return updated;
}
