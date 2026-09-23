# ADR 0002 — Vier fachliche Kontexte, ein Unterbau mit Änderungsregeln

**Status:** akzeptiert
**Datum:** 2026-09-24
**Codestand der Belege:** `main` @ `bea6b5c7`
**Löst teilweise ab:** ADR 0001 (`0001-drei-kontexte.md`) — Kontextzahl; Regel 2 (präzisiert); Regeln 5 und 6 (abgelöst); Regeln 1 und 4 (Auslöser statt Zielbild); Offene Frage 1 (beantwortet)
**GitHub:** Issue #110 (T19)

Alle Belege in diesem Dokument beziehen sich auf diesen Commit. Sie sind über Symbole zitiert
(Modell-, Funktions- und Konstantennamen); Zeilennummern stehen nur dort, wo kein Symbol die Aussage
trägt. Jede Zahl stammt aus dem Block unter „Belege nachrechnen“ und lässt sich damit auch auf einem
späteren Stand nachrechnen.

Was der Kopf nicht nennt, gilt aus ADR 0001 unverändert weiter: Regel 3 (kein direkter
Tabellenzugriff auf fremde Kontexte), die Einmal-Reduktion samt `calcLeaveAbsenceMinutesTz()`, die
Trennung von beantragter (`LeaveRequest`) und auferlegter Abwesenheit (`Absence`) und ein
`TimeEntryType` ohne Abwesenheitswerte. Die Offenen Fragen 2 und 3 von ADR 0001 berührt dieses ADR
nicht.

---

## Kontext

### Warum ADR 0001 nicht mehr trägt

Milestone v1.12.0 legt Fremdschlüssel auf `Salon` an, und `Salon` gehört zum Unterbau:
`TimeEntry.salonId` (#68), `Shift.salonId` (#325), die Phorest-Kopplungstabelle und
`PhorestSyncRun` (#65). #66 würde es später ebenfalls tun. Regel 2 von ADR 0001 („Keine
Fremdschlüssel über Kontextgrenzen“) verbietet genau das wörtlich. Der Owner hat #110 deshalb am
2026-09-24 als erstes Ticket nach v1.12.0 gezogen (Kommentar auf #110): Ohne dieses ADR würde das
Milestone gegen das eigene ADR gebaut.

### Der vierte Kontext war schon da

Die maßgebliche Zuordnung der 41 Modelle zu Kontexten ist `MODEL_OWNER` in
`apps/api/scripts/measure-foreign-context-access.ts`. Nach den drei Kontexten von ADR 0001 und dem
Unterbau bleiben dort acht Modelle übrig: `Shift`, `ShiftTemplate`, `EmployeeShiftPattern`,
`EmployeeAvailability`, `CoverageRule`, `PhorestAppointment`, `PhorestStaffMapping` und
`PhorestSyncRun`. Phase 99b hat sie nach `contexts/scheduling/` geschnitten, `docs/context-cut-map.md`
§ 0 führt Schichtplanung als eigenen Kontext, und `BOUNDARY_CONTEXTS` in `eslint.boundaries.mjs`
kennt seit Phase 101B fünf Grenzbereiche: vier Kontexte plus `platform`. Der Kontext existiert im
Code und in der Grenzprüfung. Er hatte nur nie einen Namen in einem ADR.

### Was auf `bea6b5c7` gemessen ist

- **Modelle:** 41. `MODEL_OWNER` und `schema.prisma` decken dieselbe Menge ab: 13 Unterbau
  (`platform`), 6 Zeiterfassung, 9 Abwesenheiten, 5 Arbeitszeitkonto, 8 Schichtplanung.
- **Fremdschlüssel:** 52 insgesamt, davon 28 über eine Kontextgrenze. Alle 28 zeigen auf den
  Unterbau (18 auf `Employee`, 10 auf `Tenant`), 0 verbinden zwei gleichrangige Kontexte.
- **`onDelete`:** Von den 28 sind 9 `Restrict` und 19 `Cascade`. Die drei Relationen, für die
  `CLAUDE.md` `onDelete: Restrict` vorschreibt (`Employee → TimeEntry/LeaveRequest/Absence`), sind
  unter den 9.
- **„Zwanzig `Employee`-Relationen“:** #110 und #105 sprechen von zwanzig. Gemessen zeigen 20
  Fremdschlüssel auf `Employee`: 18 kontextübergreifende und 2 innerhalb des Unterbaus
  (`Invitation`, `WorkSchedule`). Beide Zahlen stimmen.
- **Grenzprüfung:** 5 Grenzbereiche in `BOUNDARY_CONTEXTS`. Das Register
  `apps/api/scripts/context-boundary-import-exceptions.json` führt die Kompositionswurzel mit
  `expectedCount` 46 und sechs weitere Einträge: E-1, E-2 (zweimal), E-3, E-4, E-8.
  `0001-abweichungen.md` Eintrag H nennt noch 45. Das ist der Stand von Phase 101B, Phase 292 hat
  den Wert auf 46 gehoben (siehe das `reason`-Feld des Registereintrags).
- **Kompositionsschicht:** 5 Dateien in `apps/api/src/composition/`, 0 Importe aus `contexts/` oder
  `services/` nach `composition/`.
- **Ereignisse:** 0 Treffer für `DomainEvent`, `EventDispatcher` oder `EventEmitter` in
  `apps/api/src`. `recalcProvisionalLeaveForShiftChange` ist genau einmal definiert.
- **T11:** 0 Vorkommen in `docs/` und `CLAUDE.md`, 8 Vorkommen in 4 Dateien des übrigen Baums.

### Bereitstellung: eine Instanz pro Kunde

Der Owner hat am 2026-09-09 entschieden (Kommentar auf Epic #63): eine Instanz pro Kunde.
Hintergrund ist #226, die Datenbank setzt die Mandantengrenze nicht selbst durch. Die Grenze
zwischen Kunden verläuft damit physisch, nicht logisch. `Tenant` bleibt im Unterbau, die neue Ebene
darunter ist `Salon` (#64).

### Belege nachrechnen

Jede Zahl in diesem ADR stammt aus dem folgenden Block. Er liest Commit `bea6b5c7` über `git show`
und rechnet deshalb auf jedem späteren Stand dasselbe nach; wer den heutigen Stand messen will,
setzt `C` auf `HEAD`. Er braucht `git`, `node` und `jq` und läuft aus dem Wurzelverzeichnis des
Repositorys.

```sh
C=bea6b5c7

# 1. Model ownership (MODEL_OWNER) and every foreign key of the schema, both read from commit $C.
node -e '
const { execSync } = require("child_process");
const C = process.argv[1];
const show = (p) => execSync(`git show ${C}:${p}`, { encoding: "utf8", maxBuffer: 1 << 26 });
const ms = show("apps/api/scripts/measure-foreign-context-access.ts");
const start = ms.indexOf("export const MODEL_OWNER");
const block = ms.slice(start, ms.indexOf("};", start));
const owner = {};
for (const m of block.matchAll(/^\s+(\w+): "([a-z-]+)",/gm)) owner[m[1][0].toUpperCase() + m[1].slice(1)] = m[2];
const perArea = {};
for (const a of Object.values(owner)) perArea[a] = (perArea[a] || 0) + 1;
const schema = show("packages/db/prisma/schema.prisma");
const models = [...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]);
if (models.length === 0 || models.some((m) => !owner[m]) || Object.keys(owner).length !== models.length) {
  console.error("ABORT: MODEL_OWNER and schema.prisma do not cover the same model set");
  process.exit(1);
}
let cur = null;
const fks = [];
for (const l of schema.split("\n")) {
  const mm = l.match(/^model (\w+) \{/);
  if (mm) { cur = mm[1]; continue; }
  if (l.startsWith("}")) { cur = null; continue; }
  if (cur && /@relation\(/.test(l) && /fields:/.test(l)) {
    const p = l.trim().split(/\s+/);
    fks.push({ from: cur, field: p[0], to: p[1].replace(/[?\[\]]/g, ""), od: (l.match(/onDelete:\s*(\w+)/) || [])[1] || "default" });
  }
}
if (fks.length === 0) { console.error("ABORT: no foreign key found"); process.exit(1); }
const cross = fks.filter((r) => owner[r.from] !== owner[r.to]);
const kind = (r) => (owner[r.from] === "platform" || owner[r.to] === "platform" ? "UNTERBAU" : "PEER");
const count = (xs, f) => xs.filter(f).length;
console.log(`MODEL_OWNER ${Object.keys(owner).length} platform=${perArea.platform} time-tracking=${perArea["time-tracking"]} absence=${perArea.absence} working-time-account=${perArea["working-time-account"]} scheduling=${perArea.scheduling}`);
console.log(`SCHEMA_MODELS ${models.length}`);
console.log(`FK_TOTAL ${fks.length}`);
console.log(`FK_CROSS ${cross.length} UNTERBAU=${count(cross, (r) => kind(r) === "UNTERBAU")} PEER=${count(cross, (r) => kind(r) === "PEER")}`);
console.log(`FK_CROSS_TARGET Employee=${count(cross, (r) => r.to === "Employee")} Tenant=${count(cross, (r) => r.to === "Tenant")}`);
console.log(`FK_CROSS_ONDELETE Restrict=${count(cross, (r) => r.od === "Restrict")} Cascade=${count(cross, (r) => r.od === "Cascade")}`);
console.log(`FK_ONTO_EMPLOYEE_ALL ${count(fks, (r) => r.to === "Employee")}`);
for (const r of cross) console.log(`  ${kind(r)} ${r.from}(${owner[r.from]}).${r.field} -> ${r.to}(${owner[r.to]}) onDelete=${r.od}`);
' "$C"

# 2. The boundary lint: five areas (four contexts + platform), and the exception register.
echo "BOUNDARY_AREAS $(git show $C:eslint.boundaries.mjs | awk '/^export const BOUNDARY_CONTEXTS/{f=1;next} f&&/^\];/{f=0} f' | grep -c '"')"
git show $C:apps/api/scripts/context-boundary-import-exceptions.json | jq -r '"COMPOSITION_ROOT_EXPECTED_COUNT " + ([.exceptions[] | select(.id == "composition-root") | .expectedCount] | first | tostring), "REGISTER_ENTRIES " + ([.exceptions[] | select(.id != "composition-root")] | length | tostring) + " ids=" + ([.exceptions[] | select(.id != "composition-root") | .id] | unique | join(","))'

# 3. Composition layer: its files, and that no context or service imports from it.
echo "COMPOSITION_FILES $(git ls-tree --name-only $C apps/api/src/composition/ | grep -c '\.ts$')"
echo "IMPORTS_INTO_COMPOSITION $(git grep -nE "from ['\"][^'\"]*composition/" $C -- apps/api/src/contexts apps/api/src/services | wc -l | tr -d ' ')"

# 4. Events: no dispatcher exists yet; the one invariant-carrying handler runs inside the caller's transaction.
echo "DISPATCHER_HITS $(git grep -nE 'DomainEvent|EventDispatcher|EventEmitter' $C -- apps/api/src | wc -l | tr -d ' ')"
echo "TX_RESOLVER $(git grep -n 'export async function recalcProvisionalLeaveForShiftChange' $C -- apps/api/src/contexts/absence/shift-leave-recalc-resolver.ts | wc -l | tr -d ' ')"

# 5. "T11": absent from every checked-in document; the bare token in code is Phase 100B's plan-internal task label.
echo "T11_IN_DOCS $(git grep -nw T11 $C -- docs CLAUDE.md | wc -l | tr -d ' ')"
echo "T11_IN_TREE $(git grep -nw T11 $C | wc -l | tr -d ' ') files=$(git grep -lw T11 $C | wc -l | tr -d ' ')"
```

Die Kennzeilen seiner Ausgabe auf `bea6b5c7` (dazwischen stehen die 28 einzelnen Fremdschlüssel):

```text
MODEL_OWNER 41 platform=13 time-tracking=6 absence=9 working-time-account=5 scheduling=8
SCHEMA_MODELS 41
FK_TOTAL 52
FK_CROSS 28 UNTERBAU=28 PEER=0
FK_CROSS_TARGET Employee=18 Tenant=10
FK_CROSS_ONDELETE Restrict=9 Cascade=19
FK_ONTO_EMPLOYEE_ALL 20
BOUNDARY_AREAS 5
COMPOSITION_ROOT_EXPECTED_COUNT 46
REGISTER_ENTRIES 6 ids=E-1,E-2,E-3,E-4,E-8
COMPOSITION_FILES 5
IMPORTS_INTO_COMPOSITION 0
DISPATCHER_HITS 0
TX_RESOLVER 1
T11_IN_DOCS 0
T11_IN_TREE 8 files=4
```

---

## Entscheidung

Clokr hat vier fachliche Kontexte, einen Unterbau (Shared Kernel) und eine Kompositionsschicht.

| Ebene               | Verzeichnis                                         | Modelle |
| ------------------- | --------------------------------------------------- | ------- |
| Zeiterfassung       | `contexts/time-tracking/` + `services/clock/`       | 6       |
| Abwesenheiten       | `contexts/absence/`                                 | 9       |
| Schichtplanung      | `contexts/scheduling/` + `services/phorest/`        | 8       |
| Arbeitszeitkonto    | `contexts/working-time-account/`                    | 5       |
| Unterbau            | `contexts/platform/`                                | 13      |
| Kompositionsschicht | `apps/api/src/composition/` + `apps/api/src/app.ts` | 0       |

Die Nummerierung der folgenden Abschnitte folgt den Punkten 1 bis 10 in Issue #110. Andere Dokumente
verweisen auf sie als „Entscheidung N“; sie wird nicht umnummeriert.

### 1. Vierter Kontext: Schichtplanung

Schichtplanung ist der vierte fachliche Kontext. Sie plant die Zukunft, die Zeiterfassung zeichnet
die Vergangenheit auf.

### 2. Regel 5 abgelöst: Der Auslöser ist eingetreten

Die Auslöseklausel von Regel 5 („verallgemeinert wird, wenn der vierte Kontext gebaut wird“) ist
gegenstandslos, denn der vierte Kontext existiert. Der Kern der Regel, keine Verallgemeinerung auf
Vorrat, gilt unverändert weiter.

### 3. Regel 6 abgelöst, eingeschränkt: Taktische Bausteine nur im Arbeitszeitkonto

Aggregat, Repository und Value Object sind zugelassen, aber nur im Arbeitszeitkonto.

### 4. Regel 2 präzisiert: Fremdschlüssel auf den Unterbau sind erlaubt

Fremdschlüssel zwischen gleichrangigen Kontexten bleiben verboten, Fremdschlüssel von einem Kontext
auf den Unterbau sind erlaubt. Das `onDelete`-Verhalten bestehender Relationen bleibt unberührt.

### 5. Kein Broker — mit Auslöser

Die kontextübergreifende Invariante ist transaktional, ein Broker kann an dieser Transaktion nicht
teilnehmen. Bis ein benannter Auslöser eintritt, bleibt die Integration im Prozess.

### 6. Regeln 1 und 4: Auslöser statt Zielbild

Ein Schema und ein Migrationsverzeichnis pro Kontext sind kein ständiges Zielbild mehr, an dem der
Code gemessen wird, sondern Arbeitspakete mit Auslöser.

### 7. Governance des Unterbaus

Der Unterbau bekommt ein Änderungsverfahren: Wer eine Änderung genehmigt, woran man sie erkennt und
was eine Erweiterung von einer Semantikänderung unterscheidet.

### 8. Ereignis-Versionierung: Notiz, kein Arbeitspaket

Ereignisverträge im Prozess sind TypeScript-Typen und compilergeprüft. Ihre Versionierung wird erst
mit einem Broker ein Problem und wird dann gelöst.

### 9. Kompositionsschicht

`apps/api/src/composition/` und die Kompositionswurzel `apps/api/src/app.ts` bilden eine eigene
Schicht, die kein Modell besitzt und keine Fachregel trägt.

### 10. Handler-Arten

Ereignis-Handler sind entweder invariantentragend oder reaktiv. Der Standard für einen neuen Handler
ist reaktiv.

---

## Konsequenzen

**Positiv**

- Das Repository widerspricht sich nicht mehr selbst: v1.12.0 wird gegen sein eigenes ADR gebaut.

**Negativ / einzupreisen**

- Enge Kopplung an den Shared Kernel: Jede Änderung am Unterbau pflanzt sich in alle vier Kontexte
  fort. Das ist bewusst in Kauf genommen.

---

## Status

**Akzeptiert** am 2026-09-24.

ADR 0001 ist in den im Kopf genannten Teilen abgelöst, nicht umgeschrieben.
