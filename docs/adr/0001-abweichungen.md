# ADR 0001 — Abweichungen vom Zielbild

**Begleitdokument zu** `0001-drei-kontexte.md`
**Erhoben:** 2026-08-28
**Codestand:** `main` @ `263ed0aa`

Warum getrennt vom ADR: Ein akzeptiertes ADR beschreibt eine Entscheidung und sollte stabil
bleiben. Diese Liste dagegen schrumpft, sobald Punkte abgearbeitet werden — sie ist ein lebendes
Dokument.

**Dieses Dokument legt keine Tickets an.** Was davon wann in den Backlog geht, entscheidet der
Owner.

---

## Vorbemerkung: Der Abstand ist größer als „ein paar Verstöße"

Die Regeln 1–4 des ADR (ein Schema pro Kontext, keine kontextübergreifenden Fremdschlüssel, kein
direkter Fremdzugriff, Migrationen beim Kontext) sind heute **nicht punktuell verletzt — die
beschriebene Struktur existiert schlicht nicht:**

| Regel                          | Ist-Zustand auf `main` @ `263ed0aa`                                              |
| ------------------------------ | -------------------------------------------------------------------------------- |
| Ein Schema pro Kontext         | **1** Schema, 41 Modelle, `@@schema` kommt **0**-mal vor                         |
| Migrationen beim Kontext       | **1** zentrales Verzeichnis, 22 Migrationen                                      |
| Keine kontextübergreifenden FK | FK-Graph läuft sternförmig über `Employee` (20 Modelle mit direkter `@relation`) |
| Kein direkter Fremdzugriff     | 67 Dateien greifen direkt auf Prisma zu; es gibt keine Datenzugriffsschicht      |
| Ereignis-Integration           | **0** Treffer für Emitter/Bus/Publish/Subscribe in `apps/api/src`                |

> **Nachtrag 2026-09-24 (ADR 0002, Issue #110):** Drei Zeilen dieser Tabelle lesen sich seit ADR 0002 anders — „Ein Schema pro Kontext“ und „Migrationen beim Kontext“ sind keine Abweichungen mehr, sondern Arbeitspakete mit Auslöser; „Keine kontextübergreifenden FK“ ist in der präzisierten Fassung gemessen erfüllt. Die Tabelle bleibt als historische Messung auf `263ed0aa` stehen — siehe Eintrag J.

Das ist nicht als Vorwurf gemeint. Bei genau einem Fachbereich bringt ein Schema pro Kontext
keinen Nutzen und kostet echten Aufwand. Es ist die ehrliche Feststellung, dass das ADR ein
**Zielbild** beschreibt und nicht einen erreichten Zustand — und dass die Regeln 1–4 erst mit dem
zweiten Kontext praktisch werden.

---

## A — Deutsche Anzeigetexte als Steuerwerte

**Schwere: hoch. Vor dem Kettenumbau.**

An mehreren Stellen ist ein deutscher, für Menschen gedachter Text der **Selektor oder
Identitätsträger** einer fachlichen Entscheidung.

### A.1 `invalidReason` als Selektor und Vergleichswert

| Stelle                                                                       | Was passiert                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/api/src/contexts/absence/api/leave.ts:884`                             | `updateMany` auf `TimeEntry` **selektiert** über `invalidReason: "Urlaubsstornierung ausstehend"` |
| `apps/api/src/contexts/absence/api/leave.ts:1787`                            | dasselbe, zweiter Pfad                                                                            |
| `apps/api/src/contexts/time-tracking/api/time-entries.ts:1735`               | `existing.invalidReason === "Ausstempeln fehlt"` **steuert Verhalten**                            |
| `apps/api/src/contexts/time-tracking/api/time-entries.ts:1244, 1322`         | schreiben `"Urlaubsstornierung ausstehend"`                                                       |
| `apps/api/src/services/clock/resolver.ts:91`                                 | schreibt `"Urlaubsstornierung ausstehend"`                                                        |
| `apps/api/src/contexts/time-tracking/plugins/attendance-checker.ts:303, 314` | schreiben `"Ausstempeln fehlt"`                                                                   |

**Korrektur gegenüber dem Voranalyse-Bericht vom 2026-08-27:** Dort waren drei Stellen genannt. Es
sind **sieben**. `resolver.ts` und `attendance-checker.ts` waren nicht erfasst — der Befund ist also
breiter, nicht schmaler.

### A.2 Typidentität über den Anzeigenamen

**Status: GESCHLOSSEN (Phase 97, T2 — 2026-09-14).** `LeaveType.code` (Enum `LeaveTypeCode`,
`@@unique([tenantId, code])`) ist jetzt die Identität; `name` ist reiner, mandantenseitig frei
umbenennbarer Anzeigetext. Die einzige verbliebene Code<->Name-Abbildung liegt in
`apps/api/src/contexts/absence/leave-type.ts` (D-04). Die ursprüngliche Erhebung unten nannte fünf
Vergleichsstellen als Beispiel — die vollständige, phasenweit gemessene Fundstelleninventur
(Plan 97-01) waren **71 Fundstellen über 16 Dateien**, nicht fünf; alle sind auf `code`
umgestellt, mit Ausnahme der bewusst verbliebenen Anzeigestellen und der beiden
Absence-Model-Ternärketten (siehe `leave-type-identity-guard.test.ts`s `ALLOWED`-Liste, Plan
97-10 Task 1). Ein CI-Gate (`apps/api/src/__tests__/leave-type-identity-guard.test.ts`)
verhindert seit Plan 97-10, dass ein deutscher Anzeigename erneut zum Steuerwert wird — mit zwei
geführten Rot-Nachweisen (siehe die zugehörige SUMMARY). Drei genuine, ausserhalb des
Phasenumfangs liegende Restfunde (Cron-Job, Austritts-Pro-rata-Warnung, ein Dashboard-Icon) sind
als bekannte, verfolgte Ausnahmen in Issue #205 erfasst, nicht stillschweigend akzeptiert.

Die ursprüngliche Erhebung, unverändert als Historie:

`LeaveType` ist eine **mandantenbezogene Tabelle**; die Zuordnung zu den hartkodierten `TYPE_CODES`
(`leave.ts:59-70`) lief über einen **Namensvergleich**:

- `leave.ts:101` — `findFirst({ where: { tenantId, name: def.name } })`
- `leave.ts:108` — Umbenennen alter Seed-Namen über `LEGACY_ALIASES` (`leave.ts:88`)
- `leave.ts:759, 803, 2071, 2273, 2340` — `TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === r.leaveType.name)`

Fünf Vergleichsstellen, nicht eine. Ein Mandant, der „Urlaub" umbenennt, verlor die Typzuordnung
— aufgefangen nur durch die Alias-Liste, die jede künftige Umbenennung mitpflegen musste.

### Warum das der erste Punkt ist

> **Solange deutsche Anzeigetexte Steuerwerte sind, kann keine Kontextgrenze technisch nachweisbar
> sein — sie wäre ein Stringvergleich quer durch die Wand.**

Eine Modulgrenze, die ein Linter oder ein Test prüfen soll, braucht etwas Prüfbares: einen Typ, ein
Enum, einen Import. Ein Stringvergleich ist für jedes Werkzeug unsichtbar. Deshalb steht dieser
Punkt vor allen anderen — **er muss vor dem Kettenumbau weg**, sonst werden die neuen Grenzen auf
derselben unprüfbaren Grundlage gezogen.

Erschwerend: Der Kettenumbau führt eine Datenzugriffsschicht ein. Genau dort müssten diese
Selektoren später sitzen — auf einem Feld, das eigentlich Anzeigetext ist.

---

## B — `Absence` mit `SICK`: zwei Leser, zwei Wahrheiten

**Schwere: mittel. Vor der nächsten Saldo-Fehlersuche; nicht zwingend vor dem Kettenumbau.**

`packages/db/prisma/schema.prisma:730-740` dokumentiert selbst: _„The Absence side is DEAD: no code
path calls `absence.create()` with type SICK."_ Für die **API** stimmt das. Für den **Demo-Seed
nicht**: `packages/db/src/reset-demo.ts:589-592` legt `Absence` mit `type: "SICK"` an.

Auf solche Zeilen reagieren zwei Leser gegensätzlich:

| Leser                                                                        | Verhalten bei `Absence.SICK`                                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `apps/api/src/contexts/absence/leave-check.ts:39`                            | **ignoriert** sie — liest aus `Absence` nur `MATERNITY` und `PARENTAL`                     |
| `apps/api/src/contexts/working-time-account/close-employee-month.ts:613-639` | **kreditiert** sie — der Kommentar sagt ausdrücklich „ALL absence types are credited here" |

Eine Demo-Krankheit senkt also das Soll, blockiert aber nicht das Stempeln; eine Produktiv-Krankheit
läuft über `LeaveRequest` und tut beides.

**Entschärfend:** `close-employee-month.ts` führt eine tagesbasierte Dedup-Menge (`sbClaimed`), eine
Doppelanrechnung desselben Tages entsteht dadurch nicht. Der Schaden ist **irreführende Demo- und
Testdaten**, keine falsche Produktivrechnung.

Nach der Trennlinie im ADR ist die Zuordnung eindeutig: **`SICK` gehört zu `LeaveRequest`.** Der
Demo-Seed widerspricht dem.

---

## C — Kein Beschäftigungsobjekt: Kontingente hängen am Mitarbeiter

**Schwere: mittel. Teil des Kettenumbaus, nicht davor.**

`LeaveEntitlement` (`schema.prisma:613`) ist eindeutig über `(employeeId, leaveTypeId, year)`
— es gibt kein Beschäftigungsobjekt dazwischen. Ebenso `OvertimeAccount` und `WorkSchedule`
(letzteres hat `validFrom`, aber **kein** `validTo`).

Folge: Wiedereintritt, Vertragswechsel oder ein zweites Beschäftigungsverhältnis haben keine
Trennlinie im Datenmodell. Der Anspruch eines Jahres ist ein Wert am Mitarbeiter, nicht an einer
Beschäftigung.

Das ist **kein Versäumnis, das nachzuholen wäre** — es ist bekannt und im Kettenumbau bereits
adressiert. Für dieses ADR relevant, weil „Beschäftigung" im Zielbild zum **Unterbau** gehört: Sie
darf nicht dem Kontext Abwesenheiten gehören, obwohl das Kontingent dort hängt.

---

## D — Ungenutzte `TimeEntryType`-Werte

**Schwere: niedrig. Nach dem Kettenumbau — oder gar nicht.**

`TimeEntryType` (`schema.prisma:996`) hat drei Werte. Für `OVERTIME` und `PUBLIC_HOLIDAY` gibt es
**null Schreibzugriffe** im gesamten Code (`apps/api/src`, `apps/web/src`, `packages/db/src`); die
einzigen Treffer sind Kommentare. Geschrieben und gefiltert wird ausschließlich `WORK`.

Praktisch folgenlos. Für dieses ADR trotzdem erwähnenswert aus einem anderen Grund: **Ein Enum mit
freien Plätzen lädt dazu ein, dort eine Abwesenheit einzutragen** — genau der Fehler, den das ADR
ausschließt. Wer die Werte aufräumt, sollte den Enum-Kommentar um den Hinweis ergänzen, dass hier
keine Abwesenheitswerte hingehören.

---

## E — Kontingentbuchung im Kontext Abwesenheiten rechnet mit Vertragsdaten

**Schwere: mittel bis hoch, aber derzeit als Code-Review-Befund offen. Vor dem Kettenumbau prüfen.**

`deductVacationDays()` (`leave.ts:3269`) und `reverseVacationDays()` (`leave.ts:3348`) nehmen einen
Parameter `totalDays`. Im **jahresübergreifenden Zweig** wird dieser Parameter verworfen: die
Buchung erfolgt stattdessen aus `splitDaysAcrossYears(startDate, endDate, false, workDays, holidays)`
(`leave.ts:3291` bzw. `:3371`), also aus einer eigenständigen Neuberechnung über die Wochentagsmenge
des Vertrags.

Zwei Dinge daran sind aus Sicht dieses ADR relevant:

1. **Eine Kontingentbuchung rechnet selbst**, statt den ihr übergebenen Wert zu buchen. Damit gibt
   es zwei Rechenwege für dieselbe Zahl — `LeaveRequest.days` und `Σ LeaveEntitlement.usedDays`
   können auseinanderlaufen.
2. Sie greift dafür auf **Vertragsdaten aus dem Unterbau** zu (`resolveWorkDays`), nicht über eine
   Schnittstelle, sondern durch Neuberechnung.

Dies wurde unabhängig auch als Befund CR-01 im Code-Review der Phase 107 erfasst und ist dort offen.
Hier steht es, weil es strukturell ist und nicht nur ein Bug: Die Regel „wie viele Tage kostet
dieser Zeitraum" gehört nach dem ADR zum **Arbeitszeitkonto**, wird aber an zwei Stellen im Kontext
Abwesenheiten unabhängig implementiert.

---

## Reihenfolge

| #   | Punkt                                                 | Schwere     | Zeitpunkt                          |
| --- | ----------------------------------------------------- | ----------- | ---------------------------------- |
| A   | Anzeigetexte als Steuerwerte (7 + 5 Stellen)          | hoch        | **vor** dem Kettenumbau            |
| E   | Kontingentbuchung rechnet selbst, jahresübergreifend  | mittel–hoch | vor dem Kettenumbau prüfen         |
| C   | Kein Beschäftigungsobjekt                             | mittel      | **im** Kettenumbau                 |
| B   | `Absence.SICK` nur im Demo-Seed, zwei Leser           | mittel      | vor der nächsten Saldo-Fehlersuche |
| D   | Ungenutzte `TimeEntryType`-Werte                      | niedrig     | danach oder nie                    |
| F   | Zeiterfassung/Schichtplanung je in zwei Bäumen (D-17) | niedrig     | bewusst befristet, siehe unten     |

Punkt A ist nicht zufällig oben: Er ist die Voraussetzung dafür, dass irgendeine der ADR-Regeln
überhaupt überprüfbar wird.

---

## F — Zeiterfassung und Schichtplanung liegen je in zwei getrennten Bäumen

**Schwere: niedrig. Bewusst und befristet — Phase 99b (Issue #99), erhoben 2026-09-16.**

Nach Phase 99b's Kontextschnitt liegt der Kontext **Zeiterfassung** in zwei physisch getrennten
Verzeichnissen:

- `apps/api/src/contexts/time-tracking/` — die 14 verschobenen Routen/Utilities (Phase 99b,
  Plan 99B-05)
- `apps/api/src/services/clock/` — unverändert, bewegt sich in Phase 99b NICHT

Ebenso **Schichtplanung**:

- `apps/api/src/contexts/scheduling/` — die 11 verschobenen Routen/Utilities (Phase 99b,
  Plan 99B-03)
- `apps/api/src/services/phorest/` — unverändert, bewegt sich in Phase 99b NICHT

Issue #99 nennt `services/clock/` und `services/phorest/` explizit „das Vorbild, nicht die
Ausnahme" — sie sind bereits fachlich sauber geschnitten und dienten Phase 99b als Referenz für den
Zuschnitt der neuen `contexts/`-Verzeichnisse. Genau deshalb wurden sie NICHT verschoben: das
Vorbild (die Struktur, das Muster) wurde kopiert, nicht die physischen Dateien. Sie unter
`contexts/` zu ziehen ist eigenständige Arbeit mit eigenem Risiko (Importpfade, die von
`services/phorest/{sync-appointments,sync-shifts}.ts` und den Phorest-/Clock-Testsuiten ausgehen)
und war ausdrücklich nicht Gegenstand dieser Phase (D-17,
`.planning/phases/99B-t4-kontextschnitt/99B-CONTEXT.md`).

**Warum dieser Eintrag existiert:** Ein unkommentierter Zwischenstand wäre die schlechtere
Variante — die nächste Person, die `services/clock/` oder `services/phorest/` anfasst, könnte den
Zustand für ein Versehen halten statt für Absicht. Beide Hälften sind hier benannt, damit sie
auffindbar sind:

- Zeiterfassung: `apps/api/src/contexts/time-tracking/` UND `apps/api/src/services/clock/`
- Schichtplanung: `apps/api/src/contexts/scheduling/` UND `apps/api/src/services/phorest/`

Weiteres zum Zuschnitt: `docs/context-cut-map.md` § 4 und § 7.

---

**Nachtrag 2026-09-16 (Issue #233).** Phase 99b hat `routes/`, `utils/` und `plugins/` nach
`apps/api/src/contexts/<kontext>/` bzw. `apps/api/src/composition/` verschoben. Die Pfadangaben
in `0001-drei-kontexte.md` bleiben bewusst auf `263ed0aa` eingefroren — das ADR bezeichnet sie im
Kopf selbst als Belege, nicht als Wegbeschreibung. Die Zuordnung alt→neu steht in
`docs/context-cut-map.md`.

---

## G — Fassaden geschlossen (Phase 100b, Issue #100), was dabei bewusst NICHT geschah

**Schwere: informativ. Abgeschlossen — Phase 100b, erhoben 2026-09-17.**

Regel 3 des ADR („kein direkter Tabellenzugriff auf fremde Schemas") ist ab Phase 100b eine
messbare Tatsache, nicht mehr eine Absicht: `measure:context-access --check 0` läuft in der CI und
zählt null direkte Fremdzugriffe unter `contexts/`, `composition/` und `services/` — gemessen
gegen die 169 zu Phasenbeginn (Plan 01), abgebaut Welle für Welle bis auf null (Plan 13).

**Was bewusst NICHT geschah, damit die nächste Person es nicht für ein Versehen hält:**

- **`composition/` und `services/` tragen keine eigene `index.ts`.** Beide sind laut ADR 0001
  Konsumenten der Fassaden, nicht Träger eigener Modelle — eine eigene öffentliche Fläche für
  Verzeichnisse, die selbst keine Daten besitzen, wäre eine Fassade ohne Eigentümer.
- **`services/clock/` und `services/phorest/` wurden NICHT konvertiert** — sie bleiben der in
  Eintrag F beschriebene, bewusst befristete Übergangszustand. Phase 100b hat lediglich die zwei
  verbliebenen echten Grenzübertritte AUS `services/` (beide in
  `services/phorest/sync-shifts.ts`) auf Fassadenaufrufe umgestellt; `services/clock/`s eigene
  Modellzugriffe (`timeEntry`) sind laut Eintrag F kein Grenzübertritt und wurden nicht angefasst.
  Eine Ausnahme: `services/clock/resolver.ts` importiert `hasApprovedLeaveOnDate` seit Plan 14 über
  `contexts/absence` statt über die konkrete Datei — eine reine Importpfad-Änderung ohne
  Verhaltensänderung (AC-1), kein Grenzübertritt, der eine Fassade gebraucht hätte, da die
  aufgerufene Funktion selbst schon eine war.
- **`test-bootstrap.ts`s 21 Zugriffe bleiben eine benannte, begründete Ausnahme** (D-03), keine
  Fassade — die Route ist auf int/prod nicht registriert, eine destruktive `resetForTests()` auf
  der dauerhaften öffentlichen Fläche jedes Kontexts wäre der schlechtere Tausch.
- **Die im falschen Kontext liegenden Routen wurden verschoben, nicht in eine Fassade gepresst.**
  Wo eine Fassaden-Zählung während der Konversion auffällig machte, dass eine Route eigentlich zu
  einem anderen Kontext gehört (Abwesenheiten-CRUD in `settings.ts`/`employees.ts`, 15 Zugriffe;
  `PresenceDevice`-CRUD in `employees.ts`, 5 Zugriffe), wurde das als Fund dokumentiert und als
  Issue #243 abgelegt (D-13) — nicht bei Gelegenheit verschoben.

**Was #101 aus Phase 100b erbt, aber noch nicht kann:** der Unterbau
(`apps/api/src/contexts/platform/`) importiert selbst neun Dateien lang aus fremden
Fach-Kontexten (`docs/context-cut-map.md` § 7 nennt sie einzeln) — jeder dieser Zugriffe läuft
bereits über eine Fassade/einen Index, ist also sicher, aber die Importrichtung ist genau das, was
#101s geplantes AC3 verbietet. Diese Entscheidung liegt bei #101, nicht hier (D-13, keine
Neugestaltung nebenbei).

**Warum dieser Eintrag existiert:** Ein geschlossenes Kapitel ohne Protokoll sieht rückblickend wie
vollständige Konvertierung aus — die drei bewusst NICHT konvertierten Stellen (Komposition ohne
eigenen Index, die Übergangsbäume aus Eintrag F, die Test-Bootstrap-Ausnahme) sind hier benannt,
damit niemand sie für eine vergessene Aufräumarbeit hält. Weiteres: `docs/context-cut-map.md` § 7,
`.planning/phases/100B-t5-fassade/100B-14-SUMMARY.md`.

---

## H — Routen und Querschnittsmodule in den richtigen Kontext (Phase 243, Issue #243), das Ausnahmeregister für #101

**Schwere: informativ. Vorbedingung für #101 — abgeschlossen, 2026-09-17.**

### Was verschoben wurde und warum

Issue #243 sortierte den Befund, dass der Unterbau vier Fach-Kontexte importiert, in drei Klassen.
Die Planung hat die Klasseneinteilung geprüft und zwei Punkte korrigiert (siehe die
Ticket-Kommentare selbst). Am Ende bewegt: Klasse A (kompositionsartige Dateien) und Klasse B
(fremde Routengruppen). Kriterium für A: die Datei besitzt kein eigenes Modell, trägt keine
Fachregel und aggregiert über mehrere Kontexte hinweg — genau die Aufgabenbeschreibung der
Kompositionsschicht (`dashboard.ts`, `reports.ts`, `pdf.ts`). Kriterium für B: eine Routengruppe,
deren fachliches Subjekt ein anderer Kontext besitzt, gehört in dessen Verzeichnis, unabhängig
davon, unter welchem URL-Präfix sie historisch registriert wurde.

Bewegt (`docs/context-cut-map.md` § 8 nennt die elf Routen im Detail): `activity.ts` und
`data-retention.ts` (Klasse A, `git mv` nach `composition/`); die Abwesenheiten-Settings-Routen,
die `/employees/me/wifi`-Routen und die `/me/availability`-Route (Klasse B, in je eine neue Datei
im zuständigen Kontext ausgelagert). Alle URLs unverändert — bewiesen durch
`apps/api/baselines/route-surface.txt`, eingefroren VOR der ersten Verschiebung und über die ganze
Phase kein zweites Mal beschrieben.

### Was bewusst NICHT verschoben wurde, damit es nicht wie ein Versehen aussieht

- **`anonymize.ts` bleibt im Unterbau.** Es ist kein Blatt — `contexts/platform/api/employees.ts:11`
  und `contexts/scheduling/api/shifts.ts:17` importieren daraus. Es nach `composition/` zu ziehen,
  würde die erste Kante von `contexts/` nach `composition/` schaffen; heute importiert **kein**
  Kontext aus `composition/`. Das wäre für #101 eine schlechtere Regel als die, die es ersetzen
  soll. Seine eigene, dokumentierte Zuständigkeit (Employee+User, `context-area-map.ts:120`) sagt
  ohnehin Unterbau, nicht Komposition. Gemessener Gate-Preis einer testweisen Verschiebung:
  `lint:tenant-scoping` in-scope stiege 478→487 — neun Aufrufe, die keinen `req`-gebundenen
  Bezeichner tragen, würden dauerhaft in einem Gate sichtbar, dessen Kandidatenregeln genau darauf
  aufbauen.
- **Die drei geteilten Konstanten-Module** (`break-constants.ts`, `vocational-school-constants.ts`,
  `missing-entries-window.ts`) blieben zunächst, wo sie sind — siehe die separate
  Owner-Entscheidung in `.planning/phases/243-.../243-04-SUMMARY.md`. Die Eigentumsfrage selbst ist
  seither durch Issue #246 beantwortet und E-6 dadurch aufgelöst, nicht mehr offen — siehe den
  Nachtrag am Ende dieses Eintrags.
- **`holidays.ts` und `imports.ts`** rufen einen Fach-Kontext für einen Seiteneffekt auf
  (Saldo-Neuberechnung, Zeiterfassungs-Schreibzugriffe). Das ist Block 2s Job (#102–#104), nicht
  eine Platzierungsfrage — siehe E-1/E-2 unten.

### Das Ausnahmeregister für #101 (E-1..E-8, seit Issue #246: E-1..E-5 + E-7 + E-8, sieben statt

### acht benannte Klassen)

Gemessen nach Abschluss dieser Phase: **7 Dateien / 22 Importe** verbleiben unter
`contexts/platform/`. Jeder Eintrag unten ist einzeln benannt und begründet, wie #101s AC5 es
verlangt ("befristete, einzeln begründete Ausnahmen — keine pauschale Ausnahmeliste"). **Nachtrag
Issue #246:** E-6 ist seither aufgelöst (die fünf Werte-Importe sind regulärer öffentlicher
Zugriff geworden, keine Ausnahme mehr) — die Tabellenzeile ist zur Historie unten verschoben, das
Register zählt ab jetzt **7 Dateien / 17 Importe**.

| ID      | Wo                                                                                                                                                                                 | Importe                                                                                                                                                                                                                                         | Warum                                                                                                                                                                     | Wo es verschwindet                                                                                                                                                                                                                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E-1** | `platform/api/holidays.ts:5`                                                                                                                                                       | 1 — `recalculateSnapshots`                                                                                                                                                                                                                      | Anlegen eines Feiertags schleift über alle Mitarbeiter und ruft die Saldo-Neuberechnung direkt auf                                                                        | **Block 2 (#102–#104)** — ein `holiday-created`-Ereignis ersetzt den Direktaufruf                                                                                                                                                                                                                                         |
| **E-2** | `platform/api/imports.ts:11-14`                                                                                                                                                    | 4                                                                                                                                                                                                                                               | der Importer schreibt direkt in `time-tracking` und `working-time-account`                                                                                                | **Block 2 (#102–#104)**                                                                                                                                                                                                                                                                                                   |
| **E-3** | `platform/api/settings.ts:6,15`                                                                                                                                                    | 2 — `recalculateSnapshots`, `getShiftsInRange`/`cancelOrphanShifts`                                                                                                                                                                             | `PUT /settings/work/:employeeId` löst Saldo-Neuberechnung und Schicht-Stornierung als Seiteneffekte eines Vertragswechsels aus                                            | **Block 2** — dieselbe Fehlerklasse wie E-1, ein `schedule-changed`-Ereignis                                                                                                                                                                                                                                              |
| **E-4** | `platform/api/employees.ts` — Aufrufe bei `:448` (`createOvertimeAccount`), `:612`/`:619` (`getVacationEntitlementByDisplayName`/`calculateProRataVacation`); Importzeilen `:8,14` | 3 Aufrufe (dieselben zwei Importe wie E-5 — `createOvertimeAccount` und `hardDeleteOvertimeDataForEmployee` teilen sich einen Import in Zeile 14)                                                                                               | Mitarbeiter anlegen erzeugt das Überstundenkonto (`:448`) und berechnet beim Austritt den Pro-rata-Anspruch über eine Anzeigenamen-Suche (`:612`/`:619`) als Seiteneffekt | **Block 2** — `employee-created`/`employee-changed`-Ereignisse                                                                                                                                                                                                                                                            |
| **E-5** | `platform/anonymize.ts:55-58` + `platform/api/employees.ts` — Aufrufe bei `:1001,1005,1203,1206,1208,1211,1213`; Importzeilen `:14,15,35`                                          | 4 + 7 (`hardDeleteOvertimeDataForEmployee`, `hardDeleteTimeDataForEmployee`, `getAbsenceDocumentPaths`, `getSection9DocumentPaths`, `hardDeleteLeaveRequestsForEmployee`, `hardDeleteAbsencesForEmployee`, `hardDeleteEntitlementsForEmployee`) | DSGVO-Art.-17-Löschung muss jeden Kontext erreichen; das fachliche Subjekt ist Employee+User (siehe oben)                                                                 | **verschwindet nicht durch Verschieben.** Entweder dauerhafte, begründete Ausnahme, oder ein `employee-erased`-Ereignis in Block 2. #101 muss wählen; diese Phase empfiehlt dauerhaft-und-begründet, weil eine über ein Ereignis verteilte Löschung genau die eine Stelle verliert, die heute die Vollständigkeit beweist |
| **E-7** | `platform/api/admin/school-holidays.ts:18`                                                                                                                                         | 1 — `listActiveBsPatternsWithFederalStateOverride`                                                                                                                                                                                              | `POST /admin/school-holidays/refresh` muss wissen, welche Bundesländer zu synchronisieren sind, was von den BS-Mustern des Abwesenheiten-Kontexts abhängt                 | **offen** — ein echter kontextübergreifender LESE-Zugriff für einen Unterbau-eigenen Cache. Kandidat für Block 2 (Query-seitiges Ereignis/Projektion) oder ein eigenes Ticket                                                                                                                                             |
| **E-8** | `platform/api/test-bootstrap.ts:42`                                                                                                                                                | 1 — `leaveTypeFields`                                                                                                                                                                                                                           | reine Test-Fixture-Route, auf int/prod nicht registriert                                                                                                                  | **dauerhafte, benannte Ausnahme** — dasselbe Präzedens wie Phase 100b's D-03 für dieselbe Datei (Eintrag G oben)                                                                                                                                                                                                          |

**E-6 ist AUS DIESEM REGISTER ENTFERNT (Issue #246, 2026-09-17) — aufgelöst, nicht mehr
ausgenommen.** Bis zu dieser Auflösung stand hier eine achte Zeile: `settings.ts:14,21,27` +
`employees.ts:21,27`, 5 Importe, die drei reinen Werte-Module `time-tracking/break-constants.ts`,
`absence/vocational-school-constants.ts` und `working-time-account/missing-entries-window.ts`.
Die vollständige Begründung steht im Nachtrag am Ende dieses Eintrags — kurz: eine Konstante trägt
keine Query-Semantik, keinen Soft-Delete-Guard, keinen Tenant-Scope; die Zahl IST die Fachregel,
kein `where`, das eine Fassaden-Funktion (D-02-Argument) rechtfertigen würde. Die fünf Importe
laufen seither über das jeweilige `index.ts` der drei Kontexte und sind damit regulärer,
deklarierter öffentlicher Zugriff — keine Ausnahme mehr.

**Zeilenabgleich gegen die jetzt 17 gemessenen Importe (vorher 22, siehe Nachtrag).** E-4 und E-5
teilen sich EINE Importzeile (`employees.ts:14`, `createOvertimeAccount` UND
`hardDeleteOvertimeDataForEmployee` aus demselben `from "../../working-time-account"`-Block) — die
Spalten "Aufrufe" zählen deshalb FUNKTIONEN, nicht Importzeilen, und E-4s 3 / E-5s 7 dürfen nicht
addiert werden, um auf die Importzeilenzahl zu schließen. Auf Importzeilen-Ebene (die Einheit, die
die 22 aus P1 zählte): E-1=1, E-2=4, E-3=2, E-4∪E-5 in `employees.ts`=4 (Zeilen 8, 14, 15, 35),
E-7=1, E-8=1 → 13, plus `anonymize.ts`s 4 Zeilen (Teil von E-5) → **17**. Die fehlenden 5 sind
E-6, jetzt Teil der öffentlichen Oberfläche der drei Kontexte statt des Registers.

**Ob #101s Lint auch `__tests__` erfasst, ist seit Issue #246 entschieden: NEIN.** Owner-Entscheidung
2026-09-17: `#101`s Boundary-Lint erfasst `__tests__`-Verzeichnisse NICHT. Begründung: ein Test, der
importiert, was er prüft, ist keine Laufzeit-Abhängigkeit der Produktionsschicht — dieselbe
Begründung, mit der `lint:tenant-scoping`s `SCOPED_DIRS` nur `api/`-Verzeichnisse zählt. Zwei
Testdateien unter `contexts/platform/api/__tests__/` importieren fremde Kontexte
(`minijob.test.ts:8` → `working-time-account/timezone`, `schedule-versioning.test.ts:8` →
`time-tracking/api/time-entries`) und bleiben davon unberührt. **Akzeptiertes Risiko, ausdrücklich
festgehalten:** ein Test kann dadurch Interna eines fremden Kontexts fixieren und einen späteren
Refactor dort bremsen — dieser Preis ist bewusst in Kauf genommen, nicht übersehen.

### Die Korrektur, offen ausgesprochen

Eintrag Gs Schlusssatz sagt: der Unterbau importiere aus fremden Kontexten in neun Dateien, und die
Entscheidung liege bei #101. Dieser Eintrag ersetzt diesen Satz: der gemessene Wert auf
`fcf7c432` (Phase 100b gemerged) war **zehn Dateien / 35 Importe** (Issue #243s zweiter Kommentar
maß 34, korrigiert auf 35 in der Planung — die abweichende Neben-Datei war ein Zählfehler, nicht
ein Substanzbefund), Phase 243 entfernte drei Dateien und dreizehn Importe, und **sieben Dateien /
22 Importe** verbleiben. Issue #243s eigener Kommentar sagte "#101 nach #243 mit genau zwei
dokumentierten Ausnahmen erfüllbar" voraus; die gemessene Antwort sind **acht** benannte Klassen.
Ein ADR, das eine überholte Zahl stillschweigend fallen lässt, lehrt die nächste Leserin, seinen
Zahlen zu misstrauen — deshalb steht das hier so ausdrücklich.

### Was #101 noch entscheiden muss

1. ~~Ob die Grenzregel `contexts/platform/api/__tests__/` erfasst~~ — **entschieden, Issue #246,
   2026-09-17: Nein.** Siehe der Nachtrag unten und den Owner-Kommentar auf Issue #101.
2. Ob E-5 eine dauerhafte, begründete Ausnahme bleibt oder ein `employee-erased`-Ereignis in
   Block 2 wird — diese Phase empfiehlt dauerhaft-und-begründet. **Weiterhin offen.**
3. ~~Wer die drei Konstanten-Module aus E-6 besitzt~~ — **entschieden, Issue #246, 2026-09-17: die
   drei Module bleiben, wo sie sind, und werden aus ihrem `index.ts` re-exportiert; E-6 entfällt
   aus dem Register.** Siehe der Nachtrag unten.

### Nachtrag (Issue #246, 2026-09-17): E-6 aufgelöst, `__tests__`-Frage beantwortet

Zwei der drei oben offen gelassenen Fragen sind entschieden. Diese Phase (#243) hatte zwei
Alternativen für die Konstanten-Module ausdrücklich NICHT entschieden, weil es eine
Eigentumsfrage war, keine Platzierungsfrage — die Owner-Entscheidung dazu ist jetzt getroffen:

**Die Konstanten werden aus dem `index.ts` des jeweils besitzenden Kontexts re-exportiert.** Nicht
"als Ausnahme erlaubt", nicht "in eine Fassaden-Funktion verpackt" — als öffentlicher Teil der
Oberfläche erklärt. Begründung: D-02s Argument (der Aufrufer besitzt das `where`) trägt für eine
Konstante nicht — `ARBZG_FLOOR_OVER_6H = 30` hat keine Query-Semantik, keinen Soft-Delete-Guard,
keinen Tenant-Scope; die Zahl selbst IST die Fachregel, ein öffentlicher gesetzlicher Fakt, und ein
Compile-Time-Import einer Konstante trägt eine Änderung automatisch weiter — eine Fassaden-Funktion
wäre hier Zeremonie ohne Nutzen. Ein pfadbasiertes Lint kann außerdem nicht unterscheiden, ob ein
Import-Binding eine `const`-Primitive oder eine Funktion ist — "Werte-Importe sind erlaubt" wäre
also selbst wieder eine Konvention, und #101 existiert genau, um Konventionen durch Mechanik zu
ersetzen. Ein Re-Export aus `index.ts` braucht keine neue Regel, keinen neuen Mechanismus und keine
Ausnahme — #101s Regel ("nur aus `contexts/<x>/index.ts` importieren") gilt für diese fünf Stellen
dann wörtlich.

Umgesetzt: `time-tracking/index.ts` re-exportiert `ARBZG_FLOOR_OVER_6H`, `ARBZG_FLOOR_OVER_9H`,
`BREAK_MAX_OVER_6H`, `BREAK_MAX_OVER_9H`; `absence/index.ts` re-exportiert `BS_DAILY_MIN_BOUND`,
`BS_DAILY_MAX_BOUND`, `BS_BLOCK_WEEKLY_MIN_BOUND`, `BS_BLOCK_WEEKLY_MAX_BOUND`;
`working-time-account/index.ts` re-exportiert `DEFAULT_MISSING_ENTRIES_DAYS`. `settings.ts` und
`employees.ts` importieren alle fünf jetzt aus dem jeweiligen `index.ts` statt aus dem internen
Submodul. Keine Verhaltensänderung — nur der Importpfad ändert sich; alle Gates (Tenant-Scoping,
Fassaden-Signaturen, Import-Ziele, Kommentarsprache, volle Suite, Saldo-Golden) auf Gleichheit
verifiziert. Das Register zählt seither **7 Dateien / 17 Importe** statt zuvor 22 (die 5
Differenz ist E-6, das entfallen ist) und **sieben statt acht** benannte Klassen (E-1..E-5, E-7,
E-8).

**Die zweite Frage — erfasst #101s Boundary-Lint `__tests__`? — ist ebenfalls entschieden: NEIN.**
Begründung: ein Test, der importiert, was er prüft, ist keine Laufzeit-Abhängigkeit der
Produktionsschicht — dieselbe Begründung, mit der `lint:tenant-scoping`s `SCOPED_DIRS` nur
`api/`-Verzeichnisse zählt. Akzeptiertes Risiko, ausdrücklich festgehalten: ein Test kann dadurch
Interna eines fremden Kontexts fixieren (pinnen) und einen künftigen Refactor dort bremsen — dieser
Preis ist bewusst in Kauf genommen, nicht übersehen. Beide Entscheidungen sind zusätzlich als
Kommentar auf Issue #101 hinterlegt; Issue #246 selbst ist mit dieser Umsetzung geschlossen.

Weiteres: `docs/context-cut-map.md` § 8.

### Nachtrag (Phase 101B, Issue #101, 2026-09-17): die Grenze ist mechanisch

**Was zuvor Konvention war, ist jetzt Code.** Diese Phase (101B) baute die maschinelle
Durchsetzung, die dieser Eintrag seit seiner ersten Fassung als Ziel nennt: `no-restricted-imports`
(ein eingebautes ESLint-Rule, keine neue Abhängigkeit, D-02) mit fünf Konfigurationsblöcken —
einem pro Kontext — in `eslint.boundaries.mjs`, importiert von der echten `eslint.config.js`. Das
Glob-Muster ist `**/<name>/**`, bewusst NICHT `**/contexts/<name>/**` — der Grund in einem Satz:
die meisten kontextübergreifenden Importe in diesem Baum wiederholen das `contexts/`-Segment im
Pfad nie (eine Datei in `scheduling` schreibt `from "../../absence"`, nie eine Form mit dem
Segmentnamen davor). Das ist der Satz, der eine spätere „Aufräum"-Änderung der Regel verhindert —
das längere, korrekter aussehende Glob würde kompilieren, einen `app.ts`-förmigen Testfall
bestehen und dabei die Mehrheit der echten Verstöße stillschweigend übersehen.

**Was es gekostet hat, gemessen.** Vor Phase 101B: **150** tiefe produktionsseitige
kontextübergreifende Importe. Danach: **51** — 45 in `app.ts` (Kompositionswurzel-Ausnahme) plus
6 einzeln begründete Registereinträge. **99 umgestellt über fünf Kontext-Wellen**
(working-time-account 34, platform 23, absence 23, time-tracking 16, scheduling 3), plus vier
§8.3-Umlenkungen und ein Restfall, der in dieser letzten Welle geschlossen wurde — durchweg über
benannte, aus Blattmodulen gespeiste Re-Exporte auf den fünf `index.ts`-Dateien, nie über eine
Routendatei. Rund **30 neue benannte Re-Exporte** entstanden dabei auf diesen fünf Oberflächen.

**Das Register, aufgefrischt.** Die Tabelle oben (E-1..E-5, E-7, E-8) bleibt unverändert stehen.
Neu ist die Aussage, welche Einträge einen mechanischen Marker im Code tragen und welche nicht:
E-1, E-2 (beide Importzeilen), E-3, E-4 und E-8 tragen jeweils einen inline
`eslint-disable-next-line no-restricted-imports`-Kommentar, dessen Existenz und Zuordnung
`apps/api/scripts/measure-context-boundary-imports.ts` bidirektional gegen
`apps/api/scripts/context-boundary-import-exceptions.json` prüft (ein Eintrag ohne Kommentar
ODER ein Kommentar ohne Eintrag ist ein Fund). **E-5 und E-7 tragen KEINEN solchen Kommentar** —
beide Importzeilen laufen bereits durch ein `index.ts` (`platform/anonymize.ts` importiert die
vier Fach-Kontexte über deren öffentliche Oberfläche, nicht tief), sodass die Regel sie strukturell
nie als tiefen Import sieht. Für diese beiden bleibt **das Register selbst**, nicht die Regel, die
einzige Aufzeichnung.

**Frage 2 aus „Was #101 noch entscheiden muss" bleibt ausdrücklich offen.** Ob E-5 eine dauerhafte,
begründete Ausnahme bleibt oder in Block 2 zu einem `employee-erased`-Ereignis wird, entscheidet
diese Phase NICHT — dieselbe Empfehlung (dauerhaft-und-begründet) steht weiterhin unwidersprochen,
aber unentschieden. Das ausdrücklich so festzuhalten statt es aussehen zu lassen, als sei es mit
der übrigen Umsetzung miterledigt worden, ist der Punkt dieses Absatzes.

**Die benannte Lücke: dynamische `import()`.** `no-restricted-imports` sieht strukturell keine
dynamischen Imports — ESLint löst dort keinen Modul-Spezifizierer auf. Die eine produktionsseitige
Instanz (`src/composition/reports.ts:1090` → `absence/plugins/carryover-warning.ts`, Phase
101B-01s Baseline) wurde in Welle 07 (absence) auf einen statischen Import umgestellt, nicht als
Ausnahme registriert — das Register zählt deshalb weiterhin sechs Klassen, keine siebte für diesen
Fall. `measure-context-boundary-imports.ts --forms` hält die Größe dieser Lücke fest, damit sie nie
stillschweigend wächst — es zählt die Formen des ARBEITSVORRATS, und der ist am Phasenende 0, also
druckt das Werkzeug heute nichts. **Das ist die Prüfung, nicht ihr Fehlen:** taucht dort je wieder
eine `dynamic-import`-Zeile auf, ist ein Import entstanden, den die ESLint-Regel konstruktionsbedingt
nicht sehen kann. (Eine frühere Fassung dieses Absatzes nannte hier `from 51` als aktuelle Ausgabe.
Das reproduziert nicht — 51 ist die Zahl der AUSGENOMMENEN Importe, nicht der gedruckten Formen.
Korrigiert beim Zielabgleich der Phase, aus demselben Grund, aus dem die drei Zahlkorrekturen oben
ausgeschrieben stehen: eine Doku mit einer Zahl, die sich nicht nachrechnen lässt, bringt ihrer
nächsten Leserin bei, den übrigen Zahlen ebenfalls zu misstrauen.)

**Die Herauslösung (Owner-Entscheidung Q1 = Option D, 2026-09-17).** Acht kontextübergreifend
genutzte Helfer sind aus `absence/api/leave.ts` und `time-tracking/api/time-entries.ts` in
Blattmodule gewandert (`absence/leave-days.ts`, `time-tracking/entry-invariants.ts`,
`working-time-account/overtime-balance.ts`) — plus die sieben gleichdatei-internen Helfer, die
sie mitziehen. Kein `index.ts` re-exportiert eine Routendatei. Zwei Symbole haben dabei den
Kontext gewechselt (`updateOvertimeAccount`, `computeOvertimeBalanceBreakdown` →
Arbeitszeitkonto), weil sie fachlich dort hingehören; die Messung zeigte, dass die Platzierung
zyklenneutral ist, die Entscheidung fiel also fachlich, nicht graphentheoretisch. Ein drittes
Symbol (`computeOvertimeBalanceHours`) blieb bis zur letzten Welle bewusst außerhalb der
öffentlichen Oberfläche — Welle 09 (die abschließende Welle) schloss auch diese letzte Lücke: die
eigene Weiterleitung von `time-tracking/api/time-entries.ts` war selbst ein echter, heute
bestehender kontextübergreifender Bedarf, also wurde sie über `working-time-account/index.ts`
geführt statt als siebter Registereintrag verbucht.

**Der Zyklus — und dass er NICHT auf 0 ging.** Vorher azyklisch. Form C naiv 29 Module, Option D
27, Option D plus das `NOT_ANONYMIZED_EMPLOYEE_WHERE`-Blatt 21 (`platform` verlässt dabei die
Komponente) — die vom Owner am 2026-09-17 akzeptierte Zahl, ausdrücklich als Projektion vor jeder
realen Umstellung. Die real gemessene Endzahl nach Abschluss aller fünf Wellen ist **22, nicht 21**
— siehe die dritte Korrektur unten. Die Resttreiber, real gemessen (nicht aus der Simulation
übernommen) und keiner davon ein Routenmodul:

| Kante                                                                    | tragende Datei(en)                                                                                                                                                                                                    | Status                       |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `absence -> working-time-account`                                        | `absence/shift-leave-recalc-resolver.ts`                                                                                                                                                                              | Block-2-Kandidat (#102-#104) |
| `absence -> scheduling`, `absence -> platform`                           | `absence/leave-days.ts` (eines der beiden neuen Blätter aus der Herauslösung)                                                                                                                                         | Block-2-Kandidat (#102-#104) |
| `working-time-account -> {absence, platform, scheduling, time-tracking}` | `working-time-account/overtime-balance.ts` (das zweite der beiden neuen Blätter)                                                                                                                                      | Block-2-Kandidat (#102-#104) |
| `time-tracking -> absence`                                               | `time-tracking/presence.ts`                                                                                                                                                                                           | Block-2-Kandidat (#102-#104) |
| `time-tracking -> working-time-account`                                  | `time-tracking/find-unconfirmed-break-days.ts` UND `time-tracking/entry-invariants.ts` (sechster, durch die reale Herauslösung entstandener zweiter Träger derselben Kantenrichtung — kein siebter Fachkopplungsfall) | Block-2-Kandidat (#102-#104) |
| `scheduling -> time-tracking`                                            | `scheduling/shift-netto.ts`                                                                                                                                                                                           | Block-2-Kandidat (#102-#104) |
| `scheduling -> working-time-account`                                     | `scheduling/shift-cleanup.ts`                                                                                                                                                                                         | Block-2-Kandidat (#102-#104) |

Jede dieser Kanten ist eine echte, wechselseitige Fachkopplung (Berufsschule/BS-Slot, Schicht/Soll,
Pause/Saldo, Überstundenberechnung, die alle vier Geschwisterkontexte erreicht) — Block-2-Material
(#102-#104, Ereignis-Architektur), keine Platzierungsfrage, die diese Phase noch hätte lösen können.

**Drei Korrekturen, offen ausgesprochen**, im Ton dieses Eintrags:

1. **Form Cs Begründung „keine Routenmodule in die `index.ts`" trug nur für die ~45
   Routen-Registrierer in `app.ts`.** Zwei Routen-MODULE (nicht Routen-Registrierer) exportierten
   kontextübergreifende Helfer — `absence/api/leave.ts` und `time-tracking/api/time-entries.ts` —
   genau deshalb die Herauslösung in eigene Blattmodule.
2. **Die erste Zyklenprojektion nannte 49 Module.** Das war falsch — die Simulation schob
   `app.ts`s 45 ausgenommene tiefe Importe in die Re-Export-Menge, als gäbe es die
   Kompositionswurzel-Ausnahme nicht. Korrigiert sind es **29** (Form C naiv).
3. **Die als angenommen geführte Restzyklen-Zahl war 20, dann 21, und ist real gemessen 22.** Der
   Owner bestätigte am 2026-09-17 auf Issue #101 die Korrektur von 20 auf **21** — diese Zahl war
   selbst eine Projektion (`--project all --extract-sim`), gemessen VOR jeder realen Umstellung, mit
   der ausdrücklichen Einschränkung (101B-ZYKLEN-BEFUND.md §8.4), dass sie nicht als Ersatz für die
   reale Pro-Welle-Messung gelten darf. Die reale, kumulative Messung am Ende jeder Welle blieb
   durchgehend einen Schritt über der Projektion (Welle 05: 8 real vs. 6 projiziert; Welle 07/08: 17
   real vs. 15/16 projiziert) — Ursache in jedem Fall dieselbe (§2a): die Simulation modellierte
   `time-tracking/entry-invariants.ts` und das Overtime-Blatt als EIN gemeinsames Blatt, während die
   reale, vom Owner selbst benannte Umbauform ZWEI daraus machte, und das zweite Blatt trägt eine
   eigene, unabhängige Kante in den Zyklus. Diese Differenz wurde nie aufgeholt — sie lief bis zum
   Schluss durch und landet in der letzten Welle bei **22 statt 21**. Der stehende CI-Gate misst
   deshalb den REALEN, gemessenen Wert (`--cycles --check 22`), nicht die Projektion — dieselbe
   Regel, die die gesamte Phase seit §8.4 befolgt: nachmessen, nicht übernehmen. Ein Dokument, das
   eine überholte Zahl stillschweigend fallen lässt, lehrt die nächste Leserin, seinen Zahlen zu
   misstrauen — deshalb stehen alle drei Korrekturen hier, nicht nur die ersten zwei.

`__tests__`-Verzeichnisse bleiben außerhalb dieser Regel (Owner-Entscheidung #246) — die 191 tiefen
Importe dort sind gemessen, benannt und unverändert, damit ein späteres Ticket sie nicht neu
entdecken muss.

Weiteres: `.planning/phases/101B-.../101B-WORKLIST.md` §14 (die Wellen-für-Welle-Messung),
`.planning/phases/101B-.../101B-ZYKLEN-BEFUND.md` (der volle Befund inkl. §2a/§7),
`apps/api/scripts/README.md` § Lint gates (die neue Gate-Dokumentation), Issue #101 (Owner-Kommentare
und der Abschlusskommentar dieser Phase).

## I — Vakuosität von Riegeln maschinell verboten (Phase 235, Issues #235/#240/#245)

**Eintrag I, im Ton und in der Form von Eintrag H (Phase 101B).** Warum dieser Eintrag existiert: #235, #240 und #245 beschreiben dieselbe Fehlerfamilie aus drei
Richtungen, mit **vier** realen Wiederholungen — die dritte ausgerechnet auf der Datei, um die das
erste Ticket ging. Derselbe Zug wie #101 (Eintrag H): eine Konvention durch Mechanik ersetzen, statt
ein fünftes Erinnerungsticket zu schreiben. Ein geschlossenes Kapitel ohne Protokoll sieht
rückblickend wie ein Kapitel aus, das nie stattgefunden hat.

### Was gebaut wurde

Ein AST-Klassifikator (`apps/api/scripts/lint-guard-vacuity-detect.ts`), der über echte TypeScript-
Binding-Auflösung — nie über einen Namens- oder Regex-Heuristik — erkennt, ob eine Datei den
Quellbaum über eines von sieben fs-Primitiven walkt (`readdirSync`, `opendirSync`, `globSync`,
`readdir`, `glob`, `execSync`/`spawnSync` mit `find`/`grep`/`ls`/`rg`, `import.meta.glob`) und auf
dem Ergebnis zusichert (`throw`, `expect`, `process.exit(<ungleich 0>)`,
`process.exitCode = <ungleich 0>`), UND ob diese Zusicherung durch einen Nicht-Leer-Beweis auf der
GEWALKTEN Menge selbst gedeckt ist — nie auf der Ausgabemenge (den Verstößen), die fast jedes dieser
Gates korrekterweise leer sehen will. Das CLI (`lint-guard-vacuity.ts`, `--rows`/`--guards`/
`--check <n>`/`--scope <prefix>`/`--json`) und das Ausnahmeregister
(`lint-guard-vacuity-exceptions.json`, ein Eintrag pro Datei mit Pflichtfeldern `reason` und
`disappearsIn`) sind Geschwister derselben Idee wie Eintrag H's `context-boundary-import-exceptions.json`.
Beide Durchsetzungspfade sind jetzt Mechanik, nicht mehr Konvention: ein neuer, unconditional CI-
Schritt (`Lint guard vacuity`, `.github/workflows/ci.yml`, unmittelbar nach `Check context import
cycles`) und eine dritte volle-Repo-Zeile in `.husky/pre-commit`, beide `--check 0`, beide durch
einen absichtlichen Verstoß rot bewiesen und zurückgenommen, nicht aus der Konfiguration angenommen
(Plan 235-09, Task 1 — die zwei Transkripte stehen in `235-09-SUMMARY.md`).

### Warum ein Skript und keine ESLint-Regel

Drei gemessene Gründe, nicht behauptete:

1. **`eslint src/` erreicht `scripts/` nie.** Sowohl `apps/api/package.json`s `"lint"`-Skript als
   auch der CI-Schritt `Lint API` (`.github/workflows/ci.yml:211`) rufen wörtlich
   `eslint src/ --no-warn-ignored` auf — `apps/api/scripts/` und `apps/web/scripts/` liegen
   außerhalb des übergebenen Pfads, unabhängig von jeder `ignores`-Konfiguration.
2. **Die Flat-Config schließt beide Apps' `scripts/**`zusätzlich explizit aus** — der
Typ-bewusste`files: ["**/*.ts"]`-Block in der Wurzel-`eslint.config.js`trägt`ignores: ["apps/web/scripts/**", "apps/api/scripts/**", ...]`mit derselben Begründung wie die
bereits dort dokumentierten`packages/types/src/\*\*`-Zeilen: kein `tsconfig.json`-Projekt deckt
diese Bäume ab. Selbst ein künftiger `eslint .`-Aufruf würde diese Dateien also weiterhin
   überspringen, ohne dass jemand die Zeile bewusst gelesen haben müsste.
3. **`lint-staged`s Glob (`*.{ts,js,svelte}`, Wurzel-`package.json`) trifft `.mjs` überhaupt
   nicht** — vier der 29 Riegel, die dieses Gate beweist (`lint-ui.mjs`, `lint-ui-classes.mjs`,
   `lint-save-pattern.mjs`, `scripts/lint-comment-language.mjs`), sind `.mjs`-Dateien. Eine ESLint-
   Regel, die nur über `lint-staged` liefe, würde diese vier strukturell nie erreichen.
4. **#101s eigene Regel schließt `__tests__` bewusst aus** (Owner-Entscheidung #246,
   `eslint.boundaries.mjs:42-45`, `BOUNDARY_IGNORES = ["**/__tests__/**", "**/*.test.ts"]`) — und
   genau dort liegt die Mehrheit dieser Riegel: 12 der 30 Befunde in `235-BEFUND.md` (Gruppen A und
   B) sind `*.test.ts`-Dateien.

Das ist der Absatz, der eine spätere „Aufräum"-Änderung verhindert, die dieses Gate in ESLint
faltet und dabei zwei Drittel seines Anwendungsbereichs (Skripte, Tests) stillschweigend verliert —
dieselbe Funktion, die Eintrag H's Glob-Absatz für `no-restricted-imports` bereits erfüllt.

### Was es gekostet hat, gemessen

**29 Riegel gesamt** (gemessen am Phasenende, `577 file(s) scanned`), verteilt über fünf Gruppen —
A (`apps/api/scripts/__tests__/`, 5), B (`apps/api/src/**/__tests__/`, 7), C
(`apps/api/scripts/*.ts` + `apps/api/src/utils/*.ts`, non-test, 9), D (`apps/web/src/__tests__/`,
4), E (vier `.mjs`-Werkzeuge, 4 geprüft — siehe die 27→29-Korrektur unten für den Grund, warum nur 2
davon zu Phasenbeginn als Riegel sichtbar waren). Ausgangslage: 23 von 27 gemessen vakuos (85%),
`235-BASELINE.md`, Plan 02. Endzustand: **0 vakuos, 1 begründete Ausnahme, 29 Riegel** — jeder
einzelne entweder maschinell nachgerüstet oder mit einer individuell begründeten Ausnahme versehen.
`235-BEFUND.md` (Plan 09, die konsolidierte Fassung der fünf Gruppen-Befunde) zählt **30 Funde**
gegen die 29 Riegel (ein Riegel, `absence-vocabulary-guard.test.ts`, trug zwei unabhängige,
strukturell getrennte Funde — G5 bereits bewiesen, G6 eine echte Lücke): **26 behoben**, **1
ausgenommen**, **3 benannt, aber nicht geschlossen** (siehe „Die benannte Grenze" unten). Jede
Gruppe erreichte `--scope <prefix> --check 0` durch Gleichheit, nicht durch Beobachtung — pro
Gruppen-SUMMARY re-gemessen an ihrem eigenen Ausgangspunkt, nie aus dem Plantext übernommen (die
phaseneigene Regel, die die 235-PLANKORREKTUR unten selbst erzwungen hat).

`check-test-completeness.mjs`s Testfloor stieg über die neun Wellen von **266/3184** (Plan-02-Start)
auf **266/3220** — jede einzelne Erhöhung aus einem gemessenen Vorher/Nachher-Lauf hergeleitet, nie
geschätzt, mit einer dokumentierten Korrektur unterwegs (Plan 07: die eigene `<verification>`-Zeile
verlangte „+4", tatsächlich waren es gemessen +2 — Copy-Paste-Rest aus Plan 04, korrigiert gegen die
Baseline statt stillschweigend übernommen).

### Das Ausnahmeregister

Eine Zeile, `apps/api/scripts/lint-guard-vacuity-exceptions.json`:

| `id`                                      | `file`                                    | Grund (gekürzt)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `disappearsIn`                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release-notes-fail-silent-boot-contract` | `apps/api/src/utils/release-notes.ts:256` | `loadReleaseNotes()`s Walk ist per dokumentiertem Vertrag fail-silent ("Never throws. Returns [] on any failure.") — dieser Vertrag existiert, weil die Funktion beim API-Modul-Init läuft: ein `throw` dort verhindert, dass der API-Prozess überhaupt startet. Ein Leer-Abbruch wäre hier aktiv FALSCH, nicht nur unerwünscht. Die drei `throw`s, die der Klassifikator fand, liegen in einer separaten, pfadgetrennten Funktion (`parseReleaseNote`, Markdown-Validierung pro Datei). Der reale Schutz (ein leeres/fehlendes `docs/release-notes/`-Verzeichnis im echten Repo) liegt bereits auf der Testseite: `release-notes.test.ts`s `corpusFiles`-Beweis schlägt laut fehl, falls das im Image gebackene Korpus je verschwindet. | „Never by design" — der Fail-Silent-Vertrag ist eine Korrektheitsanforderung (die API muss immer starten), keine Lücke, die dieses Register schließen will; nur eine bewusste Vertragsänderung an `loadReleaseNotes` könnte das ändern, eine architektonische Entscheidung außerhalb dieser Phase. |

Ein Register mit genau einem Eintrag ist ein Ergebnis, kein Zufall — die Phase hat sich selbst die
Regel gesetzt, dass ein Wachstum über niedrige einstellige Zahlen ein Halt-Signal ist ("die
Erkennung ist falsch, nicht die Riegel"), und sie nie erreicht.

### Die benannte Grenze

Was dieses Gate strukturell nicht sehen kann — benannt, nicht implizit gelassen, dieselbe Bewegung,
die Eintrag H für dynamische `import()` macht:

- **Ein Riegel, der den Baum NICHT walkt.** Eine reine Verhaltenszusicherung ohne fs-Primitiv kann
  durch ein verschwundenes Verzeichnis nicht entwaffnet werden, weil sie nie von einem Verzeichnis
  abhing — dieses Gate hat dafür nichts zu prüfen, und das ist korrekt, keine Lücke.
- **Vakuosität durch Stub/Mock** (die `#216`-Familie) — ein Test, der `vi.mock()` über die reale
  Implementierung legt und dadurch prüft, dass sein eigener Mock sich selbst gleicht, statt
  irgendetwas Echtes zu berühren. Ein anderer Fehlermechanismus als "leerer Walk", außerhalb dieses
  Klassifikators.
- **Generierter Code** — ein Walk über ein Verzeichnis, das ein Build-Schritt füllt, kann diesem
  Gate zufolge "beweisen", nicht-leer zu sein, obwohl der Build-Schritt selbst leise fehlgeschlagen
  sein könnte; das Gate sieht nur den Dateibaum zum Prüfzeitpunkt, nie die Kette, die ihn erzeugte.
- **Zwei echte, benannte Restlücken innerhalb des Klassifikators selbst**, aus `235-BEFUND.md`
  #13/#18: `check-import-targets.ts`s `.ts`-only-Filter würde eine `.mjs`-Datei unter einer
  gewalkten Wurzel unsichtbar machen (heute harmlos — keine existiert); `lint-tenant-scoping-
candidates.ts`s `extractWhereArgument` hat keinen `ts.isSpreadAssignment`-Zweig beim Auffinden des
  `where:`-Schlüssels selbst, sodass ein `findFirst({ ...ganzesObjektViaSpread })` durchrutscht statt
  laut `<unresolved>` zu melden — nicht live im Baum gefunden (per Grep bestätigt), aber ein
  inhaltlicher, kein Vakuositäts-Defekt, als Issue-Kandidat benannt, nicht eingereicht.
- **Vakuosität in einer PLAN- oder DOKUMENT-Datei, nicht in Quelltext.** Kein Quellbaum-Gate erreicht
  `.planning/`-Prosa — diese Phase demonstrierte das an sich selbst: `235-PLANKORREKTUR.md` (Befund
  vor Ausführungsbeginn) fand eine ungeprüfte Zahl (`lint:import-targets` als `1095` geplant, real
  `1074` bzw. `1079` an Plan 03s Start — aus einem STATE.md-Zwischenstand einer ANDEREN, längst
  abgeschlossenen Phase geerbt, nie selbst ausgeführt), eine grob geschätzte Dateizahl (`~330` geplant,
  real `620`), und vier ins Leere zeigende Zeilenverweise. `lint-guard-vacuity` hätte keinen dieser
  sechs Befunde gefunden — es prüft Quelltext-Riegel, keine Plandokumente. Das ist die ehrliche
  Grenze dieser Phase: Vakuosität in der Planung bleibt eine Frage der Prüfung durch einen zweiten
  Leser, nicht der Mechanik. Hier hat genau das funktioniert — der Plan-Checker fand den Befund vor
  Ausführungsbeginn, nicht danach.

### Die Korrekturen, offen ausgesprochen

**29 → 26 → 27 → 29, die Riegel-Gesamtzahl selbst.** CONTEXT.mds Erstmessung klassifizierte über ein
Namensmuster (`walk*(`) und traf damit `walkSaldoChain(rows)` in drei Dateien
(`audit-saldo-chain-integrity.ts` und beide `saldo-chain-integrity*.test.ts`) — reine
Speicher-Walker über DB-Zeilen, kein einziger `readdirSync`/`globSync`/`execSync` darin. Drei
Fehlalarme derselben Fehlerfamilie, nur in die andere Richtung: ein Prüfer, der zu VIEL trifft, ist
so wertlos wie einer, der zu wenig trifft — der Grund, warum diese Phase von Anfang an eine
AST-Erkennung über die echten fs-Primitive verlangt (AC-1), keine Namensheuristik. Die ROADMAP
korrigierte auf **26**. `235-BASELINE.md` (Plan 02) maß am selben Punkt neu und fand **27**, nicht
26 — nachgerechnet, nicht übernommen: zwei neue, dieser Phase selbst gehörende Dateien
(`lint-guard-vacuity.ts`, `lint-guard-vacuity-detect.test.ts`) plus **25 vorbestehende** ergeben 27;
eine dateigenaue Rekonstruktion der ursprünglichen 26 war aus den verfügbaren Aufzeichnungen NICHT
möglich (`CONTEXT.md` nennt seine Liste explizit eine „Auswahl", keine vollständige Aufzählung) —
ein Delta von −1 zu den behaupteten 26, dokumentiert statt angeglichen. Plan 08s Addendum (Finding
0, ein Koordinator-Hinweis fing es auf, bevor der Plan als abgeschlossen gemeldet wurde) schloss
eine echte Erkennungslücke des Klassifikators selbst: `isCpCommandWalk` erkannte
`ts.isStringLiteralLike`, aber keine `ts.TemplateExpression` (ein Template-Literal MIT `${…}`-
Substitution) — genau die Form, die `lint-ui.mjs` und `lint-ui-classes.mjs` für ihren
``execSync(`find '${scope}' ...`)``-Aufruf benutzen. Beide waren dem Klassifikator architektonisch
unsichtbar (`walks: false`), nicht bloß als vakuos fehlklassifiziert. Der Fix hob 27 auf **29** —
beide neu sichtbaren Riegel landen als BEWIESEN, nicht vakuos (Plan 07 hatte sie bereits mit einem
Leer-Abbruch gehärtet, nur sichtbar wurden sie erst hier). Ab hier zählt die gemessene 29, keine der
Vorgängerzahlen.

**Die Planungskorrektur (`235-PLANKORREKTUR.md`, Befund des Plan-Checkers vor Ausführungsbeginn).**
Eine Phase, die Prüfern vorwirft, auf ungeprüften Zahlen zu ruhen, tat dasselbe in ihrer eigenen
Planung, zweimal: `lint:import-targets` stand an sieben Stellen (`235-01-PLAN.md` ×4,
`235-05-PLAN.md` ×3) als `1095` — nicht erfunden, sondern aus `STATE.md`s Protokoll für Phase 101B
Plan 04 geerbt, ein Zwischenstand mitten in einer damals noch sechs Wellen laufenden Phase, ohne den
Befehl je selbst auszuführen. Real gemessen: `1074` (dann `1079` ab Plan 03, durch die Phase eigene
vier neuen relativen Importe verschoben). Wörtlich das Muster aus #245: eine Zahl, die einmal
stimmte, still aufgehört hat zu stimmen, und weiterhin geprüft aussieht. Zweitens: eine
Kostenaussage in zwei Threat-Model-Zeilen nannte „~330 Dateien" für den AST-Durchlauf — real `620`
(Faktor 2 daneben). Die Behebung war beide Male NICHT der Zahlentausch (das behebt die Instanz und
lässt die Fehlerklasse stehen), sondern die Form: keine stehende Zahl mehr im Plantext, jede
Gleichheitsprüfung liest aus `235-BASELINE.md` § Standing gates oder der SUMMARY der Welle, die den
Wert selbst gemessen hat. Ein mechanischer Vollständigkeitsnachweis (alle Ziffernfolgen aller acht
Pläne extrahiert, 1065 Vorkommen, 95 distinkte Tokens, 60 davon ≥10 einzeln disponiert) fand
zusätzlich vier ins Leere zeigende Zeilenverweise, behoben durch Symbol-Anker statt Zeilennummern.

**Weitere, kleinere Korrekturen, von den fünf Gruppen-SUMMARYs festgehalten:** Gruppe A war laut
`235-BASELINE.md` fünf Dateien, das Planfrontmatter von Plan 03 nannte nur vier (fehlte:
`lint-guard-vacuity-detect.test.ts`, dieser Phase eigene Welle-1-Testdatei) — die Baseline-Liste
galt, nicht das Frontmatter, und die fünfte Datei wurde mitgenommen. Gruppe E war laut Instrument
zwei Dateien, nicht die vier im Planfrontmatter genannten (Finding 0, oben). Ein `let`-then-
reassign-Muster (`lint-facade-signatures.ts`, dann `lint-saldo-lock-derivation.ts`) verbarg einen
bereits korrekten Leer-Abbruch vor dem Klassifikator — kein Vakuositätsdefekt der Datei, sondern
eine Erkennungslücke, in beiden Fällen mit derselben Einzeiler-Umstellung behoben. Eine echte,
vorher latente Kreuz-Scope-Validierungslücke in `lint-guard-vacuity.ts` selbst (der Werkzeug-Bug,
nicht Riegel-Befund, siehe `235-BEFUND.md`) wurde erst sichtbar, als A3s Ausnahmeeintrag zum ersten
Mal einen `--scope`-Lauf traf, dessen Wurzel den Eintrag nicht enthielt — gefunden und behoben unter
Regel 1/3, nicht als eigene Welle geplant.

### Was weitergereicht wird

Drei benannte, nicht geschlossene Restlücken (`235-BEFUND.md` #13, #18, plus die generischen
Grenzen oben) — keine davon live im Baum gefunden, alle als Fund benannt statt stillschweigend
übernommen oder verschwiegen:

- `check-import-targets.ts`s `.ts`-only-Walk-Filter (real aber harmlos heute) — kein Issue eröffnet,
  Behebung wäre eine unverwandte Erweiterung des Erweiterungsfilters, kein Vakuositätsdefekt.
- `lint-tenant-scoping-candidates.ts`s `extractWhereArgument`, fehlender
  `ts.isSpreadAssignment`-Zweig beim `where:`-Schlüssel selbst — ein inhaltlicher, kein
  Vakuositätsdefekt; Issue-Kandidat, noch nicht eingereicht.
- Die generischen Klassen-Grenzen oben (Stub/Mock-Vakuosität, generierter Code, Plan-Vakuosität)
  gehören keiner einzelnen Datei — sie sind Eigenschaften des Mechanismus selbst, für die nächste
  Phase, die eine dieser Formen antrifft, nicht für einen GitHub-Issue-Tracker.

#235, #240 und #245 werden mit einem deutschen, PII-freien Kommentar geschlossen, der auf diesen
Eintrag und `235-BEFUND.md` verweist (Plan 235-09, Task 3). Weiteres:
`.planning/phases/235-vakuositaet-von-riegeln-maschinell-verbieten/235-BEFUND.md` (die konsolidierte
Fundtabelle), `235-BASELINE.md` (die Ausgangsmessung), `235-PLANKORREKTUR.md` (die
Planungskorrektur), `apps/api/scripts/README.md` § Lint gates (die neue Gate-Dokumentation),
`CLAUDE.md` § Multi-Tenancy Convention (der Verweis-Eintrag für Leser ohne `.planning/`-Zugriff).

---

## J — ADR 0002 (Issue #110)

**Schwere: informativ. Nachtrag 2026-09-24 — ADR 0002 löst Teile von ADR 0001 ab.**

**Warum dieser Eintrag existiert:** Die Vorbemerkung zeigt drei Zeilen als Abweichungen, die ADR 0002
(`0002-vier-kontexte-und-unterbau.md`) neu einordnet. Blieben sie unkommentiert stehen, lernte die
nächste Leserin, der Tabelle zu misstrauen. Die Tabelle selbst bleibt unverändert als Messung auf
`263ed0aa`; dieser Eintrag sagt, wie sie ab ADR 0002 zu lesen ist.

### Offene Frage 1 ist geschlossen

ADR 0001 § Offene Fragen, Punkt 1 (Fremdschlüssel als Compliance-Kontrolle), ist durch
`0002-vier-kontexte-und-unterbau.md`, Entscheidung 4, beantwortet: Fremdschlüssel auf den Unterbau
sind erlaubt, zwischen gleichrangigen Kontexten bleiben sie verboten. Die Kontrolle
`onDelete: Restrict` auf `Employee → TimeEntry/LeaveRequest/Absence` bleibt in der Datenbank. ADR
0001 selbst trägt nur einen Verweis, sein Text ist unverändert.

### Die Vorbemerkungstabelle, neu gelesen

| Zeile der Vorbemerkung         | Stand `263ed0aa` (oben, unverändert) | Lesart ab ADR 0002, gemessen auf `bea6b5c7`                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ein Schema pro Kontext         | Abweichung                           | Keine Abweichung mehr — Arbeitspaket #105 (T10) mit Auslöser (Entscheidung 6)                                                                                                                                                                                                                                                                                 |
| Migrationen beim Kontext       | Abweichung                           | Keine Abweichung mehr — Arbeitspaket #106 (T12) mit Auslöser (Entscheidung 6)                                                                                                                                                                                                                                                                                 |
| Keine kontextübergreifenden FK | Abweichung                           | Erfüllt in der präzisierten Fassung: 28 kontextübergreifende Fremdschlüssel, alle 28 auf den Unterbau (18 auf `Employee`, 10 auf `Tenant`), 0 zwischen gleichrangigen Kontexten. Die „20 Modelle“ von damals sind heute 20 Fremdschlüssel auf `Employee` = 18 kontextübergreifend + 2 innerhalb des Unterbaus (`Invitation`, `WorkSchedule`) (Entscheidung 4) |
| Kein direkter Fremdzugriff     | Abweichung                           | Unverändert durch ADR 0002; seit Eintrag G gemessen erfüllt                                                                                                                                                                                                                                                                                                   |
| Ereignis-Integration           | Abweichung                           | Weiterhin 0 Treffer; die Handler-Arten sind die Regel für #102 (Entscheidung 10), kein Broker (Entscheidung 5)                                                                                                                                                                                                                                                |

Jede Zahl lässt sich mit dem Block in ADR 0002 § Kontext › „Belege nachrechnen“ nachrechnen.

### T11 entfällt

Das Kriterium stammt aus Issue #110; der Owner-Kommentar auf #110 vom 2026-09-24 hält fest, dass
der Bezeichner T11 in keinem eingecheckten Dokument vorkommt. Gemessen auf `bea6b5c7`: 0-mal in
`docs/` und `CLAUDE.md`; 8-mal in 4 Codedateien, dort durchweg als planinterne Aufgabenbezeichnung
von Phase 100B Plan 08 (`hardDeleteTimeDataForEmployee`), also in einem anderen Namensraum. Die
T-Reihe der Issues (#96–#113) hat kein T11 (T10 = #105, T12 = #106; auch T13, T16 und T17 fehlen).
Nachrechnen: `gh issue list --state all --limit 400 --json number,title --jq '.[] | select(.title | test("^T[0-9]+ ")) | "\(.number) \(.title)"'`.

Schluss, kein Beleg: T11 war das Arbeitspaket „Fremdschlüssel über Kontextgrenzen entfernen“, das
Regel 2 von ADR 0001 verlangt hätte. Dafür spricht der Text von #105: „Die Fremdschlüssel bleiben, wo
sie sind“, „Damit entfällt der frühere Blocker vollständig“, „Siehe T19“ — T19 ist #110.

Unabhängig von der Nummerierung gilt, wörtlich aus ADR 0002, Entscheidung 4:
Kein Arbeitspaket, das einen Fremdschlüssel auf den Unterbau entfernt oder abschwächt, existiert oder wird angelegt.

### Regeln 1 und 4: Auslöser statt Abweichung

Der Satz aus den Konsequenzen von ADR 0001, der heutige Code erfülle die Regeln 1–4 nicht, liest
sich seit ADR 0002 so: Die Regeln 1 und 4 sind Arbeitspakete mit Auslöser (Entscheidung 6 —
Migrationen verschiedener Kontexte kollidieren in der Praxis, oder eine Datenbankrolle muss pro
Kontext vergeben werden). Regel 2 ist in der präzisierten Fassung erfüllt. Regel 3 ist seit Eintrag G
erfüllt.

### Eintrag C: nur ein Verweis

Owner-Entscheidung vom 2026-09-24 auf #66: Backlog ohne Milestone, „derzeit kein Anlass“; es gibt
keine Entität Beschäftigung. Eintrag C bleibt, wie er steht. Kommt #66 zurück, ist es eine
Semantikänderung des Unterbaus und läuft durch das volle Verfahren aus ADR 0002, Entscheidung 7.

---

## K — Zugriffskontext und fail-closed `employeeScopeWhere()` (Phase 77b, Issue #77)

**Schwere: informativ. Nachtrag 2026-09-24 (Issue #77, Phase 77b) — Semantikänderung eines
Unterbau-Exports nach ADR 0002, Entscheidung 7.**

**Warum dieser Eintrag existiert:** `employeeScopeWhere()` ist ein Export von
`contexts/platform/index.ts`, und seine Bedeutung hat sich geändert — eine Semantikänderung im Sinn
von `0002-vier-kontexte-und-unterbau.md`, Entscheidung 7, die nach der Auslieferung hier
nachgetragen wird. Zugleich legt die Phase den Zugriffskontext an, an dem #91 die Reichweite
einschränken wird. Ohne Protokoll sähe die Hälfte, die bewusst offen blieb, wie Vergessenes aus.

### Was sich geändert hat

- **`employeeScopeWhere()` bindet den Mandanten in allen drei Varianten.** `employee` ergibt
  `{ employeeId, employee: { tenantId } }`, `employees` ergibt
  `{ employeeId: { in }, employee: { tenantId } }`, `tenant` ergibt `{ employee: { tenantId } }`
  (`apps/api/src/contexts/platform/facade/employee-scope.ts:66-80`). Vorher trug die
  `employee`-Variante nur die `employeeId` und die `employees`-Variante nur die ID-Menge (Stand
  `28009b3f`, `employee-scope.ts:57-60`); der Mandant im `EmployeeScope` war dort ein Pflichtfeld
  ohne Wirkung. Eine fremde `employeeId` passierte den Fassadenfilter.
- **Ein leerer Mandant wirft.** `undefined`, `null`, ein Nicht-String, `""` oder nur Leerzeichen
  ergeben `AccessContextError` (`requireTenantId()`, `contexts/platform/access-context-error.ts:34`)
  statt eines Filters. Es gibt keinen Rückfall-Mandanten.
- **Keine Fassaden-Aufrufstelle hat sich geändert.** Die Fassaden spreizen das Fragment wie bisher;
  die Rechen- und Hintergrundmodule, die ihren `EmployeeScope` noch als Literal bauen, sind durch
  dieselbe Bindung jetzt mitgeschützt, ohne angefasst worden zu sein.
- **Fehlender Kontext = HTTP 500.** `app.ts:169-178` fängt `AccessContextError` vor dem generischen
  Zweig ab, schreibt einen Fehler-Logeintrag mit Route und Methode und antwortet
  `500 { error: "Interner Serverfehler" }` — nie mit Daten, nie mit dem Fehlertext.
- **Eine fremde ID bleibt 404.** Ablehnungen für echte Entitäten eines fremden Mandanten sind
  unverändert und byte-gleich mit einer nirgends existierenden ID (T-100-09,
  `t100-09-oracle-probe.test.ts` grün). Ein fehlender Kontext ist ein Programmierfehler, kein Orakel.
- **Ein JWT ohne Mandant bekommt jetzt 500 statt einer leeren Antwort.** `auth.ts` stellt für einen
  Benutzer ohne Mitarbeiterdatensatz `tenantId: ""` aus (`contexts/platform/api/auth.ts:176`,
  `:270`, `:305`, `:383`, `:549`). Gemessen: Jeder Pfad, der einen Benutzer anlegt (POST
  `/employees`, `employees.ts:382`; `imports.ts:116`; `test-bootstrap.ts`; `seed.ts`;
  `seed-demo.ts`), legt den Mitarbeiter mit an — ein solches Token hat also keinen regulären
  Entstehungsweg. Auf den umgestellten Handlern (`/dashboard/team-week`, `/today-attendance`,
  `/my-week`, `/open-items`, Schichtplanung, Überstunden, Einstellungen) antwortet es mit 500 statt
  mit einem leeren 200. Das ist beabsichtigt, Issue #77: „Ein fehlender Kontext wird nie zu einem
  leeren Filter.“ GET `/dashboard/` behält seine datenbankfreie 200-Antwort mit leeren Kennzahlen
  für ein Token ohne `employeeId` (`composition/dashboard.ts:64`); der Zugriffskontext wird erst
  danach gebaut (`:79`).

### Der Zugriffskontext

`apps/api/src/contexts/platform/access-context.ts` trägt Mandant, Akteur und Reichweite. Es gibt
genau zwei Konstruktoren, beide rein und synchron, beide werfen bei fehlendem Mandanten, bevor
irgendeine Abfrage läuft:

- `accessContextFromRequest(req)` (`:58`) — Akteur `user` oder `apiKey` (Präfix `apikey:` im
  `sub`);
- `accessContextForJob(tenantId, job)` (`:79`) — Akteur `system`.

Die Reichweite kennt heute nur `{ kind: "wholeTenant" }` — bewusst nicht `"tenant"`, damit ein
Reichweiten-Literal nie mit einem `EmployeeScope`-Literal verwechselt werden kann.
`employeeScopeFor()` (`:98`) ist die einzige Funktion, die aus einem Zugriffskontext einen
`EmployeeScope` macht, und damit die eine Stelle, an der #91 die Reichweite auf Salon oder Personen
einschränken wird. Routendateien (`contexts/*/api/**`, `composition/dashboard.ts`,
`composition/reports.ts`) bauen einen Scope nur noch darüber;
`apps/api/src/__tests__/route-employee-scope-literals.test.ts` prüft das über den TypeScript-AST und
scheitert an jedem Literal. `findShiftConflict()` (`contexts/scheduling/api/shifts.ts:171`) nimmt
dafür den Zugriffskontext statt einer `tenantId`.

`AccessContextError` und `requireTenantId()` liegen in einem eigenen Blattmodul ohne Importe
(`access-context-error.ts`). Grund: `measure-context-boundary-imports.ts --cycles --check 22` zählt
auch reine Typ-Importe als Kante; ein Importpaar `access-context.ts` ↔ `facade/employee-scope.ts`
hätte einen neuen Zyklus erzeugt. Die Zyklenzahl ist unverändert 22.

### Was bewusst NICHT geschah

- **Die Mandantenfilter in den Routen bleiben — für #226.** `tenantId: req.user.tenantId` steht
  weiterhin an 117 Stellen in 21 Produktionsdateien. Dass es vorher 118 in 22 waren, ist keine
  Umstellung eines Filters: Die eine Fundstelle in `contexts/platform/api/settings.ts:993` (Stand
  `28009b3f`) war ein `EmployeeScope`-Literal, kein Prisma-Filter, und wurde mit den übrigen
  Scope-Literalen umgestellt.
- **Die Aliase `const tenantId = req.user.tenantId` bleiben.** `lint:tenant-scoping` erkennt einen
  Mandanten nur über `req.user.<feld>` und daran gebundene Namen
  (`apps/api/scripts/lint-tenant-scoping-request-bindings.ts:323-331`), nicht über
  `access.tenantId`. Eine Umstellung hätte das Gate rot gemacht oder neue Ausnahmen verlangt; beides
  ist #226.
- **Die Scope-Literale in Rechen- und Hintergrundmodulen bleiben** (Owner-Entscheidung auf #77): 30
  in 11 Dateien — `absence/leave-days.ts` (1), `time-tracking/arbzg.ts` (2),
  `time-tracking/plugins/attendance-checker.ts` (2), `working-time-account/close-month-data.ts` (3),
  `month-gap-check.ts` (1), `month-saldo.ts` (4), `overtime-balance.ts` (4),
  `plugins/auto-close-month.ts` (4), `recalculate-snapshots.ts` (4), `vocational-school-saldo.ts`
  (3), `services/phorest/sync-shifts.ts` (2). Die im Issue genannten „31“ zählten eine
  Docblock-Zeile in `absence/facade/absences.ts:104` (Stand `28009b3f`: `:103`) mit. Diese Literale sind jetzt durch das
  fail-closed `employeeScopeWhere()` gedeckt.
- **Die Rückfälle `employee?.tenantId ?? ""` in den Rechenmodulen blieben unangetastet.** Geprüft
  wurde, ob ein erreichbarer Pfad einen Scope mit leerem Mandanten baut (sieben Stellen in
  `overtime-balance.ts` und `vocational-school-saldo.ts`): Jeder Aufrufer arbeitet an einem
  existierenden Mitarbeiter, und ein voller Testlauf mit einer Sonde in `requireTenantId()` zählte
  24 Würfe, alle aus den neuen Tests, 0 aus einem Produktionspfad. Kein Frührücksprung, kein
  Ersatz-Rückfall.
- **Keine Zeilenrechte in der Datenbank, keine Prisma-Erweiterung** (`$extends`/`$use`), keine
  Umstellung der Cron-Plugins: `accessContextForJob()` hat noch keinen Produktionsaufrufer — #226.
- **Keine neue Ausnahme** in einem Ausnahmeregister; in `lint-tenant-scoping-exceptions.json`
  wurden nur Zeilennummern nachgezogen (20 Einträge, 43 Aufrufe, unverändert).

### Gemessen

Produktionsdateien unter `apps/api/src`, ohne `__tests__/` und `*.test.ts`:

| Größe                                          | vorher (`28009b3f`) | nachher           |
| ---------------------------------------------- | ------------------- | ----------------- |
| `EmployeeScope`-Literale in Routendateien      | 33 in 4 Dateien     | 0                 |
| `EmployeeScope`-Literale in Rechen-/Jobmodulen | 30 in 11 Dateien    | 30 in 11 Dateien  |
| `tenantId: req.user.tenantId`                  | 118 in 22 Dateien   | 117 in 21 Dateien |
| `req.user.tenantId`                            | 300 in 38 Dateien   | 297 in 38 Dateien |
| `CROSS_TENANT_ACCESS_DENIED`                   | 40 in 11 Dateien    | 40 in 11 Dateien  |
| API-Testdateien / Testfälle (Reporter)         | 282 / 3451          | 288 / 3512        |

Die drei entfernten `req.user.tenantId`-Treffer sind das Scope-Literal in `settings.ts` und die zwei
Aufrufargumente von `findShiftConflict()`. Die Testzahlen nachher stammen vom Lauf nach dem Merge
von `origin/main` (Phase 72b, +2 Dateien); Phase 77b selbst trägt 4 Dateien und 46 Laufzeitfälle
bei (5 + 21 + 15 + 4, dazu eine Tabellenzeile in `lint-guard-vacuity.test.ts` für den neuen
Walker).

Jeder neue Schutz war einmal rot, dann zurückgenommen:

- **M1:** `accessContextFromRequest()` nahm einen leeren Mandanten an —
  `access-context-missing.test.ts` wurde in drei Fällen rot, weil vor der 500 bereits eine
  `tenantConfig`-Abfrage lief bzw. (Schlüssel fehlt) der Prisma-Fehlertext im Antwortkörper stand.
- **M2:** `accessContextForJob()` übersprang die Mandantenprüfung — vier Fälle in
  `contexts/platform/__tests__/access-context.test.ts` rot.
- **M3:** Die `employee`-Variante verlor `employee: { tenantId }` — `employee-scope.test.ts` rot,
  darunter der Fall, in dem der Scope von Mandant A den Zeiteintrag eines Mitarbeiters von Mandant
  B zurückgab.
- **M4:** Ein `{ kind: "tenant", tenantId }`-Literal zurück in `composition/dashboard.ts` —
  `route-employee-scope-literals.test.ts` rot mit Datei und Zeile.

### Nachrechnen

```bash
# Route-file literals (expected: no match, exit 1)
git grep -cE 'kind: "(tenant|employee|employees)"' -- 'apps/api/src/contexts/*/api/**' \
  apps/api/src/composition/dashboard.ts apps/api/src/composition/reports.ts ':!**/__tests__/**'
# Calc/background literals (30 in 11; the two excluded files define the type and the factory)
git grep -nE 'kind: "(tenant|employee|employees)"' -- apps/api/src ':!**/__tests__/**' \
  ':!**/*.test.ts' ':!apps/api/src/contexts/platform/access-context.ts' \
  ':!apps/api/src/contexts/platform/facade/employee-scope.ts' | grep -v ' \* ' \
  | awk -F: '{f[$1]++} END {n=0; for (k in f) n+=f[k]; print n, length(f)}'
# Occurrences and files; swap the pattern for 'req.user.tenantId' / 'CROSS_TENANT_ACCESS_DENIED'
git grep -o 'tenantId: req.user.tenantId' -- apps/api/src ':!**/__tests__/**' ':!**/*.test.ts' \
  | awk -F: '{f[$1]++} END {n=0; for (k in f) n+=f[k]; print n, length(f)}'
# Gates
pnpm --filter @clokr/api run lint:tenant-scoping
pnpm --filter @clokr/api exec tsx scripts/measure-context-boundary-imports.ts --cycles --check 22
pnpm --filter @clokr/api run test:setup
pnpm --filter @clokr/api exec vitest run src/__tests__/route-employee-scope-literals.test.ts \
  src/__tests__/access-context-missing.test.ts src/contexts/platform/__tests__/access-context.test.ts \
  src/contexts/platform/__tests__/employee-scope.test.ts
```

Für den Vorher-Stand dieselben `git grep`-Befehle mit `28009b3f` vor dem `--`; weil `git grep`
dann jede Zeile mit `28009b3f:` beginnt, zählt `awk` über `$2` statt `$1`. Der zweite Befehl zählt
auf `28009b3f` die 33 Routenliterale mit (63 in 15 Dateien = 33 in 4 + 30 in 11).

**Offen, nicht Teil dieser Phase:** Der generische Zweig in `app.ts` (`:179-182`) gibt bei jedem
unerwarteten Fehler `error.message` wörtlich an den Client zurück — bei Prisma-Fehlern samt
Aufruftext und absolutem Serverpfad. Vorbestehend, hier nicht geändert (nur der neue
`AccessContextError`-Zweig hat einen festen Text); Kandidat für ein eigenes Issue.

**Nachtrag 2026-09-24 (Issue #330, PR #331):** Erledigt. Bei Status ≥ 500 antwortet der
generische Zweig jetzt immer mit `{"error":"Interner Serverfehler"}`; die Originalmeldung steht
nur im Log, mit Route und Request-ID (`error-handler-5xx.test.ts`).

---

## L — Öffnungszeiten wandern an den Salon (Phase 64b, Issue #64)

**Schwere: informativ. Nachtrag 2026-09-24 — Semantikänderung des Unterbaus nach ADR 0002,
Entscheidung 7.**

**Was sich geändert hat:** Der Unterbau hat ein neues Modell `Salon` unterhalb von `Tenant`
(Erweiterung). Dazu wandert ein Wert zwischen Unterbau-Modellen (Semantikänderung): Die
Öffnungszeiten gehören jetzt dem Salon (`Salon.openingHours`). `TenantConfig.storeHours` ist als
veraltet markiert (`/// @deprecated` in `packages/db/prisma/schema.prisma`). Die Migration
`20260924071637_add_salon` legt für jeden bestehenden Mandanten genau einen aktiven Standard-Salon an.
Er heißt wie der Mandant und übernimmt `TenantConfig.storeHours` unverändert. Der Zugriff läuft nur
über `contexts/platform/facade/salons.ts`, erreichbar über `contexts/platform/index.ts`.

**Was bewusst noch nicht umgestellt ist:** Die Schicht-Öffnungszeitprüfung
(`assertWithinStoreHours()` in `apps/api/src/contexts/scheduling/api/shifts.ts`) liest bis #325
weiter den Mandantenwert `TenantConfig.storeHours`, denn eine Schicht kennt noch keinen Salon. Die
Schichtplanungsseite (`apps/web/src/routes/(app)/shifts/+page.svelte`) liest die geschlossenen
Wochentage ebenfalls weiter über `GET /settings/work`. Das legt die Owner-Entscheidung vom
2026-09-24 auf #64 fest.

**Wie die beiden Werte bis #325 gleich bleiben:** Ändert `PUT /api/v1/settings/work` die
Mandanten-Öffnungszeiten und hat der Mandant genau einen aktiven Salon, schreibt derselbe Aufruf
die Werte in dieselbe Transaktion auch in diesen Salon. Dazu kommt ein eigener Audit-Eintrag
`UPDATE Salon` mit altem und neuem Wert. Den Spiegel übernimmt `syncSoleActiveSalonOpeningHours()`.
Gespiegelt wird nur bei einer echten Änderung. Bei mehr als einem aktiven Salon wird nicht
gespiegelt, weil offen wäre, welchen Salon der Mandantenwert meint. #325 entfernt den Spiegel
zusammen mit der Umstellung der Prüfung.

**Was verhindert, dass neue Logik den alten Wert liest:** `apps/api/src/__tests__/store-hours-readers.test.ts`
hält die heute erlaubten Stellen fest, an denen der Code `storeHours` liest. Jede neue Stelle macht
den Test rot.

**Mandantengrenze:** Der Fremdschlüssel `Salon → Tenant` bleibt im Unterbau, mit
`onDelete: Restrict` (ADR 0002, Entscheidung 4). Ein Salon wird nie gelöscht, nur deaktiviert.
Die Routen mit Pfadparameter unter `/api/v1/salons/:id` stehen als `probe` im T-100-09-Register.

### Nachtrag 2026-09-24 — Phase 325 (Issue #325)

**Was sich geändert hat:** `Shift.salonId` und `PhorestAppointment.salonId` sind Pflicht-Fremdschlüssel
auf `Salon` mit `onDelete: Restrict` — die Frage, die die Prüftabelle von ADR 0002 für #325 offen ließ,
hier entschieden, weil ein Salon nie hart gelöscht wird und Schichten revisionsrelevant sind. Die
Migration `20260924145508_shift_salon` gibt jeder bestehenden Schicht und jedem Termin den Default-Salon
des Mandanten (frühester aktiver Salon; nur in der Migration als Rückfall der früheste Salon überhaupt)
und ändert an diesen Zeilen nichts außer `salonId`. Neue Fassadenfunktion `findDefaultSalon()` (additiv,
Erweiterung nach ADR 0002 Entscheidung 7).

**Die Öffnungszeitprüfung:** `assertWithinStoreHours()` liest seit #325 die Öffnungszeiten des Salons der
Schicht; `shiftStoreHoursMode` bleibt eine Mandanteneinstellung. Für einen Mandanten mit einem Salon ist
das Verhalten nachweislich gleich (Tabelle in `shift-store-hours-salon.test.ts`, vor der Umstellung gegen
den alten Leser aufgenommen).

**Abweichung von Eintrag L:** Der Spiegel `syncSoleActiveSalonOpeningHours()` bleibt entgegen dem Satz
oben bis #82 — Begründung D-13: die einzige Öffnungszeiten-Oberfläche (`admin/system`) schreibt weiter
`TenantConfig.storeHours`; ohne Spiegel wäre jede Änderung dort für die Prüfung unsichtbar und ein
Mandant mit einem Salon verhielte sich anders (widerspricht #325 AC-5). Der Spiegel ist ein Schreiben in
den Salon, kein fachliches Lesen. Die Schichtplanungsseite liest `storeHours` weiter nur zur Anzeige
geschlossener Wochentage (D-16), ebenfalls bis #82. `store-hours-readers.test.ts` erlaubt nur noch
`settings.ts`.

**Mandantengrenze:** kein Datenbank-Trigger (eine Instanz pro Kunde, #226); die Anwendung prüft über
`findSalon()` mandantengebunden, fremde und nicht existierende Salon-IDs werden byte-gleich mit 404
abgelehnt (T-100-09). `POST /api/v1/shifts/bulk` prüft seit #325 zusätzlich, dass jeder Mitarbeiter zum
Mandanten gehört — sonst hätte eine Schicht einen Salon eines fremden Mandanten bekommen können
(vorher fehlende Prüfung, beim Bau gefunden).

**Phorest:** Bis #65 schreibt die Synchronisation den Default-Salon; ohne aktiven Salon bricht der Lauf
mit Fehler ab, bestehende Schichten werden nie umgehängt.

---

## M — Phorest-Filiale je Salon: `SalonCoupling` löst `TenantConfig.phorestBranchId` ab (Phase 65b, Issue #65)

**Schwere: informativ. Nachtrag 2026-09-25 — Semantikänderung des Unterbaus nach ADR 0002,
Entscheidung 7, und neue Fremdschlüssel auf den Unterbau.**

**Was sich geändert hat:** Die Schichtplanung bekommt ein neues Modell `SalonCoupling` (höchstens
eine Kopplung je Salon, Provider-Enum mit dem einzigen Wert `PHOREST`, Filialkennung eindeutig je
Mandant und Provider — bewusst nicht global, T-100-09). `TenantConfig.phorestBranchId` ist als
veraltet markiert (`/// @deprecated` in `packages/db/prisma/schema.prisma`); kein Produktivcode
liest oder schreibt die Spalte mehr, mechanisch belegt durch
`apps/api/src/__tests__/phorest-branch-id-deprecated.test.ts`. Die Spalte bleibt für den
Rückfallweg erhalten und wird in einem späteren Ticket entfernt (wie `storeHours` in #64). Die
Migration `packages/db/prisma/migrations/20260925004150_salon_coupling/` koppelt jeden Mandanten
mit einer nicht-leeren, getrimmten `phorestBranchId` an seinen Default-Salon — dieselbe Regel wie
`findDefaultSalon()` (frühester aktiver Salon, sonst frühester überhaupt); ein Mandant ohne Wert
oder mit nur Leerraum bekommt keine Kopplung; jeder bestehende `PhorestSyncRun` bekommt denselben
Default-Salon. `phorestBranchId` wird dabei nicht gelöscht.

**Neue Shared-Kernel-Abhängigkeiten:** `SalonCoupling.salonId -> Salon`, `SalonCoupling.tenantId ->
Tenant`, `PhorestSyncRun.salonId -> Salon`, alle mit `onDelete: Restrict` (ADR 0002, Entscheidung 4) — ein Salon mit Kopplung oder Sync-Lauf kann nie gelöscht werden. Dieselbe Mandantengrenze wie
bei #64/#325: kein Datenbank-Trigger (eine Instanz pro Kunde, #226), die Anwendung löst Salons nur
über `findSalon()`/`listSalons()` auf. Die `tenantId`-Spalte auf `SalonCoupling` trägt die
mandantenweite Eindeutigkeit (`@@unique([tenantId, provider, externalBranchId])`) und macht jede
Abfrage über die Tabelle mandantenfähig für `lint:tenant-scoping`.

**Abgleich je Salon:** Ein gemeinsamer Orchestrator (`syncPhorestForTenant`,
`apps/api/src/services/phorest/sync-tenant.ts`) läuft für Cron und manuellen Trigger gleich, unter
der unveränderten mandantenweiten Advisory-Lock, einmal je gekoppeltem AKTIVEM Salon. Jede
Abgleich-Prüfung ist zusätzlich auf den Salon des Laufs eingegrenzt: GATE 3, das Stornieren
verwaister Schichten, der Schutz bei offenem Urlaubsantrag, die Übernahme bestehender
MANUAL-Schichten (Adopt-on-match, `sync-shifts.ts:564`) und der Phorest-Master-Ersetzen-Durchlauf
(`sync-shifts.ts:898`) sowie das harte Ersetzen von Terminen (`sync-appointments.ts`). Die
Begrenzung von Übernahme und Ersetzen-Durchlauf geht über den wörtlichen Kriterienkatalog des
Issues hinaus — sie folgt aus dem Grundsatz "ein Lauf für Salon A ändert nichts an Salon B" und ist
für einen Mandanten mit einem Salon byte-gleich zum bisherigen Verhalten. Der
Schicht-/Termin-Schlüssel (`phorestShiftKey()`/`phorestAppointmentKey()`,
`apps/api/src/services/phorest/types.ts:229`/`:250`) bleibt UNVERÄNDERT, damit der erste Lauf nach
der Migration nicht jede bestehende Schicht storniert und neu anlegt. Folge: Trifft ein Lauf auf
eine externe ID, die bereits einem ANDEREN Salon gehört (`sync-shifts.ts:512`), wird der Slot
übersprungen, nie umgehängt — gezählt im laufinternen Zähler `skippedOtherSalon` (kein DB-Feld,
gleiches Muster wie `protectedPendingLeave`).

**Was verhindert, dass der alte Wert zurückkommt:**
`apps/api/src/__tests__/phorest-branch-id-deprecated.test.ts` — vier Wurzeln (`apps/api/src`,
`apps/api/scripts`, `apps/web/src`, `packages/db/src`), AST-Suche nach dem Bezeichner
`phorestBranchId`, zweimal rot gesehen (eine `.ts`-Referenz, eine Svelte-Markup-Referenz) und
danach wiederhergestellt.

**API und Oberfläche:** Kopplungs-Routen
(`GET/POST/DELETE /api/v1/integrations/phorest/couplings[/:salonId]`,
`integrations.ts:251/279/374`), alle auditiert; das Löschen einer Kopplung ist ein harter Delete
(Konfiguration, keine Zeitdaten — Owner-Entscheidung wie bei `storeHours`, #64) und rührt
Schichten, Termine und Sync-Läufe nicht an (deren Fremdschlüssel zeigt auf den Salon, nicht auf die
Kopplung). Die DELETE-Route steht als `probe` im T-100-09-Register. Test-, Mitarbeiter- und
Termin-Kollisions-Routen lösen ihre Filiale über `resolvePhorestCoupling()` auf
(`integrations.ts:168-213`): ohne Salonangabe genau eine aktive Kopplung, sonst
`400 SALON_REQUIRED`; eine explizit angegebene Salon-ID darf auch einen eigenen, INAKTIVEN Salon
benennen (derselbe Zweig prüft `isActive` bewusst nicht). Der Kollisions-Deep-Link
(`GET /phorest/appointment-collisions`) blockiert die Kollisionszählung nie wegen der
Salon-Auflösung — bei mehreren Kopplungen ohne Salonangabe liefert er `deepLink: null` statt eines 400. Die Konfig-API (`GET/PUT /phorest/config`) bleibt für Mandanten mit genau einem aktiven Salon
unverändert nutzbar; bei mehr als einem aktiven Salon antwortet PUT mit einer neuen Branch-ID auf
`400 BRANCH_PER_SALON` (`integrations.ts:465-469`). Die Admin-Seite
(`apps/web/src/routes/(app)/admin/phorest/+page.svelte`) sperrt das Branch-ID-Feld in diesem Fall
mit einem deutschen Hinweis; eine Mehrfach-Kopplungs-Oberfläche folgt erst mit #82 ff.

**Bewusst nicht:** ein Studiolution-Provider-Wert, das Entfernen der Spalte `phorestBranchId`, ein
filialbewusster Schicht-/Termin-Schlüssel, ein Sync-Fenster/Cron je Salon (bleibt mandantenweit),
und eine Änderung an der env-gesteuerten E2E-Test-Bootstrap-Teardown
(`apps/api/src/contexts/platform/api/test-bootstrap.ts:296-299`): E2E-Mandanten legen nie eine
Phorest-Kopplung oder einen Sync-Lauf an, daher blockiert die bestehende
`Restrict`-Fremdschlüsselkette das Löschen des Salons dort nicht, und die Teardown-Liste ließ die
beiden neuen Tabellen unverändert aus.

**Bekannte Grenze:** Ein Mandant, der schon vor dieser Phase mehr als einen Salon hatte und dessen
Default-Salon sich nach #325 geändert hat, behält ältere PHOREST-Schichten auf dem früheren
Default-Salon. Der Lauf des gekoppelten Salons überspringt sie (gezählt in `skippedOtherSalon`,
sichtbar in der Antwort des manuellen Triggers) und hängt sie nie um. Mandanten mit genau einem
Salon sind davon nicht betroffen. Es wird nur gesagt, was gemessen wurde — keine Aussage über
Produktionszahlen.

Der Satz "Phorest: Bis #65 schreibt die Synchronisation den Default-Salon; ohne aktiven Salon
bricht der Lauf mit Fehler ab, bestehende Schichten werden nie umgehängt." am Ende des Nachtrags zu
Eintrag L (Phase 325) ist mit diesem Eintrag abgelöst.

---

## N — Die API entscheidet über Permissions statt über Rollen (Phase 75b, Issue #75)

**Schwere: informativ. Nachtrag 2026-09-25 — Semantikänderung des Unterbaus nach ADR 0002,
Entscheidung 7.**

**Warum dieser Eintrag existiert:** Bis Phase 75b entschied die API jede Zugriffsfrage über
`User.role` (bzw. den `role`-Claim im JWT) und den Guard `requireRole(...)`. Seitdem entscheidet sie
über die Permissions der gespeicherten Rollenzuweisungen (#72 Katalog, #73 Rollen, #74 Zuweisungen).
`User.role` bleibt als Spalte stehen, ist aber kein Eingang einer Zugriffsentscheidung mehr, sondern
ein aus den Zuweisungen abgeleitetes Kompatibilitätsfeld. Die Bedeutung eines Unterbau-Felds ändert
sich also, und es kommen neue Exporte von `contexts/platform/index.ts` hinzu — eine Semantikänderung,
die nach der Auslieferung hier nachgetragen wird. Der Umbau ist **rechteneutral**: Keine Person,
kein API-Schlüssel und keine Benachrichtigung bekommt durch ihn mehr oder weniger Zugriff. Das ist
nicht behauptet, sondern gegen eine Aufnahme des alten Codes geprüft (unten, „Gemessen“).

### Was sich geändert hat

- **Drei globale Systemrollen mit festen Ids** (D-01): Admin `00000000-0000-4000-8000-00000000a001`
  (87 Permissions), Manager `…a002` (63), Mitarbeiter `…a003` (22),
  `apps/api/src/contexts/platform/system-roles.ts:33`. Der Code erkennt eine Systemrolle nur an der
  Id, nie am Namen. Die drei Mengen sind nicht ausgedacht, sondern aus der Spalte „heute“ von
  `docs/permissions.md` abgeleitet (D-03); `system-roles.test.ts` parst das Dokument und vergleicht.
- **Eine reine Datenmigration** (`packages/db/prisma/migrations/20260925070842_system_roles_and_legacy_role_assignments/`):
  legt die drei Rollen an und gibt jedem Nutzer mit nicht anonymisiertem Mitarbeiter und ohne
  bisherige Zuweisung genau eine `TENANT`-Zuweisung auf die Systemrolle seiner Alt-Rolle, mit je
  einem Audit-Eintrag (`userId` NULL, `origin: "SYSTEM"`, `legacyRole`). Additiv (kein Schema-Diff,
  `User.role` wird nicht geschrieben) und idempotent. Eine `RAISE NOTICE` meldet vier Zahlen, die
  jeden `User` genau einmal zählen; `docs/migrations.md` § Phase 75b enthält die lesende Abfrage,
  die dieselben Zahlen liefert, und ein Test liest sie aus dem Dokument.
- **Ein Auflöser je Anfrage** (`apps/api/src/contexts/platform/request-permissions.ts:111-157`)
  lädt einmal pro Anfrage die wirksamen Permissions des Aufrufers — getrennt nach ZUGEWIESEN und
  EIGENE plus eigener Mitarbeiter-Id. Darauf bauen `requirePermission` / `requireAnyPermission`
  (Guards, `:211`/`:227`, 401 und 403 `{ error: "Forbidden" }` byte-gleich zu früher),
  `hasPermission` und `permissionReach` (Prüfungen im Handler, `:177`/`:187`) und
  `userIdsHoldingPermission` (Empfängersuche, `contexts/platform/facade/role-assignments.ts:289`).
  Alle sind nur über `contexts/platform/index.ts` erreichbar.
- **`requireRole` ist gelöscht** (`middleware/auth.ts`, D-18). 143 Guard-Aufrufstellen, 39
  Rollenprüfungen im Handler und 17 Empfängersuchen fragen Permissions ab; jede Stelle steht mit
  ihrer Permission in `docs/permissions.md` (Abschnitte „Aufrufstellen der Permission-Guards“,
  „Handler-Prüfungen“, „Empfängersuchen“), und `permission-site-mapping.test.ts` vergleicht je Datei
  Anzahl und Permission-Multimenge mit dem Dokument.
- **Neue Rollenprüfungen sind maschinell verboten** (D-19): `lint:role-checks`
  (`apps/api/scripts/lint-role-checks.ts`, in CI und `.husky/pre-commit`) findet über den
  TypeScript-AST jeden `requireRole(`-Aufruf und jeden Vergleich, jede Mengenprüfung, jeden
  `switch` und jedes Prisma-`where` auf einen Rollenwert in `apps/api/src` (ohne Tests). Einzige
  erlaubte Datei: `contexts/platform/compat-role.ts`. Eine Ausnahmeliste gibt es nicht.
- **API-Schlüssel** (D-11/D-30): Ein Schlüssel mit Scope `admin` bekommt die Permissions der
  Admin-Systemrolle, jeder andere die der Manager-Rolle, beides mandantenweit und ohne eigenen
  Mitarbeiter (`request-permissions.ts:115-121`) — genau die Wirkung, die `requireAuth` einem
  Schlüssel bisher über die Rolle gab (`middleware/auth.ts:52-58`). Andere Scopes wirken weiter nicht.
- **`User.role` wird abgeleitet und zurückgeschrieben** (D-14): `deriveCompatRole()`
  (`compat-role.ts:90`) ergibt ADMIN bei einer `TENANT`-Zuweisung auf die Admin-Systemrolle, sonst
  MANAGER bei mindestens einer ZUGEWIESEN-Permission, sonst EMPLOYEE. Anmeldung, OTP und Refresh
  stellen den `role`-Claim daraus aus; jede Änderung einer Zuweisung (POST/PATCH/DELETE
  `/role-assignments`, Rollenwechsel in `POST`/`PATCH /employees`, CSV-Import) schreibt die Spalte
  zurück. Ändert sich die Spalte, trägt der Audit-Eintrag der auslösenden Zuweisungsänderung
  `compatRole: { from, to }` (D-29, `role-assignment-audit.ts:138-155`). `PATCH /employees/:id`
  schreibt Rollenteil und Mitarbeiterfelder in einer Transaktion (D-31): Ein 409 der
  Aussperr-Sperre aus #74 hinterlässt nichts.
- **17 Empfängersuchen, nicht 16** (D-16/D-17): Das Issue nannte 16; die Admin-Benachrichtigung
  bei gesperrtem Konto (`ACCOUNT_LOCKED`, `contexts/platform/api/auth.ts`) ist die siebzehnte und
  ebenfalls umgestellt. Jede Stelle behält alle übrigen Filter und ersetzt nur das Rollenprädikat
  durch die Menge der Halter einer Permission.

### Was bewusst NICHT geschah

- **Keine Salon- oder Personengrenze an der API** (#91). Eine Zuweisung mit Scope `SALONS` oder
  `PERSONS` gewährt in 75b mandantenweit nichts (D-09, fail-closed); ZUGEWIESEN-Permissions wirken
  nur aus einer `TENANT`-Zuweisung.
- **Keine Umstellung der Oberfläche und kein Entfernen von `User.role` / Enum `Role`** (#83). Das
  Frontend liest weiter den `role`-Claim.
- **Keine neuen Systemrollen** (#76) und **kein Permission-System für API-Schlüssel-Scopes**.
- **Keine erneute Prüfung von `User.isActive` je Anfrage.** Ein noch gültiges Zugriffstoken eines
  inzwischen deaktivierten Nutzers wirkt wie vorher bis zu seinem Ablauf; das zu ändern wäre nicht
  rechteneutral (Härtungs-Kandidat).
- **#333 unangetastet:** Der Audit-Eintrag eines API-Schlüssels verletzt weiter den Fremdschlüssel
  auf `User` (500 nach dem Schreiben). Die Matrix hat diese 500 so aufgenommen, wie sie vorher war.
- **Die Sperren blieben byte-gleich und unabhängig von Permissions** (AC-75-17): Selbstgenehmigung
  von Urlaub und Zeitnachtrag, das Vier-Augen-Prinzip bei der Stornierung und beim endgültigen
  Löschen. Die Matrix nimmt ihre deutschen Ablehnungstexte als Zellen auf.

### Übergangs- und Randregeln

- **Alt-Rollen-Rückfall** (D-08): Hat ein Nutzer im Mandanten KEINE gespeicherte Zuweisung, gilt
  eine implizite `TENANT`-Zuweisung auf die Systemrolle von `User.role`
  (`request-permissions.ts:142-145`). Für jeden migrierten Nutzer ist der Rückfall damit ruhend; er
  existiert für Nutzer, die ein Weg ohne Zuweisung anlegt (Test-Fixtures, Seeds,
  `test-bootstrap.ts`) und für die Zeit eines Rolling Deploys. Eine einzige gespeicherte Zeile
  schaltet ihn ab, auch eine fehlerhafte (die trägt dann nichts bei). Der Rückfall wird mit
  `User.role` in #83 entfernt.
- **Materialisierung beim ersten Schreiben** (D-26): Ändert ein Schreibweg die Zuweisungen eines
  Nutzers ohne gespeicherte Zuweisung, legt er zuerst in derselben Transaktion die Rückfall-Zuweisung
  als echte Zeile an (Audit mit `reason: "Übernahme der Alt-Rolle (#75)"`,
  `role-assignment-audit.ts:83`) und wendet erst dann die Änderung an. Eine erste Kundenrolle nimmt
  so nie still die Alt-Rolle weg. Ändert sich die wirksame Rolle nicht, schreibt der Weg nichts.
- **Anonymisierung lässt `User.role` stehen** (Abweichung von D-14): Die Anonymisierung löscht wie
  seit #74 alle Zuweisungen, schreibt die Spalte aber NICHT auf EMPLOYEE zurück
  (`contexts/platform/anonymize.ts:135-143`). Sonst verlöre das noch gültige Token eines Admins, der
  sich selbst anonymisiert, mitten in der Sitzung seine Rechte — zwei aufgenommene Zellen der Matrix
  (`DELETE /api/v1/employees/:id`, fremd, ADMIN und FALLBACK_ADMIN) wären von 204 auf 403 gekippt.
  Die Anmeldung ist so oder so weg (Passwort und Refresh-Tokens werden entfernt).
- **Das Token eines gelöschten Nutzers hält nichts** (T-75b-28): Gibt es die `User`-Zeile nicht
  mehr, ergibt der Auflöser keine Permission (`request-permissions.ts:140`). Vorher ließ der
  `role`-Claim das Token bis zu seinem Ablauf durch. Das ist die einzige beabsichtigte Verengung.
  Betroffen ist nur ein Zugriffstoken, das nach dem endgültigen Löschen seines Nutzers bis zum
  Ablauf weiterbenutzt wird; keine aufgenommene Zelle der Matrix ändert sich dadurch.
- **Rolling Deploy:** `apps/api/docker-entrypoint.sh` fährt `migrate deploy` beim Start des neuen
  Containers, während der alte noch Anfragen bedient. Ändert der alte Pod in diesem Fenster eine
  Rolle, schreibt er nur `User.role`. `docs/migrations.md` § Phase 75b, Schritt 3, enthält die lesende
  Konsistenzabfrage, die genau diese Nutzer findet, und die Abhilfe (die Rolle über den neuen Code
  erneut speichern).
- **Rollback:** Das vorige Release liest weder `AccessRole` noch `RoleAssignment`; `User.role` ist
  für jeden migrierten Nutzer unverändert (AC-75-8). **Einschränkung:** Sobald ein Nutzer eine
  Kundenrolle mit mindestens einer ZUGEWIESEN-Permission hält, steht in `User.role` MANAGER — ein
  Rollback über 75b hinweg läse ihn als vollen Manager. Vor 75b hält kein produktiver Nutzer eine
  Kundenrolle; das Risiko entsteht erst mit der Nutzung von #73/#74.
- **Anonymisierte Nutzer sind von der Migration ausgenommen** (D-28, Abweichung vom Wortlaut der
  Akzeptanzkriterien, die „jeden Nutzer“ nennen): Ein anonymisierter Mitarbeiter hat keine Anmeldung
  mehr und seit #74 keine Zuweisung; eine neue Zuweisung gäbe ihm wieder Rechte. Die NOTICE zählt
  diese Nutzer in einer eigenen Zahl.

### Auswirkung auf die Kontexte

- **Zeiterfassung:** Guards und die Eigentumsprüfungen in `time-entries.ts`,
  `retro-entry-requests.ts`, `terminals.ts`, `admin-presence-sources.ts` fragen Permissions ab;
  acht Empfängersuchen (drei in `time-entries.ts`, eine in `retro-entry-requests.ts`, vier in
  `attendance-checker.ts`) gehen über `userIdsHoldingPermission`. Verhalten unverändert.
- **Abwesenheiten:** Guards und Handler-Prüfungen in `leave.ts`, `special-leave.ts`,
  `leave-settings.ts`, `company-shutdowns.ts`, `vocational-school*.ts`; `canSeeLeaveType` nimmt ein
  `canSeeAll` statt einer Rolle. Die Empfängersuchen für Anträge, Erinnerungen und den
  Übertrag-Hinweis sind umgestellt. Die Selbstgenehmigungs- und Stornier-Sperren sind unverändert.
- **Schichtplanung:** `shifts.ts`, `shift-patterns.ts`, `integrations.ts` fragen Permissions ab
  (`shift:plan`, `shift:read`, `shift-config:manage`, `integration:manage`); die Matrix-Mutation
  unten zeigt, dass die Planungsrouten wirklich an `shift:plan:ZUGEWIESEN` hängen.
- **Arbeitszeitkonto:** `overtime.ts` fragt Permissions ab; die Monatsabschluss-Erinnerungen
  (`auto-close-month.ts`, `deferred-month-close-reminder.ts`) suchen ihre Empfänger über
  `month-close:close`. Keine Rechenregel berührt.
- **Kompositionsschicht:** `composition/dashboard.ts`, `reports.ts` und `activity.ts` fragen
  Permissions ab; der Aktivitäts-Feed bleibt exklusiv (`audit-log:read` hat Vorrang vor
  `team-overview:read`). Der Rollenfilter des Firmen-PDFs liest `User.role` nur noch über
  `compatRoleUserWhere()` aus `compat-role.ts`.
- **Unterbau:** trägt Systemrollen, Auflöser, Guards, `userIdsHoldingPermission`, die
  Kompatibilitätsrolle und die Datenmigration; `middleware/auth.ts` verliert `requireRole`.

### Gemessen

- **Aufnahme vor der Umstellung:** Die Neutralitätsmatrix
  (`apps/api/src/__tests__/permission-neutrality-matrix.test.ts`) ruft jede aus dem Quelltext
  abgeleitete Route mit acht Akteuren auf (Mitarbeiter, API-Schlüssel ohne und mit `admin`, Manager,
  Admin, dazu drei Akteure ohne gespeicherte Zuweisung für den Rückfall) und hält je Zelle Status,
  Fehlertext und die Multimenge der IDs im Antwortkörper fest. Aufgenommen auf dem unveränderten
  Code in Commit `83279acb` (2226 Zellen, 209 Routen), bevor irgendeine Zugriffsentscheidung
  umgestellt war; die drei Salonkopplungs-Routen aus `origin/main` kamen nach demselben Verfahren
  auf dem Stand vor ihrer Umstellung dazu (`7e964d75`, +24 Zellen). Empfänger aller 17 Suchen
  sowie Aktivitäts-Feed und Anmelderolle: `69b5a4fa` (17 Stellen, 23 Einträge). Nach der Umstellung
  prüften alle drei Dateien grün (Plan 75b-12, vor dem letzten Merge).
- **Merge von `origin/main` `704b1ee5` (Phase 68b):** Seitdem trägt ein Zeiteintrag seinen Salon,
  und die Antworten von sechs Zeiterfassungsrouten (`GET`/`POST /time-entries`, `PUT /:id`,
  `PATCH /:id/break-status`, `PATCH /:id/revalidate`, `POST /:id/clock-out`) enthalten diese Id.
  76 Zellen weichen deshalb von der Aufnahme ab — jede nur um die zusätzliche Salon-Id, Status und
  Fehlertext gleich. Eine vollständige Neuaufnahme auf dem Stand VOR der Umstellung (`origin/main`
  `704b1ee5` plus Harness, dreimal byte-gleich) stimmt mit dem umgestellten Code in allen 2250
  Zellen überein. Die Matrix-Fixture legt den zweiten Salon seitdem eine Minute nach dem
  Standardsalon an; vorher entschied bei gleichem Zeitstempel die zufällige Id, welcher Salon der
  Standardsalon war.
- **Rot gesehen:** Entzieht man der Manager-Systemrolle `shift:plan:ZUGEWIESEN` (D-22), werden
  genau 27 Zellen rot, alle auf den sieben Schichtplanungsrouten (`POST /shifts`, `PUT`/`DELETE
/shifts/:id`, `POST /shifts/:id/restore`, `/generate-week`, `/copy-week`, `/bulk`) und nur für
  Manager, den Rückfall-Manager und den API-Schlüssel ohne `admin`. `lint:role-checks` war zweimal
  auf dem echten Baum rot (ein wieder eingefügter `requireRole`-Aufruf, ein wieder eingefügter
  Vergleich `req.user.role === "ADMIN"`), der Per-Datei-Vergleich der Permission-Multimengen einmal
  (eine Stelle mit falscher Permission).
- **Testzahlen** (Reporter, voller API-Lauf): vor der Phase 301 Dateien / 3725 Tests, nach der
  Phase einschließlich des Merges von `origin/main` `704b1ee5` 331 Dateien / 5883 Tests (5880
  bestanden, 3 übersprungen); davon zehn neue Testdateien der Phase mit 1886 Fällen, 1707 davon die
  Matrix.
