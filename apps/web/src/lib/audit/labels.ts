/**
 * The German words of the Protokoll (Issue #583, D-854-10, D-854-23).
 *
 * The vocabulary lives once, in `packages/types/audit-labels.json`; the API's CSV reads the same file,
 * so the list and the export print identical words. Every accessor is total: an unknown code never
 * shows raw, it reads the fallback. Codes stay the control values - branch on a code, never on a
 * label. Pure module: no store, no `$app`. Coverage of the API's writers: `__tests__/labels-854.test.ts`.
 */
import auditLabels from "@clokr/types/audit-labels.json";

type Dictionary = Readonly<Record<string, string>>;

const data = auditLabels as {
  fallback: string;
  fieldFallback: string;
  actors: Dictionary;
  actions: Dictionary;
  entities: Dictionary;
  exportTypes: Dictionary;
  fields: Readonly<Record<string, Dictionary>>;
};

/** An own entry of the dictionary, never something inherited from `Object.prototype`. */
function lookup(dictionary: Dictionary | undefined, code: string): string | undefined {
  if (!dictionary || !Object.prototype.hasOwnProperty.call(dictionary, code)) return undefined;
  return dictionary[code];
}

export const AUDIT_FALLBACK_LABEL = data.fallback;
export const AUDIT_FIELD_FALLBACK_LABEL = data.fieldFallback;

export function actionLabel(code: string): string {
  return lookup(data.actions, code) ?? data.fallback;
}

export function entityLabel(code: string): string {
  return lookup(data.entities, code) ?? data.fallback;
}

/** The label of the `newValue.type` of an `EXPORT` row. */
export function exportTypeLabel(type: string): string {
  return lookup(data.exportTypes, type) ?? data.fallback;
}

/** A field of an entity's before/after table: the entity's own label, else the common one, else the neutral one. */
export function fieldLabel(entity: string, key: string): string {
  return (
    lookup(
      Object.prototype.hasOwnProperty.call(data.fields, entity) ? data.fields[entity] : undefined,
      key,
    ) ??
    lookup(data.fields["*"], key) ??
    data.fieldFallback
  );
}

/** The two actors that are not a signed-in user. */
export function actorKindLabel(kind: "operator" | "system"): string {
  return data.actors[kind];
}
