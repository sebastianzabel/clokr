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
echo "BOUNDARY_AREAS $(git show ${C}:eslint.boundaries.mjs | awk '/^export const BOUNDARY_CONTEXTS/{f=1;next} f&&/^\];/{f=0} f' | grep -c '"')"
git show ${C}:apps/api/scripts/context-boundary-import-exceptions.json | jq -r '"COMPOSITION_ROOT_EXPECTED_COUNT " + ([.exceptions[] | select(.id == "composition-root") | .expectedCount] | first | tostring), "REGISTER_ENTRIES " + ([.exceptions[] | select(.id != "composition-root")] | length | tostring) + " ids=" + ([.exceptions[] | select(.id != "composition-root") | .id] | unique | join(","))'

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

Sie trägt eigene Fachregeln, die heute im Code stehen:

- **Besetzung** (`CoverageRule`),
- **Verfügbarkeit** (`EmployeeAvailability`),
- die **Öffnungszeitprüfung für Schichten**, gesteuert über `TenantConfig.shiftStoreHoursMode`,
- der **Abgleich mit Phorest**.

Issue #110 zählt auch das JArbSchG zu den Regeln der Schichtplanung. Auf `bea6b5c7` liegen die
JArbSchG-Prüfungen aber in `contexts/absence/jarbschg.ts`, nicht in `contexts/scheduling/`. Dieses
ADR verschiebt sie nicht und behauptet keine Prüfung auf Seiten der Schichtplanung, die es nicht
gibt.

Seit Phase 107 speist die Schichtplanung zwei Kontexte: das Arbeitszeitkonto (das Soll von
`SHIFT_BASED`-Mitarbeitern kommt aus dem Dienstplan) und die Abwesenheiten (die Urlaubstage von
`SHIFT_BASED`-Mitarbeitern werden über `recalcProvisionalLeaveForShiftChange` nachgerechnet).

Zum Kontext gehören die acht Modelle `Shift`, `ShiftTemplate`, `EmployeeShiftPattern`,
`EmployeeAvailability`, `CoverageRule`, `PhorestAppointment`, `PhorestStaffMapping` und
`PhorestSyncRun`. Er liegt in zwei Bäumen, `apps/api/src/contexts/scheduling/` und
`apps/api/src/services/phorest/` (ein Kontext, zwei Bäume, siehe `0001-abweichungen.md` Eintrag F).

Abgleich mit der Wirklichkeit: `eslint.boundaries.mjs` setzt diese Grenze schon durch.
`BOUNDARY_CONTEXTS` führt `scheduling` als einen der fünf Grenzbereiche, und Block 6 der
Konfiguration ordnet `services/phorest/**` der Schichtplanung zu, so wie Block 5 `services/clock/**`
der Zeiterfassung zuordnet. Dieses ADR gibt der Grenze einen Namen. An der Grenzprüfung ändert es
nichts.

### 2. Regel 5 abgelöst: Der Auslöser ist eingetreten

Die Auslöseklausel von Regel 5 („verallgemeinert wird, wenn der vierte Kontext gebaut wird“) ist
gegenstandslos, denn der vierte Kontext existiert. Er hieß nur nie so.

Der Kern der Regel gilt unverändert weiter: kein Plugin-System, kein generischer
Erweiterungsmechanismus, keine Abstraktionsschicht ohne konkreten zweiten Anwendungsfall. Eine
Verallgemeinerung, die bereits mit einem konkreten Anwendungsfall eingeplant ist, ist legitim.
Benanntes Beispiel: der In-Process-Dispatcher aus #102 (T7).

### 3. Regel 6 abgelöst, eingeschränkt: Taktische Bausteine nur im Arbeitszeitkonto

Aggregat, Repository und Value Object sind zugelassen, aber nur im Arbeitszeitkonto
(`contexts/working-time-account/`). Die Arbeitspakete dafür sind #107 (T14, Value Objects im Kern)
und #108 (T15, Arbeitszeitkonto-Aggregat mit Repository).

Taktische Bausteine sind nur im Arbeitszeitkonto zugelassen. Sie sind es nicht in den anderen drei
Kontexten, nicht im Unterbau und nicht in der Kompositionsschicht.

Begründung (Issue #110, Punkt 3): Aggregate lohnen sich dort, wo transaktionale Invarianten zu
schützen sind, und die Einmal-Reduktion liegt im Arbeitszeitkonto. Für CRUD und generische
Subdomänen wie Authentifizierung und Benachrichtigungen gelten sie als Over-Engineering.

CQRS bleibt ausgeschlossen: keine Trennung in Lese- und Schreibmodell ohne gemessenen Bedarf.

### 4. Regel 2 präzisiert: Fremdschlüssel auf den Unterbau sind erlaubt

Fremdschlüssel zwischen gleichrangigen Kontexten sind verboten.
Fremdschlüssel von einem Kontext auf den Unterbau sind ausdrücklich erlaubt.
Das `onDelete`-Verhalten jeder bestehenden Relation bleibt unberührt.

Damit ist **Offene Frage 1** von ADR 0001 beantwortet: Die Compliance-Kontrolle
`onDelete: Restrict` auf `Employee → TimeEntry/LeaveRequest/Absence` bleibt in der Datenbank, wo
ein Betriebsprüfer sie erwartet. Sie wandert nicht in Anwendungscode.

Gemessen ist die präzisierte Regel schon heute erfüllt: 28 von 28 kontextübergreifenden
Fremdschlüsseln zeigen auf den Unterbau, 0 verbinden zwei gleichrangige Kontexte (siehe den Block
unter „Belege nachrechnen“). Der Preis, die enge Kopplung an den Shared Kernel, steht unter
Konsequenzen. Wie ein neuer Fremdschlüssel auf den Unterbau entsteht, regelt Entscheidung 7.

**T11 entfällt.** Der Bezeichner T11 steht in keinem eingecheckten Dokument (0 Vorkommen in
`docs/` und `CLAUDE.md`) und in keinem Issue-Titel: T10 ist #105, T12 ist #106. Der T-Reihe fehlen
auch T13, T16 und T17, eine Lücke allein identifiziert also nichts. Im Code kommt das Token 8-mal in
4 Dateien vor, dort aber als planinterne Aufgabenbezeichnung von Phase 100B Plan 08, also in einem
anderen Namensraum.

Daraus folgt ein Schluss, kein Beleg: T11 war das Arbeitspaket „Fremdschlüssel über Kontextgrenzen
entfernen“, das Regel 2 von ADR 0001 zwischen der Schematrennung (T10) und der Migrationstrennung
(T12) verlangt hätte. Dafür spricht der Text von #105: „Die Fremdschlüssel bleiben, wo sie sind“,
„Damit entfällt der frühere Blocker vollständig“ und „Siehe T19“. T19 ist #110 selbst.

Unabhängig von der Nummerierung gilt:
Kein Arbeitspaket, das einen Fremdschlüssel auf den Unterbau entfernt oder abschwächt, existiert oder wird angelegt.

### 5. Kein Broker — mit Auslöser

Die kontextübergreifende Invariante ist transaktional. Nach Phase 107 D-15 läuft
`recalcProvisionalLeaveForShiftChange(tx, …)` auf dem `Prisma.TransactionClient` des Aufrufers und
rollt die Schichtänderung zurück, wenn sie scheitert. Ein Broker kann an dieser Transaktion nicht
teilnehmen.

Auslöser für einen späteren Broker sind:

- ein Verbraucher **außerhalb des Prozesses**, oder
- ein Ereignis, das einen **Neustart** überleben muss.

Bis einer davon eintritt, bleibt die Integration im Prozess (#102).

### 6. Regeln 1 und 4: Auslöser statt Zielbild

Ein Schema pro Kontext bringt mit Prisma keine Isolation zur Übersetzungszeit: Es bleibt ein
Client, in dem alle 41 Modelle erreichbar sind. #105 (T10) und #106 (T12) liefern ein strukturelles
Signal und Migrationstrennung, keine Isolation. Die Isolation kommt aus den Fassaden (#100, T5) und
der Grenzprüfung (#101, T6).

Die Regeln 1 und 4 sind deshalb kein ständiges Zielbild mehr, an dem der Code gemessen wird. Sie
werden zu Arbeitspaketen mit Auslöser. Issue #110 nennt keine Auslöser; die folgenden sind eine
Entscheidung dieses ADR:

- Migrationen verschiedener Kontexte kollidieren in der Praxis, oder
- eine Datenbankrolle oder -berechtigung muss pro Kontext vergeben werden.

Bis dahin ist ein Schema mit einem zentralen Migrationsverzeichnis regelkonform, keine Abweichung.

### 7. Governance des Unterbaus

Der Unterbau bekommt ein Änderungsverfahren: Wer eine Änderung genehmigt, woran man sie erkennt und
was eine Erweiterung von einer Semantikänderung unterscheidet.

ADR 0001 sagt, der Unterbau „gehört keinem“. Das beantwortet die Eigentumsfrage, nicht die
Änderungsfrage. Bei einem Shared Kernel mit vier abhängigen Kontexten ist die Änderungsfrage die
Stelle, an der die enge Kopplung spürbar wird: Jede Änderung an `Employee`, `WorkSchedule` oder
künftig `Salon` pflanzt sich in alle vier Kontexte fort. Dieser Abschnitt regelt sie.

#### Was zum Unterbau gehört

Zum Unterbau gehören die 13 Modelle, die `MODEL_OWNER` dem Bereich `platform` zuordnet: `Tenant`,
`TenantConfig`, `Employee`, `User`, `AuditLog`, `ApiKey`, `Invitation`, `OtpToken`, `RefreshToken`,
`Notification`, `PublicHoliday`, `SchoolHolidayPeriod` und `WorkSchedule`. Dazu kommt alles, was
künftig in `contexts/platform/` entsteht, namentlich `Salon` (#64), die Salonzuordnung (#67) sowie
der Berechtigungskatalog und die Rollen (#72, #73).

#### Woran man eine Unterbau-Änderung erkennt

Eine Änderung ist eine Unterbau-Änderung, wenn sie

- (a) ein Feld, eine Relation, einen Enum-Wert oder ein Modell des Unterbaus hinzufügt, ändert oder
  entfernt, oder
- (b) die Signatur oder die Bedeutung eines Exports von `contexts/platform/index.ts` ändert.

#### Erweiterung und Semantikänderung

Eine **Erweiterung** ist additiv: ein neues Modell, ein neues optionales oder mit Standardwert
versehenes Feld, eine neue Fassadenfunktion. Kein bestehender Leser muss sich ändern.

Eine **Semantikänderung** ändert Bedeutung, Einheit, Nullbarkeit, Pflichtcharakter, eine
Rückfallkette oder `onDelete`, entfernt oder benennt etwas um, oder verschiebt einen Wert von einem
Unterbau-Modell in ein anderes.

Im Zweifel entscheidet eine Frage:
Muss ein bestehender Leser sich ändern? Dann ist es eine Semantikänderung.

Eine Erweiterung wiegt leichter als eine Semantikänderung.

#### Wer genehmigt

Der Owner genehmigt. Bei einer **Erweiterung** ist die Genehmigung das Erreichen des Status `Ready`
mit vorhandenem Abschnitt „Auswirkung auf die Kontexte“. Bei einer **Semantikänderung** braucht es
zusätzlich einen ausdrücklichen Entscheidungskommentar des Owners auf dem Issue, und zwar **vor**
`Ready`. Nach der Auslieferung folgt ein Nachtrag im begleitenden Dokument der ADR-Reihe, heute
`docs/adr/0001-abweichungen.md`.

#### Pflichtabschnitt „Auswirkung auf die Kontexte“

Jedes Issue, das eine Unterbau-Änderung enthält, trägt einen Abschnitt mit genau diesem Titel. Er
nennt Zeiterfassung, Abwesenheiten, Schichtplanung, Arbeitszeitkonto und die Kompositionsschicht,
jeweils mit einer Auswirkung oder einem ausdrücklichen „keine“.

Das ist Verfahren, kein Mechanismus: Die Prüfung ist das `Ready` des Owners. Eine maschinelle
Prüfung, etwa über eine PR-Vorlage oder einen Lint, ist hier nicht entschieden.

#### Neuer Fremdschlüssel auf den Unterbau

Ein neuer Fremdschlüssel **von** einem Kontext **auf** den Unterbau (Beispiele: #68, #325, #65) ist
selbst keine Unterbau-Änderung. Für ihn gilt:

- Das Issue des Zielkontexts nennt ihn als neue Abhängigkeit vom Shared Kernel.
- Revisionsrelevante Relationen tragen `onDelete: Restrict`.
- Die referenzierte Unterbau-Zeile muss zum selben Mandanten gehören. Eine ID eines fremden
  Mandanten wird so abgelehnt, dass die Antwort nicht von der auf eine nicht existierende ID zu
  unterscheiden ist (T-100-09).

#### Prüftabelle für v1.12.0 und #66

Die Einordnung ist die Lesart dieses ADR. Der Owner bestätigt sie, indem er das Issue auf `Ready`
setzt. Gelesen am 2026-09-24 (Issue-Text, Kommentare, Board-Status). Keines der sechs Issues trägt
an diesem Tag einen Abschnitt „Auswirkung auf die Kontexte“.

| Issue                       | Änderung und Kontext                                                                                                               | Einordnung nach Entscheidung 7                                                                                                                                                                                                                   | Stand 2026-09-24                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #64 Salon                   | Unterbau: neues Modell `Salon`; `TenantConfig.storeHours` wandert an den Salon                                                     | Erweiterung (neues Modell) **und** Semantikänderung (ein Wert wechselt das Unterbau-Modell) → volles Verfahren                                                                                                                                   | Owner-Entscheidung liegt vor (Kommentar vom 2026-09-24 zu den Öffnungszeiten); Ready am 2026-09-24, auf dem Board inzwischen `In Progress`. Abschnitt „Auswirkung auf die Kontexte“ fehlt, weil das Ticket älter ist als diese Regel → vor Beginn von Phase 64b nachtragen                                                                                                                                                      |
| #67 Salonzuordnung          | Unterbau: neues versioniertes Modell am `Employee`, neue Fassadenfunktion `salonForDay()`                                          | Erweiterung. Grenzfall: Der Stammsalon wird in `POST /employees` nur bei Mandanten mit mehr als einem aktiven Salon Pflicht. Das bleibt Erweiterung, weil sich kein bestehender Leser ändern muss und heute kein Mandant einen zweiten Salon hat | Ready (Ready-Prüfung, Kommentar vom 2026-09-24). Abschnitt „Auswirkung auf die Kontexte” fehlt → vor Phase 67b nachtragen. Nachtrag (Phase 67b Plan 05, 2026-09-24): Der Abschnitt „Auswirkung auf die Kontexte” wurde am 2026-09-24 im Issue ergänzt; Phase 67b hat das Issue vollständig als Erweiterung umgesetzt (Plans 01-05) — kein bestehender Leser musste geändert werden, kein Mandant hat heute einen zweiten Salon. |
| #68 `TimeEntry.salonId`     | Zeiterfassung: neuer Fremdschlüssel auf `Salon`                                                                                    | Keine Unterbau-Änderung; Regel „Neuer Fremdschlüssel auf den Unterbau“                                                                                                                                                                           | Erfüllt: Das Issue nennt die Abhängigkeit vom Unterbau, `onDelete: Restrict` und das Kriterium für fremde Mandanten (T-100-09). Ready                                                                                                                                                                                                                                                                                           |
| #65 Phorest pro Salon       | Schichtplanung: neue Fremdschlüssel auf `Salon` (Kopplungstabelle, `PhorestSyncRun`); `TenantConfig.phorestBranchId` wird abgelöst | Neue Fremdschlüssel auf den Unterbau **und** Semantikänderung eines Unterbau-Felds → volles Verfahren                                                                                                                                            | Owner-Entscheidung liegt vor (Ready-Prüfung, Kommentar vom 2026-09-24: `phorestBranchId` wird zur Kopplung am Default-Salon, die Spalte bleibt als veraltet markiert); `onDelete: Restrict` benannt. Ready. Abschnitt „Auswirkung auf die Kontexte“ fehlt → vor Phase 65b nachtragen                                                                                                                                            |
| #325 `Shift.salonId`        | Schichtplanung: neuer Fremdschlüssel auf `Salon`                                                                                   | Keine Unterbau-Änderung; Regel „Neuer Fremdschlüssel auf den Unterbau“                                                                                                                                                                           | Abhängigkeit (#64, #110) und Kriterium für fremde Mandanten vorhanden; `onDelete` nicht festgelegt → in der Phase entscheiden (ein Salon wird nach #64 nie hart gelöscht). Ready                                                                                                                                                                                                                                                |
| #66 Beschäftigung (Backlog) | Unterbau: `WorkSchedule` wird Kind der Beschäftigung, `LeaveEntitlement` und `OvertimeAccount` werden neu verankert                | Semantikänderung → volles Verfahren                                                                                                                                                                                                              | Backlog ohne Milestone (Owner-Kommentar vom 2026-09-24, „derzeit kein Anlass“); wird geprüft, wenn es zurückkommt                                                                                                                                                                                                                                                                                                               |

### 8. Ereignis-Versionierung: Notiz, kein Arbeitspaket

Ereignisverträge im Prozess sind TypeScript-Typen und compilergeprüft. Ein Sender und ein Empfänger
derselben Codeversion können nicht auseinanderlaufen. Die Versionierung wird erst dann ein echtes
Problem, wenn Ereignisse über eine Codeversion hinaus serialisiert werden, also mit einem Broker
(Entscheidung 5). Dann wird sie gelöst. Heute entsteht dafür kein Ticket.

### 9. Kompositionsschicht

`apps/api/src/composition/` (`activity.ts`, `dashboard.ts`, `data-retention.ts`, `pdf.ts`,
`reports.ts`) und die Kompositionswurzel `apps/api/src/app.ts` bilden die Kompositionsschicht. Für
sie gilt:

- Sie besitzt kein Modell. Keines der 41 Modelle hat in `MODEL_OWNER` die Kompositionsschicht als
  Eigentümer.
- Sie trägt keine Fachregel.
- Sie liest Kontexte nur über deren `index.ts`. Das ist durchgesetzt: Block 1 von
  `eslint.boundaries.mjs` gilt auch für `composition/`, und das Register
  `context-boundary-import-exceptions.json` enthält keinen Eintrag für `composition/`.
- Kein Kontext und kein Service importiert aus `composition/` (gemessen: 0, vgl.
  `0001-abweichungen.md` Eintrag H).
- Eine Fachregel, die dort entdeckt wird, wandert in den Kontext, dem sie gehört.

`apps/api/src/app.ts` bleibt die eine benannte Ausnahme der Grenzprüfung, unverändert. Die
Kompositionsschicht ist weder ein Kontext noch Teil des Unterbaus.

### 10. Handler-Arten

Ereignis-Handler sind von einer von zwei Arten:

- **invariantentragend:** synchron, in der Transaktion des Senders, fail-closed. Scheitert der
  Handler, bricht der Schreibvorgang des Senders ab.
- **reaktiv:** läuft nach dem Commit, darf scheitern, bricht den Sender nie ab. Sein Scheitern wird
  protokolliert.

Der Standard für einen neuen Handler ist reaktiv. Invariantentragend ist ein Handler nur, wenn eine
benannte Invariante es verlangt, und dann liegt er in dem Kontext, dem diese Invariante gehört.
Heutiges Beispiel: `recalcProvisionalLeaveForShiftChange`. Die Abwesenheiten besitzen die Zahl der
Urlaubstage, die Schichtplanung ruft die Funktion innerhalb ihrer eigenen Transaktion auf.

Begründung: Ohne diese Unterscheidung könnte ein künftiger Kontext das Einstempeln brechen, weil
ein scheiternder Nebenempfänger den Schreibvorgang der Zeiterfassung mitreißen würde.

Es gibt heute keinen Dispatcher. #102 baut ihn. Die Handler-Arten sind die Regel, die er umsetzen
muss, keine Beschreibung von vorhandenem Code.

---

## Konsequenzen

**Positiv**

- Das Repository widerspricht sich nicht mehr selbst: v1.12.0 (#64, #65, #67, #68, #325) wird gegen
  sein eigenes ADR gebaut.
- Offene Frage 1 von ADR 0001 ist geschlossen. Die Compliance-Kontrolle bleibt in der Datenbank.
- Die Schichtplanung hat den Namen, den die Grenzprüfung schon durchsetzt.
- Änderungen am Unterbau werden sichtbar, bevor sie passieren, und eine Semantikänderung braucht
  den Owner.
- In der Kompositionsschicht kann nicht unbemerkt eine Fachregel wachsen.
- Die Handler-Arten verhindern, dass ein künftiger Kontext das Einstempeln bricht.

**Negativ / einzupreisen**

- Enge Kopplung an den Shared Kernel: Jede Änderung am Unterbau pflanzt sich in alle vier Kontexte
  fort. Das ist bewusst in Kauf genommen (Entscheidung 4). Das Gegengewicht ist die Governance aus
  Entscheidung 7.
- 19 der 28 Fremdschlüssel auf den Unterbau sind `Cascade`. Dieses ADR lässt `onDelete` unberührt.
  Die `Restrict`-Regel in `CLAUDE.md` deckt `TimeEntry`, `LeaveRequest` und `Absence` ab, und alle
  drei sind `Restrict`. Ob weitere Relationen `Restrict` sein sollten, ist eine eigene
  Compliance-Frage und hier nicht entschieden.
- Die Governance ist Verfahren, kein Mechanismus. Sie hält nur, solange das `Ready` des Owners
  gelebt wird.
- Taktische Bausteine außerhalb des Arbeitszeitkontos brauchen ein neues ADR.
- Keine Isolation zur Übersetzungszeit (ein Prisma-Client). Die Isolation bleibt bei #100 und #101;
  #105 und #106 kommen nur mit Auslöser.
- Es gibt noch keinen Dispatcher (#102). Die Handler-Arten sind seine Regel, kein vorhandener Code.
- Die Einordnung in der Prüftabelle ist eine Lesart, die der Owner bestätigt.

---

## Status

**Akzeptiert** am 2026-09-24.

ADR 0002 löst ADR 0001 genau in den Teilen ab, die im Kopf genannt sind. Alles andere dort gilt
weiter. ADR 0001 wird markiert, nicht umgeschrieben.

Abweichungen und Nachträge werden weiter in `0001-abweichungen.md` geführt (Eintrag J). Ein eigenes
Abweichungsdokument für ADR 0002 entsteht erst mit der ersten Abweichung.

Ein Teil dieses ADR ist heute schon wahr: Die Fremdschlüsselregel ist gemessen erfüllt, und die
Grenzprüfung kennt fünf Bereiche. Ein anderer Teil ist eine Regel für künftige Arbeit: die
Governance, die Handler-Arten und die Auslöser.
