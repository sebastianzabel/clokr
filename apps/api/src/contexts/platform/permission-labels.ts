/**
 * German labels of the permission catalog for the role-management UI (Phase 83, Issue #83, D-02).
 *
 * The ONE place a permission is named for end users: the web never hard-codes a label, it reads
 * them from `GET /api/v1/roles/permission-catalog`. Group headings follow the resource headings of
 * `docs/permissions.md`; the per-key labels are end-user wording of that document's "erlaubt"
 * column. `permission-labels.test.ts` pins the key set equal to `PERMISSIONS` (no missing, no
 * extra key) and the labels unique. Not re-exported from `contexts/platform/index.ts` — only
 * `api/roles.ts` reads it (no Unterbau change in the sense of ADR 0002 Entscheidung 7).
 */
import {
  PERMISSIONS,
  PERMISSION_RESOURCES,
  permissionKey,
  type PermissionKey,
  type PermissionReach,
  type PermissionRelation,
  type PermissionResource,
} from "./permission-catalog";

export const PERMISSION_RESOURCE_LABELS: Readonly<Record<PermissionResource, string>> = {
  employee: "Mitarbeiter-Stammdaten",
  contract: "Vertrag und Arbeitszeitmodell",
  "tenant-settings": "Mandanteneinstellungen",
  "api-key": "API-Schlüssel",
  "audit-log": "Audit-Protokoll",
  holiday: "Feiertage und Schulferien",
  salon: "Salons",
  role: "Rollen",
  "role-assignment": "Rollenzuweisungen",
  "time-entry": "Zeiteinträge und Pausen",
  "retro-request": "Zeitnachträge",
  "presence-source": "Präsenzquellen (WLAN)",
  terminal: "NFC-Terminals",
  "leave-request": "Urlaubs- und Abwesenheitsanträge",
  section9: "§ 9-Vorgänge (Krankheit im Urlaub)",
  "leave-entitlement": "Urlaubsanspruch",
  "leave-config": "Abwesenheitsarten und Sonderurlaubsregeln",
  "company-shutdown": "Betriebsurlaub",
  "vocational-school": "Berufsschule",
  overtime: "Saldo und Überstundenkonto",
  "month-close": "Monats- und Jahresabschluss",
  shift: "Schichten",
  "shift-config": "Schichtvorlagen und Besetzungsregeln",
  "shift-pattern": "Schicht-Wochenmuster",
  availability: "Verfügbarkeit",
  integration: "Phorest-Integration",
  report: "Berichte und Exporte",
  "team-overview": "Team-Übersichten",
};

export const PERMISSION_LABELS: Readonly<Record<PermissionKey, string>> = {
  // ── Unterbau ──
  "employee:read:EIGENE": "Eigene Stammdaten lesen",
  "employee:read:ZUGEWIESEN": "Mitarbeiterliste und Stammdaten im zugewiesenen Bereich lesen",
  "employee:create:ZUGEWIESEN": "Mitarbeiter anlegen",
  "employee:update:ZUGEWIESEN": "Stammdaten und Salonzuordnungen im zugewiesenen Bereich ändern",
  "employee:manage-access:ZUGEWIESEN":
    "Zugänge im zugewiesenen Bereich sperren, entsperren und einladen",
  "employee:anonymize:ZUGEWIESEN": "Mitarbeiter anonymisieren (DSGVO Art. 17)",
  "employee:import:ZUGEWIESEN": "Mitarbeiter per Datei importieren",
  "employee:update-avatar:EIGENE": "Eigenes Profilbild ändern",
  "employee:update-avatar:ZUGEWIESEN": "Profilbilder im zugewiesenen Bereich ändern",
  "contract:read:EIGENE": "Eigenes Arbeitszeitmodell lesen",
  "contract:read:ZUGEWIESEN":
    "Arbeitszeitmodelle und Vertragshistorie im zugewiesenen Bereich lesen",
  "contract:update:ZUGEWIESEN": "Vertragswechsel im zugewiesenen Bereich anlegen",
  "tenant-settings:read:ZUGEWIESEN": "Mandanteneinstellungen lesen",
  "tenant-settings:update:ZUGEWIESEN": "Mandanteneinstellungen ändern",
  "api-key:manage:ZUGEWIESEN": "API-Schlüssel verwalten",
  "audit-log:read:ZUGEWIESEN": "Audit-Protokoll lesen",
  "holiday:manage:ZUGEWIESEN": "Feiertage und Schulferien verwalten",
  "salon:read:ZUGEWIESEN": "Salons lesen",
  "salon:manage:ZUGEWIESEN": "Salons anlegen, ändern und schließen",
  "role:read:ZUGEWIESEN": "Rollen und ihre Rechte lesen",
  "role:manage:ZUGEWIESEN": "Rollen anlegen, ändern, kopieren und löschen",
  "role-assignment:manage:ZUGEWIESEN": "Rollen an Personen zuweisen und entziehen",
  // ── Zeiterfassung ──
  "time-entry:read:EIGENE": "Eigene Zeiteinträge lesen",
  "time-entry:read:ZUGEWIESEN": "Zeiteinträge im zugewiesenen Bereich lesen",
  "time-entry:create:EIGENE": "Selbst stempeln und eigene Zeiteinträge anlegen",
  "time-entry:create:ZUGEWIESEN":
    "Zeiteinträge im zugewiesenen Bereich anlegen und im Auftrag stempeln",
  "time-entry:update:EIGENE": "Eigene Zeiteinträge und Pausen ändern",
  "time-entry:update:ZUGEWIESEN": "Zeiteinträge und Pausen im zugewiesenen Bereich ändern",
  "time-entry:delete:EIGENE": "Eigene Zeiteinträge löschen",
  "time-entry:delete:ZUGEWIESEN": "Zeiteinträge im zugewiesenen Bereich löschen",
  "time-entry:revalidate:ZUGEWIESEN":
    "Ungültige Zeiteinträge im zugewiesenen Bereich wieder gültig setzen",
  "time-entry:import:ZUGEWIESEN": "Zeiteinträge per Datei importieren",
  "retro-request:read:EIGENE": "Eigene Zeitnachträge sehen",
  "retro-request:read:ZUGEWIESEN": "Zeitnachträge im zugewiesenen Bereich sehen",
  "retro-request:create:EIGENE": "Eigene Zeitnachträge stellen",
  "retro-request:create:ZUGEWIESEN": "Zeitnachträge im Auftrag stellen",
  "retro-request:approve:ZUGEWIESEN": "Zeitnachträge im zugewiesenen Bereich genehmigen",
  "presence-source:manage:ZUGEWIESEN": "Präsenzquellen (WLAN) verwalten",
  "terminal:manage:ZUGEWIESEN": "NFC-Terminals verwalten",
  // ── Abwesenheiten ──
  "leave-request:read:EIGENE": "Eigene Anträge lesen",
  "leave-request:read:ZUGEWIESEN": "Anträge im zugewiesenen Bereich lesen (auch Krankheit)",
  "leave-request:create:EIGENE": "Eigene Anträge stellen",
  "leave-request:create:ZUGEWIESEN": "Anträge im Auftrag stellen",
  "leave-request:approve:ZUGEWIESEN": "Anträge im zugewiesenen Bereich genehmigen",
  "leave-request:correct:ZUGEWIESEN": "Genehmigte Anträge im zugewiesenen Bereich korrigieren",
  "leave-request:attest:ZUGEWIESEN": "Attest-Angaben im zugewiesenen Bereich setzen",
  "leave-request:cancel:EIGENE": "Eigene Anträge zurückziehen oder stornieren lassen",
  "leave-request:cancel:ZUGEWIESEN":
    "Anträge im zugewiesenen Bereich zurückziehen oder stornieren lassen",
  "section9:read:EIGENE": "Eigene § 9-Vorgänge lesen",
  "section9:read:ZUGEWIESEN": "§ 9-Vorgänge und Bescheinigungen im zugewiesenen Bereich lesen",
  "section9:upload:EIGENE": "Dokumente zu eigenen § 9-Vorgängen hochladen",
  "section9:upload:ZUGEWIESEN": "Dokumente zu § 9-Vorgängen im zugewiesenen Bereich hochladen",
  "section9:decide:ZUGEWIESEN": "§ 9-Vorgänge im zugewiesenen Bereich entscheiden",
  "leave-entitlement:read:EIGENE": "Eigenen Urlaubsanspruch lesen",
  "leave-entitlement:read:ZUGEWIESEN": "Urlaubsansprüche im zugewiesenen Bereich lesen",
  "leave-entitlement:update:ZUGEWIESEN": "Urlaubsansprüche im zugewiesenen Bereich festlegen",
  "leave-config:read:ZUGEWIESEN": "Abwesenheitsarten lesen",
  "leave-config:manage:ZUGEWIESEN": "Abwesenheitsarten und Sonderurlaubsregeln verwalten",
  "company-shutdown:manage:ZUGEWIESEN": "Betriebsurlaub verwalten",
  "vocational-school:read:EIGENE": "Eigene Berufsschultage lesen",
  "vocational-school:read:ZUGEWIESEN": "Berufsschultage im zugewiesenen Bereich lesen",
  "vocational-school:manage:ZUGEWIESEN": "Berufsschultage im zugewiesenen Bereich verwalten",
  // ── Arbeitszeitkonto ──
  "overtime:read:EIGENE": "Eigenen Saldo lesen",
  "overtime:read:ZUGEWIESEN": "Salden im zugewiesenen Bereich lesen",
  "overtime:settle:ZUGEWIESEN": "Überstunden im zugewiesenen Bereich ausgleichen oder auszahlen",
  "overtime:set-opening-balance:ZUGEWIESEN": "Eröffnungssaldo im zugewiesenen Bereich setzen",
  "month-close:read:ZUGEWIESEN": "Stand des Monatsabschlusses im zugewiesenen Bereich lesen",
  "month-close:close:ZUGEWIESEN": "Monate im zugewiesenen Bereich abschließen",
  "month-close:unlock:ZUGEWIESEN": "Abgeschlossene Monate wieder entsperren",
  "month-close:close-year:ZUGEWIESEN": "Jahresübertrag im zugewiesenen Bereich erstellen",
  // ── Schichtplanung ──
  "shift:read:EIGENE": "Eigene Schichten lesen",
  "shift:read:ZUGEWIESEN": "Schichten im zugewiesenen Bereich lesen",
  "shift:plan:ZUGEWIESEN": "Schichten im zugewiesenen Bereich planen",
  "shift-config:manage:ZUGEWIESEN": "Schichtvorlagen und Besetzungsregeln verwalten",
  "shift-pattern:read:EIGENE": "Eigenes Schicht-Wochenmuster lesen",
  "shift-pattern:read:ZUGEWIESEN": "Schicht-Wochenmuster im zugewiesenen Bereich lesen",
  "shift-pattern:update:ZUGEWIESEN": "Schicht-Wochenmuster im zugewiesenen Bereich festlegen",
  "availability:read:EIGENE": "Eigene Verfügbarkeit lesen",
  "availability:read:ZUGEWIESEN": "Verfügbarkeiten im zugewiesenen Bereich lesen",
  "availability:update:EIGENE": "Eigene Verfügbarkeit pflegen",
  "availability:update:ZUGEWIESEN": "Verfügbarkeiten im zugewiesenen Bereich pflegen",
  "integration:manage:ZUGEWIESEN": "Phorest-Integration einrichten und betreiben",
  // ── Kompositionsschicht ──
  "report:read:ZUGEWIESEN": "Berichte im zugewiesenen Bereich lesen",
  "report:export:EIGENE": "Eigenen Monatsbericht als PDF herunterladen",
  "report:export:ZUGEWIESEN": "DATEV- und PDF-Exporte im zugewiesenen Bereich erstellen",
  "report:notify:ZUGEWIESEN": "Vor verfallendem Resturlaub warnen",
  "team-overview:read:ZUGEWIESEN": "Team-Übersichten im zugewiesenen Bereich sehen",
};

export interface PermissionCatalogEntry {
  key: PermissionKey;
  label: string;
  reach: PermissionReach;
  relation: PermissionRelation;
}

export interface PermissionCatalogGroup {
  resource: PermissionResource;
  label: string;
  permissions: PermissionCatalogEntry[];
}

/**
 * The catalog grouped by resource in catalog order (`PERMISSIONS` is contiguous per resource), each
 * entry with its German label, reach and relation (D-03: a MANDANT permission takes effect only
 * through a TENANT-scope assignment). Throws on a missing label — fail loud, never an empty label.
 */
export function permissionCatalogGroups(): PermissionCatalogGroup[] {
  const groups: PermissionCatalogGroup[] = [];
  for (const permission of PERMISSIONS) {
    const key = permissionKey(permission);
    const label = PERMISSION_LABELS[key];
    if (!label) throw new Error(`permission-labels: no label for ${key}`);
    let group = groups[groups.length - 1];
    if (!group || group.resource !== permission.resource) {
      const groupLabel = PERMISSION_RESOURCE_LABELS[permission.resource];
      if (!groupLabel) {
        throw new Error(`permission-labels: no label for resource ${permission.resource}`);
      }
      group = { resource: permission.resource, label: groupLabel, permissions: [] };
      groups.push(group);
    }
    group.permissions.push({
      key,
      label,
      reach: permission.reach,
      relation: PERMISSION_RESOURCES[permission.resource].relation,
    });
  }
  return groups;
}
