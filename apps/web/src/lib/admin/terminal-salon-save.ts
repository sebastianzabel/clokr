// Issue #541 (D-03, D-08) — the instant save of a terminal key's salon on /admin/system, kept out
// of the route page so it can be unit-tested (a route page cannot be mounted: no `$app` alias).
//
// Contract: the row is updated optimistically, the server row replaces it on success, and on
// failure the PREVIOUS row is put back BEFORE `onFailed` runs (so the error toast never shows next
// to a stale choice; ADMIN_STRUCTURE §3.2.1). The result tells the cell whether to keep its
// choice (`true`) or to write the previous value back into the DOM select (`false`).

/** The salon fields of a terminal list row, as served by `GET /terminals`. */
export interface TerminalSalonFields {
  id: string;
  salonId: string | null;
  salonName: string | null;
  salonActive: boolean | null;
}

export interface TerminalSalonSaveDeps<T extends TerminalSalonFields> {
  id: string;
  /** The chosen salon id; `null` removes the binding. */
  salonId: string | null;
  getRows: () => T[];
  setRows: (rows: T[]) => void;
  /** The salons the admin can choose from (names for the optimistic row). */
  salons: { id: string; name: string }[];
  /** `PATCH /terminals/:id`; resolves with the updated server row, rejects on any failure. */
  patch: (id: string, salonId: string | null) => Promise<T>;
  onSaved: () => void;
  /** Called after the previous row was restored. */
  onFailed: (err: unknown) => void;
}

export async function saveTerminalSalon<T extends TerminalSalonFields>(
  deps: TerminalSalonSaveDeps<T>,
): Promise<boolean> {
  const { id, salonId } = deps;
  const previous = deps.getRows().find((k) => k.id === id);
  if (!previous) return false;

  const salon = salonId === null ? null : deps.salons.find((s) => s.id === salonId);
  deps.setRows(
    deps.getRows().map((k) =>
      k.id === id
        ? {
            ...k,
            salonId,
            salonName: salon?.name ?? null,
            salonActive: salonId === null ? null : true,
          }
        : k,
    ),
  );

  try {
    const updated = await deps.patch(id, salonId);
    deps.setRows(deps.getRows().map((k) => (k.id === id ? updated : k)));
    deps.onSaved();
    return true;
  } catch (err) {
    deps.setRows(deps.getRows().map((k) => (k.id === id ? previous : k)));
    deps.onFailed(err);
    return false;
  }
}
