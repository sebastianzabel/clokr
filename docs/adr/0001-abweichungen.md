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

### Nachtrag (Phase 613, Issue #613, 2026-10-17): Personenkreis „beschäftigt im Zeitraum“ als Unterbau-Regel

**Warum hier.** Es gibt weiter kein Beschäftigungsobjekt (#66, Backlog). Der Personenkreis eines Zeitraums wird deshalb
aus `Employee.hireDate` und `Employee.exitDate` abgeleitet und zieht mit einem künftigen Beschäftigungsobjekt um. Die Regel
liegt einmal im Unterbau (`contexts/platform/employed-in-period.ts`, über `contexts/platform/index.ts`): eine additive
**Erweiterung** im Sinn von ADR 0002, Entscheidung 7 (kein bestehender Leser musste sich ändern; Owner-Entscheidung vom
16.10.2026, am Issue #613 dokumentiert). Davor hatte jeder Bericht seine eigene Regel (`exitDate` leer plus aktiver Login,
gar kein Filter, oder das Prädikat aus #256 nur in DATEV).

**Was sich geändert hat.**

- **Das Modul, zwei Schichten.** `employedInPeriodWhere(start, end)` ist der Beschäftigungskern (hireDate ≤ Ende, exitDate leer
  oder ≥ Beginn, beide Grenzen einschließlich, Zeitpunkte statt Kalendertage; das #256-Prädikat unverändert).
  `reportPopulationWhere(start, end)` ist Kern und „nie anonymisiert“ (die Klausel `NOT_ANONYMIZED_EMPLOYEE_WHERE`);
  `isEmployedInPeriod()` ist der Zwilling im Speicher. `user.isActive` liest keine der drei Funktionen. DATEV liest nur den
  Kern (§ 41 EStG: das Lohnkonto eines Beschäftigungsmonats bleibt vollständig); Berichte, Status und Übersichten lesen die
  Berichtsregel. Dazu `dayRangeUtc()` (Arbeitszeitkonto) als Tagesform der Zeitgrenzen.
- **Umgestellte Leser.** Monatsbericht (JSON, Firmen-PDF, Einzel-PDF; eine Person außerhalb der Monatsmenge bekommt das 404 einer
  unbekannten Id), Urlaubsübersicht (JSON und PDF über die Fassade `listEntitlementsForYear` mit Pflichtzeitraum), Urlaubsliste und
  Urlaubs-PDF (eine Menge, eine Reihenfolge: Nachname, Vorname, Id; „kein Anspruch hinterlegt“ für eine Person ohne
  Anspruchszeile), Monatsabschluss-Status und Jahresstatus (zusätzlich `exitDate` je Zeile), Saldo-Übersicht (Fassade W9 mit
  Pflichtzeitraum), Anwesenheit heute, Team-Woche, Team-Trend und Überstunden-Trend (Stichtagsansichten mit Tag, Woche oder
  Monat als Zeitraum; ein Tag außerhalb der Beschäftigung ist in der Team-Woche kein Arbeitstag und nie „Fehlt“), DATEV.
- **Saldo-Übersicht und offener Endsaldo.** Eine ausgetretene Person bleibt in der Übersicht, bis ihr Austrittsmonat
  abgeschlossen ist. Ob er abgeschlossen ist, entscheidet einmal `finalSaldoOpen()` (Arbeitszeitkonto) aus dem jüngsten
  geschlossenen Snapshot, den die bestehende Sammelabfrage ohnehin liefert, richtig für beide Speicherformen von `periodEnd`. Der
  Abschnitt „Ausgetreten, offener Endsaldo“ ist begrenzt (die 50 jüngsten Austritte, dazu `exitedOpenFinalSaldoCount`); die
  Reichweite einer ausgetretenen Person wird am Austrittstag beurteilt, nicht heute.
- **Monatsabschluss-Status.** Fehlende Tage werden nur im Beschäftigungsfenster berechnet, das auch `closeEmployeeMonth`
  benutzt (`statusEmploymentWindow()`, lesende Spiegelung; der Schreiber bleibt unverändert, die Übereinstimmung binden
  Paritätstests).
- **Warnliste Urlaubsverfall.** Liste und Cron behalten die BUrlG-Regel `exitDate` leer und schließen zusätzlich anonymisierte
  Personen aus.
- **Guard.** `report-population-guard-613.test.ts` (AST) schlägt fehl, wenn `isActive` unter `user` in einem `where` von
  `composition/` oder `contexts/working-time-account/` steht, wenn ein registrierter Leser die Regel nicht mehr aufruft oder
  selbst `exitDate: null` filtert, oder wenn eine Ausnahme nicht mehr auf genau einen Fund zeigt.

**Was bewusst NICHT geschah.**

- **Monatsabschluss-Lauf und zurückgestellter Abschluss** wählen weiter nach Login-Zustand (Owner-Entscheidung, D-03: eine andere
  Auswahl ändert, für wen Lohnmonate geschlossen werden). Gemessen wird der Unterschied vom lesenden Skript
  `scripts/audit-613-month-close-population.ts`; die Entscheidung trägt das Folge-Issue #668.
- **Die Anonymisierungsklausel bleibt**, solange anonymisierte Zeilen ohne Austrittsdatum existieren (D-02; #614 setzt das
  Austrittsdatum von da an und listet die Bestandszeilen nur). DATEV liest den Kern ohne diese Klausel: Bis #614 greift, erscheint
  eine anonymisierte Person OHNE Austrittsdatum in jedem späteren DATEV-Monat weiter. Das ist Gegenstand von #614 und hier nicht
  geändert.
- **Keine Kennzeichnung in den eingefrorenen Antworten** von `/reports/monthly` und `/reports/leave-overview` (die Pin-Tests
  entscheiden die Antwortform); die Kennzeichnung Ausgetretener kommt mit dem Zeitraum-Endpunkt aus #612. Gekennzeichnet wird dort, wo
  die Form frei ist: Saldo-Übersicht und „Austritt am …“ im Monatsabschluss.
- **Die Warnliste zum Urlaubsverfall** behält `exitDate` leer. Ob eine Warnung noch geschuldet ist, wenn der Austritt vor der
  Übertragsfrist liegt (oder der Rest über die Urlaubsabgeltung, § 7 Abs. 4 BUrlG, erledigt wird), steht im Folge-Issue #668.

**Ursache offener Endsalden.** `PATCH /employees/:id/deactivate` setzt das Austrittsdatum UND schaltet den Login ab; der Lauf
wählt nach Login. Der Austrittsmonat jeder ordnungsgemäß deaktivierten Person wird deshalb nie automatisch abgeschlossen. Die
Saldo-Übersicht zeigt diese Personen, die Ursache gehört in #668.

**Auswirkung auf die Kontexte.**

- Zeiterfassung: keine.
- Abwesenheiten: Urlaubsübersicht, Urlaubsliste und Urlaubs-PDF lesen die Regel über die Fassade; Verfall-Warnliste und Cron schließen
  Anonymisierte aus.
- Schichtplanung: keine.
- Arbeitszeitkonto: Saldo-Übersicht (W9, `finalSaldoOpen`), Monatsabschluss-Status (lesendes Beschäftigungsfenster), Schreiber unverändert.
- Kompositionsschicht: Berichte und Dashboard rufen die Regel auf und tragen selbst keine Personenregel mehr.

**Gemessen.** Neutralitätsaufzeichnungen (`matrix.json`, `recipients.json`, `activity-auth.json`) unverändert; die eine Zelle, die sich durch die
Regel ändert (`GET /reports/leave-overview` für vier Akteure: der Platzhalter der anonymisierten Fixture-Person entfällt), steht als
Nachtragsregister-Kette (Plan 613-02, Eintrag N), nicht als Neuaufnahme. Die eingefrorenen Pins (`reports-monthly-frozen-84`,
`reports-hr-86`, `dashboard-team-week-frozen-84`, `whole-tenant-frozen-85`) sind byte-gleich zum Merge-Base. Guard: 42 durchsuchte
Dateien, 4 Funde mit 4 Ausnahmen (zwei D-03 mit #668, zwei Empfängerabfragen), 19 registrierte Leser. Saldo-Übersicht: 52 Ausgetretene
mit offenem Monat ergeben 50 Zeilen, `exitedOpenFinalSaldoCount` 52, die Saldoberechnung läuft genau 50-mal, die Abfragezahlen bleiben
(2 Snapshot-Listen, 1 Konto-Liste). Reichweite am Austrittstag: 6 Bereichsauflösungen im Fall eines Salon-Managers. Die Summen der
Gesamtläufe stehen im PR.

**Nachrechnen.** `pnpm --filter @clokr/api exec vitest run src/__tests__/report-population-guard-613.test.ts` (Guard), die
`*-613.test.ts`-Dateien (Population je Leser) und `DATABASE_URL=… pnpm --filter @clokr/api exec tsx
scripts/audit-613-month-close-population.ts` (lesend, nur IDs; Exit 2 bei Abweichungen).

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

**Nachtrag 2026-10-01 (Issue #445):** Punkt 1 ist aufgelöst. Der jahresübergreifende Zweig von
`deductVacationDays()`/`reverseVacationDays()` (`contexts/absence/leave-days.ts`) verwirft den
übergebenen `totalDays`-Parameter nicht mehr für eine eigenständige Neuberechnung über
`splitDaysAcrossYears()`, sondern bucht genau diesen Wert — chronologisch auf die beiden Jahre
verteilt über `splitLeaveDaysByYear()`, mit derselben Tageszählung, mit der der Antrag selbst
bepreist wurde (`resolveLeaveDays()`). `LeaveRequest.days` und die Summe der `usedDays` beider
Jahre können dadurch nicht mehr auseinanderlaufen — es gibt nur noch einen Rechenweg für dieselbe
Zahl. Punkt 2 bleibt unverändert bestehen: die Zählung liest die Vertragsdaten weiterhin über
`resolveLeaveDays()` aus dem Unterbau, nicht über eine Schnittstelle des Arbeitszeitkontos.

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

### Nachtrag 2026-10-17 (Issue #595) — Ein abgeschlossener Monat wird von jedem Leser gleich erkannt und gleich benannt; Krankheitstage haben eine Bedeutung

Auslöser war ein Monat, den die Seite als abgeschlossen zeigte und beide PDFs als „Prognose“ druckten, mit
zwei verschiedenen Zahlen. Ursache: auf den Stages liegen zwei Speicherkonventionen für `SaldoSnapshot.periodStart`
nebeneinander (mandantenzeitzonen-konvertiert und Altbestand „UTC-naiv“, 1. des Monats um 00:00 UTC), und genau
ein Leser — `computeMonthSaldo` — fand den Abschluss nur mit exaktem Vergleich auf die konvertierte Konvention.

**Was sich geändert hat**

- `computeMonthSaldo` sucht den Monatsabschluss über `periodStartWindow()` wie alle anderen Leser des Kontexts.
  Gibt es mehrere aktive Zeilen eines Monats, gewinnt die erste nach `monthlySnapshotOrder()` — dieselbe Zeile,
  die der exakte Vergleich vorher gefunden hat, daher ändert sich keine bereits als bestätigt angezeigte Zahl.
- Der tote Leser W4 der Snapshot-Fassade (`getMonthClosingBalance`, der letzte Abschluss-Leser mit exaktem
  Treffer, ohne Aufrufer) ist entfernt statt umgestellt; die Fassadenfunktionen sinken von 147 auf 146.
- `snapshotMonthOf()` (`contexts/working-time-account/snapshot-period.ts`) benennt den Monat einer Zeile als
  Umkehrung des Fensters. Snapshot-Antwort (`year`/`month`, eine MONTHLY-Zeile je Monat), Aktivitätsfeed,
  Saldenübersicht und Überstundenverlauf gehen alle durch diese eine Funktion; der Verlauf führt beide
  Konventionen eines Monats zu einem Punkt zusammen. Die Seite nimmt Monat und Status aus der Antwort, nie aus
  `periodStart`; der Status-Chip leitet sich aus dem Abschlusszustand ab (vorher war er fest „Offen“).
- `GET /api/v1/leave/sick-days` liefert die eigenen Krankheitstage eines Jahres in Kalendertagen über
  `sickLeaveDayCounts()` (dieselbe Zählung wie der Bericht); der gespeicherte `days`-Wert eines
  Krankheitsantrags heißt in der Oberfläche „Arbeitstage“ (ein Web-Helfer, ein Wächtertest).
- Der Demo-Seed erfindet keinen abgeschlossenen Monat mehr: er schreibt nur Null-Snapshots in der Konvention des
  echten Abschlusses; der Vormonat wird vom echten Abschluss-Kern geschlossen
  (`apps/api/scripts/demo-close-previous-month.ts`).
- Ein reines Lese-Skript (`apps/api/scripts/audit-595-legacy-period-start.ts`) listet Altbestands- und Doppelzeilen
  je Stage.

**Was bewusst NICHT geschah**

- Keine gespeicherte Zeile wurde geändert, nichts neu berechnet, keine Altformat-Zeile bereinigt oder umgeschrieben.
  Eine Altbestands-Zeile wird als abgeschlossen mit ihren gespeicherten Zahlen GELESEN. Kein Schreibpfad änderte sich
  (Monatsabschluss, Entsperren, Jahresabschluss, Eröffnungssalden, `recalculate-snapshots`, Nachtragsskript).
- `computeFirstOpenMonth` bleibt mit eigener Ableitung; ein Test setzt sie mit der neuen Regel gleich.
- DATEV-Lohnarten zählen weiter Arbeitstage und heißen nie „Krankheitstage“. Die PDFs sind unverändert — sie
  zählten schon Kalendertage; ihre Formatierung ist #617.
- Zahlen offener Monate auf der Seite kommen mit #612 (`GET /reports/period`); dort ist die Zahlengleichheit
  Seite = PDF für offene Monate noch festzuschreiben. Die Tabelle zeigt offene Monate nur mit Status und PDF.
- Die übrige Demo-Realität (erfundene Überstundenkonten, Ledger-Zeile) ist #577.
- Die Sperrprüfungen `getClosedMonthsForDates`/`getClosedMonthsInRange` (W2a/W2b der Fassade; genutzt von
  Schichtbereinigung und Berufsschul-Generator) vergleichen weiterhin auf das konvertierte Datum und erkennen einen
  Altbestands-Abschluss nicht. Das ist eine Frage der Schreibsperre, kein Berichtsleser; sie wird im Folge-Issue
  (Milestone v1.16.0) behoben, nicht hier.
- Bekannter Rest: `sumCarryOverByMonth` im Überstundenverlauf zählt einen Mitarbeiter mit Altbestands- UND
  konvertierter Zeile desselben Monats doppelt. Der Abschnitt „Duplicate months“ des Prüfskripts misst, ob es
  das gibt (dev: keine); die Behebung steht im selben Folge-Issue.
- Verwandt, nicht Teil von #595: #663 (das Nachtragsskript `backfill-month-snapshots.ts` übergibt
  Abwesenheitszeilen ohne `isOvertimeCompensation`/`creditBasis` an den Abschluss).

**Auswirkung auf die Kontexte**

- Zeiterfassung: keine.
- Abwesenheiten: neue eigene Leseroute `GET /leave/sick-days` (eigene Daten), Beschriftung „Arbeitstage“.
- Schichtplanung: keine (die Sperrprüfung von Schichtbereinigung ist das Folge-Issue).
- Arbeitszeitkonto: Abschlusserkennung über das Fenster, `snapshotMonthOf`, Reihenfolge `monthlySnapshotOrder`,
  W4 entfernt, Snapshot-Antwort mit Jahr und Monat.
- Kompositionsschicht: Monatsnamen in Aktivität und Dashboard; additives Feld `month` an den Einträgen der
  Saldenübersicht. Keine Geschäftsregel hierher verschoben.
- Unterbau: keine.

**Gemessen**

- Prüfskript auf dev (nur lesend): Mandant 1 — 245 Zeilen, davon 1 Altbestand, 244 konvertiert, 0 Doppelmonate,
  1 Monat wechselt zu „Bestätigt“, 244 Monatsnamen korrigiert; Mandant 2 — 72 Zeilen, alle konvertiert, 0 Doppelmonate,
  72 Monatsnamen korrigiert. int und prod sind ein Schritt des Eigentümers.
- Vor der Korrektur rot, danach grün: `report-page-pdf-parity-595.test.ts` (Altbestand in Sommer- und Winterzeit-Monat),
  `snapshot-month-labels-595.test.ts` (3 Fälle), `leave-sick-days-595.test.ts` (Route = Summe der zwölf
  Berichtszeilen, 15,5 = 15,5).
- Vierpfad-Vergleich der Saldopfade: `measure-saldo-path-parity.ts --check` unverändert grün; Neutralitätsaufzeichnungen und die drei
  eingefrorenen Berichtstests byte-gleich zum Merge-Base.
- Demo-Lauf (Wegwerf-Datenbank): fünf Mitarbeiter, Kernzahlen vor und nach dem echten Abschluss identisch
  (Ist, Soll, Saldo), Zeilen in der Konvention des Abschlusses, fünf Auditzeilen.

**Nachrechnen**

- `pnpm --filter @clokr/api exec vitest run src/__tests__/report-page-pdf-parity-595.test.ts src/__tests__/closed-month-never-recalculated-595.test.ts src/__tests__/snapshot-month-labels-595.test.ts src/__tests__/snapshot-month-naming-guard-595.test.ts src/__tests__/leave-sick-days-595.test.ts`,
  dazu `snapshot-period-595.test.ts` und im Web `snapshot-period-source-595.test.ts`, `leave-days-label-guard-595.test.ts`.
- `pnpm --filter @clokr/api exec tsx scripts/measure-saldo-path-parity.ts --check`.
- `DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx scripts/audit-595-legacy-period-start.ts [--tenant <uuid>]`
  (Abschnitte „Status wechselt zu Bestaetigt“ und „Duplicate months“).

### Nachtrag 2026-10-17 (Issue #681) — Der Gesamtsaldo eines offenen Monats enthält alle offenen Monate seit dem letzten Abschluss

**Schwere: Fehlerbehebung einer Anzeige- und Exportzahl. Keine Unterbau-Änderung, keine Migration, keine gespeicherte Zeile
geändert.**

Ursache: `computeMonthSaldo` begann die Tagesreihe eines offenen Monats beim Übertrag des letzten Abschlusses (oder dem
Eröffnungssaldo). Waren zwei oder mehr Monate offen, fehlten die früheren offenen Monate im Gesamtsaldo des späteren —
im Monatsexport (Spalte „Gesamtsaldo“) und in `GET /overtime/month-saldo`. Der Live-Saldo rechnete richtig.

**Was sich geändert hat**

- Eine Funktion, `openMonthCarryInMinutes()` (`contexts/working-time-account/overtime-balance.ts`), liefert den Übertrag in
  einen offenen Monat: die Kette des Live-Saldos (`computeAccountChain`, der unveränderte Rumpf von
  `computeOvertimeBalanceBreakdown`) mit dem Stichtag „Monatserster“ — letzter Abschluss vor dem Monat plus jeder offene
  Monat dazwischen, ein Nur-erfassen-Monat setzt auf 0 (#494), ohne Abschluss der Eröffnungssaldo am Kettenanfang.
  Der Gesamtsaldo am Monatsende ist damit gleich dem Live-Saldo zum selben Stichtag (letzter Monatstag, im laufenden
  Monat gestern, #438).
- Ein Monat, der nach seinem eigenen Vertrag nur erfasst (#494), zeigt an jedem Tag Gesamtsaldo 0 — wie sein Abschluss
  (gespeicherter Übertrag 0) und der Live-Saldo.
- `getConfirmedCarryOver` nimmt optional `periodStartBefore`; ohne die Option ist die Abfrage unverändert.

**Was bewusst NICHT geschah**

- Abgeschlossene Monate werden nur gelesen, nie neu berechnet (Vollzeilenvergleich im Test).
- Der Live-Saldo ist unverändert. Ohne jeden Abschluss liest er den Eröffnungssaldo nicht; der Gesamtsaldo enthält ihn
  (wie jeder Abschlusspfad). Diese Differenz ist gemessen und eigenes Issue #682.
- Die eingefrorenen Literale von `saldo-boundary-neutrality-493.test.ts` sind unverändert. 16 Felder (8 Zellen, je
  erster und letzter Tageswert) stehen im Änderungsregister
  `apps/api/src/__tests__/fixtures/saldo-boundary-neutrality-493-amendments.json`; der Test wendet es auf eine Kopie an,
  prüft jeden alten Wert gegen das Literal und das Register gegen die gemessenen Abweichungen (keine zu viel, keine
  fehlend). Beleg in derselben Datei: der amendierte Februarwert ist gleich dem dort gepinnten Live-Saldo
  (F −55862 min, M −12648 min).

**Auswirkung auf die Kontexte**

- Arbeitszeitkonto: Ort der Regel (`openMonthCarryInMinutes`, Tagesreihe in `computeMonthSaldo`).
- Kompositionsschicht: keine eigene Regel, liest nur `closingBalanceMinutes`.
- Zeiterfassung, Abwesenheiten, Schichtplanung, Unterbau: keine.

**Nachrechnen**

- `pnpm --filter @clokr/api exec vitest run src/__tests__/open-month-chain-681.test.ts src/__tests__/saldo-boundary-neutrality-493.test.ts`.

### Nachtrag 2026-10-17 (Issue #682) — Der Live-Saldo beginnt ohne abgeschlossenen Monat mit dem Eröffnungssaldo

**Schwere: Fehlerbehebung einer Anzeigezahl und des gespeicherten Live-Werts. Keine Unterbau-Änderung, keine Migration, kein
abgeschlossener Monat geändert.**

Ursache: `computeAccountChain` (`contexts/working-time-account/overtime-balance.ts`, der Rumpf von
`computeOvertimeBalanceBreakdown`) begann ohne abgeschlossenen Monat bei 0 und las den Eröffnungssaldo nie. Alle
Abschlusswege (Cron, manueller Abschluss, Neuberechnung) und seit #681 die Monatsreihe beginnen mit `getCarryOverBase()`
(Phase 99 OB-02). Live-Saldo (Dashboard, `GET /overtime/:id`, gespeichertes `OvertimeAccount.balanceHours`) und Gesamtsaldo
unterschieden sich bis zum ersten Abschluss um genau die Minuten des Eröffnungssaldos (#681, Fall pG: 600).

**Was sich geändert hat**

- Die Live-Kette beginnt mit `getCarryOverBase(prisma, id, abgeschlossen ? { carryOver } : null)` — derselbe Startwert wie
  jeder Abschluss, ein Ort. Mit abgeschlossenem Monat ist das der gespeicherte Übertrag des letzten Abschlusses; der
  Eröffnungssaldo wird dann nicht erneut gelesen (der erste Abschluss hat ihn bereits aufgenommen).
- `openMonthCarryInMinutes` addiert den Startwert nicht mehr zusätzlich auf die Kette (er steckt jetzt in ihr). Nebenbefund:
  enthielt die Kette einen offenen Nur-erfassen-Monat (#494), fügte der alte Weg den Eröffnungssaldo nach dem Rücksetzen
  wieder hinzu; jetzt fällt er wie beim Abschluss dieses Monats weg.
- `POST /overtime/opening-balance` schreibt nach der Neuberechnung den Live-Wert sofort in `OvertimeAccount.balanceHours`
  (`updateOvertimeAccount`); vorher blieb der gespeicherte Wert bis zur nächsten fremden Änderung stehen.

**Was bewusst NICHT geschah**

- „Bestätigt“ (`confirmedMinutes`) bleibt der gespeicherte Übertrag des letzten Abschlusses (dieselbe Zahl wie die Sperre des
  Überstundenausgleichs, `getConfirmedCarryOver`). Ein Eröffnungssaldo ohne Abschluss steht deshalb im Anteil „Laufender
  Monat (Prognose)“, bis der erste Monat abgeschlossen ist.
- Abgeschlossene Monate werden nur gelesen (Vollzeilenvergleich im Test). Keine eingefrorene Saldo-Zahl änderte sich
  (Goldmatrix, 493-Neutralität, 451-Identität, 617-Monatsexport, Parität der vier Saldopfade): keine dieser Fixtures hat einen
  Eröffnungssaldo ohne Abschluss. Kein Änderungsregister nötig.
- Gespeicherte Werte werden nicht nachträglich umgeschrieben. Der gespeicherte Live-Saldo einer betroffenen Person ändert sich
  bei ihrer nächsten Änderung (Zeiteintrag, Antrag, Schicht) um den Eröffnungssaldo — erwartet, offener Stand.
  `scripts/audit-682-opening-balance-live-gap.ts` listet diese Personen vorab (nur lesend, Ids und Minuten).

**Auswirkung auf die Kontexte**

- Arbeitszeitkonto: Startwert der Live-Kette (Ort der Regel), Eröffnungssaldo-Endpunkt.
- Kompositionsschicht, Zeiterfassung, Abwesenheiten, Schichtplanung, Unterbau: keine.

**Nachrechnen**

- `pnpm --filter @clokr/api exec vitest run src/__tests__/live-saldo-opening-balance-682.test.ts src/__tests__/open-month-chain-681.test.ts scripts/__tests__/audit-682-opening-balance-live-gap.test.ts`
  (vor der Korrektur 16 + 2 Fälle rot).
- `pnpm --filter @clokr/api exec tsx scripts/measure-saldo-path-parity.ts --check`.

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

### Nachtrag (Issue #447, 2026-10-02): E-4 aufgelöst

`employees.ts` importiert `absence/vacation-calc` nicht mehr tief — `calculateProRataVacation`,
der von E-4 ausgenommene Aufruf, ist aus der PATCH-Warnung entfernt. Der Austritts-Warnhinweis
kommt jetzt über die reguläre Fassade (`exitVacationOverUseWarning`, aus `../../absence` — ein
bereits bestehender, nicht-tiefer Import), und die Austrittsjahr-Neuberechnung
(`syncExitYearVacationEntitlement`) ist ein invariant-tragender Aufruf in den besitzenden Kontext
hinein (ADR 0002, Entscheidung 10), kein Seiteneffekt eines fremden Imports. Das Register in
`apps/api/scripts/context-boundary-import-exceptions.json` nennt jetzt sechs statt sieben Klassen
(gemessen: `measure-context-boundary-imports.ts --check 0` → 55 tiefe Importe, alle 55 durch die
verbliebenen sechs Einträge gedeckt); der Zyklen-Deckel bleibt bei 22 (`--cycles --check 22`).

### Nachtrag (Phase 88, Issue #88, 2026-10-13): Wurzel-Ausnahme 53 → 56

`app.ts` registriert für das Betreiberkonto drei weitere Module (`operatorAuthRoutes`,
`tenantStatusPlugin`, `operatorTenantRoutes`); der Zähler `expectedCount` der Ausnahme
`composition-root` steigt von 53 auf 56 (`context-boundary-import-exceptions.json`, dort mit der
Begründung je Schritt). Dieselbe Form wie die früheren Schritte: eine Registrierung durch die
Kompositionswurzel, kein tiefer Import in einen Kontext. Die neue Naht
`composition/tenant-onboarding.ts` importiert den Abwesenheitskontext ausschließlich über dessen
`index.ts`. Eintrag Y beschreibt die Phase.

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

Nachtrag Phase 82 (12.10.2026): #82 hat den Mandanten- und Salon-Kontext im Frontend geliefert, keine
Öffnungszeiten-Oberfläche je Salon. Spiegel und `TenantConfig.storeHours` bleiben deshalb bis #89
(Salon pflegen inklusive Öffnungszeiten); die Verweise im Code zeigen seit Phase 82 auf #89.

Nachtrag Phase 89 (13.10.2026): #89 liefert die Salonverwaltung des Betreibers, der seit Phase 89
`Salon.openingHours` bearbeitet; die Salonverwaltung im Mandanten gehört nicht dazu. Spiegel und
`TenantConfig.storeHours` bleiben deshalb bis #563 (Unterbau-Semantikänderung, Entscheidung des Eigentümers
vor `Ready`); die Verweise im Code zeigen seit Phase 89 auf #563. Der Hinweis bei genau einem aktiven Salon
in der Betreiberoberfläche erklärt den Spiegel. (Umgesetzt in Phase 563, siehe Nachtrag Phase 563 unter
Eintrag L.)

Nachtrag Phase 563 (15.10.2026): #563 liefert die Salonverwaltung für Mandanten-Admins und beendet die
Doppelführung der Öffnungszeiten. Das ist eine Semantikänderung im Unterbau nach ADR 0002, Entscheidung 7
(die Nutzung eines Unterbau-Felds entfällt): Die Owner-Entscheidung steht als Kommentar auf #563 vom
15.10.2026, davor lief ein lesender Probelauf auf int und prod — je ein Mandant mit genau einem aktiven
Salon, Zeiten identisch, nichts geht verloren.

- **Was entfällt.** `TenantConfig.storeHours` wird weder gelesen noch geschrieben. `PUT /api/v1/settings/work`
  entfernt den Schlüssel stillschweigend (200, nichts geschrieben; ein veralteter Web-Stand während eines
  Rolling Deploys bricht die Einstellungsseite nicht), alle Antworten lassen ihn über
  `RETIRED_TENANT_CONFIG_COLUMNS` weg (Muster #433). Der Spiegel `syncSoleActiveSalonOpeningHours()` samt
  seiner `UPDATE Salon`-Zeile im Audit-Protokoll ist aus Route und Facade entfernt; die Pflege in
  `admin/system` ist durch `/admin/salons` ersetzt.
- **Was bleibt.** `shiftStoreHoursMode` (STRICT/DAY_ONLY/OFF) bleibt eine Mandanten-Regel in `admin/system`
  (Mindest-Nutzlast `{ shiftStoreHoursMode }`); `DEFAULT_SALON_OPENING_HOURS` bleibt die Vorgabe für einen
  neuen Salon; die Spalte selbst bleibt bis zum Folge-Release #638 bestehen, damit ein Image-Rollback
  funktioniert (Muster #470). Es gibt keine Migration.
- **Salonverwaltung im Mandanten.** `/admin/salons` (Liste, Detailseite je Salon, Anlegen unter
  `/admin/salons/neu` mit ausdrücklich gewähltem Bundesland) benutzt die unveränderte Mandanten-API
  `/api/v1/salons` und damit dieselbe Facade wie die Betreiberkonsole; Kontingent (#566),
  `FEDERAL_STATE_IN_USE`, „nie löschen“ und der identische 404 sind unverändert. Sichtbar mit `salon:read`,
  Änderungen nur mit `salon:manage` (das Web blendet aus, die API entscheidet). Nach jedem erfolgreichen
  Anlegen, Bearbeiten, Deaktivieren und Aktivieren lädt die Seite den Salon-Kontext erzwungen neu
  (`salonContext.load(…, { force: true })`). Der Ketten-Paket-Hinweis steht beim Anlegen als fünfte Stelle
  des `ModuleHint`; beim Aktivieren zeigt die Seite den 409-Text des Servers, der das Ketten-Paket selbst
  nennt.
- **Neue additive Lesung.** `GET /api/v1/shifts/week` liefert zusätzlich `salonOpeningHours` — die
  Öffnungszeiten genau der aktiven Salons in der Reichweite des Aufrufers (Reichweite wie die Schichten, die
  der Aufruf liefert: ganzer Mandant oder Salon-Reichweite; eine reine Personen-Reichweite ohne Salon erhält
  eine leere Liste und sieht keine geschlossenen Tage). Das ist eine Erweiterung (kein bestehender Leser
  muss sich ändern). Die Schichtplanung zeigt geschlossene Tage je Salon über `closedDaysFor()`: für den
  einen erreichbaren oder den gewählten Salon; bei mehreren Salons und „Alle Salons“ erscheint ein Hinweis,
  nie ein gemischter Wert. Die Prüfung beim Schreiben einer Schicht (`assertWithinStoreHours`) ist
  unverändert.
- **Wächter.** `store-hours-readers.test.ts` läuft über `apps/api/src`, `packages/db/src` und
  `apps/web/src` und erlaubt genau eine Stelle: den Eintrag in `RETIRED_TENANT_CONFIG_COLUMNS`. Die
  eingefrorene Paritätstabelle in `shift-store-hours-salon.test.ts` (D-16) bleibt unverändert; nur ihre
  Vorbedingung schreibt die Wochenzeiten jetzt über `PATCH /api/v1/salons/:id` statt über
  `PUT storeHours`, weil der Pfad des Spiegels nicht mehr existiert.
- **Betreiberkonsole.** Der Hinweis bei genau einem aktiven Salon (er erklärte den Spiegel) und die Zuführung
  `activeSalonCount` an `SalonDialog` entfallen samt Tests.
- **Neutralitätsmatrix.** Sechs Zellen `GET /api/v1/shifts/week | none` (ADMIN, MANAGER, APIKEY_ADMIN,
  APIKEY_PLAIN, FALLBACK_ADMIN, FALLBACK_MANAGER) enthalten jetzt zusätzlich die IDs der eigenen Salons des
  Mandanten (46 → 48 IDs); Status, Route und Guard sind unverändert. Eingetragen über das
  Nachtrags-Register `matrix-amendments.json` (Issue 563), `matrix.json` ist unberührt.
  `sec-13-shifts-week-role-gate.test.ts` führt `salonOpeningHours` jetzt im Schlüsselsatz der Antwort.

**Auswirkung auf die Kontexte:** Schichtplanung — die Wochenansicht liest die Öffnungszeiten des Salons
statt des Mandanten-Feldes. Zeiterfassung, Abwesenheiten, Arbeitszeitkonto, Kompositionsschicht — keine.

**Mandantengrenze:** kein Datenbank-Trigger (eine Instanz pro Kunde, #226); die Anwendung prüft über
`findSalon()` mandantengebunden, fremde und nicht existierende Salon-IDs werden byte-gleich mit 404
abgelehnt (T-100-09). `POST /api/v1/shifts/bulk` prüft seit #325 zusätzlich, dass jeder Mitarbeiter zum
Mandanten gehört — sonst hätte eine Schicht einen Salon eines fremden Mandanten bekommen können
(vorher fehlende Prüfung, beim Bau gefunden).

**Phorest:** Bis #65 schreibt die Synchronisation den Default-Salon; ohne aktiven Salon bricht der Lauf
mit Fehler ab, bestehende Schichten werden nie umgehängt.

### Nachtrag 2026-10-12 — Phase 87b (Issue #87)

**Was sich geändert hat:** Neuer Export des Unterbaus `currentAndFutureAssignmentSalonIds()` in
`contexts/platform/facade/salon-assignments.ts`, re-exportiert aus `contexts/platform/index.ts`. Er
beantwortet, welche Salons die laufenden und künftigen Salonzuordnungen eines Mitarbeiters nennen:
stornierte und beendete Zeilen sind ausgeschlossen, einen Aktivitätsfilter gibt es nicht. Additiv, damit
eine Erweiterung nach ADR 0002 Entscheidung 7; vor dem Bau auf #87 angekündigt. `contextSalonIds()` nutzt
dieselbe Funktion, die Gültigkeitsregel einer Zuordnung existiert damit genau einmal. Der Fassadenzähler
steigt von 132 auf 133.

**Warum nicht in der Zeiterfassung:** Eine lokale Kopie wäre eine zweite Gültigkeitsregel für
Salonzuordnungen neben dem Unterbau (Owner-Entscheidung D-10). `clockSalonChoice()` in der Zeiterfassung
liest die Funktion nur.

**Auswirkung auf die Kontexte:**

- Zeiterfassung: `clockSalonChoice()` (`contexts/time-tracking/clock-salon-choice.ts`) liest den Export, um
  zu entscheiden, ob beim Stempeln im Web eine Salonwahl angeboten wird.
- Abwesenheiten: keine.
- Schichtplanung: keine.
- Arbeitszeitkonto: keine.
- Kompositionsschicht: keine.

**Was bewusst NICHT geschah:** Keine Schemaänderung und keine Migration. NFC und WLAN nehmen weiter keine
Salonangabe entgegen; die Bindung eines Terminals an einen Salon ist #541. Kein zweiter Salon je Tag und
Mitarbeiter: ein erneutes Stempeln öffnet den Eintrag des Tages und lässt dessen Salon unverändert, ein
ausdrücklich abweichender Salon ist 409 `SALON_DIFFERS_FROM_DAY_ENTRY` (#70).

### Nachtrag 2026-10-16 (Phase 70b, Issue #70): Ein ausdrücklich anderer Salon beginnt einen neuen Eintrag

Der letzte Satz oben („Kein zweiter Salon je Tag und Mitarbeiter … 409 `SALON_DIFFERS_FROM_DAY_ENTRY`“) gilt nicht mehr.
Seit #70 beginnt ein Stempeln mit einem ausdrücklich anderen, aktiven Salon an einem abgeschlossenen Tag einen **neuen
Eintrag** in diesem Salon; der erste Eintrag bleibt unverändert. Der Fehlercode `SALON_DIFFERS_FROM_DAY_ENTRY` und seine
Verzweigung sind entfernt. Ohne Salonangabe oder mit dem Salon des zuletzt endenden Eintrags wird dieser Eintrag wie bisher
wieder geöffnet; an einem laufenden Tag bleibt die Antwort `ALREADY_CLOCKED_IN`, und fremde und unbekannte Salon-Ids
antworten weiter identisch mit 404. `clockSalonChoice()` nennt am abgeschlossenen Tag den Salon des zuletzt endenden
Eintrags („Zuletzt erfasst in …“) und bietet in einem Mandanten mit mehreren Salons die anderen aktiven Salons an
(Ausnahme: nennen die aktuellen und künftigen Zuordnungen genau diesen einen Salon); an einem laufenden Tag bietet es
nichts an. Unverändert: NFC und WLAN nehmen weiter keine Salonangabe entgegen (#541). Begründung, Sicherung und Grenzen:
Eintrag AA.

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
  **Nachtrag Phase 83 (12.10.2026):** #83 hat die Oberfläche geliefert, nämlich Rollen- und
  Zuweisungsverwaltung und den Admin-Bereich nach Permissions (`admin-route-permissions.ts`). Das
  Entfernen von `User.role`, Enum `Role` und dem Altrollen-Rückfall ist eine Semantikänderung im
  Unterbau mit destruktiver Migration (ADR 0002 Entscheidung 7) und liegt seitdem bei #539, das die
  Owner-Entscheidung braucht. Die übrigen seiteninternen Rollenprüfungen der Oberfläche stehen in
  #538. Die Verweise im Code zeigen seit Phase 83 auf diese beiden Issues.
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

  **Nachtrag 2026-09-25 — Issue #357 (Sicherheitsreview zu #354/75b):** Diese Abweichung ist
  aufgehoben. `anonymizeEmployeeData` (`contexts/platform/anonymize.ts`) schreibt `User.role`
  jetzt zusammen mit `isActive: false` auf EMPLOYEE zurück. Der oben genannte Vorteil (ein noch
  gültiges Token behält seine Rechte) war der eigentliche Befund von #357: mit entfernten
  Zuweisungen UND stehengelassener Spalte hält ein vor der Anonymisierung ausgestelltes,
  noch gültiges Zugriffstoken eines MANAGER/ADMIN über den Alt-Rollen-Rückfall (D-08) volle Rechte
  bis zum Token-Ablauf — obwohl die Person anonymisiert und `isActive: false` ist (das nichts je
  Anfrage neu prüft, D-10). Die zwei genannten Matrix-Zellen kippen jetzt tatsächlich von 204 auf
  403 (Test: `apps/api/src/__tests__/employee-role-bridge.test.ts`, "a MANAGER's
  pre-anonymization access token holds no rights afterwards"); die Abweichung ist als Amendment
  in `apps/api/src/__tests__/neutrality/recorded/matrix-amendments.json` (Issue #357) verzeichnet,
  `recorded/matrix.json` bleibt unverändert. `docs/permissions.md` bekam dafür keine neue Zeile —
  es ist kein neuer Rollenvergleich außerhalb von `compat-role.ts`, sondern derselbe
  `tx.user.update()`-Aufruf, der schon `isActive` schreibt.

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
  Zellen überein. Die 76 Zellen wurden daraus allein im Commit `55492603` übernommen; ohne jede
  Salon-Id sind alte und neue Aufnahme byte-gleich. Die Matrix-Fixture legt den zweiten Salon seitdem eine Minute nach dem
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

### Nachtrag 2026-10-13 (Issue #551) — Ein Mandanten-Token ohne Mandant wird vor jeder Permission-Prüfung abgewiesen

**Messung (Phase 88, Plan 13).** Ein Mandanten-JWT mit `tenantId: ""` (ein Benutzer ohne Employee, der
Alt-Admin) passierte `requirePermission` über den Altrollen-Rückfall des Resolvers: 40 Routen
antworteten 200 (leer/Standard), 35 antworteten 500 und erreichten die Datenbank; Schreibzugriffe
scheiterten nur zufällig am Fremdschlüssel auf `Tenant`. Das ist keine Sperre, sondern ein Unfall.

**Entscheidung (D-01 bis D-04, autonom nach der Regel „Gesetz zuerst, nachhaltig statt billig“, begründet
als Kommentar am Issue #551).**

- **D-01, eine Stelle.** `requireAuth` weist ein verifiziertes Mandanten-Token (JWT und API-Schlüssel), dessen
  Mandantenwert leer, nur Leerzeichen, fehlend oder kein String ist, mit 403
  `{ error, code: "TENANT_REQUIRED" }` ab. Reihenfolge: `jwtVerify`, Betreiber-Claims, leerer Mandant,
  `tenantIsActive`. `requirePermission`/`requireAnyPermission` rufen `requireAuth` zuerst auf, die
  Abweisung kommt also vor jeder Berechtigung und vor jeder Abfrage. Der Code ist der Steuerwert, der
  deutsche Text nur Anzeige.
- **D-02, kein neues Token ohne Mandant.** `login` (nach dem Passwortvergleich, daher kein Orakel; mit
  Audit `LOGIN_REFUSED`/`TENANT_REQUIRED`, vor jedem OTP), `verify-otp`, `resend-otp` (vor Code und Mail),
  `refresh` (vor der Rotation, das gespeicherte Token bleibt unberührt) und `change-password` (hat einen
  eigenen preHandler und umgeht `requireAuth`) antworten mit demselben 403. `issueTokens()` wirft, statt
  einen leeren Mandanten zu signieren. Passwort-Zurücksetzen und Einladung stellen kein Token aus und
  bleiben unverändert.
- **D-03, Tiefenverteidigung im Unterbau.** `effectiveGrants`, `hasPermission` und
  `effectivePermissionKeysForUser` gewähren einem leeren Mandanten nichts: kein Altrollen-Rückfall, keine
  Abfrage. Das ändert die Bedeutung von drei Exporten von `contexts/platform/index.ts` bzw. ihrer
  Hilfsfunktionen für genau einen Fall (leerer Mandant) und ist damit eine **Unterbau-Semantikänderung**;
  die Entscheidung ist am Issue #551 dokumentiert (Autonomie-Regel des Owners).
- **D-04, die Regel steht einmal.** `isBlankTenantId()` (nicht-String oder nach dem Kürzen leer) ist die
  einzige Stelle, die „leerer Mandant“ entscheidet. Sie ist im importfreien Blatt
  `contexts/platform/access-context-error.ts` definiert (der Reinheitstest `access-context.test.ts` hält
  dieses Blatt frei von Imports, daher kann sie nicht in `tenant-status.ts` stehen) und von
  `tenant-status.ts` wieder ausgeführt; die Middleware bekommt sie über die Dekoration des
  Tenant-Status-Plugins (`middleware/auth.ts` importiert nichts aus `contexts/`). `requireTenantId`,
  `isTenantDeactivated`, `tenantIsActive` und der Resolver rufen sie auf. `tenantIsActive("")` antwortet
  weiterhin `true`, `isTenantDeactivated("")` weiterhin `false`.

**Auswirkung auf die Kontexte.**

| Kontext             | Wirkung                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| Zeiterfassung       | keine fachliche Wirkung: nur ein Principal ohne Employee, der nie Zeitbuchungen hatte, wird abgewiesen |
| Abwesenheiten       | keine fachliche Wirkung: dieselbe Begründung, ein Benutzer ohne Employee hat keine Anträge             |
| Schichtplanung      | keine fachliche Wirkung: dieselbe Begründung                                                           |
| Arbeitszeitkonto    | keine fachliche Wirkung: dieselbe Begründung                                                           |
| Kompositionsschicht | keine fachliche Wirkung: keine Regel wandert, die Abweisung geschieht vor jedem Handler                |

Jeder Principal mit Employee ist unverändert; das beweisen die unveränderten Aufzeichnungen
`matrix.json`, `recipients.json` und `activity-auth.json` (alle byte-gleich).

**Geänderte Aufzeichnung, über ein Register statt Neuaufnahme.** Zwei Zellen von
`activity-auth-neutrality.test.ts` betreffen den Benutzer ohne Employee: `auth | A.noEmployee | login`
(200 → 403) und `auth | A.noEmployee | refresh` (200 → 400, weil der Login keinen Refresh-Token mehr
ausgibt). Sie stehen in `neutrality/recorded/activity-auth-amendments.json` (Issue 551, Grund, Datum;
`from` ist byte-genau an die Aufzeichnung gebunden); `activity-auth.json` bleibt unverändert. Das Register
hat dieselbe Form und dieselben Regeln wie `recipients-amendments.json` und `matrix-amendments.json`.

**Betreiberschritt.** `apps/api/scripts/audit-551-users-without-employee.ts` listet jeden Benutzer ohne
Employee (Id, Rolle, aktiv, offene Refresh-Tokens, Rollenzuweisungen; nur lesend, keine Mail, kein Name).
Vor dem Deployment des Releases einmal auf int und prod ausführen: jeder aufgeführte aktive Benutzer kann
sich danach nicht mehr anmelden. Folge für die int-Auffrischung: `seed-int-admin.ts` (Schritt 8 von
`docs/data-refresh-process.md`) wählt nur noch Admins mit Employee und verweigert einen gepinnten
`--email` ohne Employee vor jedem Schreiben.

**Nachweise.** `tenant-required-551.test.ts` (Helfer, `requireAuth`-Sperre ohne Abfrage für vier
Token-Formen auf einer `requireAuth`- und einer Permission-Route, API-Schlüssel-Zweig, Resolver, jeder
Anmeldepfad), `operator-tenant-boundary-sweep-88.test.ts` (212 Routen, leer/Leerzeichen/fehlend: überall
403 `TENANT_REQUIRED`, kein Prisma-Aufruf), `access-context-missing.test.ts` (äußere Sperre und innere
Schicht), `request-permissions.test.ts`, `audit-551-users-without-employee.test.ts` sowie die angepassten
Tests (`compat-role`, `shifts-my-week`, `leave-days-work-location`, `activity-auth-neutrality`).
Mutationsprobe: ohne die Sperre in `requireAuth` werden die Fälle von `tenant-required-551.test.ts` und
der Sweep rot (siehe Summary der Quick-Task 261013-bhk).

### Nachtrag 2026-10-15 (Issue #539, Release A) — Berechtigungen nur noch aus gespeicherten Rollenzuweisungen

**Entscheidung.** Owner-Entscheidung vom 15.10.2026 (am Issue #539 dokumentiert): Der Altrollen-Rückfall, die Spalte
`User.role` und das Enum `Role` werden in **zwei Releases** entfernt. Dieser Nachtrag beschreibt **Release A**; Release B
(Spalte und Enum per Migration, Muster #470) steht im Folge-Issue #641. Release A ist eine
**Unterbau-Semantikänderung** im Sinn von ADR 0002, Entscheidung 7 (Bedeutung und Rückgabe mehrerer Exporte von
`contexts/platform/index.ts` ändern sich; ein Nutzer ohne gespeicherte Zuweisung hielt bisher implizit die Systemrolle seiner
Spalte und hält jetzt nichts).

**Was sich geändert hat.**

- **Der Rückfall ist an allen fünf Auflösungsstellen weg** (D-02, D-03): `computeGrantsForUser` (Berechtigungen),
  `resolveAccessReach` (Reichweite), `contextSalonIds` (Salonkontext), `userIdsHoldingPermission` (Empfängersuche) und
  `roleNamesByUserId` (Rollennamen) lesen nur noch gespeicherte Zuweisungen des Mandanten, fail-closed.
  `loadLegacyFallbackRole` ist gelöscht; ein Nutzer ohne Zuweisung ist ein Nutzer mit leerer Menge, leerer Reichweite, ohne
  Empfängerrolle und mit leerer Rollennamenliste.
- **Keine stille Zuweisung mehr** (D-11): `materializeLegacyRoleAssignment` ist gelöscht. Wer in einem Formular oder über
  `POST /role-assignments` eine erste Rolle bekommt, erhält genau diese Rolle und nichts von der Spalte (Fall „erste
  Kundenrolle für einen Nutzer ohne Zeilen“ in `employee-role-bridge.test.ts`).
- **Übernahme vor dem Deploy** (D-01): `apps/api/scripts/backfill-539-role-assignments.ts`. Standard ist ein lesender
  Probelauf (nur Ids, Exit-Code 2 bei übernehmbaren Nutzern); mit `--confirm` bekommt jeder aktive Nutzer mit
  Mitarbeiterdatensatz und ohne Zuweisung genau eine Zuweisung mit Scope Mandant auf die Systemrolle seiner Spalte, mit einer
  SYSTEM-Audit-Zeile „Übernahme der Alt-Rolle (#75)“, eine Transaktion je Nutzer, wiederholbar. Der Ablauf steht in
  `docs/migrations.md`, Abschnitt „Phase 539“.
- **Anmeldung ohne Berechtigung wird abgewiesen** (D-14): Login (nach dem Passwortvergleich, vor jedem OTP; Audit
  `LOGIN_REFUSED` mit Grund `NO_ROLE_ASSIGNED`), `verify-otp` und `refresh` (vor der Rotation) antworten mit 403
  `{ error, code: "NO_ROLE_ASSIGNED" }`, wenn die wirksame Permission-Menge leer ist. Der Code ist der Steuerwert; die Web-App
  zeigt den Text des Servers und verzweigt weder auf Code noch Text.
- **Kein `role`-Claim, kein `user.role` im Login-Body** (D-05): `JwtPayload` hat kein Feld `role` mehr, der API-Schlüssel-Principal
  ist `{ sub, tenantId }`, das Request-Log trägt keine Rolle. Ein vor dem Deploy ausgestelltes Token mit `role`-Claim bleibt
  gültig, der Claim wird von nichts gelesen (`token-claims-539.test.ts`: ein Token mit `role: "ADMIN"` für einen Nutzer mit
  Mitarbeiter-Zuweisung erhält nur die Rechte der Zuweisung).
- **Rollenvorbelegung im Mitarbeiterformular** (D-10): `formRolesByUserId()` leitet die angezeigte Rolle serverseitig aus den
  gespeicherten Zuweisungen ab; ohne Zuweisung ist `user.role` in `GET /employees`, `GET /employees/:id` und den Antworten
  von Anlage und Reaktivierung `null`, die Web-App zeigt „Keine Rolle zugewiesen“ mit Hinweis und sendet ohne Auswahl keine
  Rolle. Ein anonymisierter Mitarbeiter (Zuweisungen sind hart gelöscht, #74b) zeigt in `GET /employees?includeAnonymized=true`
  daher ebenfalls `null`.
- **`actorRole` wird nicht mehr geschrieben** (D-13): neue Audit-Zeilen der Urlaubsanlage im Auftrag tragen kein `actorRole`
  mehr. Bestehende Zeilen bleiben unverändert (das Protokoll ist append-only; Revisionssicherheit).
- **Exporte entfernt** (D-16): `systemRoleIdForLegacyRole`, `deriveCompatRole` und `compatRoleForUser` stehen nicht mehr in
  `contexts/platform/index.ts` (kein Verbraucher außerhalb des Unterbaus; `tsc` ist der Beweis).
- **Die Spalte wird weiter geschrieben** (D-06): `deriveCompatRole()` und `syncCompatRoleColumn` halten `User.role` nach jeder
  Änderung konsistent mit den Zuweisungen, damit ein Rollback auf das vorige Image konsistente Werte findet. Es gibt keine
  Schema-Migration.

**Was bewusst nicht geschah** (D-08). Spalte und Enum bleiben bis Release B stehen. Keine Systemrolle gewährt etwas anderes
als vorher (`system-roles.ts` ist byte-gleich zum Merge-Basisstand).

**Verbleibende Leser der Spalte.** Genau drei, vom AST-Wächter `apps/api/src/__tests__/legacy-role-reads-539.test.ts` erzwungen
(jeder Eintrag der Erlaubnisliste muss mindestens einen Treffer haben, sonst ist der Test rot): (1) der Rollenfilter des
Firmen-PDF (`&role=`, D-12, über `parseCompatRoleFilter`/`compatRoleUserWhere` in `compat-role.ts`; die Zeilendaten des Berichts
tragen keine Rolle mehr), (2) der Vergleich vor dem Zurückschreiben in `syncCompatRoleColumn` (D-06) und (3) das
Übernahme-Skript (D-01). Der Wächter läuft über 318 Quelldateien (`apps/api/src` und `apps/api/scripts`, ohne Tests) und
verbietet außerdem `select: { role: true }`, `role` unter einem `where`, `req.user.role`, ein `role`-Feld im `JwtPayload` und die
Namen der gelöschten Funktionen. `lint:role-checks` behält `compat-role.ts` als einzige Ausnahme, bis Release B die Spalte entfernt.

**Gemessen.**

- _Probe vom 15.10.2026_ (nur lesend, ohne Namen, Kommentar am Issue #539): int und prod sind identisch; von 20 Nutzern haben
  17 eine gespeicherte Zuweisung, die 3 übrigen haben die Kompat-Rolle EMPLOYEE und sind **inaktiv**. Kein aktiver Nutzer
  hing am Rückfall. Die Übernahme betrifft dort also niemanden; das Skript bleibt für künftige Instanzen. Inaktive und
  anonymisierte Nutzer bekommen bewusst keine Zuweisung zurück (Anonymisierung löscht sie absichtlich).
- _Rechteneutralität der Übernahme_ (`backfill-539-role-assignments.test.ts`): je übernommenem Nutzer sind wirksame Permissions,
  `resolveAccessReach` für alle 65 ZUGEWIESEN-Schlüssel des Katalogs und die Mitgliedschaft in `userIdsHoldingPermission` vor
  und nach der Übernahme gleich dem, was ein über `POST /employees` angelegter Nutzer mit derselben Rolle hat (Admin 87,
  Manager 63, Mitarbeiter 22 wirksame Schlüssel). Der Test ist über fünf Mutationsproben abgesichert.
- _Neutralitätsaufzeichnungen_ (`matrix.json`, `recipients.json`, `activity-auth.json`) sind **byte-gleich zum Merge-Basisstand**;
  jede Änderung steht als datierter Kettenglied in den drei Nachtragsregistern, erzeugt aus einem gemessenen Lauf mit
  `apps/api/scripts/neutrality-amendments-from-run.ts` (verweigert alles außerhalb der benannten Schlüssel). Matrix: **460**
  Glieder (FALLBACK_ADMIN 259, FALLBACK_MANAGER 158, FALLBACK_EMPLOYEE 43), alle auf Schlüsseln `FALLBACK_*`, kein Schlüssel eines
  Hauptakteurs oder API-Schlüssels. Empfänger: **17** Glieder (die Zeilen `R.fallback.*` entfallen). Aktivität/Anmeldung: **16**
  Glieder (2 Rückfall-Feeds, 6 Anmeldung/Refresh der Rückfall-Akteure mit 403 bzw. 400, 8 Einträge `auth | …`, die `bodyRole`
  und `tokenRole` für jeden Principal verlieren; D-17). Die Gültigkeit der Ketten (Anfang gleich Aufzeichnung, jedes Glied setzt das vorige fort, Datum, Issue, Grund) prüft
  `neutrality-amendment-chain-539.test.ts`.
- _Unabhängige Gegenprobe_ (D-15): ein Akteur mit gespeicherter Rolle ohne jede Permission (`ORACLE_EMPTY_ROLE`) wird gegen die
  drei Rückfall-Akteure verglichen: FALLBACK_MANAGER und FALLBACK_ADMIN sind gleich FALLBACK_EMPLOYEE, und dieser ist gleich dem
  Orakel, je **299** Zellen ohne Abweichung (Untergrenze 290). Eine Mutationsprobe (Orakel mit Admin-Rolle) macht 183 Fälle rot.
- _Fixture-Sweep_ (D-09): Testnutzer, die sich auf den Rückfall verließen, bekommen ihre Systemrolle jetzt als gespeicherte
  Zuweisung über `grantSystemRole()` (`__tests__/setup.ts`): 3 + 80 + 14 Dateien mit 197 + 50 Aufrufen, jeweils mit einem
  vorübergehenden Messfühler im Resolver belegt, der jeden Rückfall-Treffer zählte (danach null Treffer in diesen Dateien); die
  18 Dateien, die den Rückfall selbst prüften oder sich bewusst auf ihn stützten, wurden mit seinem Entfernen auf „hält
  nichts“ umgeschrieben.

**Akzeptierte Restrisiken.**

- _Veralteter Browser-Tab (D-18)._ Ein vor dem Deploy geöffneter Tab des Mitarbeiterformulars kann beim Speichern noch den
  Wert der Spalte als `role` senden. Der Server vergleicht ihn mit der aus den gespeicherten Zuweisungen abgeleiteten Rolle
  (`requestedRoleUnchanged`); weicht er ab, ist es eine gewollte Rollenänderung, die nur ein Administrator mit
  `role-assignment:manage` auslösen kann und die auditiert wird. Die Zahl der Nutzer, bei denen Spalte und abgeleitete Rolle
  auseinanderlaufen, nennt der Probelauf (`columnDrift`).
- _`actorRole`._ Neue Zeilen tragen kein `actorRole`; wer die Rolle des Handelnden zum Zeitpunkt rekonstruieren will, nimmt das
  Rollenzuweisungs-Protokoll (Audit der Zuweisung). Bestehende Zeilen bleiben unverändert.
- _Alter Token-Claim._ Tokens, die vor dem Deploy ausgestellt wurden, tragen ihren `role`-Claim weiter; er wird nicht gelesen
  .

**Auswirkung auf die Kontexte.**

| Kontext             | Wirkung                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unterbau            | Der Rückfall und die stille Übernahme entfallen, Anmeldung ohne Berechtigung wird abgewiesen (403 `NO_ROLE_ASSIGNED`), drei Exporte entfallen; die Spalte bleibt bis Release B |
| Zeiterfassung       | keine fachliche Wirkung                                                                                                                                                        |
| Abwesenheiten       | keine fachliche Wirkung; neue Audit-Zeilen der Urlaubsanlage im Auftrag tragen kein `actorRole`                                                                                |
| Schichtplanung      | keine                                                                                                                                                                          |
| Arbeitszeitkonto    | keine                                                                                                                                                                          |
| Kompositionsschicht | Der Rollenfilter des Firmen-PDF liest die Kompat-Spalte weiter (D-12), bis Release B ihn über gespeicherte Zuweisungen ausdrückt; Berichtszeilen tragen keine Rolle mehr       |

**Betreiberschritt vor dem Deploy** (T-539-45): Probelauf des Übernahme-Skripts auf int UND prod, bei Treffern `--confirm`
(Ablauf: `docs/migrations.md`, „Phase 539“). Ohne ihn können sich aktive Nutzer ohne Zuweisung nach dem Deploy nicht anmelden.

**Release B.** Spalte `User.role` und Enum `Role` entfernen, `compat-role.ts` und die `lint:role-checks`-Ausnahme streichen,
den Firmen-PDF-Filter über Zuweisungen ausdrücken, das Übernahme-Skript stilllegen: #641.

### Nachtrag 2026-10-17 (Issue #614) — Anonymisierung beendet die Beschäftigung, Personalnummer bleibt

**Entscheidung.** Owner-Entscheidung vom 16.10.2026 (am Issue #614 dokumentiert). Eine DSGVO-Löschung
(`DELETE /api/v1/employees/:id`) beendet die Beschäftigung der Person und behält ihre Personalnummer. Das ist eine
**Unterbau-Semantikänderung** im Sinn von ADR 0002, Entscheidung 7: Zwei Bedeutungen von `anonymizeEmployeeData` ändern sich
(`Employee.exitDate` wird gesetzt, `Employee.employeeNumber` wird nicht mehr überschrieben). Die Lage davor: Die Person blieb
ohne Austrittsdatum, ihre genehmigten Urlaube und Berufsschultage liefen weiter, der DATEV-Export künftiger Monate führte sie
weiter, und die überschriebene Personalnummer ließ spätere Lohnkorrekturen alter Monate nicht mehr zuordnen (§ 41 EStG,
§ 147 AO; Art. 17 Abs. 3 lit. b DSGVO erlaubt die Aufbewahrung).

**Was sich geändert hat.**

- **Austrittsdatum.** Ist es leer, setzt die Anonymisierung den Tag der Anonymisierung in der Zeitzone des Mandanten (UTC-Mitternacht
  dieses Kalendertags, wie ein im Web eingegebenes Austrittsdatum) und führt den Abgleich des Austrittsjahres aus #447 aus. Ein
  vorhandenes Datum, ob vergangen oder künftig, wird nie geändert. Ein gespeichertes Austrittsdatum wird als sein UTC-Kalendertag
  gelesen (die Konvention, mit der es geschrieben wurde).
- **Personalnummer.** Sie bleibt und bleibt im Mandanten reserviert: die Eindeutigkeit `[tenantId, employeeNumber]` besteht
  weiter, das Anlegen oder Ändern auf eine vergebene Nummer antwortet **409** mit deutscher Meldung statt eines internen Fehlers
  (`employee-creation.ts`). Das Namensmuster `GELÖSCHT-<Nummer>` im Nachnamen bleibt der Anonymisierungsmarker; er hängt nicht
  von der Nummer ab.
- **Abwesenheiten nach dem Austritt.** Die Regel liegt **nur** in `contexts/absence/employment-exit.ts`. Der Unterbau erreicht
  sie über die Dekoration `app.absenceExit` (`plan` vor der Transaktion, `apply` in ihr, `afterCommit` danach) — dieselbe
  Reichweite wie E-5, ohne neuen Import; der Importzyklus bleibt bei 22 Modulen. Ein Antrag, der nach dem Austrittstag beginnt,
  wird storniert (PENDING, APPROVED, CANCELLATION_REQUESTED, jeder Urlaubstyp) mit denselben Rückbuchungen wie eine genehmigte
  Stornierung (Urlaubstage, Überstundenausgleich über die **gespeicherten** Minuten, Revalidierung ungültiger Zeiteinträge).
  Berufsschultage (`Absence`) nach dem Austritt werden weich gelöscht.
- **Überschneidung statt Stornierung (D-02).** Ein Antrag, der den Austrittstag überspannt, wird auf den Austrittstag **gekürzt**,
  nicht storniert: Urlaub ist die Freistellung innerhalb eines bestehenden Arbeitsverhältnisses (§ 1, § 7 Abs. 1 BUrlG), die
  gewährten Tage bis zum Austritt bleiben Urlaub, der Rest wird abgegolten (§ 7 Abs. 4 BUrlG). Dafür ist der Korrekturkern der
  Route `PATCH /leave/requests/:id/correct` nach `contexts/absence/leave-correction.ts` herausgelöst (Plan, Anwendung und
  Abschluss hinter einem Audit-Port); Route und Austritt teilen **eine** Implementierung. Bleibt vom Antrag nichts übrig, wird er
  storniert; ein offener Antrag wird wie bei der Bearbeitung neu bepreist.
- **Übersprungene Fälle.** Nie angefasst, sondern im ANONYMIZE-Audit unter `skipped` mit ID und Code gelistet: `CLOSED_MONTH`
  (ein betroffener Tag liegt in einem abgeschlossenen Monat, Zeilen und Salden bleiben unverändert), `PARENTAL_REDUCTION_ACTIVE`
  (aktive § 17-BEEG-Kürzung; nur ihr eigener Widerruf ändert die Zeile) und `CORRECTION_REFUSED` (der Korrekturkern lehnt aus eigenem Grund ab).
  Die Anonymisierung wird dadurch nie blockiert (Art. 17 DSGVO). Ändert sich ein geplanter Antrag zwischen Plan und Anwendung,
  antwortet die Route **409** `EMPLOYMENT_EXIT_CONFLICT` und schreibt nichts.
- **Audit ohne Freitext.** Jede geänderte Zeile bekommt ihren eigenen Audit-Eintrag mit `auditReason` „Anonymisierung“ und
  `trigger: "ANONYMIZATION"`, ohne Notiz, Name oder E-Mail. Der ANONYMIZE-Eintrag trägt die Zahlen je Gruppe, das Austrittsdatum
  und die übersprungenen Zeilen (IDs und Codes). Zeilen, die die Anonymisierung ändert, werden vor dem Bereinigen der
  personenbezogenen Felder geschrieben, damit deren Notizen und Pfade danach geleert werden.
- **„Bevorstehende Urlaube“.** Die Dashboard-Karte (`GET /dashboard/team-upcoming-leave`) listet keine anonymisierte Person mehr;
  der Filter liegt in der Abwesenheiten-Fassade, nicht in der Kompositionsschicht.
- **Dialog.** Der Lösch-Dialog im Web nennt, dass die Beschäftigung endet und die Personalnummer bestehen bleibt.

**Auswirkung auf die Kontexte.**

| Kontext             | Wirkung                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unterbau            | `Employee.exitDate` wird gesetzt, `Employee.employeeNumber` bleibt und ist reserviert (409); `anonymizeEmployeeData` bekommt `exitDayIfUnset` und liefert das Austrittsdatum zurück |
| Zeiterfassung       | keine fachliche Wirkung; Einträge stornierter Zeiträume werden wie bei jeder Stornierung revalidiert (`revalidateLeaveCancellationEntries`)                                         |
| Abwesenheiten       | neue Regel `employment-exit.ts` (Stornieren, Kürzen, weich Löschen) und der aus der Route gelöste Korrekturkern `leave-correction.ts`; Dashboard-Filter in der Fassade              |
| Schichtplanung      | keine, wie heute (der Berufsschul-Generator überspringt Tage nach dem Austritt bereits)                                                                                             |
| Arbeitszeitkonto    | abgeschlossene Monate unverändert (summenidentisch bewiesen); offene Monate werden nach den Stornos wie bei jeder Stornierung neu berechnet                                         |
| Kompositionsschicht | DATEV führt die Person ab dem Folgemonat des Austritts bei unverändertem Code nicht mehr; die Personalnummer bleibt in den Zeilen alter Monate; keine neue Geschäftsregel           |

**Grenzen.**

- _Bestand wird nicht korrigiert._ Personen, die vor diesem Release anonymisiert wurden, haben weiter kein Austrittsdatum, ihre
  Abwesenheiten laufen weiter und ihre Personalnummer ist überschrieben. Die Entscheidung, ob und wie das nachgezogen wird,
  liegt bei #666; das lesende Skript `scripts/audit-614-anonymized-employment.ts` listet die Fälle (nur IDs).
- _`anonymize-dump.ts`._ Das Batch-Skript der Kopie-Löschung setzt das Austrittsdatum, behält die Personalnummer, beendet aber
  keine Abwesenheiten: Die Kopie hat keine Lohnfolgen, und eine Abwesenheitsregel gehört nicht in ein Skript.
- _Übersprungene Zeilen bleiben_ bis zur fachlichen Klärung. Nachtrag Issue #662: Der Fall „Urlaub nach dem Austritt teilt eine
  § 9-Gutschrift mit einem Krankheitsantrag“ wird nicht mehr übersprungen (`SECTION9_CREDIT_ACTIVE` entfällt): Die
  Stornierung — im Genehmigungsweg wie beim Austritt — setzt die Gutschriften des Antrags über
  `supersedeSection9CreditsOfCancelledRequest()` (`contexts/absence/section9-supersede.ts`) auf `SUPERSEDED`, auditiert, in
  der Transaktion der Stornierung; eine bestätigte Gutschrift wird dabei im Konto zurückgenommen (wie bei `/correct`, #468).
  Abgeschlossene Monate bleiben unberührt (die Stornierung wird dort weiter verweigert bzw. übersprungen). Bestand listet
  `scripts/audit-662-cancelled-leave-section9.ts` (nur lesend, nur IDs).
- _Aufbewahrung._ Die Frist des endgültigen Löschens beginnt bei neuen Anonymisierungen am Austrittstag statt am Anlagedatum der
  Person.

**Betreiberschritt vor dem Deploy.** Lese-Skript auf int UND prod, Ausgabe aufbewahren (Ablauf: `docs/migrations.md`,
„Phase 614“). Es gibt keine Migration und keinen Schemawechsel.

**Nachweis.** `anonymization-ends-employment-614.test.ts` (Austrittsdatum, Stornierung, Audit, Transaktion),
`anonymization-absence-kinds-614.test.ts` (alle Status und Typen, Berufsschule, übersprungene Fälle),
`anonymization-spanning-exit-614.test.ts` (Kürzung, § 9, § 17, Konflikt), `anonymization-closed-months-614.test.ts`
(abgeschlossene Monate summenidentisch, kein Freitext im Audit), `anonymization-employee-number-614.test.ts` (Nummer bleibt,
409), dazu `leave-correction-core-614.test.ts`, `dashboard-upcoming-leave-anonymized-614.test.ts` und
`scripts/__tests__/audit-614-anonymized-employment.test.ts`.

### Nachtrag 2026-10-17 (Issue #617) — Der D-12-Leser entfällt

Der firmenweite Monatsbericht (`GET /reports/monthly/pdf/all`) ist mit #617 entfernt, und mit ihm der Rollenfilter, der als
D-12 der dritte dokumentierte Leser der Kompatibilitätsspalte `User.role` war. Es bleiben zwei Leser: der Vergleich beim
Zurückschreiben (D-06) und das Übernahme-Skript (D-01). `legacy-role-reads-539.test.ts` zählte D-12 nie als Fund
(`compatRoleUserWhere()` liefert `{ role }` außerhalb eines `where`-Literals), seine Allowlist braucht deshalb keine
Änderung. `parseCompatRoleFilter` und `compatRoleUserWhere` bleiben ohne Aufrufer exportiert, bis Release B (#641) die
Spalte und das Enum entfernt; ein Hinweis steht am Issue #641.

---

## O — Bundesland und manuelle Feiertage wandern an den Salon (Phase 71b, Issue #71)

**Schwere: informativ. Nachtrag 2026-09-25 — Semantikänderung des Unterbaus nach ADR 0002,
Entscheidung 7, und ein neuer Fremdschlüssel auf den Unterbau.**

**Was sich geändert hat:** Das Bundesland gehört jetzt dem Salon (`Salon.federalState`, Pflicht,
ohne Schema-Vorgabe). Die Migration
`packages/db/prisma/migrations/20260925123734_holidays_per_salon/` gab jedem bestehenden Salon das
`Tenant.federalState` seines Mandanten. `Tenant.federalState` bleibt als Spalte und ist nur noch die
Vorgabe, die ein neuer Salon ohne eigene Angabe erbt (`createSalon()`); für gesetzliche Feiertage
liest es kein Code mehr. `PublicHoliday.salonId` ist ein Pflicht-Fremdschlüssel auf `Salon` mit
`onDelete: Restrict`, eindeutig ist `[salonId, date]` statt `[tenantId, date]`. Bestehende manuelle
Feiertage gehören dem Default-Salon ihres Mandanten (frühester aktiver Salon, in der Migration als
Rückfall der früheste überhaupt). `PublicHoliday.tenantId`, `federalState` und `year` bleiben als
denormalisierte Spalten. Die Migration schreibt keine `SaldoSnapshot`-Zeile
(`apps/api/src/__tests__/holiday-salon-migration.test.ts`).

**Eine Auflösung im Unterbau:** `holidaysForSalon()` und `holidaysAtWorkLocation()` in
`apps/api/src/contexts/platform/facade/holiday-resolution.ts` bilden als einzige Stelle eine
Feiertagsmenge. Maßgeblich ist der Arbeitsort des Tages (§ 2 EFZG): der Salon des abgeschlossenen
Arbeitseintrags an diesem Tag, sonst `salonForDay()`, sonst der Default-Salon. Der Unterbau liest
keine Zeiteinträge; Aufrufer übergeben die Zeilen aus `getWorkedEntriesInRange()`, die dafür
`salonId` mitliefert. Bei mehreren Einträgen an einem Tag entscheidet übergangsweise der früheste
(`// MULTI-ENTRY:`, #70). Die Auflösung braucht eine feste Zahl von Abfragen, unabhängig von der
Zahl der Mitarbeiter und Tage (PERF-V1814-01 gilt weiter). Die Berechnung selbst ist nicht mehr über
`contexts/platform/index.ts` erreichbar; `apps/api/src/__tests__/holiday-resolution-boundary.test.ts`
hält fest, dass außerhalb von `contexts/platform/` kein Produktivcode sie aufruft oder
`PublicHoliday` direkt liest — einmal rot gesehen gegen 13 Dateien.

**Korrekturen, offen ausgesprochen:** `composition/dashboard.ts` und `composition/reports.ts`
berücksichtigen manuelle Feiertage erst seit dieser Phase. `attendance-checker.ts` hatte sie
entgegen dem Issue-Text schon vorher über `fetchCloseMonthData()` berücksichtigt; dort ändert sich
nur der Arbeitsort. Die Schichtwoche nimmt für gesetzliche Feiertage den Arbeitsort statt
`federalStateOverride`; der Override gilt nur noch für Berufsschul-Schulferien. `GET
/api/v1/holidays` griff für Aufrufer ohne Mitarbeiterdatensatz auf einen beliebigen Mandanten
zurück; der Mandant kommt jetzt nur aus dem Token.

**Sperre:** Das Bundesland eines Salons ist nur änderbar, solange weder ein Zeiteintrag (auch ein
gelöschter) noch eine Salonzuordnung auf ihn verweist; sonst 409 `FEDERAL_STATE_IN_USE`. Die
Zählung der Zeiteinträge liefert die Zeiterfassung über `countEntriesForSalon()`;
`contexts/platform` greift nicht auf deren Tabelle zu.

**Bewusst nicht:** keine Neuberechnung geschlossener Monate; Schulferien sowie die Heiligabend- und
Silvester-Regeln bleiben mandantenweit; keine Oberfläche (Block D, #82 ff.). Die
Betreiber-Skripte `backfill-month-snapshots.ts` und
`recalculate-snapshots-after-bs-doublecount-fix.ts` rechnen weiter mit einer mandantenweiten Menge
und verweigern deshalb Mandanten mit mehr als einem Salon.

**Zusammentreffen mit dem `origin/main`-Merge (Phase 75b, Issue #75, Eintrag N; Issue #361):** Diese
Phase wurde vor dem Abschluss mit den zwischenzeitlich auf `origin/main` gelandeten Commits
zusammengeführt, darunter das Permission-System aus Eintrag N. Die AC-9-Neutralitätsbasis (Einzelsalon-
Mandant, keine manuellen Feiertage) blieb dabei byte-identisch. Die gemergte Permission-Matrix aus
Eintrag N (`permission-neutrality-matrix.test.ts`) prüft dagegen einen Mandanten mit mehreren
aktiven Salons; dort liefert `GET /api/v1/holidays` jetzt die Feiertage beider Salons (siehe
„Lesen ohne Salon“ unten) — acht Zellen wurden über den bestehenden Mechanismus aus Issue #361
(`neutrality/recorded/matrix-amendments.json`) mit Verweis auf Issue #71 als bewusste
Verhaltensänderung dokumentiert, nicht als Regression der Berechtigungsprüfung; `matrix.json`
blieb unverändert. Ein echter, vom
Merge unabhängiger Fehler (`GET /api/v1/dashboard/my-week` 500 für API-Schlüssel-Akteure ohne
`employeeId`, ausgelöst durch den neuen `holidaysAtWorkLocation()`-Aufruf dieser Phase) wurde als
solcher erkannt und im Code behoben, nicht dokumentiert.

**Lesen ohne Salon (D-09, revidiert 2026-09-25):** Der Plan sah ursprünglich vor, dass `GET
/api/v1/holidays` bei einem Mandanten mit mehr als einem aktiven Salon ohne `salonId` mit 400
`SALON_REQUIRED` antwortet. Das wurde vor der Auslieferung verworfen, weil ein Lesezugriff keinen
Salon voraussetzen darf: Ohne `salonId` liefert die Route jetzt die Feiertage ALLER aktiven Salons
des Mandanten, jeder Eintrag mit seiner `salonId` (`apps/api/src/contexts/platform/api/holidays.ts`,
`computeHolidaysForSalon()`). Bei einem Mandanten mit genau einem Salon ändert sich die Antwort
nicht. Mit `salonId` bleibt es bei genau diesem Salon; eine fremde und eine unbekannte Id bekommen
dieselbe 404 (T-100-09). Schreibende Aufrufe (`POST /api/v1/holidays`) verlangen bei mehr als einem
aktiven Salon weiterhin eine `salonId` (400 `SALON_REQUIRED`). Die beiden Web-Seiten, die ohne
Salon fragen, zeigen bei mehreren Salons damit die Feiertage aller Salons, bis Block D (#82 ff.)
eine Salonauswahl bringt.

### Nachtrag 2026-10-16 (Phase 70b, Issue #70): Der Salon des frühesten Eintrags ist die endgültige Regel

Der Satz „Bei mehreren Einträgen an einem Tag entscheidet übergangsweise der früheste (`// MULTI-ENTRY:`, #70)“ ist
keine Übergangsregel mehr. Mit #70 gibt es echte Tage mit mehreren Einträgen; die Owner-Entscheidung vom 16.10.2026
legt fest: Arbeitsort des Tages (§ 2 EFZG) ist der Salon des Eintrags mit dem **frühesten Beginn**, der Feiertag wird
einmal je Tag aufgelöst, nie je Eintrag. `holidaysAtWorkLocation()` ändert dafür weder Signatur noch Ergebnis, nur der
Kommentar (der Marker ist entfernt, der Wächter des Eintrags verlangt jetzt, dass keiner mehr vorkommt). Siehe Eintrag AA.

---

## P — Salon-/Personen-Scope in der Datenzugriffsschicht durchgesetzt (Phase 91b, Issue #91)

**Schwere: informativ. Nachtrag 2026-09-26 (Issue #91, Phase 91b) — Semantikänderung zweier
Unterbau-Exporte nach ADR 0002, Entscheidung 7.**

**Warum dieser Eintrag existiert:** Eintrag K (Phase 77b) legte den Zugriffskontext an und benannte
ausdrücklich die eine Stelle, an der eine spätere Phase die Reichweite auf Salon oder Personen
einschränken würde (`employeeScopeFor()`). Eintrag N (Phase 75b) stellte die Zugriffsentscheidung
selbst von Rollen auf Permissions um, hielt aber ausdrücklich fest: „Keine Salon- oder
Personengrenze an der API (#91). Eine Zuweisung mit Scope SALONS oder PERSONS gewährt in 75b
mandantenweit nichts (D-09, fail-closed).“ Diese Phase vervollständigt genau das — sie widerspricht
Eintrag N nicht, sie erfüllt seine eigene Vorhersage. Zwei Exporte von `contexts/platform/index.ts`
ändern dabei ihre Bedeutung (`AccessReach`, die 403-Gate-Logik in `request-permissions.ts`) — eine
Semantikänderung nach ADR 0002, Entscheidung 7, die hier nachgetragen wird. Ein Zufallsfund während
der Ausführung (`## O` — Phase 71b, Bundesland/Feiertage pro Salon) belegte den nächsten freien
Buchstaben bereits, bevor dieser Eintrag geschrieben wurde; er heißt deshalb P, nicht O, wie die
Phase ursprünglich vorsah.

### Was sich geändert hat

- **`AccessReach` bekommt eine `scoped`-Variante** (`apps/api/src/contexts/platform/access-
context.ts:61`): `{ kind: "scoped"; salonIds: readonly string[]; employeeIds: readonly string[] }`
  — die Vereinigung jeder wohlgeformten `SALONS`-/`PERSONS`-Zuweisung, die die gefragte Permission
  gewährt, niemals zwei getrennte Varianten (eine Person mit `SALONS`-Zuweisung auf Salon A UND
  `PERSONS`-Zuweisung auf Mitarbeiter C erreicht „A ODER C“ in einer Anfrage).
- **`resolveAccessReach(db, ctx, permission)`** (`facade/role-assignments.ts:168`) löst die
  Reichweite je Permission auf, einschließlich des Alt-Rollen-Rückfalls (D-08 aus Phase 75b): Ein
  Nutzer ganz ohne gespeicherte Zuweisung bekommt dieselbe implizite `TENANT`-Zuweisung, die
  `userIdsHoldingPermission()` bereits kennt — ein während Plan 91b-01 gefundenes Risiko, im
  Kontext/Research-Dokument nicht benannt: Ohne diesen Rückfall hätte jeder vor #91 migrierte Nutzer
  ohne eigene Zuweisung in dem Moment JEDE Reichweite verloren, in dem irgendein Scope-Filter zum
  ersten Mal lief (`resolve-access-reach.test.ts`, Mutationsnachweis M2).
- **Das 403-Gate unterscheidet seit D-05 nach Bezug** (`request-permissions.ts:220-229`,
  `hasPermission()`): Eine `MANDANT`-Ressource liest weiter nur die enge `zugewiesen`-Menge (nur
  eine `TENANT`-Zuweisung gewährt sie, byte-gleich zu vorher); eine `PERSON`-Ressource liest jetzt
  `zugewiesenAnyScope` — eine wohlgeformte `SALONS`- oder `PERSONS`-Zuweisung besteht das Gate
  erstmals, die Zeilenfilterung entscheidet danach, was sie tatsächlich sieht.
- **`contexts/platform/scope-filter.ts`** ist die eine Stelle, an der die Sichtbarkeitsregel einer
  Ressource entschieden wird — ein Funktionspaar je Ressourcenzeile (D-07): `isTimeEntryInScope`/
  `scopedTimeEntryIds` (:53/:93, D-09, Zeiteintrag: eigener Salon ODER Stammsalon am Eintragsdatum),
  `resolveStammsalonScopedEmployeeIds`/`isStammsalonScopeMatch` (:144/:178, D-10, Urlaub/
  Abwesenheit/Saldo/Exporte: Stammsalon-only, kein Salon-des-Eintrags-Rückfall),
  `isShiftInScope`/`shiftScopeWhere` (:212/:228, D-11, Schicht: nur der eigene Salon der Schicht,
  rein, kein `db`), `resolvePersonScopedEmployeeIds`/`isPersonMasterDataInScope` (:248/:297, D-12,
  Mitarbeiter-Stammdaten: Stammsalon-HEUTE ODER aktiver Einsatzsalon-HEUTE).
- **`SCOPE_ACCESS_DENIED`** ist eine neue, reine String-Audit-Aktion (keine Migration, D-02): Sie
  wird nur geschrieben, wenn die zugrunde liegende Zeile wirklich existiert, aber außerhalb der
  aufgelösten Reichweite liegt, und antwortet danach mit derselben 404, die die Route für eine
  nirgends existierende Id ohnehin gibt (T-100-09-Orakel-Gleichheit).
- **Drei bereits vor der Phase bestehende, ungescopte Routen sind geschlossen:** `GET
/time-entries` und `GET /leave/requests` (im Issue benannt, D-09/D-10) sowie `GET /dashboard/
overtime-overview` (ein eigener Fund dieser Phase, Plan 91b-06, `composition/dashboard.ts:862` —
  vor der Phase ohne jede Scope-Einschränkung).
- **`homeSalonAt(db, tenantId, employeeId, date)`** (`facade/salon-assignments.ts:296`) ist die eine
  Stammsalon-zu-einem-Stichtag-Grundfunktion, absichtlich NICHT `salonForDay()` (die zusätzlich
  Wochentag/Einsatzsalon abgleicht — eine andere Frage als „wo ist der Stammsalon an diesem Tag“).
- **`scopedTimeEntryIds()`** (`scope-filter.ts:93`) ist die einzige der acht Funktionen, die eine
  parametrisierte Roh-SQL-Abfrage braucht: Ein reiner Prisma-`where` kann den
  Stammsalon-ODER-Zweig nicht ausdrücken, weil er `TimeEntry.date` (die eigene Spalte der ZEILE)
  gegen `EmployeeSalonAssignment.validFrom`/`validUntil` (eine SCHWESTERTABELLE) vergleichen müsste
  — Prisma kennt keinen relationalen Filter, der auf ein Feld DERSELBEN Zeile Bezug nimmt.
- **17 Empfängersuchen sind über EINEN gemeinsamen Helfer eingeschränkt** —
  `resolveScopedHolderIds(db, tenantId, candidateUserIds, permission, isInScope)`
  (`facade/role-assignments.ts:538`): Eine `wholeTenant`-Reichweite wird IMMER behalten, unabhängig
  vom `isInScope`-Callback — im Helfer selbst erzwungen, nie einem einzelnen Callback überlassen.

### Was bewusst NICHT geschah

- **Keine Oberfläche** (#83–#86, durch diese Phase blockiert gewesen).
- **Keine Härtung der Mandantengrenze** (#226, unverändert seit Eintrag K).
- **Keine Scope-Einschränkung unter dem Mandanten für API-Schlüssel** (D-04, unverändert seit Phase
  75b): Ein API-Schlüssel bleibt mandantenweit, ungeachtet einer eventuellen künftigen
  Personen-/Salon-Zuweisung auf sein zugehöriges Systemkonto.
- **`GET /dashboard/overtime-trend`s fehlendes Permission-Gate** (`composition/dashboard.ts:1433`,
  `preHandler: requireAuth` ohne jede Permission-Prüfung) ist ein eigener, VORBESTEHENDER Fund
  (Plan 91b-06) — keine fehlende Scope-Einschränkung, sondern ein fehlendes Gate überhaupt (jeder
  angemeldete Mitarbeiter sieht heute den mandantenweiten Überstunden-Trend). Absichtlich NICHT in
  dieser Phase mitkorrigiert: Das Vermischen eines Gate-Funds mit einer Scope-Phase hätte den
  rechteneutralen Charakter dieser Phase verlassen — ein neues Gate ändert, WER überhaupt zugreifen
  darf, nicht nur WELCHE Zeilen ein bereits berechtigter Zugriff sieht.
  **Nachtrag 2026-09-26:** mit Eintrag Q (Phase 76b, D-15) geschlossen.
- **`carryover-warning.ts`s `leave-config:manage`-Empfängersuche braucht keine Änderung**
  (Plan 91b-09): `leave-config` hat Bezug `MANDANT` (`permission-catalog.ts:94`) — eine
  `SALONS`-/`PERSONS`-Zuweisung kann diese Permission wegen D-05 strukturell nie gewähren, jeder
  Halter, den `userIdsHoldingPermission()` zurückgibt, hält sie bereits mandantenweit.

### Übergangs- und Randregeln

- **`employeeScopeFor()` wirft bei einer gescopten Reichweite ohne Ziel** (D-06,
  `access-context.ts:148-151`): „a scoped reach has no tenant-wide EmployeeScope — resolve an
  explicit employeeId/employeeIds set via contexts/platform/scope-filter.ts first“. Eine
  `wholeTenant`-Reichweite ohne Ziel ergibt weiterhin `{ kind: "tenant", tenantId }` (unverändert).
- **Mitarbeiter-Stammdaten prüfen nur den GÜLTIGKEITSZEITRAUM, nie den Wochentag** (D-12, Plan
  91b-02s eigene, dokumentierte Entscheidung): Ein Einsatzsalon zählt an jedem Tag innerhalb seines
  `validFrom`/`validUntil`-Fensters, auch an einem Wochentag, an dem laut `weekdays` gar nicht dort
  gearbeitet wird — die Frage ist „ist diese Zuordnung heute aktiv“, nicht „arbeitet die Person
  heute dort“.
- **Der Stichtag für `GET /leave/requests`s allgemeine Liste ist HEUTE** (Plan 91b-04s eigene,
  dokumentierte Entscheidung), obwohl die Route keinen eigenen Zeitraum kennt — dieselbe
  Vereinfachung, die D-10 für jede andere Stichtag-lose Listenroute dieser Phase trifft.
- **Ein wiederkehrendes AND-Array-Muster beim Kombinieren zweier Filter auf demselben Feld**
  (mehrfach gefunden und behoben, u. a. `leave.ts:879`, `vocational-school.ts`, `reports.ts`s
  `GET /monthly`, die `getTeamLeaveSubmissions`-Fassade): Ein client-seitig gesetzter expliziter
  Filter (z. B. ein `?employeeId=`) und der aufgelöste Scope-Filter dürfen niemals als zwei Schlüssel
  desselben Feld-Namens in einem Objekt-Spread stehen — der später gespreizte Schlüssel überschreibt
  den früheren still. Das eigentliche Muster ist `AND: [...(x ? [{...}] : []), ...(y ? [{...}] : [])]`,
  nie ein Objekt-Spread mit demselben Feld zweimal.
- **`getTeamLeaveSubmissions()`** (`contexts/absence/facade/leave-requests.ts:568`) bekam einen
  optionalen fünften Parameter `employeeIds?: string[]` (Plan 91b-07) — der erste Entwurf hätte den
  bestehenden `excludeEmployeeId`-Filter durch das AND-Array-Muster oben still überschrieben und den
  aufrufenden Manager wieder in sein eigenes „Team“-Feed aufgenommen, gefangen VOR der Auslieferung.

### Auswirkung auf die Kontexte

- **Zeiterfassung:** `time-entries.ts` (Liste + Einzelrouten, D-09), `retro-entry-requests.ts`
  (D-10, RetroEntryRequest hat kein eigenes `salonId`), `attendance-checker.ts` (vier
  Cron-Empfängersuchen, D-17) scopen jetzt; die Vier-Augen- und Selbstgenehmigungs-Sperren bleiben
  unverändert.
- **Abwesenheiten:** `leave.ts`, `vocational-school*.ts`, `leave-settings.ts` scopen jetzt
  (D-09/D-10); `LeaveRequest`/`Section9Credit` bleiben Stammsalon-only, `carryover-warning.ts`
  bleibt unverändert (MANDANT-Bezug).
- **Schichtplanung:** `shifts.ts` (D-11, sieben Routen inkl. `GET /week`s Drei-Resolver-Aufteilung),
  `salon-assignments.ts` (D-10/D-12) scopen jetzt; `shift-config:manage` bleibt unverändert
  (MANDANT-Bezug).
- **Arbeitszeitkonto:** `overtime.ts` (D-10, alle Einzelrouten), `auto-close-month.ts`/
  `deferred-month-close-reminder.ts` (D-10/D-17, tenantweite Aggregate über mehrere Mitarbeiter,
  EIN Stichtag je Lauf) scopen jetzt.
- **Kompositionsschicht:** `dashboard.ts` (D-09/D-10/D-13, `GET /team-week`/`/today-attendance`/
  `/overtime-overview`), `reports.ts` (D-10, zehn Routen) scopen jetzt; `overtime-trend`s fehlendes
  Gate ist ein eigener, unkorrigierter Fund (siehe oben).
- **Unterbau:** trägt `access-context.ts`, `scope-filter.ts`, die Gate-Änderung in
  `request-permissions.ts`, `resolveScopedHolderIds()` und die neuen Routen in `employees.ts`/
  `avatars.ts`/`availability.ts`/`shift-patterns.ts`/`settings.ts` (D-10/D-12, vorher OHNE jede
  Zeilenfilterung — ein während Plan 91b-10 gefundener, größerer Nachholbedarf, als die
  Ausgangsliste des Issues vermuten ließ).

### Gemessen

- **`requireRole(` außerhalb `compat-role.ts`:** 0 vorher, 0 nachher (unverändert, kein
  Rollenvergleich kam durch diese Phase zurück).
- **`CROSS_TENANT_ACCESS_DENIED`:** 51 Vorkommen in 15 Produktionsdateien, vorher und nachher
  unverändert — diese Phase ändert keine bestehende Mandantengrenzen-Prüfung.
- **`SCOPE_ACCESS_DENIED`:** 0 vorher, 49 Vorkommen in 15 Produktionsdateien nachher (neu, diese
  Phase).
- **`userIdsHoldingPermission(`-Aufrufstellen** (außerhalb der Fassade selbst): 17 vorher, 17
  nachher — nur das VERHALTEN jeder Stelle änderte sich (D-17 engt die Empfängermenge ein, fügt
  keine Aufrufstelle hinzu und entfernt keine).
- **T-100-09-Sonde:** 46 `probe`-Routen vor und nach dieser Phase (unverändert); 33 davon
  mitarbeiterbezogen (`t100-09-oracle-probe.test.ts`s Scope-Sonde, Plan 91b-10), 31 davon jetzt
  scope-geprüft, 2 ausdrücklich ausgenommen (EIGENE-only bzw. kein Permission-Gate).
- **`measure-context-boundary-imports.ts --check 0`:** 56 Ausnahmen/0 Arbeitslast vor und nach
  dieser Phase unverändert.
- **`measure-context-boundary-imports.ts --cycles --check 22`:** 22 Module/1 Komponente vor und
  nach dieser Phase unverändert.
- **Testzahlen** (Reporter, voller API-Lauf, nach dem Merge von `origin/main` `fbf8047b`): 361
  Dateien / 6202 Fälle (6199 bestanden, 3 übersprungen), gegenüber dem Stand vor dieser Phase
  (`40d8cdf2`, Basis dieses Branches) — die Zunahme stammt teils aus `origin/main`s eigenen neuen
  Testdateien (Bundesland/Feiertage pro Salon, Phase 71b), teils aus den in dieser Phase neu
  geschriebenen Scope-Tests.

### Nachrechnen

```bash
grep -rn "requireRole(" apps/api/src --include="*.ts" | grep -v compat-role.ts | grep -v __tests__ | wc -l
grep -rn "CROSS_TENANT_ACCESS_DENIED" apps/api/src --include="*.ts" | grep -v __tests__ | wc -l
grep -rn "SCOPE_ACCESS_DENIED" apps/api/src --include="*.ts" | grep -v __tests__ | wc -l
grep -rn "userIdsHoldingPermission(" apps/api/src --include="*.ts" | grep -v __tests__ | grep -v "facade/role-assignments.ts" | wc -l
pnpm --filter @clokr/api run lint:tenant-scoping
pnpm --filter @clokr/api run lint:t100-09-routes --check
pnpm --filter @clokr/api exec tsx scripts/measure-context-boundary-imports.ts --check 0
pnpm --filter @clokr/api exec tsx scripts/measure-context-boundary-imports.ts --cycles --check 22
pnpm --filter @clokr/api run test:setup && pnpm --filter @clokr/api test:coverage
```

### Nachtrag 2026-09-29 (Issue #367) — SALONS-/PERSONS-Inhaber werden endlich benachrichtigt

**Schwere: informativ. Semantikänderung eines Exports von `contexts/platform/index.ts`
(`userIdsHoldingPermission`) nach ADR 0002, Entscheidung 7, per Owner-Entscheidung vom 2026-09-29
auf dem Issue.**

Dieser Eintrag selbst hatte den Befund unter „Was bewusst NICHT geschah“ nicht benannt — er ergab
sich erst aus der Phase-91b-Testsuite (Docblock von `leave-request-approve-notification-scope.
test.ts`) und wurde als #367 gemeldet: D-17s `resolveScopedHolderIds()` engt eine Kandidatenmenge
ein, fügt aber nie einen Kandidaten hinzu. Weil `userIdsHoldingPermission()` (D-16, unverändert
seit Phase 75b) einen SALONS-/PERSONS-Inhaber nie als Kandidaten lieferte, blieb die Einengung für
diese Nutzer wirkungslos — ein Salonmanager mit Scope Salon A, der seit dieser Phase einen
Urlaubsantrag aus Salon A genehmigen DARF (die Zugriffsentscheidung, D-05), wurde über einen
solchen Antrag nie BENACHRICHTIGT (eine komplett separate Kandidatenquelle).

**Was sich geändert hat:** `userIdsHoldingPermission()`
(`facade/role-assignments.ts:441-500`) akzeptiert jetzt auch eine wohlgeformte SALONS-/
PERSONS-Zuweisung als Kandidatin — aber NUR für eine Permission mit Bezug `PERSON`
(`permission-catalog.ts`), spiegelbildlich zu D-05s `zugewiesen`/`zugewiesenAnyScope`-Trennung in
`request-permissions.ts`. Eine Permission mit Bezug `MANDANT` bleibt auf TENANT-Zuweisungen
beschränkt — unverändert. Ohne diese Bezug-Unterscheidung hätte die Erweiterung
`carryover-warning.ts`s un-narrowte `leave-config:manage`-Abfrage (Bezug MANDANT) sofort mitbetroffen,
obwohl die Owner-Entscheidung ausdrücklich festhält, dass diese eine Stelle ihr Verhalten behält —
gemessen beim Bau der Neutralitäts-Nachträge unten (die erste, bezugs-blinde Fassung dieses Fixes
brach exakt diese Stelle in der Neutralitätsaufzeichnung).

Die Einengung auf den tatsächlichen Salon bzw. die tatsächliche Person übernimmt weiterhin
`resolveScopedHolderIds()` (D-17), unverändert. Von den neun Aufrufer-DATEIEN (17 Aufrufstellen,
siehe Nachrechnen-Block unten) narrowen acht bereits über `resolveScopedHolderIds()`;
`carryover-warning.ts:124` bleibt unverändert, weil `leave-config:manage` Bezug MANDANT hat und die
Fassade selbst dafür keinen SALONS-/PERSONS-Kandidaten mehr liefert (siehe oben) — ein erklärender
Codekommentar an der Aufrufstelle verweist auf diesen Eintrag.

**Empfänger-Neutralitätsaufzeichnung:** `recorded/recipients.json` bleibt byte-identisch. Vier der
17 Stellen ändern ihr tatsächliches Verhalten (die Fixture-Nutzerin `R.salonsScope`, SALONS-Scope
auf den Fixture-Salon mit jeder ZUGEWIESEN-Permission, wird dort neu benachrichtigt) — erfasst über
das bestehende Nachtrags-Register (`recorded/recipients-amendments.json`, von #355 für
`R.admin.exited`/`R.manager.exited` eingeführt): die vier betroffenen Einträge (`#03`, `#05`,
`#10`, `#15`) wurden auf den kumulativen erwarteten Wert aus #355 UND #367 aktualisiert, `from`
unverändert gegen die Aufzeichnung geprüft. Site `#06` (carryover-warning.ts) ist NICHT unter den
geänderten Einträgen — das ist der Nachweis, dass die Bezug-Unterscheidung oben tatsächlich greift.
`NEVER_RECIPIENTS` in `notification-recipients-neutrality.test.ts` verliert `R.salonsScope` als
blanket-Ausschluss; die verbleibenden 13 unveränderten Stellen bleiben durch den unamendierten
`toEqual`-Vergleich gegen die Aufzeichnung abgesichert.

**Guard-Tests:** `user-ids-holding-permission.test.ts` (die vormals D-09 nennende Zeile „a SALONS
or PERSONS assignment ... does not make a holder“ ist jetzt umgekehrt, plus ein neuer Test für eine
fehlgeformte SALONS-Zeile) und `leave-request-approve-notification-scope.test.ts` (das Phase-91b-
Dokument des Befunds selbst — vormals „evidence for the documented finding“, jetzt AK-1/AK-2 des
Issues end-to-end über `POST /leave/requests`). Beide vor dem Fix gegen den unveränderten Code rot
gemessen (mutation proof), danach grün.

**Auswirkung auf die Kontexte** (aus dem Issue übernommen): Zeiterfassung (Zeitnachtrag/Korrektur-
Empfänger ändern sich für Salon-/Personen-Scope), Abwesenheiten (Urlaubs-/Abwesenheitsanträge
ebenso), Schichtplanung (Schichtplan-Benachrichtigungen ebenso), Arbeitszeitkonto
(Monatsabschluss-Benachrichtigungen ebenso, geprüft — `auto-close-month.ts`/`deferred-month-close-
reminder.ts` narrowen bereits über `resolveScopedHolderIds()`), Kompositionsschicht: keine.

### Nachrechnen (Issue #367)

```bash
grep -rln "await userIdsHoldingPermission(" apps/api/src --include="*.ts" | grep -v __tests__ | grep -v "facade/role-assignments.ts" | wc -l   # 9 Aufrufer-Dateien
grep -rn "await userIdsHoldingPermission(" apps/api/src --include="*.ts" | grep -v __tests__ | grep -v "facade/role-assignments.ts" | wc -l    # 17 Aufrufstellen (unverändert seit Eintrag P)
pnpm --filter @clokr/api exec vitest run src/contexts/platform/__tests__/user-ids-holding-permission.test.ts src/__tests__/leave-request-approve-notification-scope.test.ts src/contexts/platform/__tests__/resolve-scoped-holder-ids.test.ts src/contexts/platform/__tests__/resolve-access-reach.test.ts
pnpm --filter @clokr/api run test:setup && pnpm --filter @clokr/api exec vitest run src/__tests__/notification-recipients-neutrality.test.ts
```

### Nachtrag 2026-10-12 (Phase 84, Issue #84) — Stammsalon je Tag als Sammelabfrage; Krankheitstage-Zählung zieht aus der Kompositionsschicht

**Schwere: informativ. Unterbau-Erweiterung (additiv) nach ADR 0002, Entscheidung 7 — angekündigt auf #84.**

Das Dashboard des Inhabers zeigt den Team-Block seit Phase 84 wahlweise für einen einzelnen Salon.
Dafür brauchte es zwei Bausteine, die nicht in die Kompositionsschicht gehören, und ein Lesefeld.

**Was sich geändert hat:**

- `homeSalonsForDays()` (`contexts/platform/facade/salon-assignments.ts`, einziger neuer Export von
  `contexts/platform/index.ts`) ist die Sammelfassung von `homeSalonAt`: der Stammsalon je Person und
  Kalendertag über einen Zeitraum, mit genau EINER Abfrage statt einer je Tag. Die Auflösung (HOME-Zeilen,
  `validFrom` aufsteigend, dann Id; DEPLOYMENT-Zeilen zählen nicht; keine Untergrenze am Eintrittsdatum;
  ein inzwischen deaktivierter Salon antwortet weiter) ist durch einen Paritätstest gegen `homeSalonAt`
  über jeden Tag eines Monats mit Stammsalonwechsel gesichert. `homeSalonAt`, `salonForDay` und
  `contextSalonIds` selbst sind unverändert.
- `getRecordedWorkEntriesInRange()` (Zeiterfassung, Fassade) liefert zusätzlich das Feld `salonId`
  (additiv: kein bestehender Leser muss sich ändern; der Schlüsselsatz ist im Fassadentest festgehalten).
- `sickLeaveDayCounts()` (`contexts/absence/sick-leave-days.ts`, über den Absence-Index) zählt die
  Krankheitstage und zog dafür aus `composition/reports.ts` in den Abwesenheiten-Kontext um — eine
  Fachregel gehört nicht in die Kompositionsschicht (ADR 0002, Entscheidung 9). Der Bericht
  `/reports/monthly` (JSON und beide PDFs) ruft sie unverändert auf; sein Ergebnis ist durch ein
  eingefrorenes Literal aus der Zeit VOR dem Umzug festgehalten
  (`reports-monthly-frozen-84.test.ts`). Optional nimmt sie ein Prädikat je Tag (`countsDay`), mit dem
  das Dashboard einen Tag dem Stammsalon dieses Tages zuordnet.
- Die Abwesenheiten-Fassade bekam `getApprovedLeaveEndingOnOrAfter()` (genehmigter Urlaub, der heute
  oder später endet) für `GET /dashboard/team-upcoming-leave`. Die Untergrenze ist seitdem der
  Kalendertag in der Zeitzone des Mandanten statt des UTC-Datums; das ist die tatsächliche Änderung
  gegenüber der bisherigen Liste (`/leave/requests?status=APPROVED&upcoming=true`), sichtbar zwischen
  22 und 24 Uhr UTC im Sommer. Ein Antrag, der heute endet, steht in beiden Listen. (Die Begründung
  in der Entscheidung D-18, `endDate >= new Date()` verwerfe einen heute endenden Antrag nach 00:00
  UTC, war ungenau: Prisma vergleicht bei `@db.Date` den Kalendertag.)
- Kompositionsschicht: `GET /dashboard/team-trend` und `GET /dashboard/team-upcoming-leave` sind neu,
  `GET /dashboard/team-week` nimmt optional `salonId` an. Alle drei prüfen `salonId` im modulprivaten
  `resolveTeamSalonFilter()` (aktiv, gleicher Mandant, innerhalb der Team-Übersichts-Reichweite des
  Aufrufers; jede Ablehnung ist derselbe 404-Körper). Es entsteht keine eigene Fachregel in der
  Schicht: Ist kommt aus `computeMonthReportFigures` bzw. den erfassten Einträgen, Krankheitstage aus
  `sickLeaveDayCounts`, der Stammsalon je Tag aus `homeSalonsForDays`.

**Auswirkung auf die Kontexte:**

- Zeiterfassung: nur das zusätzliche Feld `salonId` im Lesezugriff auf erfasste Einträge.
- Abwesenheiten: die Krankheitstage-Zählung (`sickLeaveDayCounts`) und der neue Lesezugriff
  `getApprovedLeaveEndingOnOrAfter`; Genehmigung, Anspruch und Übertrag unberührt.
- Schichtplanung: keine.
- Arbeitszeitkonto: keine (nur Leser von `computeMonthReportFigures`; `calcLeaveAbsenceMinutesTz` und
  die einmalige Soll-Minderung pro Tag sind nicht berührt).
- Kompositionsschicht: drei Dashboard-Endpunkte mit `salonId`, keine eigene Regel; die
  Krankheitstage-Regel verlässt die Schicht.

**Was bewusst NICHT geschah:**

- Kein Schlüssel, der Soll oder Saldo auf Salons aufteilt: beides sind Vertragsgrößen. Unter einem
  Salonfilter sind sie `null` mit `sollUnavailableReason` `SALON_FILTER`; ohne Filter entsprechen die
  Werte dem Monatsbericht, einschließlich der Berufsschul-Gutschrift, die keinem Salon zugeordnet wird.
- Kein Salonfilter in `/reports` (Monatsbericht, Anwesenheit heute, Saldenübersicht) — als eigenes
  Folge-Issue erfasst, nicht Teil dieser Phase.
- Keine Änderung von `homeSalonAt`, `salonForDay` oder `contextSalonIds`, keine Semantikänderung eines
  bestehenden Unterbau-Exports.
- Die Reichweite eines Salonmanagers bleibt unverändert nach 91b D-09/D-10 (Stammsalon-Personen sind
  samt ihrer in anderen Salons erfassten Stunden sichtbar); die Prüfung je Zeiteintrag gehört zu #85.
  Die drei neuen Pfade sind dort als zu überprüfen vermerkt.
- Die Anwesenheitsanzeige und die Feiertage nutzen weiterhin ALLE Einträge einer Person, damit ein
  Tag in einem anderen Salon kein falsches „Fehlt“ erzeugt.

### Nachrechnen (Issue #84)

```bash
pnpm --filter @clokr/api run lint:facade-signatures   # 134 Funktionen (132 vor Phase 84, +homeSalonsForDays, +getApprovedLeaveEndingOnOrAfter)
pnpm --filter @clokr/api run test:setup && pnpm --filter @clokr/api exec vitest run src/contexts/platform/__tests__/home-salons-for-days-84.test.ts src/contexts/absence/__tests__/sick-leave-days.test.ts src/composition/__tests__/reports-monthly-frozen-84.test.ts src/composition/__tests__/dashboard-team-week-frozen-84.test.ts src/composition/__tests__/dashboard-team-trend-84.test.ts src/composition/__tests__/dashboard-team-salon-filter-84.test.ts src/__tests__/dashboard-salon-manipulation-84.test.ts
grep -n "resolveTeamSalonFilter" apps/api/src/composition/dashboard.ts   # Definition + drei Aufrufe
```

### Nachtrag 2026-10-13 (Phase 85b, Issue #85 und #547) — Prüfung je Eintrag in den Dashboard-Teampfaden; Mitarbeiterliste nach Stammdatenregel; ein Prüfer für die Salonwahl

**Schwere: Umkehr einer in Phase 84 ausdrücklich als vorläufig vermerkten Aussage; Unterbau-Erweiterung
(additiv) nach ADR 0002, Entscheidung 7 — angekündigt auf #85. Keine Schemaänderung, keine Migration, keine
neue Route, keine neue Katalog-Permission.**

Phase 84 beließ die Reichweite eines Salonmanagers nach 91b D-09/D-10 (Stammsalon-Personen samt ihrer in
anderen Salons erfassten Stunden sichtbar) und vermerkte die Prüfung je Zeiteintrag als „bis #85“ offen.
Phase 85b schließt diese Lücke und hebt die Aussage für die Dashboard-Pfade auf.

**Was sich geändert hat:**

- **Prüfung je Eintrag (D-04 bis D-06).** Für eine eingeschränkte Reichweite (nicht der ganze Mandant) bauen
  `GET /dashboard/team-week`, `/today-attendance` und `/team-trend` ihre Zahlen nur aus Einträgen, die der
  Aufrufer sehen darf (`scopedTimeEntryIds`, Einträge über die Fassadenfunktion
  `getRecordedWorkEntriesByIds`). Die Personenmenge ist die der Stammsalon-Personen vereinigt mit den
  Personen, die einen sichtbaren Eintrag haben; Planungsdaten (Schichten, Vertrag, Urlaub, Feiertage) werden
  weiter nur für die Stammsalon-Personen gelesen. Zeit, die der Aufrufer nicht sehen darf, erscheint als
  neutrales `workedElsewhere` und nie als laufende Einstempelung. Das Konto-Ist (`computeMonthReportFigures`)
  gilt nur für einen Personenmonat, dessen Einträge alle in Reichweite liegen; sonst steht die Summe der
  sichtbaren Einträge da, `workedBasis` ist `SCOPE_ENTRIES`, das Soll `null` mit `sollUnavailableReason`
  `SCOPE_ENTRIES`. Ganzmandanten-Aufrufer laufen über unveränderte Anweisungen (eingefrorene Pins aus Phase
  84 und `whole-tenant-frozen-85.test.ts`). Die in Phase 84 festgehaltenen Zusicherungen, dass ein in B
  beheimateter Springer mit einem A-Eintrag dem Manager von A nicht gezeigt wird, sind bewusst umgekehrt und
  in den Kopfzeilen der betroffenen Tests als Nachtrag vermerkt.
- **Mitarbeiterliste (#547).** `GET /employees` verengt eine eingeschränkte `employee:read`-Reichweite mit
  derselben Stammdatenregel wie die Einzelansicht (`resolvePersonScopedEmployeeIds`, Phase 91b D-12) und
  nimmt die eigene Zeile hinzu. `overtimeAccount.balanceHours` steht nur noch unter einer `overtime:read`-
  Reichweite, die die Person abdeckt, sonst `null`. Eine neue Handler-Prüfung, keine neue Permission.
- **Berichtigung (Plan 85b-15, Verifikationsbefund).** Die Aussage in #547 und im ersten Wortlaut dieses
  Nachtrags, die Einzelansicht sei „bereits eingeschränkt“, stimmte nur für die Personenregel, **nicht für
  das Saldo-Feld**: `GET /employees/:id` lieferte `overtimeAccount.balanceHours` ungefiltert an jeden Aufrufer
  mit `employee:read` im Scope — die Maske der Liste ließ sich durch Einzelabrufe umgehen. Plan 85b-15
  schließt das: ein modulprivates Paar (`resolveBalanceVisibility`, `maskOvertimeAccount` in
  `contexts/platform/api/employees.ts`) entscheidet das Saldo für `GET /employees`, `GET /employees/:id` und
  die Antwort von `PATCH /employees/:id/reactivate` (die einzige PATCH-Antwort mit `overtimeAccount`; die
  Antwort von `PATCH /employees/:id` selbst enthält kein Konto). Verdeckt bleibt `null`, nie 0; Ganzmandanten-
  Aufrufer und die Person selbst erhalten die unveränderte Antwort. Die Antwort von `POST /employees` zeigt
  ein frisch angelegtes Konto mit 0 und gibt damit keinen gespeicherten Wert preis.
- **Überstundensaldo im Antragsdialog (Plan 85b-16, Verifikationsbefund).** `GET /leave/overtime-balance`
  (Phase 415, #415) lieferte das Live-Gesamtsaldo einer gewählten Person an jeden Aufrufer mit
  `leave-entitlement:read:ZUGEWIESEN` im Stammsalon-Scope, also auch an einen Salonmanager — ein dritter Weg
  um die Saldo-Regel vom 27.08.2026 (Gesamtsaldo nur Inhaber, Personalabteilung, die Person selbst). Jetzt
  fragt der Handler zusätzlich `overtime:read` (modulprivat `callerMaySeeSaldoOf` in
  `contexts/absence/api/leave.ts`, dieselbe Stammsalon-Abdeckung wie `GET /overtime/:employeeId`). Ohne
  Abdeckung sind `balanceHours`, `confirmedMinutes`, `openMonthMinutes`, `hasClosedMonth` und
  `isNegativeLimitExceeded` `null` und `balanceVisible` ist `false`; das Vorzeichen des Saldos wird auch über
  `isNegativeLimitExceeded` nicht verraten. Die konfigurierte Toleranz (`maxNegativeBalanceMinutes`) bleibt,
  sie ist Mandantenkonfiguration. Die Person selbst und Aufrufer mit abdeckender Reichweite erhalten die
  Zahlen mit `balanceVisible: true`. Die serverseitige OVERTIME_COMP-Prüfung bei Antrag und Genehmigung liest
  diesen Endpunkt nicht und bleibt unverändert; der Dialog zeigt statt der Zahlen „Saldo nicht einsehbar – die
  Prüfung erfolgt beim Speichern.“ und trifft keine Grenzentscheidung auf verdeckten Daten. Eine neue
  Handler-Prüfung, keine neue Permission (`docs/permissions.md`, Handler-Prüfungen).
- **Salonansicht (D-08, D-13).** `GET /time-entries` nimmt optional `salonId` mit `from` und `to` (höchstens
  31 Tage) und liefert alle sichtbaren Einträge dieses Salons für alle Personen; nur unter
  `time-entry:read:ZUGEWIESEN`.
- **Ein Prüfer für die Salonwahl.** `resolveSalonInReach()` (`contexts/platform/facade/salons.ts`, additiver
  Export von `contexts/platform/index.ts`) ersetzt das modulprivate `resolveTeamSalonFilter()` des Dashboards
  und wird von den drei Dashboard-Endpunkten und der Salonansicht aufgerufen: der Salon muss aktiv sein, zum
  Mandanten gehören und in der Reichweite des Aufrufers liegen; jede Ablehnung ist derselbe 404-Körper vor
  jedem Lesen.
- **Web.** `/team/time-entries` bekommt die Salonansicht; die Salonwahl dort entscheidet allein
  `teamSalonViewSalon()`. Eine Benachrichtigung für eine Person außerhalb der verengten Liste öffnet die
  Salonansicht des verlinkten Monats. Eine Rolle ohne Saldo-Recht sieht die Personenansicht ohne
  Saldo-Karten, nur mit Ist.

**Auswirkung auf die Kontexte:**

- Zeiterfassung: die Fassade bekam `getRecordedWorkEntriesByIds` (Lesezugriff nach Kennung, mandantengebunden,
  in Stücken); `GET /time-entries` bekam die Salonansicht; Speicherantworten zeigen Warnungen nur noch im
  Rahmen der Reichweite des Lesers (siehe Eintrag X, Nachtrag Phase 85b).
- Abwesenheiten: keine.
- Schichtplanung: keine. Schichten fremder Salons in der Wochenübersicht bleiben #548.
- Arbeitszeitkonto: keine; `computeMonthReportFigures` wird nur unter der Bedingung „alle Einträge des
  Personenmonats in Reichweite“ weiter aufgerufen, `calcLeaveAbsenceMinutesTz` und die einmalige
  Soll-Minderung pro Tag sind nicht berührt.
- Kompositionsschicht: das Dashboard ruft den Prüfer des Unterbaus auf und teilt die Zeilen je Eintrag
  (`team-entry-scope.ts`, ohne Datenbankzugriff, eigene Regel für Salon oder Stammsalon entsteht nicht).

**Was bewusst NICHT geschah:**

- Keine Änderung an `scope-filter.ts`, an `homeSalonAt`, `salonForDay` oder `contextSalonIds`; keine
  Semantikänderung eines bestehenden Unterbau-Exports.
- Kein Salonfilter in `/reports` (#542) und keine Schichten fremder Salons in der Wochenübersicht (#548).
- Soll und Saldo werden weiter nicht auf Salons aufgeteilt.
- Die Neutralitätsmatrix wurde nicht neu aufgenommen.

### Nachrechnen (Nachtrag Phase 85b)

```bash
pnpm --filter @clokr/api run lint:facade-signatures   # 137 Funktionen (135 vor Phase 85b, +resolveSalonInReach, +getRecordedWorkEntriesByIds), 17 Ausnahmen
pnpm --filter @clokr/api run test:setup && pnpm --filter @clokr/api exec vitest run src/__tests__/whole-tenant-frozen-85.test.ts src/__tests__/employees-list-scope-85.test.ts src/contexts/platform/__tests__/resolve-salon-in-reach-85.test.ts src/__tests__/time-entries-salon-view-85.test.ts src/composition/__tests__/team-entry-scope.test.ts src/composition/__tests__/dashboard-entry-scope-85.test.ts src/__tests__/cross-salon-springer-85.test.ts src/__tests__/dashboard-salon-manipulation-84.test.ts src/composition/__tests__/dashboard-team-trend-84.test.ts src/composition/__tests__/dashboard-team-week-frozen-84.test.ts
grep -n "resolveSalonInReach(" apps/api/src/composition/dashboard.ts apps/api/src/contexts/time-tracking/api/time-entries.ts   # drei Aufrufe im Dashboard, einer in der Salonansicht
```

### Nachtrag 2026-10-13 (Issue #548) — Schichten in der Wochenübersicht je Schicht nach Reichweite

**Schwere:** Fehlerbehebung; keine Unterbau-Änderung; keine Schema-, Migrations-, Routen- oder
Permission-Änderung; ergänzt die 85b-Aussage „Planungsdaten nur für Stammsalon-Personen“ für
Schichten.

**Was sich geändert hat:**

- `GET /api/v1/dashboard/team-week` wendet `isShiftInScope` (Phase 91b D-11: eigener Salon der
  Schicht oder Person in der Reichweite, nie das Stammsalon) je Schicht an. Vorher las die Route die
  Schichten der Stammsalon-Personen ohne `salonId`; ein Salonmanager von A sah Zeit, Bezeichnung und
  Farbe einer Salon-B-Schicht einer in A beheimateten Person und ein daraus abgeleitetes „Fehlt“
  oder „Geplant“.
- Schichten werden für jede gelistete Person gelesen, auch für eine nur über einen sichtbaren
  Eintrag gelistete Person (85b D-04); sie sieht nur Schichten in der Reichweite.
- Ein Tag mit nur fremder Schicht sieht aus wie ein Tag ohne Schicht: kein `shift`, kein
  SHIFT_BASED-Arbeitstag, keine Fälligkeitszeit. `expectedHours` bleibt der Vertragswert, ein neuer
  Antwortschlüssel oder Marker wird bewusst nicht eingeführt: eine verdeckte Schicht kann kein
  falsches „Fehlt“ erzeugen (anders als verdeckte Arbeitszeit, die `workedElsewhere` braucht), und
  ein Marker würde den fremden Plan verraten (Art. 5 Abs. 1 lit. c DSGVO).
- Eine nur über einen Eintrag gelistete Zeile wird nie „Fehlt“, weil die Abwesenheitsgründe
  (Urlaub, Krankheit, Berufsschule, Arbeit in einem anderen Salon) beim Stammsalon liegen und
  zurückgehalten werden; eine noch nicht fällige Schicht in Reichweite ergibt „Geplant“.
- Ganzmandanten-Aufrufer sind unverändert (gleiche Personenliste, gleiche Antwort), belegt durch
  die eingefrorenen Pins `dashboard-team-week-frozen-84` und `whole-tenant-frozen-85`.

**Auswirkung auf die Kontexte:**

- Zeiterfassung: keine.
- Abwesenheiten: keine.
- Schichtplanung: `getShiftsInRange` liefert zusätzlich `salonId`; additiv, keine Signaturänderung,
  kein bestehender Leser ändert sich.
- Arbeitszeitkonto: keine; liest das Feld nicht, der Token-Wächter aus Phase 68b/71b bleibt
  unberührt.
- Kompositionsschicht: team-week ruft den Prüfer des Unterbaus; today-attendance liest keine
  Schichten, my-week und open-items nur eigene.

**Was bewusst NICHT geschah:**

- Vertrag, Urlaub, Abwesenheiten und Feiertage einer nur über einen Eintrag gelisteten Person
  bleiben zurückgehalten (85b D-04).
- Kein neuer Antwortschlüssel, kein Marker „anderswo geplant“.
- Keine Änderung an `scope-filter.ts`.

### Nachrechnen (Nachtrag Issue #548)

```bash
pnpm --filter @clokr/api run test:setup && pnpm --filter @clokr/api exec vitest run src/composition/__tests__/dashboard-shift-scope-548.test.ts src/composition/__tests__/dashboard-team-week-frozen-84.test.ts src/__tests__/whole-tenant-frozen-85.test.ts
pnpm --filter @clokr/api run lint:facade-signatures   # meldet weiterhin 137 Funktionen
```

### Nachtrag 2026-10-16 (Phase 558, Issue #558) — Salonauswahl wirkt auf Personenlisten, Team-Kalender, Team-Anträge und Schichtplanung; `planning-overview` geprüft

**Schwere: Unterbau-Erweiterung (additiv) nach ADR 0002, Entscheidung 7 — angekündigt auf #558; eine
Geschäftsregel zieht aus der Kompositionsschicht in Abwesenheiten (die Zuordnung „Stammsalon pro Tag“); eine
bewusste Verschärfung zweier aufgezeichneter Tests. Keine Schemaänderung, keine Migration, keine neue Route,
keine neue Katalog-Permission, keine Neuaufnahme der Neutralitätsmatrix.**

Vor Phase 558 nahmen nur drei Endpunkte `salonId` an (`GET /time-entries`, `/time-entries/summary`,
`/shifts/planning-overview`); alle anderen Seiten luden ihre Personen und Zeilen ohne Salonbezug, die
Salonauswahl der Kopfleiste wirkte nur auf das Dashboard und die Salonansicht (#84, #85). Phase 558 dehnt sie
auf die Team- und Planungsseiten aus. Die Auswahl bleibt Darstellung, nie Zugriffsgrenze (#82).

**Was sich geändert hat:**

- **Ein Parameter, sechs Endpunkte.** `GET /employees`, `GET /leave/requests`, `GET /leave/calendar`,
  `GET /leave/ical/team`, `GET /leave/section9` und `GET /shifts/week` nehmen ein optionales `salonId` an
  (ungültige Kennung: 400 durch die globale Fehlerbehandlung). `resolveSalonInReach()` prüft es gegen die
  Reichweite der eigenen Permission des Endpunkts vor jedem Lesen; inaktiver, fremder, unbekannter und
  nicht erreichbarer Salon sowie ein Aufrufer mit nur eigener Datenreichweite erhalten dieselbe 404
  (`{ "error": "Salon nicht gefunden" }`, byte-identisch mit Dashboard und Salonansicht, T-100-09). Ohne
  `salonId` laufen die Anweisungen unverändert (eingefrorene Pins und Neutralitätsmatrix bleiben ohne
  Nachtrag grün).
- **Das eine Prinzip.** `salonOnlyReach(salonId)` (`contexts/platform/access-context.ts`, additiver Export
  von `contexts/platform/index.ts`) ist der einzige Konstruktor einer Salon-Reichweite. Der Filter eines
  Endpunkts ist dessen eigener Reichweiten-Auflöser, ausgewertet, als erreiche der Aufrufer nur diesen Salon,
  geschnitten mit der echten Reichweite des Aufrufers. Der Filter kann deshalb nur verengen, nie erweitern
  (D-01). Der Export prüft nichts und liest nichts; der Salon muss `resolveSalonInReach` bereits passiert haben.
- **Personen nach der Stammdatenregel (91b D-12).** Die Personenmenge unter einem Filter ist
  `resolvePersonScopedEmployeeIds(salonOnlyReach(X))` geschnitten mit der Personenmenge des Aufrufers
  (Stammsalon heute oder aktiver Einsatz). Die eigene Zeile folgt dem Filter: Unter `salonId` steht sie nur
  dort, wo der Aufrufer selbst nach der Stammdatenregel zum Salon gehört; ohne Filter bleibt die
  #547-Regel unverändert.
- **Schichten nach ihrem Salon (91b D-11).** `GET /shifts/week` hängt die Schichtbedingung
  `shiftScopeWhere(salonOnlyReach(X))` als `AND` an die unveränderte Bedingung des Aufrufers: der eigene Salon
  der Schicht entscheidet, nie der Stammsalon. Die Besetzungsprüfung läuft über die gefilterten Schichten.
- **Abwesenheiten nach dem Stammsalon pro Tag, eine Funktion.** `filterLeaveRowsToHomeSalon()`
  (`contexts/absence/salon-leave-attribution.ts`, exportiert über `contexts/absence/index.ts`) ist der einzige
  Ort dieser Zuordnung. Sie wurde aus dem Dashboard (`team-upcoming-leave`, #84) herausgelöst, das sie seitdem
  aufruft; die Schleife in `composition/dashboard.ts` ist entfernt. Eine Zeile bleibt, wenn der Stammsalon
  der Person an mindestens einem Tag der (auf ein optionales Fenster beschnittenen) Zeile der gewählte Salon
  ist; ein Stammsalonwechsel mitten im Zeitraum zeigt die Zeile in beiden Salons, ein Kalenderjahrwechsel
  wird je Jahr gebündelt, `homeSalonsForDays` wird je Bündel einmal gerufen. Die vier Lesewege nutzen sie:
  `/leave/requests` (vor § 9-, Audit- und Berufsschul-Bündellesungen, damit diese nur behaltene Zeilen sehen),
  `/leave/calendar` (mit Kalendertag-Grenzen, #493), `/leave/ical/team` (Anträge und aufgezwungene
  Abwesenheiten je eigenem Bereich) und `/leave/section9` (§ 9-Fälle nach dem Überlappungsbereich, nicht nach
  dem Bereich des Krankheits- oder Urlaubsantrags: der Fall ist die angezeigte Einheit, und #644 entscheidet
  die Reichweite bereits am Beginn des Überlappungsbereichs).
- **§ 9 und #644.** `GET /leave/section9` ist seit #644 (PR #646) reichweitenbeschränkt; der Salonfilter setzt
  darauf auf und schneidet die Fälle zusätzlich mit dem Salon, er ersetzt die Reichweitenprüfung nicht.
- **Soll unter dem Filter.** Unter einem Filter läuft die Soll-Schleife von `GET /shifts/week` nicht;
  `contractSollMinutesByEmp` ist `null`, `sollUnavailableReason` ist `"SALON_FILTER"` (wie beim Dashboard,
  Soll und Saldo werden nie nach Salon aufgeteilt). Ohne Filter ist der Schlüssel an derselben Stelle der
  Antwort und die JSON-Ausgabe byte-identisch.
- **`planning-overview` geprüft (D-07).** `GET /shifts/planning-overview` prüft `salonId` jetzt durch
  `resolveSalonInReach` gegen die Reichweite von `shift:plan`: ein nicht erreichbarer, fremder, unbekannter
  oder inaktiver Salon ergibt die identische 404 statt 200 mit leerer Liste. Die Population bleibt unverändert
  (Stammsalon am `weekStart`, jetzt über `resolveStammsalonScopedEmployeeIds` mit `salonOnlyReach` statt einer
  eigenen `employeeSalonAssignment`-Abfrage in der Route). **Zwei aufgezeichnete Tests wurden bewusst
  strenger:** `salon-context-manipulation-82.test.ts` (Manager-B-Fall und Fremd-/Unbekannt-Fall, jeweils
  200 → 404 mit Literal-Körper, im Kopf als „Amendment Issue #558 D-07“ vermerkt) und
  `shifts-planning-overview.test.ts` (Fall 430-05: 200 + `[]` → 404, rohe Körper gleich, Körper gleich dem
  Literal, die Kennung der fremden Person nicht im Körper). Keine Erwartung wurde ersatzlos entfernt.
- **Web.** Die Seiten Admin-Mitarbeiterliste, Team-Zeiten (nur die Personenauswahl; der Monat der gewählten
  Person bleibt vollständig, weil Soll und Saldo nicht geteilt werden), Team-Kalender, Team-Anträge
  (Jahresliste, Genehmigungswarteschlange, Kalender, § 9, iCal), Schichtplanung und Planungsbedarf senden den
  Salon der Kopfleiste und laden bei einem Wechsel neu. Entschieden wird allein durch `salonPageFilter()`
  (`apps/web/src/lib/salons/page-scope.ts`, dieselbe Funktion wie `teamSalonFilter()`, kein Blick auf die
  rohe Auswahl des Speichers); angezeigt wird der Bezug durch einen Baustein, `SalonScopeLabel.svelte`
  („Salon: Name“ oder „Alle Salons“); eine abgelehnte Auswahl (404) zeigt einen ruhigen Text, keinen Fehler,
  und blendet die Leerzustände aus. Jeder Lader trägt einen Generationszähler, damit eine ältere Antwort eine
  neuere nie überschreibt. Schlägt das Laden einer Liste aus einem anderen Grund als 404 fehl, leert sich die
  Auswahlliste, statt die Liste des vorigen Salons unter dem neuen Etikett zu zeigen.
- **Die Fallen von `/shifts`.** Das Soll steht durch den Code der Antwort (`SALON_FILTER`), nie durch den
  Zustand des Filters im Web. Eine neu angelegte Schicht (Ziehen und Dialog) trägt den gewählten Salon
  ausdrücklich (`salonId` im Anlegen, nie im Ändern). „Woche erzeugen“ und „Woche kopieren“ wirken weiter auf
  die ganze Reichweite und sagen es, solange ein Salon gewählt ist („Diese Aktion gilt für alle Salons Ihrer
  Reichweite, nicht nur für den gewählten Salon.“); `generate-week` und `copy-week` sind unverändert.

**Nicht gefiltert, mit Begründung** (je Seite als Quellprüfung in `salon-filter-exempt-pages-558.test.ts`
festgehalten): Posteingang (eine Arbeitsliste darf keinen fälligen Antrag verstecken), Schichtkonflikte (#645,
die Gruppen sind nur mandantenweit; ein Filter würde einen unbeschränkten Lesepfad nur schmücken),
Monatsabschluss (mandantenweite Aktion), Protokoll (revisionssicher, nicht salonbezogen), Konfigurationsseiten
mit ihren Auswahllisten (Verfügbarkeiten, Betriebsurlaub, Phorest-Zuordnung, Integrationen, Schichtvorlagen und
Besetzungsregeln), `/admin/salons` (ist selbst die Salonverwaltung), persönliche Seiten und die
Überschneidungsprüfung im Prüfdialog (Entscheidungshilfe). Berichte: #542.

**Auswirkung auf die Kontexte:**

- Zeiterfassung: keine. `GET /time-entries` filtert seit #85; die Team-Zeiten-Seite verengt nur ihre
  Personenauswahl.
- Abwesenheiten: vier Lesewege nehmen `salonId` an; die Zuordnung „Stammsalon pro Tag“ ist eine Funktion
  (`filterLeaveRowsToHomeSalon`), das Dashboard ruft sie.
- Schichtplanung: `GET /shifts/week` nimmt `salonId` an, `GET /shifts/planning-overview` prüft es; an den
  Besetzungsregeln und am Algorithmus ändert sich nichts.
- Arbeitszeitkonto: keine. Soll und Saldo werden nie geteilt, `calcLeaveAbsenceMinutesTz` und die einmalige
  Soll-Minderung pro Tag sind nicht berührt.
- Kompositionsschicht: keine neue Regel; das Dashboard ruft die herausgelöste Funktion statt einer eigenen
  Schleife; die Geschäftsregel steht nicht mehr in der Kompositionsschicht.
- Unterbau: ein neuer reiner Export `salonOnlyReach`; kein bestehender Leser ändert sich, keine
  Semantikänderung eines Exports.

**Was bewusst NICHT geschah:**

- #645 (Schichtkonflikte ohne Reichweite) ist nicht behoben; der Salonfilter ist nicht ihre Behebung und
  `GET /shifts/conflicts` bleibt ungefiltert. #644 (`GET /leave/section9` ohne Reichweite) ist durch PR #646
  behoben; der Filter setzt auf dieser Reichweite auf.
- `GET /leave/calendar` bleibt für Aufrufer ohne Vollzugriff mandantenweit, typmaskiert wie zuvor; unter einem
  Filter zeigt er weiterhin die Feiertage des Arbeitsorts des Anfragenden.
- Berichte (#542) bekommen keinen Salonfilter.
- Mindestbesetzung je Salon (Folge-Issue #647): `CoverageRule` hat keinen Salonbezug, unter einem Filter
  gelten die mandantenweiten Regeln für die Schichten des Salons.
- Keine Änderung an `generate-week` / `copy-week`, an `scope-filter.ts`, `homeSalonAt`, `salonForDay` oder
  `contextSalonIds`; kein Eingriff in das Soll, keine Neuaufnahme einer Neutralitätsaufzeichnung, keine Änderung
  am Route-Surface-Golden oder am T-100-09-Register.
- Zwei Darstellungsbefunde der Sichtprüfung (angeschnittener Wochenpfeil in `/shifts`, abgeschnittene
  E-Mail-Spalte in `/admin/employees` bei 360 px) bestanden vorher und sind als #648 erfasst.

**Gemessen** (Quelle: die SUMMARY-Dateien 558-01 bis 558-06): vier neue API-Testdateien
(`employees-list-salon-filter-558`, `leave-salon-filter-558`, `salon-leave-attribution-558`,
`shifts-week-salon-filter-558`), drei geänderte (`access-context`, `salon-context-manipulation-82`,
`shifts-planning-overview`) und neun neue Web-Testdateien (sieben Quellprüfungen der Seiten und der ausgenommenen Seiten, `page-scope`
und `SalonScopeLabel`); 22
Mutationsnachweise, jeder im Kopf der zugehörigen Testdatei vermerkt (die Datei wurde nach der Mutation
byte-gleich wiederhergestellt). Sichtprüfung: 28 Aufnahmen (sechs Seiten mal 390 und 360 px mal hell und
dunkel, dazu die abgelehnte Auswahl), jede gelesen; zwei echte Mängel des Bausteins gefunden und in einem
Commit behoben (der ruhige Text war als Warnung gestaltet und verfehlte WCAG AA, 4,06 : 1; der Baustein hatte
keinen Abstand nach unten). Die übrigen axe-Funde auf diesen Seiten bestanden vorher (Eyebrow, Kalenderzellen,
Gantt-Kopf; siehe #636) und werden durch den Baustein weder verursacht noch verändert, gemessen als
Gleichstand der Knoten mit und ohne Baustein auf derselben Seite.

### Nachrechnen (Nachtrag Phase 558)

```bash
pnpm --filter @clokr/api run test:setup && pnpm --filter @clokr/api exec vitest run src/__tests__/employees-list-salon-filter-558.test.ts src/__tests__/leave-salon-filter-558.test.ts src/contexts/absence/__tests__/salon-leave-attribution-558.test.ts src/__tests__/shifts-week-salon-filter-558.test.ts src/contexts/platform/__tests__/access-context.test.ts src/__tests__/salon-context-manipulation-82.test.ts src/contexts/scheduling/api/__tests__/shifts-planning-overview.test.ts src/__tests__/section9-reach-644.test.ts src/composition/__tests__/dashboard-team-salon-filter-84.test.ts
pnpm --filter @clokr/api exec vitest run src/__tests__/permission-neutrality-matrix.test.ts   # unverändert grün, ohne Nachtrag
pnpm --filter @clokr/web exec vitest run src/__tests__ src/lib/salons src/lib/components/team
grep -c "homeSalon === filterSalonId" apps/api/src/composition/dashboard.ts   # 0: die Zuordnung steht nur noch in Abwesenheiten
grep -c "employeeSalonAssignment" apps/api/src/contexts/scheduling/api/shifts.ts   # 0: planning-overview liest über den Unterbau
```

### Nachtrag 2026-10-17 (Phase 587, Issue #587) — Ein Tagesstatus für Team-Woche und Anwesenheitsliste

**Schwere:** Fehlerbehebung; keine Unterbau-, Schema-, Migrations-, Routen- oder Permission-Änderung. Die
Antwort der Heutigen Anwesenheit bekommt zwei additive Felder je Zeile (`expectedStart`, `lateMinutes`); die
Antwort der Team-Woche bleibt Schlüssel für Schlüssel gleich (eingefrorener Pin `dashboard-team-week-frozen-84`).

Vor Phase 587 hielten `GET /dashboard/team-week` und `GET /dashboard/today-attendance` je eine eigene Kopie der
Statusfolge aus Pflicht (`isObligatedWorkday`), Fälligkeit (`isDayDue`) und Zustand (`resolvePresenceState`).
Die Anwesenheitsliste fest verdrahtete „heute ist nie in der Zukunft“ und „keine Schicht“, las weder offene
Urlaubsanträge noch Berufsschule noch Feiertage nach Arbeitsort und meldete deshalb dieselbe Person am selben
Tag als „Fehlt“, während die Team-Woche „Geplant“ zeigte. Die beiden eingefrorenen Tests desselben Zeitpunkts
(Mittwoch 17.06.2026, 12:00 Uhr Ortszeit) widersprachen sich entsprechend.

**Was sich geändert hat:**

- `resolveDayStatus()` (`contexts/time-tracking/presence.ts`, über `index.ts`) ist die einzige Stelle, die
  Pflicht, Fälligkeit und Zustand kombiniert. Sie ist rein (kein Prisma, keine Uhr, keine Zeitzonenbibliothek)
  und bekommt mandantenlokale Strings und bereits aufgelöste Tatsachen. Die Definition eines Arbeitstags bleibt
  in `presence.ts` unverändert. Die Funktion steht in `presence.ts` und nicht in einem eigenen Modul, weil ein
  eigenes Modul über `../absence` in den gemessenen Importzyklus geraten wäre (Schranke 22 von
  `measure-context-boundary-imports.ts --cycles --check`, die nicht angehoben wird).
- Beide Handler in `composition/dashboard.ts` bilden die Eingaben über dieselben modulprivaten Hilfsfunktionen
  (P-01): Urlaub des Tages (offene Anträge eingeschlossen, die nicht beantragte Zeile hat Vorrang),
  Berufsschul-Verdrängung (die Regel bleibt bei Abwesenheiten, `vocationalSchoolDisplacesLeave`), erste Schicht
  des Tages innerhalb der Reichweite (`isShiftInScope`), Vertrag des Tages, Platzhalter für verdeckte Zeiten
  (#85) und die Eintragsregel für nur über einen Eintrag gelistete Personen (#548).
- Die Anwesenheitsliste liest damit wie die Team-Woche Schichten in der Reichweite, offene Anträge
  (Status „requested“, in der Oberfläche „Beantragt“), die Berufsschul-Verdrängung und Feiertage am Arbeitsort.
  Der Satz des Nachtrags zu #548 „today-attendance liest keine Schichten“ gilt damit nicht mehr; die Schichten
  werden je Schicht nach `isShiftInScope` gefiltert (Phase 91b D-11), eine verdeckte Schicht liest sich wie
  ein Tag ohne Schicht.
- **P-02, Vertrag des Tages:** Für einen Tag zählt der jüngste Vertrag, dessen `validFrom` am oder vor dem Ende
  dieses mandantenlokalen Tags liegt (§ 2 NachwG; Vertragswechsel gelten nur zum Monatsersten). Die Team-Woche
  beurteilte bisher alle Tage nach dem neuesten Vertrag; die einzige Wirkung auf sie betrifft Wochen mit einem
  Vertragswechsel zum Monatsersten (die Tage davor werden nach dem alten Vertrag beurteilt).
- **P-05, `expectedStart` und `lateMinutes`** nur an der Anwesenheitszeile (Schichtbeginn in Ortszeit; ganze
  Minuten seit Schichtbeginn, nur für „Fehlt“ von heute mit Schicht). Für einen Tag ohne Schicht wird kein
  Beginn erfunden; ein späteres Einstempeln wird nicht bewertet.
- **P-06, ein Wortschatz:** `$lib/dashboard/day-status-label.ts` benennt die Statuswerte in der Oberfläche
  (Berichte-Seite und Dashboard); „Fehlend“ entfällt zugunsten von „Fehlt“. Ein „Fehlt“ der Team-Woche nennt die
  erwartete Zeit aus vorhandenen Feldern (Schichtzeiten, sonst die Sollstunden des Tages).
- **P-07, Verlinkung:** Jede Zelle der Team-Woche ist für Aufrufer, die `/team/time-entries` öffnen dürfen, ein
  Link auf `/team/time-entries?employeeId&date`. „Eintrag nachtragen“ (Lesen und Anlegen von Zeiteinträgen) und
  „Abwesenheit erfassen“ (Lesen und Anlegen von Abwesenheitsanträgen, `/team/leave?create=1&employeeId&date`)
  stehen in einer „Fehlt“-Zeile der Anwesenheitsliste; beide öffnen den bestehenden Dialog vorausgefüllt und
  senden nie automatisch. Kein neuer Endpunkt, keine neue Permission.
- **Wächter:** `apps/api/src/__tests__/day-status-one-function-587.test.ts` (AST) schlägt fehl, wenn
  `resolvePresenceState` außerhalb des Kerns aufgerufen wird, wenn `isDayDue`/`isObligatedWorkday` außerhalb des
  Kerns an einer nicht registrierten Stelle aufgerufen werden und wenn `team-week` oder `today-attendance` eine
  der drei Funktionen selbst aufrufen. Das Register der bekannten Kopien (`/my-week`, Lückensuche
  `find-missing-workdays.ts`) nennt je Eintrag das Folge-Issue #670.

**Auswirkung auf die Kontexte:**

- Zeiterfassung: `resolveDayStatus()` kommt als neue Funktion in `presence.ts` hinzu; Pflicht, Fälligkeit und
  Zustand bleiben dort unverändert definiert.
- Abwesenheiten: keine; der Kommentar der Facade-Funktion `getCalendarLeaveOverlapping` nennt die
  Anwesenheitsliste als weiteren Leser (A3), die Signatur ist unverändert.
- Schichtplanung: keine; `getShiftsInRange` bekommt einen weiteren Leser (die Anwesenheitsliste).
- Arbeitszeitkonto: keine; die Lückensuche (`find-missing-workdays.ts`) bleibt, wie sie ist (Folge-Issue #670).
- Kompositionsschicht: beide Handler bilden die Eingaben über dieselben Hilfsfunktionen; die Kompositionsschicht
  trägt weiter keine Geschäftsregel, die Statusregel steht in Zeiterfassung.

**Was bewusst NICHT geschah:**

- Kein neuer Schlüssel an einem Tag der Team-Woche (D-587-3); `expectedStart` und `lateMinutes` gibt es nur an
  der Anwesenheitszeile.
- Die Definition eines Arbeitstags (`isObligatedWorkday`, `isDayDue`, `workDays`-Vorrang) ist unverändert.
- Die fünf Zähler der Summenzeile bleiben (P-03): „Geplant“ und „Beantragt“ werden wie „—“ nicht mitgezählt.
- „Meine Woche“ (`/my-week`) und die Lückensuche der offenen Punkte bleiben eigene Kopien der Statusfolge; sie
  sind im Folge-Issue #670 mit den gemessenen Abweichungen erfasst (D-587-5).
- Kein Status „in Pause“ und kein Status „zu spät beim Einstempeln“: Es gibt keine Regel, die beides
  definiert (§ 4 ArbZG regelt Länge und Lage der Ruhepause, #511; die Pünktlichkeit eines Einstempelns ist
  gesetzlich nicht definiert). Die offene Owner-Frage steht in #670.
- Der Stammsalon-Stichtag bleibt für Aufrufer mit Reichweite unterschiedlich (P-09): die Team-Woche entscheidet
  die Zugehörigkeit zum Wochenende, die Anwesenheitsliste zum heutigen Tag (Entwurf aus #85). Die
  Anwesenheitsliste hat noch keinen Salonfilter (#542).
- Neutralitätsaufzeichnungen (`matrix.json`, `recipients.json`, `activity-auth.json`) und
  `dashboard-team-week-frozen-84` sind unangetastet.

**Eingefrorene Pins:** Der Pin der Team-Woche (`dashboard-team-week-frozen-84`) ist byte-gleich zum Merge-Base.
`whole-tenant-frozen-85`, Fall (c) (`/today-attendance`), hielt den Fehler fest: dieselbe Administration am
selben Zeitpunkt las „Fehlt“, während der Pin der Team-Woche „Geplant“ festschreibt. Der Literalwert
`EXPECTED_TODAY_ATTENDANCE` ist unverändert; die Änderung läuft über die vorhandene Änderungsliste des Tests
(datierter Absatz im Kopf, Tabelle Zelle / alter Wert / Wert seit #587 / Grund, die vor dem Vergleich auf den
unberührten Literal angewendet wird; der Test prüft, dass jeder alte Wert im Literal steht). Gelistet sind genau
die gemessenen Unterschiede: die Zeilen „Admin Test“ und „Pin PinMissing“ (Feld `status`: `missing` →
`scheduled`; feste Arbeitszeit ohne Schicht ist um 12:00 nicht fällig) und `summary.missing` (2 → 0). Dieselbe
Begründung gilt für `reports.test.ts` RPT-03 Fall 5 (alt „missing“, neu „scheduled“; der Feiertagszweig bleibt).

**Gemessen:**

- Neutralität: 3 Dateien, 1752 Tests grün, 0 geänderte Zellen, Aufzeichnungen byte-gleich zum Merge-Base
  (587-01, 587-02).
- Paritätstest `day-status-parity-587.test.ts`: 12 Fixture-Personen (feste Arbeitszeit mit und ohne Schicht,
  Schichtdienst mit zwei Schichtzeiten und ohne Schicht, Gleitzeit, Monatsstunden, offener Antrag, Berufsschule
  mit Urlaub, Feiertag im Stammsalon, geschlossener und offener Eintrag) zu zwei Uhrzeiten (07:00 und 12:00)
  für die Administration und für eine Salonleitung (SALONS [A]), dazu Vertragswechsel und Verspätung; alle
  acht Statuswerte werden erreicht.
- Wächter: 257 begangene Nicht-Test-Dateien, Register mit 3 Einträgen.
- Gesamtläufe (Stand Abschluss Phase 587): API 672 Dateien / 10346 Tests (davon 3 übersprungen, 10343 grün); Web 228 Dateien / 3449 Tests grün.

### Nachrechnen (Nachtrag Phase 587)

```bash
pnpm --filter @clokr/api run test:setup && pnpm --filter @clokr/api exec vitest run src/contexts/time-tracking/__tests__/day-status.test.ts src/composition/__tests__/day-status-parity-587.test.ts src/__tests__/day-status-one-function-587.test.ts
pnpm --filter @clokr/api exec vitest run src/composition/__tests__/dashboard-team-week-frozen-84.test.ts src/__tests__/whole-tenant-frozen-85.test.ts   # die zwei eingefrorenen Pins
pnpm --filter @clokr/api exec vitest run src/__tests__/permission-neutrality-matrix.test.ts src/__tests__/notification-recipients-neutrality.test.ts src/__tests__/activity-auth-neutrality.test.ts   # unverändert grün, ohne Nachtrag
pnpm --filter @clokr/web exec vitest run src/lib/dashboard src/lib/leave src/__tests__/team-week-cell-links-587.test.ts
```

### Nachtrag 2026-10-18 (Issue #670) — „Meine Woche“ und die Lückensuche der offenen Punkte lesen denselben Tagesstatus

**Schwere:** Fehlerbehebung; keine Unterbau-, Schema-, Migrations-, Routen- oder Permission-Änderung. Owner-Entscheidung
vom 17.10.2026: die Status „in Pause“ und „zu spät“ werden nicht eingeführt (kein gesetzlicher Begriff; eine
Pünktlichkeitsbewertung wäre Leistungs- und Verhaltenskontrolle, § 87 Abs. 1 Nr. 6 BetrVG). „Fehlt“ nennt weiterhin
die erwartete Zeit und die Minuten seit Schichtbeginn (#587). Das Register aus Phase 587 ist leer.

**Was sich geändert hat:**

- `GET /dashboard/my-week` ruft `resolveDayStatus()` mit denselben Personentag-Eingaben wie Team-Woche und
  Anwesenheitsliste (Urlaub des Tages inklusive beantragt, Berufsschul-Verdrängung, erste Schicht, Vertrag des
  Tages, Beschäftigung, nur gültige Einträge). **Vokabular:** die Feldwerte der Antwort bleiben für die Oberfläche
  stabil; `composition/my-week-status.ts` ist die dokumentierte Abbildung (`present` → `complete`/`partial` nach
  Ist gegen Soll, `absent` → `leave`/`sick`/`absent` nach Urlaub bzw. Abwesenheit, `none` → `weekend`/`none`). Die
  Oberfläche und ihre Tests ändern sich nicht.
- Sichtbare Folgen in „Meine Woche“: ein Tag mit nur ungültigem Eintrag ist „Fehlt“ mit 0 Ist-Stunden (A2); jeder Tag
  nach dem an ihm gültigen Vertrag (A3); vor Eintritt und nach Austritt „—“ (A4); ein Wochenendtag, den der Vertrag
  per `workDays` schuldet, ist „Geplant“/„Fehlt“ statt „Wochenende“ (A5); `isWorkday` urteilt am Feiertag nach den
  Vertragsstunden, das angezeigte Soll bleibt 0 (A7). Ein Beschäftigter ohne Vertragszeile liest weiter den
  Mandanten-Standardvertrag.
- `GET /dashboard/open-items` bildet je vergangenem Tag des Fensters (gestern und früher, Obergrenze unverändert)
  dieselben Eingaben und meldet den Tag genau dann als fehlend, wenn der Tagesstatus „Fehlt“ ist. Ein beantragter
  Urlaub entschuldigt den Tag damit wie in der Team-Woche („Beantragt“, B1); der Vertrag des Tages (B3) und die
  Beschäftigung (Eintritt/Austritt) gelten je Tag; Schichten werden für jeden Plantyp gelesen, die Regel, wann ein
  Tag geschuldet ist, steht nur in `presence.ts` (B4). Das Fenster endet weiter gestern (B5): „heute“ ist noch
  nicht nachzutragen.
- **Begründete Abweichung (B2):** ein Tag, dessen einzige Einträge ungültig sind, liest in der Team-Woche „Fehlt“,
  steht aber nicht in `missingDays`. Der Eintrag zählt bereits in `invalidEntries`, mit eigener Handlung
  (Neubewertung bzw. Stornierung klären); den Tag zusätzlich als Lücke zu nennen schickte die Person zu einem
  Nachtrag, der den Grund nicht behebt, und zählte dieselbe Ursache zweimal in `total`. Festgehalten in
  `my-week-open-items-parity-670.test.ts`.
- Halbtage (B6): ein Halbtag-Urlaub ist im Tagesstatus „Abwesend“, also keine Lücke; die bisher verworfene
  `partial`-Lücke entfällt ohne Wirkung auf die Karte.
- **Monatsabschluss unverändert.** `find-missing-workdays.ts`, `close-employee-month.ts` und alle Saldo-Zahlen sind
  semantisch unberührt; die Lückensuche des Abschlusses ruft die Pflichtprüfung nun über `obligationOfDay()`
  (`presence.ts`), einen Delegaten derselben Funktion `isObligatedWorkday` (Vollvergleich über das gesamte
  Eingabegitter in `my-week-status-670.test.ts`). Damit bleibt der Wächter
  `day-status-one-function-587.test.ts` ohne Register-Eintrag; er verlangt zusätzlich, dass `/my-week` und
  `/open-items` `resolveDayStatus` aufrufen und kein Primitiv.
- Eingefrorener Pin: `saldo-neutrality-characterisation-79.test.ts` pinnte „Meine Woche“ vom 20.03. mit dem ungültigen
  Eintrag als Anwesenheit (8 h, `complete`). Die Literale bleiben; die zwei geänderten Zellen (`workedHours` 8 → 0,
  `status` `complete` → `scheduled`) stehen mit Regel, Begründung und Issue #670 im Änderungsregister
  `fixtures/saldo-neutrality-79-amendments.json` (Mechanismus wie #493/#80, ein veralteter `from`-Wert schlägt fehl).
  Neutralitätsaufzeichnungen und Matrix-Zellen unverändert.
- Paritätstest `my-week-open-items-parity-670.test.ts`: 16 Fixture-Personen über eine vergangene Woche und „heute“ (Mi
  12:00), dazu der Vertragswechsel zum Monatsersten mitten in der Woche; gegenprüfbar gegen die alte Fassung (Kontrolle:
  8 Fälle werden dort rot).

### Nachrechnen (Nachtrag Issue #670)

```bash
pnpm --filter @clokr/api run test:setup && pnpm --filter @clokr/api exec vitest run src/composition/__tests__/my-week-open-items-parity-670.test.ts src/composition/__tests__/my-week-status-670.test.ts src/__tests__/day-status-one-function-587.test.ts src/composition/__tests__/day-status-parity-587.test.ts
pnpm --filter @clokr/api exec vitest run src/__tests__/open-items-close-month-parity.test.ts   # Karte und Monatsabschluss
```

### Nachtrag 2026-10-17 (Phase 542, Issue #542) — Berichte folgen der Salonauswahl: Monatsbericht, Anwesenheit heute, Saldenübersicht, Monatsexport

**Schwere:** Erweiterung; keine Unterbau-, Schema-, Migrations-, Routen- oder Permission-Änderung. Ein neues reines
Kompositionsmodul (`composition/salon-view.ts`, keine Imports, keine Geschäftsregel außer der Zugehörigkeitsregel einer
Salonansicht, die nur die beiden Zuordnungen aus #84 zusammenfügt). Zusätzliche Felder in den Antworten nur unter einem
Filter; ohne `salonId` ist jede Antwort Schlüssel für Schlüssel und Zahl für Zahl gleich (eingefrorene Pins unverändert).

**Was sich geändert hat:**

Vier Stellen nehmen eine optionale `salonId`; der Salon wird in jedem Fall von `resolveSalonInReach()` gegen die Reichweite
der **eigenen** Berechtigung(en) der Route geprüft, **vor jedem Lesen**: Monatsbericht `report:read`, Anwesenheit heute
`team-overview:read`, Saldenübersicht beide (`team-overview:read` und `overtime:read`), Monatsexport `report:export`.
Fremder, unbekannter, deaktivierter und nicht erreichbarer Salon antworten mit derselben 404
(`SALON_VIEW_NOT_FOUND`, `{"error":"Salon nicht gefunden"}`, byte-gleich an allen vier Stellen und am Team-Verlauf des
Dashboards); eine ungültige Kennung antwortet 400. Der Filter schneidet nur ein, er erweitert die Reichweite nie.

- **Monatsbericht** (`GET /reports/monthly`): Zugehörigkeit über `salonViewMemberIds()` (`composition/salon-view.ts`),
  die EINE Regel einer Salonansicht: die Person hat im Zeitraum einen Eintrag im Salon **oder** ihr Stammsalon ist an
  mindestens einem Tag des Zeitraums der Salon. Ist (`workedHours`) nur aus geschlossenen, gültigen Arbeitseinträgen des
  Salons bis zum mandantenlokalen Gestern (`addWorkingMinutes`; heute zählt nie, #438; eine Dienstreise zählt für den
  Abfahrtssalon, #92; die Berufsschul-Gutschrift gehört keinem Salon); Krankheitstage und § 9-Tage an den Tagen, an denen
  der Stammsalon der Salon ist (`sickLeaveDayCounts(..., { countsDay })` mit `homeSalonsForDays`, #84). Soll, Saldo,
  Überstunden, Saldokorrektur und die acht bewerteten Urlaubszahlen sind `null`; zusätzlich stehen `salonId`,
  `workedBasis: "SALON_ENTRIES"`, `sollUnavailableReason: "SALON_FILTER"` und `leaveDaysUnavailableReason: "SALON_FILTER"`
  in der Antwort, nur unter einem Filter.
- **Anwesenheit heute** (`GET /dashboard/today-attendance`): Zugehörigkeit über dieselbe Funktion wie die Team-Woche
  (Eintrag heute im Salon oder Stammsalon heute); der Status jeder Zeile bleibt der der ungefilterten Liste (gebildet aus
  allen Einträgen der Person); neu ist `workedElsewhere` je Zeile (gültige Arbeitszeit in einem anderen Salon, nur ein
  Wahrheitswert); die fünf Summen zählen die angezeigten Zeilen; die Antwort trägt `salonId`. `/team-week` entscheidet
  die Zugehörigkeit seit dieser Phase über dieselbe Funktion, unverändert in den Bytes (`dashboard-team-week-frozen-84`).
- **Saldenübersicht** (`GET /dashboard/overtime-overview`) und **Monatsexport** (`GET /reports/monthly-export/pdf`):
  die Filter wählen nur aus, WELCHE Personen erscheinen, nach dem Stammsalon am **eigenen Stichtag des Endpunkts**, den
  die Auflösung als **Kalendertag** (UTC-Mitternacht, nie als Zeitpunkt, #493) bekommt — in der Saldenübersicht der
  mandantenlokale heutige Tag, für ausgetretene Personen ihr Austrittstag; im Monatsexport der letzte Kalendertag des
  Monats, für im Monat Ausgetretene ihr Austrittstag. Jede Person erscheint mit ihrem vollständigen Personensaldo,
  nie mit einem Salonanteil; der Monatsexport druckt unter einem Filter eine Kopfzeile „Salon: <Name> · Personen nach
  Stammsalon am Monatsende · Personensaldo, nicht nach Salon aufgeteilt“ und trägt die Salon-Kennung (nur die Kennung)
  im Exportprotokoll. Personen, die am Stichtag keinen Stammsalon haben (kein Rückgriff auf den „letzten Stammsalon“;
  das wäre eine zweite Zugehörigkeitsregel), erscheinen nur im Export ohne Salonauswahl; die Seite sagt es in einem Satz.
- **Seite „Berichte“**: folgt der Kopfleistenauswahl über `salonPageFilter()` und beschriftet über `SalonScopeLabel`
  (`$lib/salons/page-scope.ts`), ohne neue Entscheidungsfunktion. Gefiltert werden Heutige Anwesenheit (Badge „anderer
  Salon“), Überstunden-Übersicht und Monatsexport. Ungefiltert und mit dem Hinweis „Gilt für alle Salons Ihrer
  Reichweite“ bzw. „DATEV gilt für alle Salons Ihrer Reichweite“ bleiben die DATEV-Karte, die Dokumente einzelner
  Personen, die Urlaubsübersicht und die Verfall-Warnungen (Blocktabelle in `salon-filter-exempt-pages-558.test.ts`).
- **Die Reichweite der Aufrufer in der Saldenübersicht** (beide Reichweiten) wird jetzt am mandantenlokalen Kalendertag
  statt am Zeitpunkt `new Date()` ausgewertet: eine `@db.Date`-Spalte kürzt einen Zeitpunkt auf das UTC-Datum, das
  zwischen 22:00 und 24:00 UTC der Vortag ist. Ohne Filter ändert sich die Antwort nur in diesen zwei Stunden und nur für
  Aufrufer mit Salon-Reichweite, deren Zuordnung um Mitternacht wechselt.

**Auswirkung auf die Kontexte:**

- Zeiterfassung: keine.
- Abwesenheiten: keine; `sickLeaveDayCounts(..., { countsDay })` kannte den Tagesfilter bereits (#84).
- Schichtplanung: keine.
- Arbeitszeitkonto: keine; das Konto wird unter einem Filter nicht gefragt (Soll und Saldo erscheinen dort nicht).
- Unterbau: keine Änderung; `resolveSalonInReach`, `homeSalonsForDays` und `salonOnlyReach` bekommen neue Leser in der
  Kompositionsschicht.
- Kompositionsschicht: `salon-view.ts` und vier Handler (`reports.ts`: Monatsbericht und Monatsexport;
  `dashboard.ts`: Anwesenheit und Saldenübersicht); die Kompositionsschicht trägt weiter keine Geschäftsregel außer
  der Zusammenfügung der zwei Zuordnungen.

**Was bewusst NICHT geschah:**

- Keine Aufteilung von Soll oder Saldo auf Salons (Vertragsgrößen, #84). Keine bewerteten Urlaubstage je Salon: sie
  folgen einer Vorab-Reihenfolge je Zeitraum und lassen sich nicht je Tag einem Salon zuordnen; eine Tagesvariante wäre
  eine zweite Zählregel (#451).
- DATEV bleibt vollständig und nimmt nie einen Salon (§ 41 EStG); die Dokumente einzelner Personen ebenso. Die Quelltext-
  Wächter `report-salon-filter-source-542` und die Blocktabelle halten das fest.
- Die Urlaubsübersicht und die Verfall-Warnungen folgen dem Salon erst mit #612.
- Der Rest aus #85 bleibt: für Aufrufer mit Salon-Reichweite ist die Personenmenge des Monatsberichts nach Stammsalon am
  Monatsende der Rahmen; der Filter schneidet nur weiter ein.
- Der Stichtag der Reichweite des Aufrufers in Monatsbericht und Monatsexport ist weiter das Monatsende als Zeitpunkt.
  Gemessen (542-03, Reichweitensonde): Für einen Berliner Mandanten fällt eine am Monatsletzten endende Zuordnung nicht
  heraus (Prisma kürzt auf das UTC-Datum, das mit dem lokalen Tag zusammenfällt). Bestätigt ist nur der Fall einer im
  Monat ausgeschiedenen Person, deren Zuordnung nach dem Austrittstag wechselte: Ein Aufrufer mit Salon-Reichweite des
  alten Salons sieht sie nicht, die Gesamtmandanten-Administration schon. Das ist älter als #542 und steht mit allen
  Stellen (Datei:Zeile) im Folge-Issue #679.
- Der § 9-Hinweis der Karte „Monatsexport“ bleibt ungefiltert (eine Obermenge: er kann warnen, obwohl keine Person
  des gefilterten Exports § 9-Tage hat, und verdeckt nie etwas). Eine Berechnung aus der Personenmenge des Exports
  bräuchte ein neues API-Feld; das gehört nicht in diese Phase.
- Kein Eingriff am MCP-Werkzeug; kein neuer Endpunkt; keine neue Berechtigung.
- Einzelne frühere Sätze gelten damit nicht mehr (die Einträge bleiben stehen): im Nachtrag Phase 85b „Kein Salonfilter
  in `/reports` (#542)“; im Nachtrag Phase 558 „Berichte (#542) bekommen keinen Salonfilter.“; im Nachtrag Phase 587
  „Die Anwesenheitsliste hat noch keinen Salonfilter (#542).“; im Nachtrag #617 (Eintrag Q) „Kein Salonfilter. #542
  verengt `selectMonthlyExportPersons` nach Stammsalon“ — der Monatsexport grenzt jetzt dort ein, DATEV weiterhin nie.

**Gemessen** (Quellen: `542-01` … `542-05-SUMMARY.md`):

- Neue API-Testdateien (75 Fälle): `salon-view` 8, `reports-salon-filter-542` 15, `report-salon-filter-source-542` 15,
  `dashboard-salon-filter-542` 23, `monthly-export-salon-filter-542` 9, `monthly-export-salon-label-542` 5. Web: neu
  `reports-salon-filter-542`; erweitert `page-scope` und `salon-filter-exempt-pages-558`.
- Mutationsbeweise (je zurückgespielt und byte-verglichen): Monatsbericht M1–M5, Anwesenheit M1–M4, Saldenübersicht
  M1–M6 (M6: Reichweite des Aufrufers am Zeitpunkt, rot um 23:30 UTC), Monatsexport M1–M6, Seite M1–M4.
- Neutralität: 3 Dateien, 1720 Fälle, 0 geänderte Zellen (542-01, 542-03, 542-05); `neutrality/recorded/` und die
  eingefrorenen Pins `reports-monthly-frozen-84`, `reports-hr-86`, `dashboard-team-week-frozen-84`,
  `whole-tenant-frozen-85` sind byte-gleich zum Merge-Base.
- Gesamtläufe (Stand Abschluss Phase 542): API 692 Dateien / 10513 Tests (10510 grün, 3 übersprungen, nach dem Merge von
  origin/main @ 8835ef5e); Web 231 Dateien / 3488 Tests grün; Boden `check-test-completeness.mjs` 686 → 692 Dateien,
  10437 → 10513 Tests.

### Nachrechnen (Nachtrag Phase 542)

```bash
pnpm --filter @clokr/api run test:setup && pnpm --filter @clokr/api exec vitest run src/composition/__tests__/salon-view.test.ts src/__tests__/reports-salon-filter-542.test.ts src/__tests__/report-salon-filter-source-542.test.ts src/composition/__tests__/dashboard-salon-filter-542.test.ts src/__tests__/monthly-export-salon-filter-542.test.ts src/composition/__tests__/monthly-export-salon-label-542.test.ts
pnpm --filter @clokr/api exec vitest run src/composition/__tests__/reports-monthly-frozen-84.test.ts src/__tests__/reports-hr-86.test.ts src/composition/__tests__/dashboard-team-week-frozen-84.test.ts src/__tests__/whole-tenant-frozen-85.test.ts src/__tests__/salon-context-manipulation-82.test.ts   # eingefrorene Pins, unverändert grün
pnpm --filter @clokr/api exec vitest run src/__tests__/permission-neutrality-matrix.test.ts src/__tests__/notification-recipients-neutrality.test.ts src/__tests__/activity-auth-neutrality.test.ts   # unverändert grün, ohne Nachtrag
pnpm --filter @clokr/web exec vitest run src/__tests__/reports-salon-filter-542.test.ts src/__tests__/salon-filter-exempt-pages-558.test.ts src/lib/salons
grep -c 'salonViewMemberIds(' apps/api/src/composition/*.ts   # eine Definition, je ein Aufruf im Monatsbericht, zwei im Dashboard (Anwesenheit, Team-Woche)
```

### Nachtrag 2026-10-17 (Issue #679) — Reichweite nach Stammsalon wird an einem Kalendertag beurteilt, Ausgeschiedene am Austrittstag

**Schwere:** keine Unterbau-Änderung. `contexts/platform/scope-filter.ts` ist unverändert (Owner-Entscheidung 17.10.2026:
geändert wird bei den Aufrufern, nicht in der Auflösung). Kein Schema, keine Migration, keine Route, keine Permission.

**Was sich geändert hat:** Die Auflösung der Reichweite über den Stammsalon (`resolveStammsalonScopedEmployeeIds`,
`isStammsalonScopeMatch`) bekommt in der Kompositionsschicht nie mehr einen Zeitpunkt, sondern den mandantenlokalen
Kalendertag (`T00:00:00Z`, #493). Für monatsgebundene Lesungen wählt `composition/reach-day.ts` (keine Geschäftsregel, nur
die Tageswahl) den Tag je Person: der **Austrittstag**, wenn der Austritt im Monat liegt, sonst der **Monatsletzte**
(dieselbe Regel wie die Saldenübersicht #613 und der Salonfilter des Monatsexports #542; `salonPersonsAtStichtag` ruft jetzt
denselben Baustein). Stellen: `loadDatevMonth` (DATEV und Monatsexport), `GET /reports/monthly`, `GET /reports/datev/employee`,
`GET /reports/monthly/pdf`, Team-Verlauf und seine Soll-Abdeckung (`dashboard.ts`). Reine Tagesstellen nutzen den
mandantenlokalen Kalendertag statt `new Date()`/`now`/`weekEnd`: Urlaubsübersicht (31.12.), Verfall-Warnungen,
`carryover-warn`, Team-Woche (Wochenletzter), Überstunden-Verlauf und der Aktivitäts-Feed. Eine Person, die mitten im Monat
wechselt und nicht ausgeschieden ist, bleibt beim Stammsalon des Monatsletzten. Ohne Salon-Einschränkung (Gesamtmandant)
läuft keine neue Abfrage und jede Antwort bleibt Byte für Byte gleich.

**Bewusst nicht Teil davon:** die Aufrufer in `contexts/absence/` und `contexts/scheduling/` (`new Date()` bzw. Anforderungs-
daten; nicht in den Akzeptanzkriterien), die Urlaubsübersicht und Verfall-Warnungen als Personenkreis (#612) und die
personenbezogene Eingrenzung des Monatsberichts (#85).

**Nachrechnen:**

```
grep -rn "resolveStammsalonScopedEmployeeIds(\|isStammsalonScopeMatch(" apps/api/src/composition   # kein Zeitpunkt als letztes Argument
pnpm --filter @clokr/api exec vitest run src/composition/__tests__/reach-stichtag-679.test.ts
```

## Q — Systemrollen-Templates und zwei Saldo-Gates (Phase 76b, Issue #76)

**Schwere: informativ. Unterbau-Erweiterung nach ADR 0002, Entscheidung 7 (additiv, kein
bestehender Leser ändert seine Bedeutung); zwei rechte-ändernde Gate-Korrekturen (D-06, D-15),
jeweils gegen die Neutralitätsmatrix gemessen und nur über das Amendment-Register erfasst (D-13).**

### Warum dieser Eintrag existiert

Issue #76 fügt dem Unterbau vier weitere globale Systemrollen hinzu — Templates, die ein Kunde
kopiert, um eine skalierte SALONS-/PERSONS-Rolle zu bauen: Inhaber, Salonmanager,
Personalabteilung, Ausbilder (Ids `…a004`–`…a007`, `system-roles.ts`). Das ist eine reine
Erweiterung: `isSystemRoleId()` erkennt jetzt sieben statt drei Ids, kein bestehender Aufrufer
ändert seine Bedeutung. Zwei Stellen mussten die Phase trotzdem ändern, weil die Templates sonst
ihr eigenes Kriterium verletzt hätten (kein Salonmanager-Saldo): die Saldenübersicht
(`GET /dashboard/overtime-overview`, D-06) und der Überstunden-Trend (`GET /dashboard/
overtime-trend`, D-15) — Letzterer schließt den in Eintrag P selbst vorhergesagten,
vorbestehenden Fund ab (Nachtrag dort). Eine dritte Korrektur (P-02) behebt einen in `GET
/time-entries` gefundenen Vollzugslücken-Fehler, der AK-76b-4 durch die reine Existenz der
Personalabteilung-Vorlage erstmals sichtbar machte, aber unabhängig von den Templates bestand.

### Was sich geändert hat

- **Vier neue globale `AccessRole`-Zeilen** (D-01/D-02, Plan 76b-01): Inhaber (87 Permissions,
  volle Katalog-Aufzählung, kein fester Literal-Vergleich), Salonmanager (24), Personalabteilung
  (13), Ausbilder (5) — angelegt durch eine neue, von der 75b-Migration getrennte, idempotente
  Datenmigration (`…_system_role_templates`, `ON CONFLICT DO NOTHING`, keine Zuweisung, kein
  Audit-Eintrag, AK-76b-8). `isSystemRoleId()` beantwortet jetzt sieben Ids; `docs/permissions.md`
  bekam den neuen Abschnitt „Systemrollen-Templates", durch Test an `SYSTEM_ROLE_PERMISSIONS`
  gebunden (D-14, Plan 76b-07).
- **P-01 (Plan 76b-02): das Mitarbeiterformular ersetzt nur noch eine Zuweisung auf Admin, Manager
  oder Mitarbeiter.** Eine neue, engere Prädikat-Funktion `isLegacySystemRoleId()`
  (`compat-role.ts`) — bewusst NICHT die bestehende, sieben Ids kennende `isSystemRoleId()`
  verändert — grenzt die Formular-Brücke (`replaceSystemRoleAssignment`,
  `assignmentsBlockingDemotionToEmployee`) auf die drei Alt-Rollen ein. Eine Template-Zuweisung
  übersteht seitdem einen Formular-Speichervorgang unverändert und zählt weiter als
  Herabstufungs-Sperre (409). `deriveCompatRole()` (D-10) blieb dabei unverändert — ihre bestehende
  Mandant-Scope-only-Ableitung ergab für alle vier Templates schon vorher das richtige Ergebnis
  (Inhaber/Personalabteilung → `MANAGER`, Salonmanager/Ausbilder → trägt nichts bei); dieser Plan
  bewies das nur mit Tests.
- **D-16/P-05 (Plan 76b-08): eine unveränderte Formularrolle ist keine Rollenänderung.**
  `requestedRoleUnchanged()` vergleicht die angeforderte Rolle gegen die `User.role`-SPALTE des
  Ziels (P-05 — nie gegen `compatRoleForUser`/die Ableitung, siehe Mutationsnachweis M2 der
  Plan-Summary) und lässt `applyRoleFromEmployeeForm` bei Gleichheit früh zurückkehren, VOR
  Materialisierung und Herabstufungs-Sperre. Das schließt einen vorbestehenden, in Plan 76b-02
  gefundenen Fehler in der Kompatibilitäts-Projektion: Das Mitarbeiterformular sendet bei jedem
  Stammdaten-Speichern die abgeleitete Rolle erneut (`+page.svelte:740`), sodass ein Halter der
  Personalabteilung-Vorlage oder einer Kundenrolle mit ZUGEWIESEN-Permission (Kompatibilitätsrolle
  `MANAGER`) bei jedem unrelated Speichern eine NEUE Manager-Zuweisung bekam, und ein
  Salonmanager-/Ausbilder-Halter mit Mitarbeiter beim Speichern fälschlich 409 erhielt. Fix-Commit
  `483f737d` (`fix(76b-08)`). Die `role-assignment:manage`-Sperre bleibt unangetastet, auch für
  eine unveränderte Rolle (Mutationsnachweis M3).
- **P-02 (Plan 76b-04): `GET /time-entries` beantwortet 403 ohne jede `time-entry:read`-Reichweite.**
  Der Handler kollabierte seine Reichweite auf `isManager = (permissionReach(...) ===
"ZUGEWIESEN")` und fiel für einen Aufrufer OHNE jede Reichweite (die Personalabteilung-Vorlage
  hält bewusst keine `time-entry:*`-Permission) in den Eigene-Einträge-Zweig — 200 mit den eigenen
  (i. d. R. keinen) Einträgen statt 403. Fix: ein `readReach === null`-Guard vor jeder Abfrage,
  derselbe Aufbau, den jeder andere Handler im Repository schon vorher hatte. Issue #76 erwartete
  an dieser Stelle „Zeiterfassung: keine Codeänderung" — der Handler bewies das Gegenteil.
- **D-06/P-04 (Plan 76b-03): Saldenübersicht — Schnittmenge, keine Vereinigung.**
  `GET /dashboard/overtime-overview` verlangt zusätzlich zu `team-overview:read:ZUGEWIESEN` jetzt
  `overtime:read:ZUGEWIESEN` (zweiter, unabhängiger `requirePermission()`-Eintrag im nativen
  Fastify-`preHandler`-Array — keine neue Katalog-Permission, kein neuer AND-Kombinator). Ein
  Mitarbeiter-Konto bleibt in der Liste nur, wenn es BEIDE unabhängig aufgelösten Reichweiten
  besteht — eine weite `team-overview:read`-Reichweite kann eine engere `overtime:read`-Reichweite
  nie überstimmen. Für D-06 selbst amendierte sich KEINE Matrixzelle, weil jeder Halter von
  `team-overview:read` in der aufgezeichneten Matrix bereits `overtime:read` hält (vorab in
  RESEARCH.md geprüft, live mit dem vollen 1712-Fälle-Lauf bestätigt); die drei amendierten
  `GET /api/v1/roles`-Zellen unten (P-03) gehören zu AK-76b-1, nicht zu D-06.
- **D-15 (Plan 76b-03): Überstunden-Trend — erstes Permission-Gate, gescopte Aggregation.**
  `GET /dashboard/overtime-trend` verlangte bis zu dieser Phase nur `requireAuth` (`preHandler`
  ohne jede Permission-Prüfung, `composition/dashboard.ts:1433` VOR dieser Phase — der in Eintrag P
  benannte, dort bewusst zurückgestellte Fund). Seit D-15 verlangt die Route
  `overtime:read:ZUGEWIESEN` und aggregiert (`sumCarryOverByMonth`, `getBalances`) nur noch über die
  Mitarbeiter im aufgelösten Scope des Aufrufers, nie mandantenweit für einen SALONS-/
  PERSONS-Halter. Zwei amendierte Matrixzellen, beide 200 → 403 (issue 76,
  `matrix-amendments.json`): `EMPLOYEE | GET /api/v1/dashboard/overtime-trend | none` und
  `FALLBACK_EMPLOYEE | GET /api/v1/dashboard/overtime-trend | none` — die Systemrolle Mitarbeiter
  hält nur `overtime:read:EIGENE`, keine ZUGEWIESEN-Reichweite, und verliert dadurch den bisherigen
  mandantenweiten Einblick. Das Web-Dashboard blendet die Überstunden-Trend-Karte bei 403 still aus
  (kein Toast, kein `console.error` für genau diesen Statuscode) statt eine irreführende
  Nulllinie zu zeichnen.
- **P-03 (Plan 76b-01): drei `GET /api/v1/roles`-Amendments.** `GET /roles` listet konstruktionsbedingt
  jede Systemrolle auf (AK-73-3) — die vier neuen Templates erscheinen deshalb in den drei
  ADMIN-artigen Zellen als vier zusätzliche `<new>`-Einträge, alle 200 → 200 (issue 76,
  `matrix-amendments.json`): `ADMIN | GET /api/v1/roles | none`,
  `APIKEY_ADMIN | GET /api/v1/roles | none`, `FALLBACK_ADMIN | GET /api/v1/roles | none`. Route und
  Prüfung (`role:read:ZUGEWIESEN`) sind unverändert — die beabsichtigte Folge von AK-76b-1, keine
  Regression.

### Was bewusst NICHT geschah

- **Keine Oberfläche** (#83–#86, durch diese Phase weiterhin blockiert).
- **Keine Zuweisung eines Templates an einen bestehenden Nutzer** und **keine Bindung eines
  Templates an einen Scope-Typ** — der Scope gehört der Zuweisung (#74), nicht der Rolle.
- **Keine #78-Laufzeitsperre** — die Selbstgenehmigungs-Prüfung (D-09: nur Inhaber hält von den
  vier Templates beide Hälften des Paars) bleibt eine reine Test-Aussage dieser Phase, keine neue
  Laufzeit-Sperre.
- **Keine Empfängersuchen-Änderung für SALONS-/PERSONS-Halter** (#367, unverändert).
- **Keine Aufteilung von `report:read`** (#86) — die Personalabteilung-Vorlage bleibt deshalb ohne
  Urlaubsübersicht, obwohl sie fachlich dazu gehören würde.
- **Die Formular-Kompatibilitäts-Projektion ist FERTIG, nicht offen:** Anders als in Plan 76b-02
  zunächst vorgesehen, wurde der dort gefundene Fehler (Formular sendet die abgeleitete Rolle bei
  jedem Speichern erneut) NICHT als eigenes Issue verschoben, sondern noch in dieser Phase behoben
  (D-16/P-05, Plan 76b-08, oben) — die Templates machten ihn erstmals praktisch erreichbar, also
  wurde er hier geschlossen statt vertagt.
- **Zwei verwandte, VORBESTEHENDE Eigene-Daten-Rückfälle sind gefunden, aber NICHT behoben:**
  `GET /leave/requests` (`leave.ts:828`) und `GET /section9` (`leave.ts:3150`) fallen für einen
  Aufrufer ohne jede `…:read`-Reichweite auf die eigenen Daten zurück statt mit 403 zu antworten —
  dieselbe Fehlerform wie P-02, aber außerhalb dieser Phase's `files_modified` und von keinem der
  vier Templates ausgelöst (jedes hält irgendeine `leave-request:read`-Reichweite). Ebenso bleibt
  `GET /time-entries`s ungefilterte Liste (ohne `?employeeId`) beim eigenen Datensatz des
  Aufrufers, statt den SALONS-/PERSONS-Scope eines ZUGEWIESEN-Halters anzuwenden
  (`time-entries.ts:1017`, gefunden in den Plänen 76b-05/76b-06) — jede explizite
  `?employeeId`-Abfrage ist davon nicht betroffen. Alle drei Funde sind als Issue #368 registriert.

### Übergangs- und Randregeln

- **Die Namen der vier Templates sind ab der Migration für Kundenrollen reserviert** (case-insensitiv,
  wie bei den drei 75b-Rollen): eine bestehende gleichnamige Kundenrolle bleibt funktionsfähig, kann
  aber nicht mehr auf diesen Namen umbenannt oder neu angelegt werden (409).
- **`requestedRoleUnchanged()` vergleicht ausschließlich gegen die `User.role`-Spalte, nie gegen die
  Ableitung** (P-05) — bei einer veralteten Spalte (Datenbestand vor #75 oder eine seltene
  Nachzügler-Zeile) gewinnt die Spalte; das entspricht dem bereits bekannten, akzeptierten
  Restrisiko einer veralteten Spalte (T-76b-34, Plan 76b-08).
- **Ein arbeitender Salonmanager/Ausbilder/Personalabteilung-Halter braucht zusätzlich die
  Systemrolle Mitarbeiter (Scope Mandant), um überhaupt Reichweite EIGENE zu bekommen** — keines
  der drei ZUGEWIESEN-only-Templates trägt selbst eine EIGENE-Permission.

### Auswirkung auf die Kontexte

- **Zeiterfassung:** `time-entries.ts` — P-02 (`GET /`, ein neuer früher 403-Guard vor jeder
  Abfrage, keine sonstige Verhaltensänderung für einen bestehenden EIGENE-/ZUGEWIESEN-Halter).
- **Abwesenheiten:** keine Codeänderung — zwei vorbestehende, verwandte Funde derselben Fehlerform
  sind oben unter „Was bewusst NICHT geschah" dokumentiert, nicht behoben.
- **Schichtplanung:** keine Codeänderung.
- **Arbeitszeitkonto:** keine Codeänderung — die Saldo-ROUTEN selbst (`overtime.ts`) waren bereits
  korrekt gegate; die beiden neuen Gates (D-06, D-15) sitzen in der Kompositionsschicht, nicht im
  Kontext.
- **Kompositionsschicht:** `dashboard.ts` — D-06 (zweites Gate + Schnittmenge auf
  `overtime-overview`), D-15 (erstes Gate + gescopte Aggregation auf `overtime-trend`), P-04 (die
  Schnittmengen-Regel selbst); `apps/web/src/routes/(app)/dashboard/+page.svelte` (stiller
  403-Rückzug der Trend-Karte).
- **Unterbau:** `system-roles.ts` (vier neue Slots, D-01/D-02), `compat-role.ts`
  (`isLegacySystemRoleId()`/P-01, `requestedRoleUnchanged()`/D-16/P-05), `employees.ts`
  (`applyRoleFromEmployeeForm`s früher Rückkehrpunkt), die neue Migration
  (`…_system_role_templates`), `docs/permissions.md` (D-14).

### Gemessen

- **`isSystemRoleId()` / `SYSTEM_ROLE_IDS`:** 3 Ids vor dieser Phase, 7 danach (Admin, Manager,
  Mitarbeiter, Inhaber, Salonmanager, Personalabteilung, Ausbilder).
- **Neutralitätsmatrix (`permission-neutrality-matrix.test.ts`, voller Lauf über alle Fälle):**
  bleibt grün, mit genau fünf neuen, dokumentierten Amendments (Issue 76) in
  `matrix-amendments.json`: drei `GET /api/v1/roles | none`-Zellen (`ADMIN`, `APIKEY_ADMIN`,
  `FALLBACK_ADMIN`, P-03), zwei `GET /api/v1/dashboard/overtime-trend | none`-Zellen (`EMPLOYEE`,
  `FALLBACK_EMPLOYEE`, D-15). `recorded/matrix.json` und die Testdatei selbst blieben über alle acht
  Pläne dieser Phase byte-gleich (D-13).
- **`permissionReach(req, "time-entry:read")`-Aufrufstellen in `time-entries.ts`:** 1 vor und nach
  dem P-02-Fix (nur der Rückgabewert wird jetzt zusätzlich auf `null` geprüft, keine zweite
  Aufrufstelle).
- **Verhaltensmatrix-Testdateien gegen die ECHTEN Vorlagen** (nie eine Ad-hoc-`AccessRole`):
  `system-role-template-personalabteilung.test.ts` (19 Fälle, AK-76b-4),
  `system-role-template-ausbilder.test.ts` (15 Fälle, AK-76b-6),
  `system-role-template-salonmanager.test.ts` (21 Fälle, AK-76b-5) — je mit mindestens einem
  Mutationsnachweis (`TEMPLATE_SLOT` auf eine andere Vorlage umgestellt), beobachtet rot,
  wiederhergestellt.
- **`git log --format=%s main..HEAD` dieser Phase:** genau zwei `fix(`-Commits
  (`5ab8dec8` P-02, `483f737d` D-16/P-05), der Rest `feat`/`chore` — passend zu den zwei
  genuinen Bugfixes, die die acht Pläne dieser Phase gefunden haben.

### Nachrechnen

```bash
grep -c '"' apps/api/src/contexts/platform/system-roles.ts  # SYSTEM_ROLE_IDS-Block überfliegen
grep -rn "permissionReach(req, \"time-entry:read\")" apps/api/src/contexts/time-tracking/api/time-entries.ts
grep -c '"issue": 76' apps/api/src/__tests__/neutrality/recorded/matrix-amendments.json
git log --format=%s main..HEAD | grep -c '^fix('
pnpm --filter @clokr/api run test:setup
pnpm --filter @clokr/api test
pnpm --filter @clokr/api exec vitest run src/__tests__/permission-neutrality-matrix.test.ts src/__tests__/permission-site-mapping.test.ts src/contexts/platform/__tests__/system-roles.test.ts
```

### Nachtrag 2026-10-16 (Phase 86b, Issue #86) — Personalabteilung liest Berichte und Salons; Tageslisten nur in Zeiteintrags-Reichweite

**Schwere: informativ. Unterbau-Semantikänderung nach ADR 0002, Entscheidung 7 (der Inhalt einer bestehenden
Systemrolle ändert sich und gilt sofort für jedes bestehende Konto mit dieser Rolle); nach der Auslieferung hier
nachgetragen, wie Entscheidung 7 es verlangt.** Stand der Messungen: Branch `feat/86-personalabteilung`, Basis `83ab85f0`.

#### Warum

Owner-Entscheidung vom 16.10.2026
([Kommentar am Issue #86](https://github.com/sebastianzabel/clokr/issues/86#issuecomment-6211469762)): Die Vorlage
„Personalabteilung“ erhält `report:read` und `salon:read`, jeweils `ZUGEWIESEN`. Das kehrt die Entscheidung D-07 von
Phase 76b für `report:read` um. Ihre Prämisse — die JSON-Antwort des Monatsberichts bündle Tageszeilen mit der
Urlaubsübersicht — ist widerlegt: Die drei `report:read`-Routen (`GET /reports/monthly`, `/reports/leave-overview`,
`/reports/carryover-at-risk`) tragen nur Summen je Person und Monat bzw. Jahr; Tageszeilen stehen ausschließlich in den
PDFs und im DATEV-Export unter `report:export`, das die Personalabteilung weiterhin nicht hält. Die oben in diesem Eintrag
offen gelassene Frage „Keine Aufteilung von `report:read` (#86)“ ist damit beantwortet: Eine Aufteilung ist nicht nötig.
`salon:read` braucht die Personalabteilung, um Salonzuordnungen zu pflegen, auch zu inaktiven Salons.

Die Vorlage hält seitdem 15 statt 13 Schlüssel. #66 (Beschäftigung als eigene Entität) ist kein Blocker: Es liegt im
Backlog, hat keine Entität und sieht selbst keine Oberfläche vor; die Ansicht baut auf dem heutigen Modell.

#### Was sich geändert hat

- **Vorlage.** Neue, reine Datenmigration `20261016102152_hr_template_report_salon_read` (ein `UPDATE "AccessRole"` auf die
  Id `…a006`, geschützt durch `IS DISTINCT FROM`, keine DDL, keine Zuweisung, kein Audit-Eintrag). Die ursprüngliche
  Migration `…_system_role_templates` bleibt unverändert; eine Vorlage ändert sich nur über eine NEUE Datenmigration plus
  die Konstante `SYSTEM_ROLE_PERMISSIONS.HR`. Konstante, Datenbankzeile, Zeile in `docs/permissions.md` und die Persona-Fixture
  der Web-App sind durch Gleichheitstests aneinander gebunden. Betrieb und Rückweg: `docs/migrations.md`, Abschnitt „Phase 86b“.
- **Berichte sind tagesfrei festgenagelt.** `reports-hr-86.test.ts` hält je Route eine Schlüsselpfad-Allowlist (24, 30 und
  23 Pfade) und einen Detektor für Tagesstrukturen, mit Positivkontrollen; die Berichtsfamilie (11 Routen, abgeleitet aus dem
  Quelltext) beantwortet der Personalabteilung 3 mit 200 und 8 mit 403.
- **Tageslisten nur in Zeiteintrags-Reichweite (Datenminimierung, Art. 5 Abs. 1 lit. c DSGVO).** `dayDetailVisibility()`
  (`contexts/working-time-account/api/day-detail-visibility.ts`) entscheidet an genau einer Stelle, ob ein Aufrufer die
  Tageslisten einer Person sehen darf: die eigene Person mit `time-entry:read:EIGENE`, jede andere nur mit
  `time-entry:read:ZUGEWIESEN` über die Person zum Stichtag der Route. Außerhalb dieser Reichweite sind die Listen leer,
  `dayDetailsWithheld` ist `true`, alle Anzahlen, Statuswerte und Saldenzahlen bleiben gleich. Betroffen sind vier Antworten
  des Arbeitszeitkontos: `GET /overtime/month-saldo` (`days`), `GET /overtime/close-month/status` (vier Listen, dazu
  `missingDateCount`, `unconfirmedBreakDayCount`, `breakFindingDayCount`, `karenzOverrunDayCount`), `GET
/overtime/close-month/year-status` (`missingDates`, dazu `missingDateCount`) und `GET /overtime/close-month/deferred?detailed=true`
  (`gapDates`, `gapCount` bleibt). Die zwei zuletzt genannten hat die Planung der Umsetzung gefunden
  ([Kommentar](https://github.com/sebastianzabel/clokr/issues/86#issuecomment-6213895582)). Die fünfte Antwort mit Tagesdaten,
  die 409-Vorschau `shiftPreview` von `PUT /settings/work/:employeeId`, folgt der `shift:read`-Reichweite (Anzahl
  `pendingShifts` bleibt). `getDeferredMonthCloseState` ist unverändert, weil die Erinnerung per Cron die Daten braucht; die
  Schwärzung sitzt in der Route. `lastLoginAt` bleibt (L4): kein Arbeitszeitdatum.
- **Web.** Die Reiter der Mitarbeiter-Detailseite richten sich nach Berechtigung (`employeeDetailTabs`: „Berechtigungen“ nur
  mit `employee:manage-access` oder `role-assignment:manage`, „Gefahrenzone“ nur mit `employee:anonymize`), dazu der Reiter
  „Salons“ (Zuordnungsverlauf mit Namen, inaktive Salons eingeschlossen; Einsatzsalon hinzufügen, Stammsalon ändern,
  Einsatzsalon beenden, nichts löschbar). „Vertragsverlauf“ aus den `WorkSchedule`-Zeilen, das Austrittsdatum als Ende der
  Beschäftigung mit Hinweis, Beschäftigungsstatus und Filter in der Mitarbeiterliste. Beim Anlegen ist der Stammsalon in einem
  Mandanten mit mehreren aktiven Salons Pflicht (behebt den 400 des Formulars). Der Monatsabschluss zeigt bei
  zurückgehaltenen Listen Anzahlen („N Tage ohne Eintrag“) und einen Hinweis; `/team/time-entries` weist einen Aufrufer ohne
  `time-entry:read` vor jeder Anfrage ab.

#### Was bewusst NICHT geschah

- **Keine Beschäftigungs-Entität.** Mehrere Beschäftigungen je Person, ein Konto je Beschäftigung und ein `validTo` an
  Verträgen bleiben #66. „Beschäftigung beenden“ ist „Austrittsdatum setzen“, der Verlauf sind die `WorkSchedule`-Zeilen.
- **Keine Sperre des Zugangs.** Ohne `employee:manage-access` sperrt ein Austrittsdatum das Login nicht; die Oberfläche
  sagt das im Hinweis.
- **Kein `report:export`**, keine Zeiteintrags-, Schicht- oder Team-Übersichts-Schlüssel, keine `EIGENE`-Schlüssel in der
  Vorlage: Wer in der Personalabteilung selbst arbeitet, hält zusätzlich die Systemrolle Mitarbeiter.
- **Kundenkopien der Vorlage bleiben unverändert** (eine Kopie ist eine eigene Rolle; die Änderung wirkt nur auf die Systemrolle).
- **Keine Löschung.** Beendete Beschäftigungen bleiben sichtbar (§ 147 AO); die Personalabteilung hält weder
  `employee:anonymize` noch `employee:manage-access`, und die Routenliste kennt keine DELETE-Route für Verträge,
  Urlaubsanspruch oder Salonzuordnungen.

#### Restrisiken

- **`POST /overtime/close-month` (409).** Die Antwort trägt ebenfalls Tageslisten und ist nicht geschwärzt. Sie verlangt
  `month-close:close`, das die Vorlage nicht hält; eine Kundenrolle mit `month-close:close` ohne `time-entry:read` sieht sie.
- **`cancelOrphanShifts`.** Ein Inhaber von `contract:update` ohne `shift:*` kann über `PUT /settings/work/:employeeId`
  zukünftige Schichten hart löschen (je Schicht auditiert); die Vorlage ist so ein Inhaber. Das bestand schon vorher, ist nicht
  Teil der Entscheidung und steht als Folge-Issue #650 beim Owner.
- **„Heute“ der Beschäftigungsanzeige** ist der Kalendertag des Browsers, weil die Web-App keinen mandantenlokalen Tag kennt;
  ein Browser außerhalb der Mandanten-Zeitzone kann eine Person mit Austrittstag „heute“ um wenige Stunden früher oder später
  als ausgeschieden zeigen.
- **Anlegen ohne `salon:read`.** Eine Rolle mit `employee:create`, aber ohne `salon:read` bekommt in einem Mandanten mit
  mehreren aktiven Salons den Server-400 zum fehlenden Stammsalon statt einer Auswahl.
- **Schmale Bildschirme.** Mehrere Tabellen scrollen waagerecht ohne Hinweis, Wichtiges liegt rechts hinter dem Falz
  (Folge-Issue #651).

#### Auswirkung auf die Kontexte

- **Unterbau:** Die Vorlage „Personalabteilung“ erhält zwei Schlüssel (Semantikänderung, Owner-Entscheidung oben); die
  409-Schichtvorschau in `settings.ts` folgt der `shift:read`-Reichweite.
- **Zeiterfassung:** keine fachliche Änderung. Die Sperre der Personalabteilung wirkt serverseitig und ist über alle
  abgeleiteten Routen von `/time-entries`, `/day-breaks` und `/retro-entry-requests` getestet.
- **Abwesenheiten:** keine.
- **Schichtplanung:** keine Codeänderung; die Schichtvorschau wird in der Unterbau-Route gefiltert, die Fassade bleibt.
- **Arbeitszeitkonto:** `day-detail-visibility.ts` und die vier Routen in `overtime.ts`; keine Zahl, kein Saldo und kein
  Status ändert sich, nur Listen werden geleert.
- **Kompositionsschicht:** keine Codeänderung; `reports-hr-86.test.ts` pinnt die Antworten.

#### Gemessen

- **Neutralitätsregister** (`permission-neutrality-matrix.test.ts` mit 1752 Fällen über drei Dateien, jeweils mit
  `NEUTRALITY_ACTUAL_OUT_DIR`): Probelauf der Generatoren ohne `--write`, `differing=0` für Matrix, Empfängersuchen und
  Aktivität/Login — nach Plan 86b-01 und nach Plan 86b-02; `recorded/` ist byte-gleich zum Merge-Basisstand. Keine
  Aufnahme wurde neu geschrieben, kein Amendment eingetragen.
- **Zugriffswege auf Zeitdaten (AC-86-4):** 22 aus dem Quelltext abgeleitete Routen unter `/time-entries`, `/day-breaks`,
  `/retro-entry-requests`, je mit der Personalabteilung allein und mit Personalabteilung plus Mitarbeiter geprüft (44
  Proben); keine Antwort trägt Einträge oder Uhrzeiten einer fremden Person, keine Probe schreibt.
- **Vorlagen-Test:** 76b-Matrix gegen die echte Vorlage (`system-role-template-personalabteilung.test.ts`) und die neue
  Abnahme `hr-view-86.test.ts` (16 Fälle für AC-86-1/2/5/6, Mutationsnachweis mit `TEMPLATE_SLOT = "TRAINER"`: 11 Fälle rot).
- **Sichtprüfung:** Matrix aus 16 Zellen (Mitarbeiterliste, Reiter „Salons“, Reiter „Arbeitszeit“, Monatsabschluss bei 390
  und 360 px, hell und dunkel) in `apps/e2e/tests/hr-view-86.spec.ts`; sie fand und behob einen abgeschnittenen Reiter „Salons“.

#### Nachrechnen

```bash
pnpm --filter @clokr/api run test:setup
pnpm --filter @clokr/api exec vitest run src/__tests__/hr-view-86.test.ts src/__tests__/hr-no-day-level-data-86.test.ts \
  src/__tests__/reports-hr-86.test.ts src/__tests__/hr-template-migration-86.test.ts \
  src/__tests__/system-role-template-personalabteilung.test.ts src/contexts/platform/__tests__/system-roles.test.ts
pnpm --filter @clokr/api exec vitest run src/__tests__/permission-neutrality-matrix.test.ts   # danach die drei Generator-Probeläufe ohne --write
git diff --quiet "$(git merge-base HEAD origin/main)" -- apps/api/src/__tests__/neutrality/recorded
```

### Nachtrag 2026-10-17 (Issue #617) — Ein Monatsexport statt vieler PDFs; Urlaubsübersicht nur mit Urlaub

**Schwere: informativ. Keine Unterbau-Änderung, keine Migration.** Stand der Messungen: Branch `fix/617-monatsexport`,
Basis `83114c35` (Phase 587 eingemergt, `c6f29716`).

#### Warum

Owner-Entscheidung vom 17.10.2026 (Kommentare am Issue #617). Es gab fünf PDFs, die sich überlappten: den
Stundennachweis je Person, den firmenweiten Monatsbericht, die Urlaubsliste, den Urlaubsbericht und die
Urlaubsübersicht. Die Urlaubsliste führte Krankheitszeilen in einem Dokument, das für ein anderes Publikum gedacht war
(wer Urlaub plant, braucht keine Krankheitsdaten), „Resturlaub“ hieß auf Seite und Dokument nicht dasselbe, die Zahlen
standen mit Dezimalpunkt und „1 Tage“ da, und ein Stundennachweis mit 19 Einträgen erzeugte eine Leerseite.

#### Was sich geändert hat

- **Monatsexport.** `GET /api/v1/reports/monthly-export/pdf` (`report:export:ZUGEWIESEN`, eine Zeile je Person, keine
  Tageszeilen) ist die lesbare Fassung des DATEV-Exports. Die Personen kommen über den gemeinsamen DATEV-Lader
  (`loadDatevMonth`, kein zweiter Auswahlweg) und genau eine Auswahlfunktion (`selectMonthlyExportPersons`); die
  Abwesenheitstage und die Spalte „DATEV-Std.“ stammen aus den Personenwerten von DATEV (`datevPersonFigures`), Soll, Ist,
  Saldo, Status und Gesamtsaldo aus dem Ergebnis des Arbeitszeitkontos (`computeMonthReportFigures`, dazu das additive Feld
  `closingBalanceMinutes`). Der Abschnitt „Urlaubsjahr“ kommt aus der Urlaubsfassade mit der neuen Aufteilung in
  verfügbare, genommene und genehmigte künftige Tage und wird zu einem **Stichtag** ausgewertet: letzter Tag des
  exportierten Monats, im laufenden Monat der gestrige Tag in der Mandanten-Zeitzone. Ein erneuter Export desselben Monats
  druckt dieselben Zahlen.
- **Stundennachweis** (`GET /reports/monthly/pdf`, bleibt) mit deutschem Format (H:MM, Dezimalkomma, Tag/Tage), benannten
  Einheiten, Markenfarbe, Fußzeile ohne Leerseite, Einträgen in Startzeit-Reihenfolge und eigenen Zeilen für Urlaub,
  Krankmeldung, Berufsschule und Feiertage (ein Feiertag vor dem Eintritts- oder nach dem Austrittstag der Person erscheint
  nicht). Er ist das einzige Dokument mit einer Tagesliste.
- **Entfernt:** der firmenweite Monatsbericht (`GET /reports/monthly/pdf/all`), die Urlaubsliste, der Urlaubsbericht und
  die Urlaubsübersicht als PDF samt Renderern, Zeilentypen, Kompositionshelfern und Schaltflächen. Die
  Urlaubsübersicht der App (`GET /reports/leave-overview`) listet **nur Urlaub** — eine Positivliste nach Abwesenheitsart
  im Code, keine Ausschlussliste — mit den sieben Spalten Anspruch, Übertrag (wirksam), Verfügbar, Genommen, Genehmigt,
  Beantragt, Resturlaub; die Seite und der Abschnitt „Urlaubsjahr“ im Monatsexport tragen dieselben Beschriftungen
  (Spiegeltest) und Resturlaub = Verfügbar − Genommen − Genehmigt.
- **Ein Ort für PDF-Zahlen.** `composition/pdf-format.ts` ist der einzige Ort, der PDF-Zahlen schreibt; der Wächtertest
  `pdf-output-guard-617.test.ts` verbietet `.toFixed`, Locale-Formatierer und die Altfarbe in `pdf.ts` und
  `pdf-format.ts`.

#### Datenschutz

Der Monatsexport enthält Krankheitstage. Das ist zulässig, weil sein Zweck die Vorbereitung der Lohnabrechnung ist:
Entgeltfortzahlung im Krankheitsfall (EFZG) und das Lohnkonto (§ 41 EStG). Rechtsgrundlage ist Art. 9 Abs. 2 lit. b DSGVO
(Erfüllung arbeits- und sozialrechtlicher Pflichten) zusammen mit Art. 6 Abs. 1 lit. c DSGVO. Die Zweckbindung
(Art. 5 Abs. 1 lit. b DSGVO) bleibt gewahrt, weil Publikum und Berechtigung dieselben sind wie beim DATEV-Export
(`report:export`, die Personalabteilung hält sie nicht). Die Begründung stützt sich nicht auf § 26 BDSG, dessen
Generalklausel seit EuGH 30.03.2023, C-34/21, zweifelhaft ist. Das Problem von #617 war Krankheit in einer
**Urlaubs**liste für ein anderes Publikum; diese Liste gibt es nicht mehr, und die Urlaubsübersicht ist durch die
Positivliste im Code auf Urlaub beschränkt. Eine künftige Abwesenheitsart gelangt dadurch nie von selbst hinein.

#### Was bewusst NICHT geschah

- **Kein Salonfilter.** #542 verengt `selectMonthlyExportPersons` nach Stammsalon; DATEV bleibt ungefiltert (§ 41 EStG).
- **Ist und „DATEV-Std.“ werden nebeneinander gedruckt, nicht vereinheitlicht.** Gemessene Ursachen eines Unterschieds
  (617-01) stehen in der Legende des Dokuments: Beschäftigungszeitraum (das Konto kappt, DATEV summiert alle Einträge des
  Monats), Berufsschul-Anrechnung, nur Einträge der Art Arbeit (DATEV summiert jede Art), gespeicherter Stand eines
  abgeschlossenen Monats.
- **Stichtag, aber keine Statushistorie.** Der Abschnitt „Urlaubsjahr“ liest die heutigen Status der Anträge. Eine
  Genehmigung oder Ablehnung nach dem Stichtag verschiebt Tage daher auch bei einem erneuten Export; es wird keine
  frühere Statuslage rekonstruiert. Reproduzierbar sind der Stichtag, der wirksame Übertrag und „Beantragt“ nach Anlagedatum
  (`pendingCreatedByAsOfDays`).
- **Die Selbstheilung der Urlaubsübersicht fasst nur noch Urlaubszeilen an.** Zeilen anderer Anspruchsarten gehören nicht
  mehr zur Antwort und werden dort nicht mehr geheilt. Geprüft, ob ein Leser davon abhing: `GET
/leave/entitlements/:employeeId` heilt beim Laden alle Zeilen der Person selbst (`selfHealUsedDays`); die übrigen
  Leser von `usedDays` (16 Nicht-Testdateien) betreffen Urlaubszeilen. Kein Leser der übrigen Zeilen hing an der Heilung der
  Übersicht.
- **Anonymisierte Personen.** Der Monatsexport folgt der DATEV-Population: Eine anonymisierte Person erscheint für ihre
  Beschäftigungsmonate (bis #666 auch ohne Austrittsdatum), ihr Anspruch wird nie geschrieben (kein Heilen, im Speicher
  ausgerichtet).
- Die Kompatibilitätsfunktionen `parseCompatRoleFilter`/`compatRoleUserWhere` bleiben bis Release B (#641). Die Absence-Exporte
  ohne Produktivaufrufer sind mit #674 entfernt (`BS_NO_LEAVE_LABEL`, `leaveRequestDaysWithin`) bzw. nicht mehr aus
  `index.ts` exportiert (`vocationalSchoolDatesForLeaveRequests`, bleibt im Kontext).
- Die Kachel „PDF-Bericht“ der Admin-Exportseite → #593; die Neugestaltung der Berichtsseite → #612.

#### Auswirkung auf die Kontexte

- **Zeiterfassung:** keine.
- **Abwesenheiten:** additive Felder der Urlaubsfassade (`availableDays`, `takenDays`, `approvedUpcomingDays`,
  `pendingCreatedByAsOfDays`, `splitAsOf`) und das optionale `asOf`; die Urlaubsübersicht ist eine Positivliste.
- **Schichtplanung:** keine.
- **Arbeitszeitkonto:** additives `closingBalanceMinutes` an `computeMonthReportFigures`.
- **Unterbau:** keine — kein Export einer Unterbau-Datei und keine Unterbau-Semantik hat sich geändert.
- **Kompositionsschicht:** Monatsexport, Entfernungen, `pdf-format.ts`; keine Geschäftsregel hierher verschoben (die
  Personenauswahl bleibt in einer Funktion, die Urlaubszahlen kommen aus der Fassade).

#### Gemessen

Alle Zahlen stehen in den Zusammenfassungen der Pläne 617-01 bis 617-05 (Stand 617-04/05, danach nur Dokumentation).

- **DATEV byte-gleich:** Mit einem Neun-Personen-Fixture (u. a. Krankheit mit Attest, § 9, Austritt, Berufsschule,
  Waisen-Gutschrift) war die DATEV-Datei vor und nach dem Herauslösen von `loadDatevMonth` und `datevPersonFigures`
  identisch (1574 Byte, 24 Zeilen; 617-01).
- **Paritätstabelle:** Der Monatsexport druckt je Person genau die Minuten von `computeMonthReportFigures`, die
  Abwesenheitstage der DATEV-Zeilen und die Normalstunden der DATEV-Datei; die Personenmenge ist gleich der der
  DATEV-Datei (12 Zeilen, 12 `pnr`; 617-01).
- **Seiten:** Monatsexport 3 Zeilen = 1 Seite, 60 Zeilen = 2 Seiten (4 mit dem Abschnitt „Urlaubsjahr“, 617-02);
  Stundennachweis mit 19 Einträgen = 1 Seite (vorher 2), 45 Einträge = 2 Seiten (vorher 4); Mutationsnachweis mit dem
  alten Fußzeilentext (617-01, 617-05).
- **Wächter:** `pdf-output-guard-617.test.ts` geht `pdf.ts` und `pdf-format.ts` ab (mindestens zwei Dateien, beide
  benannt); zwei Mutationen (ein `.toFixed`, eine falsche Markenfarbe) färben ihn rot (617-05).
- **Neutralität:** 1752 → 1720 Fälle (drei Dateien) = vier entfernte Routen × 8 Akteure (eine in 617-03, drei in 617-04);
  die Orakelzellen je Akteur 299 → 298 → 295 (Untergrenze 290, unverändert); `matrix.json`, `recipients.json`, `activity-auth.json` und
  `matrix-amendments.json` sind byte-gleich zum Merge-Basisstand, es wurde kein Amendment erzeugt (617-03/04).
- **Entfernte Testfälle ohne Gegenstand:** zwölf, je mit deutscher Begründung in 617-03 (vier Rollenfilter-Fälle der
  Firmen-PDF-Route) und 617-04 (acht Fälle der Urlaubsliste, der Urlaubs-PDFs und ihrer Zugriffsfälle); alle übrigen
  Fälle dieser Dokumente wurden auf den Monatsexport oder die Urlaubsübersicht der App umgestellt. Die Untergrenze der
  Testzahl sinkt deshalb einmalig um 36 (10400 → 10364 zwischen den vollen Läufen von 617-03 und 617-04:
  Neutralitätsmatrix −24, `reports-hr-86` −3, `reports.test` −3, `reports-vacation-population-613` −2,
  `reports-salon-scope` −2, `reports-priced-leave-days-451` −1, `reports-bs-leave-448` −1) und die des Fremdmandanten-Durchlaufs um drei (209 → 206), jeweils nur wegen
  entfernter Routen, nicht wegen gelockerter Prüfungen.
- **Eingefrorene Stände:** `reports-monthly-frozen-84`, `dashboard-team-week-frozen-84`, `whole-tenant-frozen-85` sind
  byte-gleich zum Merge-Basisstand.

#### Nachrechnen

```bash
pnpm --filter @clokr/api run test:setup
pnpm --filter @clokr/api exec vitest run src/__tests__/monthly-export-617.test.ts \
  src/composition/__tests__/monthly-export-render-617.test.ts src/composition/__tests__/pdf-format-617.test.ts \
  src/contexts/absence/__tests__/vacation-balance-split-617.test.ts src/__tests__/leave-overview-vacation-617.test.ts \
  src/composition/__tests__/stundennachweis-render-617.test.ts src/__tests__/stundennachweis-day-rows-617.test.ts \
  src/__tests__/pdf-output-guard-617.test.ts src/__tests__/reports-hr-86.test.ts
pnpm --filter @clokr/web exec vitest run src/__tests__/reports-monthly-export-617.test.ts src/lib/reports
git diff --quiet "$(git merge-base HEAD origin/main)" -- apps/api/src/__tests__/neutrality/recorded
```

### Nachtrag 2026-10-17 (Phase 588, Issue #588) — Team-Salden aus einem Modul hinter denselben zwei Saldo-Gates; Prognose-Beschriftung aus den Daten

**Schwere: Anzeige. Keine Schema-, Migrations-, Routen-, Permission- oder Unterbau-Änderung.** Additive Felder an vier
Leseantworten; eine neue Fassadenfunktion der Zeiterfassung. Kein Saldo wird anders berechnet. Stand der Messungen: Branch
`feat/588-team-salden`, Basis `59ef142e`.

#### Warum

Das Issue verlangte vier Dinge: Top Plus/Minus im Team-Bereich des Dashboards, den Median statt des Durchschnitts mit einer
dokumentierten Ausreißerregel, jeden Saldo als ±H:MM und „Laufender Monat“ nur dort, wo der Wert wirklich den laufenden
Monat betrifft (die Spalte „Verlauf“ zeigt Daten oder entfällt). Der Durchschnitt über `balanceHours` ließ Personen ohne
jede Erfassung und „Nur erfassen“-Verträge die Teamzahl verzerren; die Beschriftung „Laufender Monat (Prognose)“ stand
auch dort, wo die Prognose seit mehreren Monaten ohne Abschluss läuft. Owner-Entscheidungen und Grauzonen stehen als
Kommentar am Issue #588.

#### Was sich geändert hat

- **Ein Modul für Team-Salden.** `apps/web/src/lib/reports/team-saldo.ts` ist der einzige Ort für den Median, die Top 5
  Plus/Minus und die Ausreißerregel. `/reports` und die Dashboard-Karte „Salden“ lesen es; der Wächtertest
  `team-saldo-one-place-588.test.ts` verbietet einen zweiten Median, einen Mittelwert über Zeilensalden und eine
  Teamfläche, die das Modul nicht liest.
- **Dieselben zwei Gates.** Die Karte liest `GET /dashboard/overtime-overview` und damit dieselben zwei Gates wie bisher,
  `team-overview:read` UND `overtime:read`; Reichweite und Salonfilter (#542, Personensaldo nicht nach Salon aufgeteilt)
  gelten unverändert. Ohne beide Rechte wird die Karte ausgeblendet und nichts angefragt; sie lädt nach dem Team-Block und
  blockiert ihn nie.
- **Drei Fakten je Zeile** der Saldenübersicht (additiv): `hasRecordedTime` (gültiger, abgeschlossener Arbeitseintrag seit
  Eintritt, eine Sammelabfrage über die Fassade der Zeiterfassung), `trackOnly` (Regel #494 des heute gültigen Vertrags)
  und `unconfirmedMonths` (Monate vom ersten offenen Tag bis einschließlich zum laufenden Monat).
- **Median und Ausreißerregel.** Wert einer Person ist der Gesamtsaldo. Es zählen nur Personen im heutigen Team mit
  verfügbarem Live-Saldo, ohne „Nur erfassen“-Vertrag und mit Erfassung seit Eintritt. Alle anderen stehen mit genau einem
  Grund in einer Liste („Saldo nicht verfügbar“, „nur Zeiterfassung“, „ohne Erfassung“), nie stillschweigend weggelassen;
  ausgeschiedene Personen behalten ihren eigenen Abschnitt (#613).
- **Drei Spalten, ±H:MM.** Jeder Saldo im Team-Bereich läuft über `fmtBalance` (Vorzeichen immer, auch „±0:00“; das gilt
  jetzt in jeder Variante von `SaldoAnzeige`), je Wert eine Spalte (Abgeschlossen · Prognose · Gesamt). Die stets leere
  Spalte „Verlauf“ und ihr Sparkline-Code entfallen.
- **Prognose-Beschriftung an einer Stelle.** `apps/web/src/lib/saldo/forecast-label.ts` wählt die Beschriftung aus
  `unconfirmedMonths` und `hasClosedMonth`: genau 1 → „Laufender Monat (Prognose)“; mehr als 1 mit abgeschlossenem Monat →
  „Seit Monatsabschluss (Prognose)“; sonst „Prognose (seit Eintritt)“; gemischte Spalte „Prognose (offener Zeitraum)“. Das
  gilt auf jeder Fläche: Dashboard, Zeiterfassung, Team-Zeiten, Abwesenheiten (Kennzahl und Antragsformular), Berichte.
  `unconfirmedMonths` liefern zusätzlich `GET /dashboard`, `GET /overtime/:employeeId` und die sichtbaren Zweige von
  `GET /leave/overtime-balance`.

#### Auswirkung auf die Kontexte

- **Zeiterfassung:** eine neue lesende Fassadenfunktion `employeesWithValidWorkSince` (Fassadenzählung 146 → 147, ohne
  Ausnahme durch F1–F3 gelaufen).
- **Abwesenheiten:** `GET /leave/overtime-balance` trägt ein additives Feld in den sichtbaren Zweigen; der maskierte Zweig
  (`balanceVisible: false`) ist unverändert und trägt den Schlüssel nicht.
- **Schichtplanung:** keine.
- **Arbeitszeitkonto:** `computeOvertimeBalanceBreakdown` meldet zwei weitere Werte (`unconfirmedMonths`, `trackOnly`); keine
  Rechnung ist geändert, die Datei hat nur hinzugefügte Zeilen (26 hinzugefügt, 0 entfernt), und `GET /overtime/:employeeId`
  trägt ein additives Feld.
- **Unterbau:** keine.
- **Kompositionsschicht:** drei additive Zeilenfelder der Saldenübersicht und ein additives Feld an `GET /dashboard`; keine
  Geschäftsregel dorthin verschoben (die Regel für „Nur erfassen“ bleibt `isTrackOnlySchedule`, die Erfassung kommt aus der
  Fassade).

#### Was bewusst NICHT geschah

- **Keine Saldo-Rechnung.** Kein Kernel des Arbeitszeitkontos wurde verändert; Zeilen- und Personen-Salden sind vor und nach
  gleich (Gleichheitstests gegen `GET /overtime/:employeeId`).
- **Der maskierte Zweig von `GET /leave/overtime-balance` bleibt unverändert.**
- **`snapshots` bleibt in der API** (P-09); nur die Spalte der Seite entfällt. Die Monatsabschluss-Tabelle der Person behält
  `SaldoAnzeige` (P-08).
- **Keine neue Route, keine neue Berechtigung, kein Folge-Issue** (Entscheidung zu P-14).
- **Die PDF-Beschriftungen sind unverändert** (`OVERTIME_LABEL_CONFIRMED`, `OVERTIME_LABEL_FORECAST`,
  `MONTHLY_EXPORT_FORECAST_LEGEND`): eine PDF-Zeile ist monatsbezogen.
- **Die Berichtsseite wird nicht neu gestaltet** (#612); die Tabelle hat jetzt drei Saldo-Spalten und scrollt auf schmalen
  Bildschirmen waagerecht.

#### Laufzeit

Die Übersicht kostet gemessen etwa 18 ms je Person (Testumgebung: 31 Personen 556–600 ms, 101 Personen 1809–1864 ms; die
Zeit ist linear in der Personenzahl). Weil die Karte erst startet, nachdem der Team-Block geladen ist, und ihn nie
blockiert, verzögert das die Team-Woche nicht; eine Reichweite von 300 Personen braucht rund 5–6 s, bis die Karte
erscheint, und bis dahin zeigt sie ein Platzhalterbild.

#### Gemessen

Alle Zahlen stehen in den Zusammenfassungen der Pläne 588-01 bis 588-05.

- **Neutralität:** 0 abweichende Zellen. Die drei Neutralitätsdateien liefen nach Plan 01 und Plan 03 mit 1720 Fällen grün;
  `neutrality/recorded` und die vier eingefrorenen Stände (`dashboard-team-week-frozen-84`, `reports-monthly-frozen-84`,
  `reports-hr-86`, `whole-tenant-frozen-85`) sind byte-gleich zum Merge-Basisstand, `leave-overtime-balance-mask-85b` ist
  unverändert.
- **Wächter:** `team-saldo-one-place-588.test.ts` geht 266 Nicht-Test-Dateien unter `apps/web/src` ab (Untergrenze 150), das
  Register der Mittelwert-Ausnahmen ist leer, die Aufrufstellen der Prognose-Beschriftung sind 3 `SaldoAnzeige` mit
  Aufteilung und 2 `KontoSaldoCard` (Untergrenzen 3 und 2); zwölf Fälle, acht Mutationsnachweise lassen ihn rot werden.
- **Fassade:** `lint:facade-signatures` meldet 147 Funktionen, 17 Ausnahmen, 0 Befunde.
- **Eine Abfrage:** mit mindestens sechs Personen ruft eine Anfrage `timeEntry.groupBy` genau einmal auf.
- **Testzahlen:** voller API-Lauf nach Plan 01 10 527 bestanden (3 übersprungen, Bestand), voller Web-Lauf nach Plan 04
  3 603 bestanden; die Endstände des Gesamtlaufs stehen in der Zusammenfassung von 588-05.
- **Visuelle Baselines:** `01-dashboard` und `10-mobile-dashboard` ändern sich absichtlich (neue Karte, Wert-Bereich
  maskiert); `04` und `05` (Abwesenheiten) ebenfalls, weil die neue Beschriftung und „±0:00“ die Kennzahl-Box um 15 px
  verkürzen. Alle in der festgelegten Image-Umgebung neu erzeugt; ein Unterschied in der CI wäre ein Befund.

#### Nachrechnen

```bash
pnpm --filter @clokr/api run test:setup
pnpm --filter @clokr/api exec vitest run src/__tests__/overtime-overview-588.test.ts src/__tests__/personal-saldo-label-588.test.ts \
  src/contexts/time-tracking/__tests__/facade-time-entries.test.ts
pnpm --filter @clokr/web exec vitest run src/lib/reports/__tests__/team-saldo-588.test.ts \
  src/lib/saldo/__tests__/forecast-label-588.test.ts src/__tests__/team-saldo-one-place-588.test.ts \
  src/__tests__/reports-team-saldo-588.test.ts src/__tests__/personal-saldo-label-588.test.ts \
  src/__tests__/dashboard-team-saldo-588.test.ts src/__tests__/dashboard-team-saldo-pending-588.test.ts
git diff --quiet "$(git merge-base HEAD origin/main)" -- apps/api/src/__tests__/neutrality/recorded
```

## R — Fehlender Urlaubsanspruch bei Mitarbeiteranlage (Phase 416, Issue #416)

**Schwere: informativ. Keine Berechtigungsänderung — eine reine Response-Body-Erweiterung einer
bestehenden Route, erfasst über das Amendment-Register (Eintrag N/Issue #360-Mechanismus), damit
`permission-neutrality-matrix.test.ts` grün bleibt.**

### Warum dieser Eintrag existiert

Issue #416: kein Codepfad legte vor dieser Phase automatisch eine `LeaveEntitlement`-Zeile
(VACATION) für eine neue Mitarbeiterin an — nur ein manueller Admin-Schreibvorgang
(`PUT /settings/vacation/:employeeId`) tat das. Neue Mitarbeitende hatten dadurch bis zum ersten
manuellen Eintrag keinen sichtbaren Urlaubsanspruch. Die Phase schließt die Lücke an drei Stellen
(Mitarbeiteranlage, Erstzugriff-Self-Heal, Reparatur-Skript) über einen gemeinsamen Facade-Helper
(`ensureVacationEntitlementForYear`, `contexts/absence/facade/entitlements.ts`) und macht die
verbleibende Lücke im Urlaubsbericht sichtbar (`GET /reports/leave-overview`, Task 6): aktive
Mitarbeitende ohne VACATION-Zeile für das abgefragte Jahr erscheinen jetzt als Platzhalter-Zeile
(`missingEntitlement: true, leaveType: null`) statt stillschweigend zu fehlen. Diese
Sichtbarkeits-Erweiterung ändert die Antwort der Route für sechs Akteure mit Zugriff (die
IDs-Liste enthält jetzt zusätzlich die drei Fixture-Mitarbeitenden, die vorher keine
Urlaubsanspruch-Zeile hatten) und macht die Neutralitätsmatrix ohne ein Amendment rot — nicht,
weil sich Zugriff geändert hätte (alle sechs Akteure sehen die identischen drei neuen IDs), sondern
weil der Response-Body selbst mehr Zeilen trägt.

### Was sich geändert hat

- **`GET /api/v1/reports/leave-overview` liefert zusätzliche Platzhalter-Zeilen** für aktive
  Mitarbeitende ohne VACATION-`LeaveEntitlement` des abgefragten Jahres
  (`apps/api/src/composition/reports.ts`, Task 6). Die Route selbst schreibt dabei nichts — reine
  Anzeige, kein `ensureVacationEntitlementForYear`-Aufruf in diesem Handler.
- **Sechs Amendment-Einträge** (Issue 416, `ADMIN`/`APIKEY_ADMIN`/`APIKEY_PLAIN`/
  `FALLBACK_ADMIN`/`FALLBACK_MANAGER`/`MANAGER` × `GET /api/v1/reports/leave-overview | none`) in
  `apps/api/src/__tests__/neutrality/recorded/matrix-amendments.json`: `ids` wächst von 6 auf 9
  Einträge (drei neue Fixture-Mitarbeitende: `anchor.admin.employee`, `anonymized.employee`,
  `holder.employee`), `status` bleibt 200 für alle sechs. `EMPLOYEE`/`FALLBACK_EMPLOYEE` bleiben
  unverändert bei 403/`[]` (kein Berechtigungszugriff auf die Route, daher keine Amendment-Zeile
  nötig). `recorded/matrix.json` bleibt byte-gleich.
- Kein Unterbau-Feld/-Modell geändert — `LeaveEntitlement.isAutoCalculated` (bereits vorhanden)
  und ein additives, optionales Feld auf der internen `UpsertVacationEntitlementData`-Schnittstelle
  der Abwesenheiten-Fassade sind die einzigen Signaturänderungen, beide additiv.

### Auswirkung auf die Kontexte

- **Zeiterfassung:** keine Codeänderung.
- **Abwesenheiten:** `vacation-calc.ts` (neue `calculateProRataVacationForHire`),
  `facade/entitlements.ts` (neuer `ensureVacationEntitlementForYear`, additives Feld auf
  `UpsertVacationEntitlementData`), `api/leave-settings.ts` (CREATE-vs-UPDATE-Audit-Fix,
  Erstzugriff-Self-Heal).
- **Schichtplanung:** keine Codeänderung.
- **Arbeitszeitkonto:** keine Codeänderung.
- **Kompositionsschicht:** `composition/reports.ts` — `GET /leave-overview` liefert zusätzliche
  Platzhalter-Zeilen (Task 6, dieser Eintrag).
- **Unterbau:** `contexts/platform/api/employees.ts` — `POST /employees` ruft
  `ensureVacationEntitlementForYear` im Rahmen der bestehenden Transaktion auf (invariant-carrying,
  ADR 0002 Entscheidung 10); keine Modell-/Feldänderung.

### Gemessen

- **Neutralitätsmatrix (`permission-neutrality-matrix.test.ts`, voller Lauf):** bleibt grün, mit
  genau sechs neuen, dokumentierten Amendments (Issue 416) in `matrix-amendments.json` — alle für
  dieselbe Route, alle mit identischem `from`/`to`. `recorded/matrix.json` und die Testdatei selbst
  unverändert.
- **`lint:facade-signatures`:** golden count 128 → 129 exportierte Facade-Funktionen
  (`ensureVacationEntitlementForYear` neu), 0 unexcepted findings.
- **`lint:tenant-scoping`:** zwei vorgepinnte Ausnahme-Einträge in
  `lint-tenant-scoping-exceptions.json` (`POST /:id/resend-invitation`,
  `DELETE /:id/hard-delete`, beide in `employees.ts`) um +33 Zeilen verschoben durch den neuen
  Codeblock in `POST /employees` — reine Zeilenverschiebung, kein neuer Fund (0 findings vor und
  nach dem Re-Pinning).

### Nachrechnen

```bash
grep -c '"issue": 416' apps/api/src/__tests__/neutrality/recorded/matrix-amendments.json
pnpm --filter @clokr/api exec vitest run src/__tests__/permission-neutrality-matrix.test.ts
pnpm --filter @clokr/api run lint:facade-signatures
pnpm --filter @clokr/api run lint:tenant-scoping
pnpm --filter @clokr/api test
```

## S — SHIFT_BASED-Urlaubstage werden nach Vertrag statt nach Schichtplan gezählt (Phase 417, Issue #417)

**Schwere: fachlich bedeutsam (BUrlG § 3) — keine Berechtigungsänderung.**

### Warum dieser Eintrag existiert

Phase 107 (D-06) entschied: SHIFT_BASED-Urlaubstage werden "roster-exact" gezählt — eine ganze
ISO-Woche innerhalb des Zeitraums zählt vertraglich, eine Teilwoche zählt exakt nach den an diesem
Tag tatsächlich aktiven Schichten, sofern die Woche überhaupt einen Schichtplan hat; ohne
Schichtplan in dieser Woche griff eine vorläufige Schätzung
(`min(Kalendertage, Vertragstage) − Feiertage`, als `daysProvisional: true` markiert), die sich bei
jeder späteren Schichtplan-Änderung über `recalcProvisionalLeaveForShiftChange()`
(`apps/api/src/contexts/absence/shift-leave-recalc-resolver.ts`) neu berechnete.

Befund von prod (29.09.2026, Issue #417): Im Salon wird ein Urlaubstag gerade NICHT als Schicht
geplant. Beide Reihenfolgen landeten deshalb bei `days: 0`: (1) Schicht zuerst per Phorest
entfernt, Antrag danach findet keine Schicht in einer sonst verplanten Woche → 0 Tage (exakter
Zweig zählt 0 am ungeplanten Tag). (2) Antrag zuerst (vorläufig geschätzt), Salon plant die Woche
danach ohne genau diesen Tag → Neuberechnung zählt "exakt" und setzt den Antrag auf 0 Tage. Der
gesetzliche Urlaubsanspruch wurde dadurch nie tatsächlich verbraucht.

**Owner-Entscheidung (29.09.2026, bindend, ersetzt Phase-107-Entscheidung D-06):** Urlaubstage von
SHIFT_BASED-Mitarbeitenden werden NACH VERTRAG gezählt, unabhängig vom Schichtplan. Begründung:
§ 3 BUrlG bemisst Urlaub nach den vertraglichen Arbeitstagen; der Schichtplan bildet im Salon den
Urlaub gerade nicht ab.

### Was sich geändert hat

- **`countShiftBasedLeaveDays()`** (`apps/api/src/contexts/absence/vacation-calc.ts:377-418`)
  zählt jetzt ausschließlich nach Vertrag: eine ganze ISO-Woche im Zeitraum zählt
  `contractWorkDaysPerWeek` abzüglich gesetzlicher Feiertage in dieser Woche; eine Teilwoche zählt
  `min(Kalendertage der Teilwoche, contractWorkDaysPerWeek) − Feiertage in der Teilwoche` — die
  bestehende "flache" Formel aus Phase 107 D-07/D-08, jetzt UNIFORM auf jede Woche angewandt statt
  nur auf eine Woche ohne Schichtplan. Der Schichtplan (`rosteredDates`/`weeksWithRoster`) wird
  nicht mehr abgefragt — die Funktionssignatur verlor diese beiden Parameter. `provisional` bleibt
  im Rückgabetyp (Kompatibilität für Aufrufer), ist aber ab jetzt immer `false`.
- **`resolveLeaveDays()`** (`apps/api/src/contexts/absence/leave-days.ts:396-426`) fragt für
  SHIFT_BASED keine `Shift`-Zeilen mehr ab (`getShiftsInRange`-Aufruf entfernt) — der Schichtplan
  ist für die Urlaubs-Tagezählung nicht mehr relevant.
- **`recalcProvisionalLeaveForShiftChange()`** (`shift-leave-recalc-resolver.ts:195`) bleibt
  unverändert bestehen, wird aber für JEDEN neuen/neu genehmigten Antrag zum No-op: sein Filter
  (`daysProvisional: true`) trifft auf keine neue Zeile mehr zu, da `resolveLeaveDays()` für
  SHIFT_BASED nie wieder `provisional: true` liefert. Die Funktion bleibt als Sicherheitsnetz für
  ALTBESTAND (Zeilen mit `daysProvisional: true` von vor diesem Fix) aktiv, bis das
  Korrektur-Skript (unten) sie bereinigt hat — siehe die ausführliche Begründung im Code-Kommentar
  direkt über der Funktion. Keiner der elf Aufrufer (sieben in `scheduling/api/shifts.ts`, vier in
  `services/phorest/sync-shifts.ts`) wurde geändert.
- **Neues Korrektur-Skript**
  (`apps/api/scripts/recalculate-shift-based-leave-days.ts`, Geschwister-Skript zu
  `backfill-missing-vacation-entitlements.ts`, dessen `TODO(#417)`-Kommentar hierher verweist):
  findet SHIFT_BASED-VACATION-Anträge (PENDING/APPROVED), deren gespeicherte `days`/
  `daysProvisional` vom heutigen Vertragswert abweichen. PENDING wird direkt korrigiert
  (`UPDATE`-Audit); APPROVED wird über dasselbe Rückbuchen/Neubuchen-Paar korrigiert, das
  `PATCH /requests/:id/correct` (Phase 94) nutzt, mit `LEAVE_CORRECTED`-Audit; ein Antrag, dessen
  Zeitraum einen gesperrten Monat berührt, wird übersprungen und gemeldet — nie in-place
  editiert. Dry-Run per Default, `--confirm` zum Schreiben.
- **Keine Migration.** `LeaveRequest.daysProvisional Boolean?` bleibt als Spalte bestehen — sie
  wird für neue Zeilen nur noch nie wieder `true`, das ist eine semantische, additive Änderung,
  keine Schema-Änderung.

### Auswirkung auf die Kontexte

- **Zeiterfassung:** keine Codeänderung.
- **Abwesenheiten:** `vacation-calc.ts` (`countShiftBasedLeaveDays()` neu formuliert, Signatur
  verkleinert), `leave-days.ts` (`resolveLeaveDays()` fragt keinen Schichtplan mehr ab),
  `shift-leave-recalc-resolver.ts` (unverändert, Code-Kommentar zur Rolle als Sicherheitsnetz für
  Altbestand ergänzt), neues Skript `scripts/recalculate-shift-based-leave-days.ts`.
- **Schichtplanung:** keine Codeänderung — die elf Aufrufer von
  `recalcProvisionalLeaveForShiftChange()` in `scheduling/api/shifts.ts` (sieben) /
  `services/phorest/sync-shifts.ts` (vier) bleiben unverändert; ihr Effekt auf NEUE Urlaubsanträge ist
  jetzt strukturell ein No-op (siehe oben), ohne dass ein Aufrufer angepasst wurde.
- **Arbeitszeitkonto:** keine Codeänderung. Geprüft: `calcLeaveAbsenceMinutesTz()`
  (`contexts/working-time-account/timezone.ts:479-518`) liest `LeaveRequest.days` NICHT — der
  Soll-Abzug für eine Abwesenheitsperiode wird für SHIFT_BASED/FLEXTIME über `avgWorkMinutesCore()`
  rein aus dem Kalenderzeitraum (`from`/`to`) und dem Vertrags-Durchschnitt berechnet, komplett
  unabhängig von der Urlaubstage-ZÄHLUNG (die nur `LeaveEntitlement.usedDays` betrifft). Die
  "genau einmal"-Invariante (`sbClaimed`-Set in `close-employee-month.ts`) dedupliziert über den
  Kalenderzeitraum, nicht über `days` — von dieser Phase nicht berührt. Golden-Matrix
  (`golden-matrix.test.ts`, 38 Fälle) und Shift-Based-Saldo-Paritätstests
  (`shift-based-saldo-parity.test.ts`, 33 Fälle) liefen unverändert grün, ohne eine einzige
  angepasste Erwartung — empirische Bestätigung der Unabhängigkeit.
- **Kompositionsschicht:** keine Codeänderung.
- **Unterbau:** keine Codeänderung.

### Gemessen

- `apps/api/src/contexts/absence/__tests__/vacation-calc.test.ts` — die D-05..D-09-Testgruppe
  (vormals roster-abhängig) wurde durch eine äquivalente, roster-unabhängige Gruppe ersetzt
  (12 Fälle, alle grün).
- Drei neue Regressionstests (`apps/api/src/__tests__/leave-days-by-contract-417.test.ts`),
  bewiesen ROT gegen den Stand unmittelbar vor diesem Fix (separates `git worktree add --detach`
  gegen `origin/main`, siehe PR-Beschreibung): (a) Schicht gelöscht, dann Antrag → vorher 0 Tage,
  jetzt 1 Tag; (b) Antrag zuerst, dann Woche ohne diesen Tag geplant → vorher fiel `days` von 2
  auf 0, jetzt bleibt es bei 2; (c) ganze Woche auf 5-Tage-Vertrag → 5 Tage (war schon vorher
  korrekt, jetzt als Regressionsschutz fixiert).
- Drei bestehende Integrationssuiten (`shift-leave-recalc.test.ts`,
  `phorest-shift-leave-recalc.test.ts`, `leave-provisional-approval.test.ts`) mussten an die neue
  Semantik angepasst werden — 14 Erwartungen, die das alte roster-exakte Verhalten prüften, wurden
  auf das neue Verhalten umgeschrieben (Details: PR-Beschreibung).
- Golden-Matrix + Shift-Based-Saldo-Parität: 91 Tests, unverändert grün, 0 angepasste Erwartungen.

### Nachrechnen

```bash
pnpm --filter @clokr/api exec vitest run src/contexts/absence/__tests__/vacation-calc.test.ts
pnpm --filter @clokr/api exec vitest run src/__tests__/leave-days-by-contract-417.test.ts
pnpm --filter @clokr/api exec vitest run src/__tests__/shift-leave-recalc.test.ts src/__tests__/phorest-shift-leave-recalc.test.ts src/__tests__/leave-provisional-approval.test.ts
pnpm --filter @clokr/api exec vitest run src/__tests__/golden-matrix.test.ts src/__tests__/shift-based-saldo-parity.test.ts
pnpm --filter @clokr/api exec tsx scripts/recalculate-shift-based-leave-days.ts --all-tenants
```

## T — Saldo: Urlaub reduziert die vertraglichen Wochenarbeitstage bei SHIFT_BASED (Phase 429, Issue #429)

**Schwere: fachlich bedeutsam (Überstundenberechnung) — keine Berechtigungsänderung.**

### Warum dieser Eintrag existiert

Issue #429 (Analyse-Kommentar gegen den echten Code,
https://github.com/sebastianzabel/clokr/issues/429#issuecomment-5909407943, AK-429-1, bereits vor
dieser Phase abgeschlossen) wies nach: der SHIFT_BASED-Urlaubs-Soll-Abzug lief über
`calcLeaveAbsenceMinutesTz()` → `avgWorkMinutesCore()`
(`apps/api/src/contexts/working-time-account/timezone.ts`), der einen Urlaubstag mit
`weeklyHours ÷ workDays.length` bewertete und nur Tage INNERHALB von `workDays` anrechnete — beides
falsch für "N Vertragstage/Woche, der Schichtplan entscheidet welche". Vier-Modell-Analyse (main =
v1.13.1, Juni 2026, Woche 08.–14.06., 4-Tage-Vertrag/38h): Urlaub Montag (ungeplant), Di–Do 10,5h
gearbeitet — korrekt wäre +180 min (+3h Überstunden); der alte Code lieferte je nach
`workDays`-Variante −10 min (Mo–Sa), +66 min (Mo–Fr) oder +180 min (Mo–Do, Zufallstreffer); Variante
A2 (Urlaub Samstag statt Montag) ebenso falsch (−228 min bzw. −3,80h je Variante). Die ganze
Urlaubswoche (Fall B) lieferte in allen Varianten korrekt 0 — das Symptom betraf nur Teilwochen.

### Was sich geändert hat

- **`weekLeaveDays()`** (privater Kernel, `apps/api/src/contexts/absence/vacation-calc.ts:419`) und
  **`leaveDaysPerWeek()`** (`vacation-calc.ts:506`, D-01/D-02) — neue Exportfunktion, die über die
  UNION aller Zeilen pro ISO-Woche rechnet und DIESELBE Formel wie `countShiftBasedLeaveDays()`
  (`vacation-calc.ts:434`, Phase 417/Eintrag S) verwendet — bewiesen per Property-Test (1764
  Parameterkombinationen, 0 Abweichungen zwischen beiden Funktionen).
- **`contractWorkDaysPerWeekFrom()`** (`apps/api/src/contexts/absence/leave-days.ts:97`, D-03) — die
  Fallback-Kette selbst (`contractWorkDaysPerWeek` → `workDays.length` →
  `TenantConfig.defaultWorkDays.length` → `5`, Phase 107 D-04) wurde hierhin extrahiert;
  `resolveContractWorkDaysPerWeek()` (`leave-days.ts:121`) holt nur noch Schedule + TenantConfig und
  delegiert (CLAUDE.md § Schedule Types korrigiert im selben Commit).
- **`shiftBasedLeaveCreditByDate()`** (neues Modul
  `apps/api/src/contexts/working-time-account/shift-based-leave-credit.ts:58`, D-06) — eine
  Pro-Datum-Kredit-Map je ISO-Woche: `leaveDaysPerWeek(...).days ×
(weeklyHours×60÷contractWorkDaysPerWeek)`, pro Wochenteil gekappt auf `calcExpectedMinutesTz()`
  desselben Teils (D-08). Die Wochen berechnet der Aufrufer `close-employee-month.ts`; das Modul
  importiert `contexts/absence` bewusst NICHT und bleibt so außerhalb des per CI gezählten
  Import-Zyklus (`measure-context-boundary-imports --cycles --check 22`). Der Beleg-Gegenpart
  **`shiftBasedLeaveMinutesForRequest()`** liegt aus demselben Grund in Abwesenheiten
  (`apps/api/src/contexts/absence/vacation-calc.ts:633`, D-13).
- **`close-employee-month.ts`** (`apps/api/src/contexts/working-time-account/close-employee-month.ts:742-772`)
  — NUR die SHIFT_BASED-`approvedLeave`-Schleife (`sbLeaveCredit`) wurde umgestellt: statt eines
  Live-`calcLeaveAbsenceMinutesTz()`-Aufrufs pro Zeile liest sie aus `sbLeaveCreditByDate` (D-06).
  `grep -c "calcLeaveAbsenceMinutesTz" close-employee-month.ts`: 8 → 7 (genau −1 Aufruf).
- **`getScheduledHours()`** (`apps/api/src/contexts/absence/api/leave.ts:4117`, SHIFT_BASED-Zweig
  `:4143-4153`, Issue #293/D-13) — die Beleg-Funktion für eine einzelne Anfrage folgt derselben
  Formel (`shiftBasedLeaveMinutesForRequest()` statt der alten Ø-Methode), damit Beleg und Saldo
  dieselbe Zahl liefern.
- **`calcLeaveAbsenceMinutesTz()` selbst ist UNVERÄNDERT**
  (`apps/api/src/contexts/working-time-account/timezone.ts`) und bleibt die Funktion für: die
  SHIFT_BASED-`absences`-Schleife (`sbAbsenceCredit`, BS-Subtract-then-recredit, v1.8.27 —
  `close-employee-month.ts:798`) sowie JEDEN nicht-SHIFT-Zweig (`close-employee-month.ts:927`). Nur
  der SHIFT_BASED-**approvedLeave**-Pfad ruft sie nicht mehr auf — exakt die Schleife, die D-06
  ersetzt.

### Wie die "genau einmal"-Invariante gesichert bleibt

`sbClaimed` (`close-employee-month.ts:729`) ist UNVERÄNDERT (D-09) — nur WAS ein geclaimter Tag wert
ist, hat sich geändert, nicht die Claim-Reihenfolge (`sortForDedup`) oder der Dedup-Mechanismus
selbst. Bewiesen durch:

- `apps/api/src/__tests__/shift-based-leave-week-soll-429.test.ts` — § 9-Überlappung (zwei
  überlappende Zeilen == eine Union-Zeile), OPEN-01 (volltägige Zeile schlägt Halbtags-Zeile am
  selben Datum), Σ-Zeilenkredite == Gesamt, OVERTIME_COMP-Entnahme == Kredit (D-10),
  Monatsgrenzen-Split (D-07), Split-Request-Cap (D-08). Mutationsbeweis: `sbClaimed.has(dateStr)`
  entfernt (`if (false && ...)`) → 3 Tests rot (§9-Überlappung, OPEN-01, Split-Request-Cap — jeweils
  doppelte Anrechnung), reverted, wieder grün.
- `apps/api/src/__tests__/four-model-leave-analysis-429.test.ts` — die Vier-Modell-Analyse aus der
  Issue-Diskussion als Pin (17 Assertions): FIXED_SCHEDULE/FLEXTIME/MONTHLY_HOURS unverändert,
  SHIFT_BASED korrigiert (+180 min in A/A2, 0 in B, für alle drei `workDays`-Varianten).
- `apps/api/src/__tests__/section9-soll-dedup.test.ts` — unverändert grün bis auf zwei gerechtfertigte
  Erwartungsänderungen (Integration 4/5, s. „Gemessen" unten).

### D-05 (Feiertage)

`leaveDaysPerWeek()` erhält auf der Saldo-Seite bewusst ein LEERES Feiertags-Set (nicht das echte
Feiertagsfenster). Begründung: (a) der SHIFT_BASED-Vertrags-Soll wird heute bereits NICHT
feiertagsreduziert (Golden-Zellen `sb-40-4-feiertag`/`sb-30-4-feiertag`: "Feiertag NICHT abgezogen,
§615 verrechnet die Lücke") — ein Feiertag innerhalb eines Urlaubs bleibt dadurch weiterhin ein
Soll-freier Tag über den Urlaub selbst, exakt wie bisher; (b) der Live-Pfad übergibt ein
fenstergefiltertes Feiertags-Set, der Abschluss-Pfad den vollen Monat (`overtime-balance.ts`
`partialHolidayExclude`, `month-saldo.ts` `partialHolidaySet`) — Feiertage in die Wochenzählung
einzubeziehen hätte für Wochen mit einem zukünftigen Feiertag eine neue Live-vs-Close-Divergenz
erzeugt. Das ist eine bewusste Abweichung vom Anspruchs-Zähler (`resolveLeaveDays()`, der Feiertage
ausschließt) — dokumentiert, nicht übersehen.

### Nachtrag Audit (PR #437): Bemessung je Abwesenheitsart

Ein unabhängiges Audit fand: die Vertragswochen-Formel behandelte SICK wie VACATION, weil die
Antragszeilen keinen Typ trugen. Nach § 4 Abs. 1 EFZG (Lohnausfallprinzip) entlastet ein
Krankheitstag nur die Stunden, die tatsächlich gearbeitet worden wären — die geplante Schicht. Ein
ungeplanter Krankheitstag entlastet nichts (Beispiel 38 h / 4 Tage, krank am ungeplanten Montag:
`main` +3,17 h, die erste PR-Fassung +6,33 h Scheinüberstunden). Entscheidung nach dem Prinzip
„ersetzt die Art einen vertraglichen Arbeitstag, oder bezahlt sie nur tatsächlich geplante
Stunden?" — eine Stelle, `leaveCreditBasisForCode()` in `close-employee-month.ts`, über den einen
Mapper `toCloseMonthApprovedLeave()` (Pflichtfeld `creditBasis`, wie `isOvertimeCompensation`):

| Code                              | Basis       | Begründung                                                                              |
| --------------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `SICK`, `SICK_CHILD`              | Schichtplan | § 4 Abs. 1 EFZG; Kinderkrank (§ 45 SGB V) stellt ebenso nur von geplanter Arbeit frei   |
| `SPECIAL` (Sonderurlaub)          | Schichtplan | § 616 BGB: Vergütung für die ausfallende, geplante Arbeitszeit                          |
| `VACATION`                        | Vertrag     | BUrlG; einziger anspruchsverbrauchender Typ (`deductVacationDays`)                      |
| `OVERTIME_COMP`                   | Vertrag     | Owner-Entscheidung #293 („der Tag IST der Ø-Vertragstag"); Entnahme = Gutschrift (#220) |
| `EDUCATION`                       | Vertrag     | Bildungsurlaub zählt in Arbeitstagen je Jahr, wie Urlaub                                |
| `UNPAID`, `MATERNITY`, `PARENTAL` | Vertrag     | die Arbeitspflicht selbst ruht für den Zeitraum                                         |
| `OTHER`, unbekannt/`null`         | Vertrag     | Vor-Tracking-Brückenzeilen neutralisieren das Soll; bisheriges Verhalten                |

Schichtplan-Basis: Entlastung = Netto-Minuten der geplanten Schicht(en) des Tages (dieselbe
Netto-Regel wie R; halber Tag = Hälfte), ohne Schicht 0. Nur Vertrags-Basis-Zeilen gehen in
`leaveDaysPerWeek()` ein, ein Krankheitstag verändert also weder Ganzwochen-Prüfung noch Anteile.
Die Invariante bleibt: beide Basen laufen durch dieselbe `sbClaimed`-Erstbelegung in
`sortForDedup`-Reihenfolge — ein Tag mit Urlaub UND Krankheit wird genau einmal entlastet. Tests
(vorher rot: 570 statt 0, 570 statt 630, 1140 statt 1200): `shift-based-leave-week-soll-429.test.ts`
„SHIFT_BASED sick leave is credited roster-based" (ungeplanter Montag 0, geplanter Dienstag 630,
SICK_CHILD/SPECIAL, gemischte Woche, Überlappung) und die Vollständigkeit der Zuordnung über alle
elf Codes. Restgrenze: der Live-Pfad übergibt Schichten nur bis heute — eine Krankmeldung für einen
künftigen geplanten Tag entlastet live erst, wenn der Tag erreicht ist; der Abschluss rechnet mit
dem vollen Monat.

### Was bewusst NICHT geschah

- **D-12 (MONTHLY_HOURS):** keine Codeänderung. Die rechtliche Richtung ist klar (§§ 1, 11, 13
  BUrlG; §§ 2, 4 TzBfG; § 2 Abs. 2 MiLoG; EFZG für Krankheit), aber ob `monthlyHours` ein
  geschuldetes Soll oder eine Verdienstgrenzen-Budgetgröße ist, die Urlaubstags-Bewertung und das
  Kippen der Golden-Zelle `mj-80-urlaub` sind Owner-Entscheidungen mit Lohnkonsequenzen →
  Folge-Issue #433 (dokumentiert auf #429). `four-model-leave-analysis-429.test.ts` pinnt den
  unveränderten Fall B (−600 min) als bewusst nicht gefixt.
- **D-14 (Planer-Soll, Schichtplanung):** `apps/api/src/contexts/scheduling/api/shifts.ts`s
  Wochenplaner (`contractSollMinutesByEmp`) bleibt unverändert — er weicht bereits heute vom Saldo ab
  (schließt Feiertage aus) und wird nicht angefasst, weil Phase 430 parallel in diesem Bereich
  arbeitet. Bekannter Restbefund, nicht stillschweigend gefixt.
- **Residuum Monatsgrenzen-Split (Plan 429-02, Finding, kein eigener D-Punkt):** bei einer
  durchgehenden Mo–Sa-`workDays`-Woche summiert der Split (D-07/D-08) exakt zu einer Wochen-Soll;
  bei einer engeren `workDays`-Form (z. B. Mo–Fr), die an bestimmten Stellen geteilt wird, kann der
  unabhängige Pro-Wochenteil-Cap (D-08, wie spezifiziert — keine Umverteilung zwischen Wochenteilen)
  zu einer UNTER-Anrechnung führen (gemessenes Konstruktionsbeispiel: 2128 statt 2280 min) — nie
  negativ, nie doppelt, aber auch nie über den wörtlichen Anspruch "nie verloren" hinaus für diese
  `workDays`-Form. Nicht gefixt, da D-08 keine Umverteilung vorsieht; als eigener grüner Test
  gemeldet statt die Hauptfixtur stillschweigend zu verengen
  (`shift-based-leave-week-soll-429.test.ts`).
- **Residuum Urlaub+BS additiv (strukturell verhindert, kein Fix nötig):** Urlaub und
  Berufsschul-Abwesenheit am selben Kalendertag sind additiv (nicht dedupliziert) — unverändert von
  dieser Phase, weil `isBsAbsence()`-Zeilen `sbClaimed` nicht beanspruchen; per Superpositionstest
  verifiziert (`bothEffect === leaveEffect + bsEffect`), aber laut dem bestehenden Code-Kommentar
  über `sortForDedup` strukturell verhindert ("ein BS-Tag kann heute physisch keinen LeaveRequest
  überlappen").
- **Residuum Entitlement pro Antrag (Abwesenheiten, vorbestehend, außerhalb des #429-Scopes,
  Finding):** die Anspruchs-Zählung (`countShiftBasedLeaveDays()`) zählt pro Antrag, nicht über
  mehrere Anträge derselben Woche vereint — zwei Anträge Mo–Mi + Do–Sa kosten auf einem
  4-Tage-Vertrag 6 Tage statt der korrekten 4. Dieser Fehler liegt außerhalb dieser Phase (Entitlement
  via Abwesenheiten, nicht der hier geänderte Saldo via Arbeitszeitkonto) und wird nur als Befund
  gemeldet, nicht gefixt. Geschlossen durch Issue #436 (siehe Nachtrag unten).

### Auswirkung auf die Kontexte

- **Zeiterfassung:** keine Codeänderung.
- **Abwesenheiten:** `vacation-calc.ts` (`weekLeaveDays()`/`leaveDaysPerWeek()`, D-01/D-02),
  `leave-days.ts` (`contractWorkDaysPerWeekFrom()`, D-03), `api/leave.ts` (`getScheduledHours()`
  SHIFT_BASED-Zweig, D-13).
- **Schichtplanung:** keine Codeänderung — D-14 (Planer-Soll bleibt divergent, siehe oben).
- **Arbeitszeitkonto:** die eigentliche Korrektur — `shift-based-leave-credit.ts` (neu),
  `close-employee-month.ts` (SHIFT_BASED-`approvedLeave`-Schleife umgestellt, `defaultWorkDays` durch
  alle sechs Aufrufer durchgereicht: `recalculate-snapshots.ts`, `plugins/auto-close-month.ts`,
  `overtime-balance.ts` ×2, `month-saldo.ts`, `api/overtime.ts`).
- **Kompositionsschicht:** keine Codeänderung.
- **Unterbau:** keine Codeänderung.

### Gemessen

- `apps/api/src/contexts/absence/__tests__/vacation-calc.test.ts` — 77 passed (inkl. 7 neue
  Property-Tests für `leaveDaysPerWeek`; 1764-Kombinationen-Fuzz, 0 Abweichungen).
- `apps/api/src/contexts/absence/__tests__/leave-days.test.ts` — 6 passed
  (`contractWorkDaysPerWeekFrom`, neu).
- `apps/api/src/contexts/absence` (gesamter Kontext, nach `test:setup`) — 220 passed, 11/11 Dateien.
- `apps/api/src/__tests__/shift-based-leave-week-soll-429.test.ts` — 18 passed
  (Regression + Invarianten, D-07..D-10).
- `apps/api/src/__tests__/four-model-leave-analysis-429.test.ts` — 17 passed (Vier-Modell-Pin).
- `apps/api/src/__tests__/golden-matrix.test.ts`,
  `apps/api/src/__tests__/close-employee-month.test.ts`,
  `apps/api/src/__tests__/section9-soll-dedup.test.ts`,
  `apps/api/src/contexts/absence/api/__tests__/overtime-comp-saldo.test.ts`,
  `apps/api/src/__tests__/leave-overtime-comp-shift-based.test.ts`,
  `apps/api/src/__tests__/shift-based-saldo-parity.test.ts`,
  `apps/api/src/contexts/working-time-account/__tests__/shift-based-saldo.test.ts` — zusammen mit den
  beiden vorgenannten (429-02): 164 passed, 9/9 Dateien (Golden-Matrix' 38 Zellen unverändert,
  close-employee-month's 18 Vier-Pfad-Paritätsfälle unverändert).
- `apps/api/scripts/__tests__/dry-run-429-leave-contract-days.test.ts` — 11 passed (D-15-Skript,
  Null-Mutation gegen die gelesene `SaldoSnapshot`-Zeile bewiesen).
- Gerechtfertigte Erwartungsänderungen in `section9-soll-dedup.test.ts` (beide auf
  `SHIFT_AS_TUE_FRI`-Fixtur mit `tenantConfig: null` → die Kette fällt auf den Default `5` zurück,
  wo der alte Ø-Methode-Pfad per `{day}Hours`-Fallback `4` nutzte — exakt die
  Divisor-Vereinheitlichung, die #429 herstellt, keine neue Divergenz): Integration 4
  `expectedMinutes` 8550 → 8664 (+114 min, SICK-Tag-Kredit 570→456 bei Divisorwechsel 4→5);
  Integration 5 `expectedMinutes` 7980 → 7638 (−342 min: Montags-Urlaubstag 0→456, da er unter dem
  alten `{day}Hours`-Gate keinen Kredit erhielt; Dienstag 570→456 beim selben Divisorwechsel).
  `workedMinutes`/`balanceMinutes` in beiden Fällen unverändert.
- `apps/api/src/__tests__/leave-overtime-comp-shift-based.test.ts` — eine Erwartung von 8,00h auf
  4,00h korrigiert (Halbtags-Urlaub über einen 2-Tage-Zeitraum: die flache 0,5-Tage-Regel, identisch
  zu `countShiftBasedLeaveDays` und zum Saldo-Kredit).

### Nachrechnen

```bash
pnpm --filter @clokr/api run test:setup
pnpm --filter @clokr/api exec vitest run src/contexts/absence/__tests__/vacation-calc.test.ts src/contexts/absence/__tests__/leave-days.test.ts
pnpm --filter @clokr/api exec vitest run src/__tests__/shift-based-leave-week-soll-429.test.ts src/__tests__/four-model-leave-analysis-429.test.ts
pnpm --filter @clokr/api exec vitest run src/__tests__/golden-matrix.test.ts src/__tests__/close-employee-month.test.ts src/__tests__/section9-soll-dedup.test.ts src/contexts/absence/api/__tests__/overtime-comp-saldo.test.ts src/__tests__/leave-overtime-comp-shift-based.test.ts src/__tests__/shift-based-saldo-parity.test.ts src/contexts/working-time-account/__tests__/shift-based-saldo.test.ts
pnpm --filter @clokr/api exec vitest run scripts/__tests__/dry-run-429-leave-contract-days.test.ts
pnpm --filter @clokr/api exec tsx scripts/dry-run-429-leave-contract-days.ts --tenant-id <uuid>
```

### Nachtrag (Phase 436, Issue #436) — übliche Arbeitstage bei SHIFT_BASED und Wochen-Union über Anträge

**Schwere: Semantikänderung des Unterbaus nach ADR 0002, Entscheidung 7. Owner-Entscheidung = Issue
#436, Ticketbeschreibung 01.10.2026, plus die Ergänzung desselben Tages (Wochen-Union über mehrere
Anträge) und die bei der Planung getroffenen Verfeinerungen (Reihenfolgeregel, Bestand-Dry-Run).**

**1. Neues Feld.** `WorkSchedule.usualWorkDays Int[] @default([])` (Unterbau-Modell, additive
Migration `20261002064813_shift_based_usual_work_days`). Leer = keine Angabe. Nur für
`type: "SHIFT_BASED"` beschreibbar — ein nicht-leerer Wert bei jedem anderen Typ wird mit 400
abgelehnt (`validateUsualWorkDays()`). Muss mindestens so viele Wochentage enthalten wie
`contractWorkDaysPerWeek` — sonst 400 mit der deutschen Meldung. Schreibwege: `PUT
/settings/work/:employeeId` (frühe Ablehnung vor der Phase-49.3-Orphan-Shift-Transaktion; der
`cancelOrphanShifts`-Zweig schreibt immer `[]`) und `POST /employees`. Beide auditieren das Feld.
Bestand startet leer (keine Backfill-Migration). Der EINE Leser ist `usualWorkDaysFrom()`
(`apps/api/src/contexts/absence/leave-days.ts`); `WorkSchedule.workDays` wird dafür weder gelesen
noch geändert (Phase 95b D-01, Phase 107 D-02 bleiben unberührt).

**2. Die Regel im Wochenkern.** `weekLeaveDays()` (Kern von `countShiftBasedLeaveDays` und
`leaveDaysPerWeek`) bleibt für eine VOLLE Woche unverändert (kostet immer die Vertragstage). Für
eine ANGEBROCHENE Woche zählen nur die beantragten Tage, die zugleich in `usualWorkDays` stehen,
gekappt auf die Vertragstage; ein Feiertag zählt genau einmal; Sonntag folgt reiner
Mengenzugehörigkeit (`usualWorkDays.includes(0)`), kein Sonderfall mehr; ein halber Tag an einem
nicht üblichen Wochentag zählt 0. Anspruch (`countShiftBasedLeaveDays`), Saldo (#429,
`close-employee-month.ts`), Planungswarnung (#430, `getShiftBasedLeaveDaysForWeek`) und die
Stunden-Vorschau (`getScheduledHours`) erben die Regel alle über denselben Leser.

**3. Wochen-Union über mehrere Anträge.** `marginalShiftBasedLeaveDays()` bepreist einen VACATION-
Antrag als Grenzkosten gegenüber den anderen zählenden Urlaubsanträgen (PENDING, APPROVED,
CANCELLATION_REQUESTED) desselben Mitarbeiters, die dieselben ISO-Wochen überlappen UND vor dem
anfragenden Antrag angelegt wurden (Reihenfolgeregel, Ties nach Id). Ohne diese Regel würde die
Genehmigung zweier Anträge derselben Woche in einer anderen Reihenfolge ein anderes Ergebnis liefern
als ihre Anlage-Reihenfolge nahelegt (1 + 1 statt der korrekten 3 + 1 bei nachträglicher Genehmigung
in umgekehrter Reihenfolge) — die Reihenfolgeregel hält den Preis eines Antrags von seiner Anlage bis
zu seiner Genehmigung stabil. `resolveLeaveDays()` nimmt dafür ein PFLICHT-Argument
`LeaveDaysPricing` (`{ mode: "request", leaveTypeCode, excludeRequestId? } | { mode: "isolated" }`);
der Compiler zählt dadurch jede Aufrufstelle auf. Nur VACATION wird wochenweise über Anträge
vereint; jahresübergreifende Aufteilung (`prefixLeaveDays()`) bepreist isoliert, weil ein bereits
bepreister Gesamtbetrag nie neu bepreist werden darf.

**4. Bestand.** Genehmigte Anträge werden von keinem Schreibpfad dieser Phase je stillschweigend neu
berechnet. Nach dem Deployment listet der Betreiber betroffene Bestandsfälle per Dry-Run:

```bash
pnpm --filter @clokr/api exec tsx scripts/recalculate-shift-based-leave-days.ts --all-tenants
```

(ohne `--confirm` — die Liste ist der einzige Effekt; nichts wird geschrieben oder auditiert.)

**5. Bekannte Grenzen.**

- Wird ein früher angelegter, zählender Antrag später abgelehnt oder storniert, bleibt ein bereits
  genehmigter späterer Antrag bei seinem gespeicherten Tageswert stehen (der Dry-Run listet ihn als
  Kandidaten, schreibt aber nichts).
- § 9-gutgeschriebene Tage eines früheren Antrags gelten für die Preisbildung späterer Anträge
  weiterhin als belegt (kein Rückfluss in den Wochen-Union-Pool).
- Werden zwei Anträge derselben Woche gleichzeitig angelegt, entscheidet die Reihenfolgeregel über
  `createdAt`/Id — eine echte Gleichzeitigkeit zweier Schreibtransaktionen ist nicht gesondert
  gesperrt.
- **(Code Review 436, WR-01, 02.10.2026)** `PATCH /requests/:id/correct` kann einen früher
  angelegten, bereits genehmigten Antrag per Datumsänderung so AUSWEITEN, dass die neue
  Tagesmenge zusammen mit einem später angelegten, bereits genehmigten Geschwisterantrag über die
  Vertragstage-Kappung dieser ISO-Woche hinausgeht — ohne den Geschwisterantrag zu betrachten. Die
  Korrektur bepreist nur den korrigierten Antrag selbst, über dieselbe Reihenfolgeregel ("nur vor
  ihm angelegte Geschwister"), die für den geweiteten Antrag immer leer bleibt, weil der
  Geschwisterantrag ja NACH ihm angelegt wurde. Der bestehende Überschneidungsguard der
  Korrektur-Route (`leave.ts`, "Überschneidung mit bestehendem Antrag") greift dabei NICHT —
  er prüft nur, ob sich die DATUMSBEREICHE zweier Anträge überschneiden, nicht, ob ihre
  TAGESMENGEN gemeinsam die Vertragstage-Kappung der Woche sprengen; eine Ausweitung, die lückenlos
  vor dem Geschwisterantrag endet, bleibt für ihn unsichtbar. Verifiziertes Beispiel (4-Tage-
  Kontrakt, keine Angabe, eine ISO-Woche): A (nur Montag, 1, zuerst angelegt) und B (Do–Fr,
  grenzkostenbepreist gegen A: cost({Mo,Do,Fr}=3) − cost({Mo}=1) = 2, danach angelegt) sind beide
  genehmigt (1 + 2 = 3, innerhalb der Kappung). Wird A per Korrektur auf Mo–Mi ausgeweitet (endet
  Mittwoch, vor B's Donnerstag — KEINE Datumsüberschneidung, die Korrektur geht durch), wird A
  isoliert auf cost({Mo,Di,Mi}=3) bepreist — B bleibt unverändert bei 2, macht 3 + 2 = 5 für eine
  Woche auf einem 4-Tage-Kontrakt, einen Tag über der Kappungsgrenze, bis ein Betreiber den
  Dry-Run-Reparaturscript (Abschnitt 4 oben) laufen lässt — dieser ERKENNT den Fall (B würde gegen
  das korrigierte A neu bepreist auf cost({Mo,Di,Mi,Do,Fr}=5, gekappt 4) − cost({Mo,Di,Mi}=3) = 1,
  ein 2 → 1-Kandidat). Dies ist eine ENGERE Ausprägung derselben Klasse wie der erste Punkt oben
  (ein genehmigter Geschwisterantrag kann veralten) — hier durch eine WEITENDE Korrektur des
  FRÜHEREN Antrags statt durch Ablehnung/Stornierung des Geschwisterantrags selbst. Gepinnt (als
  bekannte Grenze, nicht als Spezifikation eines zukünftigen Fixes) in
  `apps/api/src/__tests__/leave-week-union-436.test.ts` ("[KNOWN LIMITATION, 436-REVIEW WR-01]").
- **(Code Review 436, WR-02, 02.10.2026)** `scripts/recalculate-shift-based-leave-days.ts
--confirm` ist, seit dieser Phase, AUCH der Weg, einen genehmigten SHIFT_BASED-VACATION-Antrag
  unter der NEUEN Wochen-Union-Regel neu zu bepreisen — das ist ein zusätzlicher Effekt
  gegenüber dem ursprünglichen Issue-#417-Zweck (Vertrags- statt Dienstplan-Bepreisung), den der
  Betreiber beim Ausführen von `--confirm` beachten muss. Das ist AUSDRÜCKLICH KEIN stilles
  Umschreiben im Sinne der obigen „niemals stillschweigend neu berechnet"-Regel: `--confirm` ist
  eine explizite, pro Zeile auditierte (`LEAVE_CORRECTED`) Betreiberaktion über denselben
  Korrektur-Mechanismus wie `PATCH /requests/:id/correct` (Phase 94) — kein Hintergrundjob, kein
  impliziter Nebeneffekt eines anderen Schreibpfads. Der Unterschied zur „niemals stillschweigend"-
  Aussage in Abschnitt 4 ist, dass diese Aussage nur für automatische Schreibpfade gilt, nicht für
  diesen manuell angestoßenen, explizit auditierten Reparaturlauf.

**Auswirkung auf die Kontexte:**

- **Unterbau:** Semantikänderung — neues Feld `WorkSchedule.usualWorkDays`, geschrieben/validiert in
  `contexts/platform/api/settings.ts` und `contexts/platform/api/employees.ts`.
- **Abwesenheiten:** Kern der Änderung — `vacation-calc.ts` (`weekLeaveDays`,
  `leaveDaysPerWeek`, `marginalShiftBasedLeaveDays`), `leave-days.ts` (`usualWorkDaysFrom`,
  `LeaveDaysPricing`, `countedVacationSiblingRequests`, `resolveLeaveDays`), `api/leave.ts` (alle
  sieben `resolveLeaveDays`-Aufrufstellen, `GET /hours-preview` type/excludeRequestId),
  `shift-leave-recalc-resolver.ts`, `scripts/recalculate-shift-based-leave-days.ts`.
- **Arbeitszeitkonto:** keine eigene Regel — liest die Angabe über `usualWorkDaysFrom()` im
  bestehenden `leaveDaysPerWeek()`-Aufruf in `close-employee-month.ts` mit.
- **Schichtplanung:** keine eigene Änderung — `getShiftBasedLeaveDaysForWeek()` folgt derselben
  Angabe, weil es dieselbe `leaveDaysPerWeek()`-Funktion aufruft.
- **Zeiterfassung:** keine Codeänderung.
- **Kompositionsschicht:** keine Codeänderung.

**Gemessen** (RED/GREEN-Werte aus den Plan-Summaries 436-01 bis 436-04): D-05-Äquivalenz ohne Angabe
über >20.000 generierte Vergleiche (Plan 01); Parity-Fuzz mit Angabe über 4000+ Fälle (Plan 03);
Eigentümer-Beispiel Mo–Mi = 3 Tage, danach Do–Sa = 1 Tag in derselben ISO-Woche (3 + 1 = 4, nicht 6)
über HTTP bewiesen, beide Genehmigungsreihenfolgen getestet (Plan 04); volle API- und Web-Testsuite
nach Plan 05 (6844 passed/3 skipped bzw. 1498 passed, 0 failed), alle projektweiten Gates grün.

### Nachtrag (Phase 481, Issue #481) — übliche Arbeitstage Pflicht bei SHIFT_BASED; Urlaubsverbrauch nach dem Vertrag am Urlaubstag

**Warum.** Messung auf prod am 04.10.2026 nach dem Rollout von v1.14.0 (nur lesend): Die Bepreisung
des Urlaubsverbrauchs las für jede Woche den **neuesten** `WorkSchedule`-Datensatz, auch für Urlaub
vor einem Vertragswechsel. 0 von 15 `SHIFT_BASED`-Mitarbeitenden hatten „übliche Arbeitstage“; ohne
Angabe zählte jede angebrochene Woche jeden beantragten Tag Mo–Sa. Der Probelauf von
`recalculate-shift-based-leave-days.ts` hätte zudem importierte Vorlauf-Anträge (März/April, Import
vom 26.05.) umbepreist. Owner-Entscheidung 04.10.2026: die Angabe ist bei Schichtbetrieb Pflicht.

**Was sich geändert hat.**

- **Semantikänderung** `WorkSchedule.usualWorkDays`: optional → Pflicht bei jedem Schreibvorgang, der
  einen `SHIFT_BASED`-Vertrag anlegt oder ändert (`validateUsualWorkDays()`, deutsche 400). Die zwei
  echten Schreibwege (Mitarbeiter anlegen, `PUT /settings/work/:employeeId`) erben die Regel; für
  Sammelanwendung, den `cancelOrphanShifts`-Zweig und den CSV-Import ist per Test belegt, dass sie
  keine `SHIFT_BASED`-Zeile schreiben.
- Neue Route `PATCH /settings/work/:employeeId/usual-work-days`: setzt die Angabe auf einem
  **bestehenden** Vertragsdatensatz, auditiert (`UPDATE WorkSchedule`, alt/neu), gleiche Berechtigung
  und Scope-Prüfung wie der Vertragswechsel, einheitliche 404 für fremde/unbekannte Datensätze.
- Bepreisung je Woche mit dem in ihr gültigen Vertrag (#450-Abschnitte); eine Woche, deren
  beantragte Tage in zwei Abschnitten liegen, wird geteilt und je Teil als angebrochene Woche
  gerechnet (D-01/D-07); gleichwertige Folgeabschnitte bilden einen Abschnitt (PD-01); andere
  Vertragsarten zählen jeden Tag mit dem Wochentagssatz des an ihm gültigen Vertrags.
- Das Neuberechnungs-Skript überspringt Anträge, die vor dem ersten erfassten Arbeitstag enden,
  optional zusätzlich vor `--before`.
- UI: Abschnitt „Übliche Arbeitstage nachtragen“ und Pflicht-Kennzeichnung in beiden Vertragsmasken.

**Was bewusst NICHT geschah.** Kein Backfill, kein Ableiten aus `workDays`, keine Migration, keine
automatische Umbepreisung gespeicherter Anträge (nur das Skript mit Probelauf und `--confirm`),
keine Saldo- oder Anspruchs-Neuberechnung beim Nachtrag. Die Saldo-Seite (Monatsabschluss, ein
Vertrag je Kalendermonat) bleibt unverändert; der enge Grenzfall einer Woche über einen
Monatswechsel mit Vertragswechsel ist als Befund in #481 notiert (D-10).

**Auswirkung auf die Kontexte.**

- Unterbau: Pflichtregel in `validateUsualWorkDays()`; neue Nachtrag-Route in `settings.ts`.
- Abwesenheiten: Bepreisung nach Vertragsabschnitt (`resolveLeaveDays`, Segment-Kerne), Skript-Ausschluss.
- Schichtplanung: `getShiftBasedLeaveDaysForWeek` liest den Vertrag der Woche; die Spalte
  „Vertragstage“ zeigt weiter den aktuellen Vertrag (Befund, nicht geändert).
- Arbeitszeitkonto: keine.
- Zeiterfassung: keine (das Skript liest nur das Datum des ersten nicht gelöschten Zeiteintrags).
- Composition-Schicht: keine (Berichte folgen über `prefixLeaveDays`/`resolveLeaveDays`).

**Gemessen.** Vertrag A (5 Tage Mo–Fr bis 31.07., 4 Tage Di–Fr ab 01.08.2026): 23.–29.07. → 5,
11.–14.09. → 1; ohne Angabe 6 bzw. 3. Vertrag B (4 Tage, Angabe nur auf dem Oktober-Datensatz):
Vorschau 12.–28.06. 10, nach Nachtrag auf dem Mai-Datensatz 9, gespeicherter Antrag bleibt 10.
Einzelvertrag-Äquivalenz gegen den eingefrorenen Kern vor #481 über generierte Matrizen (481-01).
Skript-Probelauf: importierte Anträge als `[SKIPPED-PRE-TRACKING]`, echte Kandidaten 4 → 5.

**Nachrechnen.**
`pnpm --filter @clokr/api run test:setup && pnpm --filter @clokr/api exec vitest run src/__tests__/leave-days-contract-at-time-481.test.ts src/contexts/absence/__tests__/leave-pricing-segments-481.test.ts src/contexts/absence/__tests__/shift-based-kernel-equivalence-481.test.ts src/__tests__/usual-workdays-required-481.test.ts src/__tests__/usual-work-days-backfill-route-481.test.ts scripts/__tests__/recalculate-shift-based-leave-days-481.test.ts`;
Probelauf auf einer Datenbank: `pnpm --filter @clokr/api exec tsx scripts/recalculate-shift-based-leave-days.ts --all-tenants` (ohne `--confirm`).

## U — MONTHLY_HOURS: Monats-Soll nach Ø-Methode, Schalter `monthlyHoursHolidayDeduction` stillgelegt (Phase 433, Issue #433)

**Schwere: Semantikänderung des Unterbaus nach ADR 0002, Entscheidung 7 (`TenantConfig`). Owner-Entscheidung = Issue #433, Kommentar vom 03.10.2026 (plus die Umsetzungsentscheidungen desselben Tages).**

### Warum dieser Eintrag existiert

Die Vier-Modell-Analyse zu Issue #429 hatte für `MONTHLY_HOURS` einen Befund mitgeliefert, der dort bewusst nicht gefixt wurde (siehe Eintrag T, Abschnitt „Was bewusst NICHT geschah", D-12): bei 44 h/Monat reduzierte eine volle Urlaubswoche das Soll um nichts — der Mitarbeiter bekam dadurch de facto 10 h weniger Soll angerechnet, als ihm nach § 1, § 13 Abs. 1 BUrlG, §§ 3, 4 EFZG und § 2 Abs. 2 MiLoG zustand ("vertraglich vereinbarte Arbeitszeit" bleibt geschuldet, Urlaub/Krankheit ersetzen sie, sie löschen sie nicht). Der tenantweite Schalter `TenantConfig.monthlyHoursHolidayDeduction` war zusätzlich bereits vor dieser Phase wirkungslos, weil er `{day}Hours > 0` prüfte und jede reale `MONTHLY_HOURS`-Zeile `{day}Hours` uniform auf 0,00 hält (Phase 95b, CLAUDE.md § Schedule Types).

### Was sich geändert hat

- **Ø-Rate-Kern** (`apps/api/src/contexts/working-time-account/timezone.ts`): neue private Helfer `explicitWorkDaysOf` (:204), `monthlyHoursWorkDays` (:319, D-05-Kette), `monthlyHoursFullMonthWorkdays` (:338), `monthlyHoursMinutesCore` (:374) — ein gemeinsamer Kern mit drei dünnen Einstiegspunkten: `calcMonthlyHoursHolidayMinutesTz` (:434, Feiertag), `calcExpectedMinutesTz` (:474, volles Soll), `calcLeaveAbsenceMinutesTz` (:618, Urlaub/Krankheit/angeordnete Abwesenheit) — derselbe Aufbau wie das bestehende `avgWorkMinutesCore` für SHIFT_BASED/FLEXTIME (Plan 01/02).
- **`close-employee-month.ts`**: die bisherige `if (scheduleType !== "MONTHLY_HOURS")`-Sperre um die Nicht-SHIFT-Urlaubs-/Abwesenheits-Schleifen ist entfernt; ein neuer MONTHLY_HOURS-spezifischer Skip verhindert, dass ein bereits von der BS-Schleife gutgeschriebener Berufsschultag zusätzlich das Soll mindert (D-07, "ein Tag mindert das Soll genau einmal", Plan 01). Der Feiertagsblock liest den Schalter nicht mehr und testet nicht mehr `{day}Hours` (Plan 02). `monthlyHoursMonthSollMinutes()` (:338) ist die EINE Stelle, die den vollen Monats-Soll-Wert für die Monatsansicht, das Dashboard, Berichte/PDF und den Web-Kalender-Kopf liefert (Plan 05) — alle drei Konsumenten rufen dieselbe Funktion, keine eigene Formel mehr.
- **Schalter entfernt** aus `CloseMonthInput`-Typ, allen 6 Produktions-Aufrufern und 5 Betreiberskripten (Plan 03), aus der Settings-API (`GET`/`PUT /api/v1/settings/work`, Prisma `omit`-Konstante statt Zod-Feld, alte Clients erhalten weiterhin 200) und dem Admin-UI-Toggle (Plan 04), aus Dashboard und Bericht (Plan 05) und aus den beiden Web-Kalenderköpfen (`/time-entries`, `/team/time-entries`, Plan 06).
- Die alte Kalendertag-Ersatzrechnung (Fallback auf Kalendertage statt Arbeitstage bei leeren `workDays`) entfällt für MONTHLY_HOURS vollständig — Rückfallkette ist durchgehend `workDays` → `TenantConfig.defaultWorkDays` → Mo–Fr (D-05), nie `{day}Hours`.
- Rundung: ein `Math.round()` über die Monatssumme, wie bei `avgWorkMinutesCore` (OQ2).
- Lesender Prüfbericht Urlaubsansprüche: unverändert, weil er die Entitlement-Seite (Abwesenheiten), nicht das Arbeitszeitkonto-Soll betrifft.

### Wie die "genau einmal"-Invariante gesichert bleibt

Die bestehende `sbClaimed`/`holidayExcludeSet`-Erstbelegung aus `close-employee-month.ts` ist unverändert; ein Berufsschultag wird ausschließlich auf der Ist-Seite (Arbeitsminuten) gutgeschrieben, nie zusätzlich auf der Soll-Seite abgezogen (MONTHLY_HOURS-Skip im Abwesenheits-Loop). Die 14-Fall-Entscheidungsmatrix (Plan 02, Fall d) prüft explizit die Überlappung aus Feiertag, Urlaub, Krankheit und angeordneter Abwesenheit am selben Kalendertag — genau einmal entlastet.

### Was bewusst NICHT geschah

- **Die Spalte `TenantConfig.monthlyHoursHolidayDeduction` wurde nicht gelöscht.** Sie bleibt für Image-Rollback-Sicherheit bis zu einem Folge-Release bestehen (kein Code liest oder schreibt sie mehr) — Folge-Issue #470.
- **Bereits abgeschlossene Monate wurden nicht neu berechnet.** Revisionssicherheit: ein `SaldoSnapshot` ändert sich nie stillschweigend. Der Bestand wird ausschließlich über `scripts/dry-run-433-monthly-hours-soll.ts` (read-only, Plan 07) sichtbar gemacht; eine Korrektur erfolgt nur als bewusste Korrekturbuchung nach Owner-Entscheidung.
- **Berichte für andere Vertragsmodelle (FIXED/FLEXTIME) wurden nicht konvergiert.** Die vorbestehende Lücke "angeordnete Abwesenheit mindert den Berichts-Soll für FIXED/FLEXTIME nicht" bleibt unverändert — Folge-Issue #451.
- **`WorkSchedule.workDays`-Bestand wurde nicht angefasst.** Die Divergenz zwischen `{day}Hours`-Platzhaltern und `workDays` für `MONTHLY_HOURS`-Zeilen bleibt unkorrigiert, wie Phase 95b, D-01 es für alle Modelle vorschreibt.
- **§ 11 BUrlG (Referenzprinzip)** betrifft das Urlaubs*entgelt* (Lohnabrechnung), nicht das Soll im Zeitkonto — deshalb hier nicht angewendet.

### Auswirkung auf die Kontexte

- **Zeiterfassung:** keine Codeänderung.
- **Abwesenheiten:** keine Codeänderung — die Entitlement-Seite (`LeaveRequest`, Anspruchszählung) ist unberührt; nur die Soll-Seite im Arbeitszeitkonto ändert sich.
- **Schichtplanung:** keine eigene Codeänderung; der wöchentliche Planer-Soll-Zweig (`contractSollMinutesByEmp`) bleibt wie vor dieser Phase, sein Blattwert für MONTHLY_HOURS-Mitarbeiter in der roster-pro-Woche-Urlaubskarte führt nun einen von 0 abweichenden Wert, den die Planer-UI für diesen Zeitplan-Typ nicht auswertet — keine sichtbare Änderung.
- **Arbeitszeitkonto:** der Kern der Änderung — `timezone.ts` (Ø-Rate-Kern, drei Einstiegspunkte), `close-employee-month.ts` (geöffnete Schleifen, BS-Skip, `monthlyHoursMonthSollMinutes`), alle Aufrufer und Betreiberskripte.
- **Unterbau:** der Schalter `TenantConfig.monthlyHoursHolidayDeduction` wird stillgelegt (nicht gelöscht); die Settings-API liest/schreibt ihn nicht mehr (`omit`-Konstante bis zur Spaltenlöschung in Folge-Issue #470).
- **Kompositionsschicht:** `dashboard.ts` und `reports.ts` lesen den Soll-Wert für MONTHLY_HOURS jetzt ausschließlich aus dem Arbeitszeitkonto-Kern (`monthlyHoursMonthSollMinutes()`), keine eigene Formel mehr.

### Gemessen

- Golden-Zellen bewusst umgedreht: `mj-80-urlaub` 4800/0/0 → 4145/655/655 (Plan 01); `mj-80-feiertag` 4800/0/0 → 4582/218/218 (Plan 02); alle übrigen 47 Zellen byte-identisch bei beiden Flips (RED-first je nur eine Zelle betroffen, 49/49 grün danach).
- 14-Fall-Entscheidungsmatrix (`close-employee-month-monthly-hours.test.ts`, D-02/D-03/D-05 bis D-10): 14/14 grün.
- Cross-Path-Paritätstest (`monthly-hours-soll-parity-433.test.ts`, D-11): Monatsabschluss, Dashboard und Bericht liefern denselben Wert für drei Mitarbeiter-Fixturen — 1740 min (überlappende Urlaub/Krankheit/Abwesenheit/Feiertag), 1320 min (Monatseintritt), 900 min (drift-freier voller Monat) — 9/9 Assertions grün.
- `dry-run-433-monthly-hours-soll.ts`-Testfixtur (D-12): Eigentümer-Beispiel 44 h/Monat, 5-tägige Urlaubswoche — gespeichert 2640 min vs. neu berechnet 2040 min, Delta −600 min, Saldo-Delta +600 min, `locked: true` — 13/13 grün, Null-Mutation bewiesen.
- Volle API-Suite (Plan 01–07, letzter gemessener Stand vor dem finalen Gate-Lauf dieses Plans): 7036+ passed, 1 vorbestehender, nicht zusammenhängender `reports.test.ts`-Flake (siehe unten), 3 skipped.
- Volle Web-Suite (Plan 06): 95 Dateien, 1519 passed, 0 failed.
- Finaler Gate-Lauf auf dem Phasen-HEAD (Plan 08, Task 3): volle API-Suite 423 passed, 1 failed (424 Dateien) / 7056 passed, 3 skipped (7060 Tests) — die eine Fehlermeldung ist der bereits dokumentierte, datumsabhängige `reports.test.ts`-Flake (heutiger deutscher Feiertag, auf `main` bereits separat behoben, auf diesem Branch unverändert vorbestehend); Test-Vollständigkeits-Untergrenze 424/346 Dateien, 7060/6023 Tests — erfüllt; API-Build (`tsc`) grün. Volle Web-Suite: 95 Dateien, 1519 passed, 0 failed; Web-Build grün. Alle projektweiten Gates grün: Typecheck, Lint, `lint:tenant-scoping` (492 Aufrufe, 0 Befunde), Kontextgrenzen (`--check 0`: 0 Workload; `--cycles --check 22`: 1 Komponente/22 Module, unverändert), Facade-Signaturen (128 Funktionen, 0 Befunde), Import-Ziele (1833 Spezifizierer, alle aufgelöst), fremder Kontextzugriff (0), T-100-09-Vollständigkeit (92 Routen klassifiziert) und der Oracle-Probe-Test, Guard-Vakuität (852 Dateien, 0 vakuos), Rollenprüfungen (API 0/191, Web 0/14), Saldo-Lock-Herleitung (0 Befunde), Kommentarsprache (0 neue Verstöße, Baseline 221 unverändert), sowie auf Web-Seite `lint:tokens`, `lint:ui-classes`, `lint:save-pattern`, Typecheck. Die Permission-Neutralitätsmatrix (1712 Fälle) und der T-100-09-Oracle-Probe-Test liefen erneut grün, ohne dass eine Aufzeichnungsdatei unter `apps/api/src/__tests__/neutrality` verändert wurde (`git diff --stat` leer).
- AC-3-Identifikator-Gate (getrackte Dateien, `git grep -l monthlyHoursHolidayDeduction -- apps/`): außerhalb von Nicht-Testdateien kommt die Kennung nur noch in `apps/api/src/contexts/platform/api/settings.ts` vor; innerhalb von Testdateien zusätzlich in drei Negativ-Assertions (`apps/api/src/contexts/platform/api/__tests__/minijob.test.ts`, `apps/api/scripts/__tests__/dry-run-433-monthly-hours-soll.test.ts`, `apps/web/src/__tests__/admin-system-save-wiring.test.ts`, `apps/web/src/__tests__/monthly-hours-calendar-433.test.ts`), die alle `expect(...).not.toContain("monthlyHoursHolidayDeduction")` prüfen und die Kennung deshalb strukturell selbst enthalten müssen (dasselbe bereits in den Plänen 03–07 dokumentierte Selbsttreffer-Muster). Außerhalb von Testdateien ist die Kennung ausschließlich in `settings.ts` (der `omit`-Konstante) vorhanden — der fachliche Teil des Kriteriums ist erfüllt.

### Nachrechnen

```bash
pnpm --filter @clokr/api run test:setup
pnpm --filter @clokr/api exec vitest run src/__tests__/golden-matrix.test.ts
pnpm --filter @clokr/api exec vitest run src/contexts/working-time-account/__tests__/close-employee-month-monthly-hours.test.ts
pnpm --filter @clokr/api exec vitest run src/__tests__/monthly-hours-soll-parity-433.test.ts
pnpm --filter @clokr/api exec vitest run src/contexts/platform/api/__tests__/minijob.test.ts
pnpm --filter @clokr/api exec tsx scripts/dry-run-433-monthly-hours-soll.ts --tenant-id <uuid>
pnpm --filter @clokr/web exec vitest run src/__tests__/monthly-hours-calendar-433.test.ts src/lib/utils/__tests__/work-schedule.test.ts
```

### Nachtrag (Phase 494, Issue #494) — MONTHLY_HOURS ohne Monatsstunden verhält sich wie „Nur erfassen“

**Schwere.** Unterbau-Semantikänderung nach ADR 0002, Entscheidung 7 (`WorkSchedule.overtimeMode` /
`WorkSchedule.monthlyHours` — die Bedeutung, nicht das Schema; keine Migration). Owner-Entscheidung =
Issue #494, Kommentar vom 06.10.2026.

**Warum.** Befund auf prod: Ein Minijob-Vertrag ohne Monatsstunden im Modus „Übertragen“ buchte jede
gearbeitete Stunde als Plus und übertrug sie von Monat zu Monat (Größenordnung im Issue, ohne
Namen). Ohne Soll gibt es nichts, wogegen ein Saldo entstehen könnte. Owner-Entscheidung: ein
`MONTHLY_HOURS`-Vertrag ohne Monatsstunden (`null` oder ≤ 0) verhält sich immer wie
`overtimeMode = TRACK_ONLY`, unabhängig vom gespeicherten Modus.

**Was sich geändert hat.**

- Die eine Funktion `isTrackOnlySchedule()` in
  `apps/api/src/contexts/working-time-account/track-only-schedule.ts`. Der Schlüssel `monthlyHours` ist
  Pflichtparameter, damit kein Aufrufer ihn vergessen kann. Sie wird nicht über einen
  `index.ts` exportiert; es entsteht kein neuer Export eines Kontexts.
- Zwei Leser: der Live-Saldo (`overtime-balance.ts`) und der gemeinsame Abschlusskern
  (`close-employee-month.ts` — manueller Abschluss, Cron und Neuberechnung laufen alle darüber).
  Abschluss, Cron und Neuberechnung entscheiden nach dem Vertrag des Monats, die Live-Anzeige nach dem
  heutigen Vertrag.
- D-10: Offene (nicht abgeschlossene) Monate unter jedem Track-only-Vertrag zählen im Live-Saldo 0 —
  das gilt auch für einen ausdrücklichen Modus `TRACK_ONLY` mit Monatsstunden > 0, nicht nur für
  Verträge ohne Monatsstunden. Live-Wert und späterer Abschluss stimmen damit überein. „Bestätigt“ bleibt der gespeicherte
  Übertrag des letzten Abschlusses.
- D-11: Prüf- und Migrationsskript (`audit-saldo-chain-integrity.ts`, `migrate-opening-balances.ts`)
  überspringen nur die Nullungs-Signatur (Übertrag 0 im Track-only-Monat), nicht jeden Monat eines
  solchen Vertrags — sonst würden Eröffnungssalden auf Minijob-Zeilen unsichtbar.
- Das Formular „Überstunden-Modus“ in der Mitarbeiterverwaltung zeigt „Nur erfassen“ gesperrt, solange
  keine Monatsstunden eingetragen sind (nur Anzeige; der gespeicherte Modus ändert sich nicht).
- Neues Probelauf-Skript `apps/api/scripts/audit-494-track-only-carry.ts` (nur lesend, nur IDs) listet
  abgeschlossene Monate mit gespeichertem Übertrag ≠ 0 unter einem Track-only-Vertrag.

**Was bewusst NICHT geschah.** Keine Datenänderung und keine Migration. Gespeicherte
`overtimeMode`-Werte werden nicht umgeschrieben (D-02), beim Speichern wird nichts normalisiert (D-05),
abgeschlossene Monate werden nicht neu berechnet — eine Korrektur ist eine bewusste, auditierte
Handlung je Monat (Entsperren mit Begründung, erneuter Abschluss).

**Bekanntes Verhalten (D-12).** Leser gespeicherter Überträge, die die Regel nicht erreicht:

- die Überstundenausgleich-Prüfung (`contexts/absence/api/leave.ts`) liest den bestätigten Übertrag
  über `getConfirmedCarryOver`;
- die Kalenderzelle abgeschlossener Monate (`month-saldo.ts`) liest `SaldoSnapshot.carryOver`;
- der Jahresübertrag (`api/overtime.ts`, `plugins/auto-close-month.ts`) kopiert den gespeicherten
  Dezember-Übertrag;
- das Team-Diagramm (`composition/dashboard.ts`) summiert gespeicherte Überträge;
- `recalculate-snapshots.ts` schreibt bei gesperrtem letztem Monat den gespeicherten Übertrag in
  `OvertimeAccount.balanceHours` (die Anzeige liest live und ist davon unberührt).

Die Live-Anzeige folgt dem HEUTIGEN Vertrag (bewusst, seit Issue #451), Abschluss, Cron und
Neuberechnung dem Vertrag des Monats (D-04). Ein späterer Vertrag mit Soll übernimmt einen alten,
gespeicherten Übertrag aus einem früheren Track-only-Monat — das Probelauf-Skript markiert solche Fälle
mit `priority=HIGH`.

Die Überstundenausgleich-Prüfung zeigt dabei einen sichtbaren Widerspruch: Für einen betroffenen
Mitarbeiter (Vertrag ohne Monatsstunden, gespeicherter Altübertrag X > 0 aus einem Abschluss vor der
Regel) melden die Live-Anzeigen (`GET /overtime/:id`, `GET /leave/overtime-balance`) 0, die Prüfung
`overtimeCompBalanceRejection()` rechnet aber mit dem gespeicherten Übertrag X — ein
Überstundenausgleich-Antrag wird angenommen und bei der Genehmigung gegen den Altübertrag gebucht,
obwohl die Anzeige 0 zeigt. Bewusst unverändert (D-12: Leser gespeicherter Überträge bleiben); die
Korrektur ist der auditierte Weg je Monat (Entsperren, erneuter Abschluss), nicht eine Codeänderung
des Prüfers. Das Probelauf-Skript markiert diesen Fall mit `priority=HIGH` und
`priorityReason=BOOKABLE_LEGACY_CARRY` (heutiger Vertrag betroffen, gespeicherter Übertrag > 0), damit
er vor dem Release bereinigt werden kann. Zeilen mit `reason=OPENING_BALANCE` (Brücken-Snapshot oder
Monat mit aktivem `OpeningBalance`) dürfen dabei NICHT entsperrt und neu abgeschlossen werden — der
erneute Abschluss unter einem Track-only-Vertrag schreibt Übertrag 0 und vernichtet den
Eröffnungssaldo.

**Auswirkung auf die Kontexte.**

- **Unterbau:** Bedeutung von `overtimeMode` / `monthlyHours` für Verträge ohne Monatsstunden; keine
  Feldänderung, keine Schemaänderung, kein neuer Export.
- **Zeiterfassung:** keine.
- **Abwesenheiten:** keine Codeänderung, aber eine sichtbare Wirkung: die Überstundenausgleich-Prüfung
  (`overtimeCompBalanceRejection()`) liest weiterhin den gespeicherten Übertrag. Ein Altübertrag
  bleibt dadurch buchbar, während der Live-Saldo bereits 0 zeigt (siehe Bekanntes Verhalten, D-12);
  bis zur auditierten Korrektur des betroffenen Monats bleibt dieser Widerspruch bestehen.
- **Schichtplanung:** keine.
- **Arbeitszeitkonto:** Kern der Änderung — Regel, Live-Saldo, Abschlusskern (und damit Cron und
  Neuberechnung).
- **Composition-Schicht:** keine Codeänderung; die Dashboard-Überstundenübersicht folgt automatisch über
  `computeOvertimeBalanceBreakdown`.

**Gemessen.**

- Vorher (auf `7c6018e9`, rot in `monthly-hours-no-target-track-only-494.test.ts`): Vertrag mit 0 h /
  ohne Monatsstunden, Jan–Jun je 25 h gearbeitet, live 150 h (Übertrag 1500 → 9000 Min.) → nachher 0 h,
  jeder Abschluss mit Übertrag 0; Altübertrag-Fall 59,8 h → 0, Juni-Übertrag 3588 Min. → 0;
  Vertragswechsel 0 h → 40 h: live 12 h → −113 h (= Kette der Abschlüsse, Live-Wert gleich Abschluss).
- Unverändert (festgeschrieben vor der Änderung, `track-only-neutrality-494.test.ts`): Monatsstunden > 0
  in beiden Modi, explizit „Nur erfassen“, alle anderen Vertragsarten.
- Volle API-Suite auf dem gemergten Stand mit `origin/main` (Phase 493): 481 Dateien, 7740 Tests
  bestanden, 3 übersprungen; volle Web-Suite: 105 Dateien, 1629 Tests bestanden;
  `measure-saldo-path-parity.ts --check` OK (Baseline unverändert).

**Nachrechnen.**

```bash
pnpm --filter @clokr/api run test:setup
pnpm --filter @clokr/api exec vitest run src/__tests__/monthly-hours-no-target-track-only-494.test.ts src/__tests__/track-only-neutrality-494.test.ts src/contexts/working-time-account/__tests__/track-only-rule-494.test.ts
pnpm --filter @clokr/api exec vitest run scripts/__tests__/audit-494-track-only-carry.test.ts scripts/__tests__/migrate-opening-balances-494.test.ts scripts/__tests__/audit-saldo-chain-integrity-494.test.ts
pnpm --filter @clokr/api exec tsx scripts/measure-saldo-path-parity.ts --check
pnpm --filter @clokr/api exec tsx scripts/audit-494-track-only-carry.ts --tenant-id <uuid>
```

---

## V — Urlaubsbuchungen: gespeicherter Überstundenausgleich, § 9 bei Korrektur, 6-Tage-Vertrag, Elternzeit-Kürzung (Phase 468, Issue #468)

**Schwere: Semantikänderung des Unterbaus nach ADR 0002, Entscheidung 7 (neue Fremdschlüssel-Referenz
`ParentalLeaveReduction.employeeId -> Employee`). Owner-Entscheidung = Issue #451 Kommentar vom
2026-10-03 (Elternzeit: manuell, auditiert) plus die Grauzonen-Entscheidungen desselben Tages (A-1 bis
A-4, dokumentiert in `468-CONTEXT.md`).**

### Warum dieser Eintrag existiert

Issue #468 bündelte vier unabhängige, von #451 abgespaltene Befunde der Buchungsseite im Kontext
Abwesenheiten: (1) der Überstundenausgleich prüfte, buchte und stornierte mit drei unterschiedlichen
Formeln, die bei nicht-FIXED-Vertragsmodellen voneinander abwichen; (2) `PATCH
/requests/:id/correct` ignorierte bestätigte § 9 BUrlG-Gutschriften und rechnete sie teils doppelt an;
(3) ein 6-Tage-Vertrag war beim Basiswert implizit auf den 5-Tage-Wert gedeckelt (30 statt 36); (4) die
Elternzeit-Kürzung nach § 17 Abs. 1 BEEG existierte nur als manueller Edit ohne Audit-Spur.

### Was sich geändert hat

- **Überstundenausgleich, EINE Formel (D-01/D-02/D-03, Pläne 01/03/08):** `scheduledLeaveMinutes()`
  (`contexts/absence/api/leave.ts`, ersetzt das vormalige `getScheduledHours()`) ist jetzt die EINE
  Funktion hinter dem Negativsaldo-Gate (POST UND der PENDING-Edit-Pfad PATCH `/requests/:id`), der
  Buchung bei Genehmigung, dem Storno/Korrektur-Reversal und `GET /hours-preview`. Für SHIFT_BASED
  bleibt die #293/#429-„Quittung folgt dem Konto"-Verzweigung byte-gleich; jeder andere Vertragstyp
  ruft dieselbe Fassadenfunktion wie das Saldo selbst (`calcLeaveAbsenceMinutesTz`,
  `contexts/working-time-account`) statt der `{day}Hours`-Platzhalter — ein FLEXTIME-Tag kostet jetzt
  die reale Ø-Methode (480 min statt der gemessenen 60-min-Platzhalterstunde). Feiertage UND
  Berufsschultage sind genau wie beim Saldo ausgeschlossen. Die gebuchten Minuten werden bei
  Genehmigung auf `LeaveRequest.overtimeCompMinutes Int?` (additive Spalte) gespeichert; Storno und
  Korrektur kehren GENAU den gespeicherten Wert um, nie eine Neuberechnung — eine Alt-Zeile ohne
  gespeicherten Wert fällt protokolliert auf die aktuelle Formel zurück (A-4). Nach dem Merge mit
  Phase 433 (Issue #433, `fix(433): MONTHLY_HOURS – Monats-Soll ...`) reicht
  `scheduledLeaveMinutes()` zusätzlich `cfg?.defaultWorkDays` in die Fassaden-Opts durch (Plan 08) —
  eine MONTHLY_HOURS-Zeile mit leerem `workDays` folgt jetzt derselben mandantenweiten
  `defaultWorkDays`-Stufe wie das Saldo selbst, statt direkt auf Mo–Fr zu springen.
- **§ 9 bei Korrektur (D-04/D-05/A-3, Plan 05):** `planSection9CreditsForCorrection()`
  (`contexts/absence/section9-detect.ts`, rein, ohne DB-Zugriff) klassifiziert jede bestätigte § 9-
  Gutschrift gegen den neuen Zeitraum einer Korrektur in „keep" (vollständig innerhalb, unverändert),
  „supersede" (vollständig außerhalb oder Typwechsel — Status `SUPERSEDED`, additiver Enum-Wert, NIE
  gelöscht, R7) oder „clip" (teilweise innerhalb — eine neue `revision + 1`-Korrekturgutschrift mit
  `supersedesId`-Verweis für den noch abgedeckten Teil). Die Issue-Beispiele sind jetzt alle vier
  grün: 10 Tage Urlaub mit 3 bestätigten Kranktagen, korrigiert auf 7 Tage → außerhalb **7**
  verbraucht (vorher fälschlich 4, der Doppelanrechnungs-Fehler), innerhalb **4** (Regressionswächter),
  teilweise **5** (Korrekturgutschrift), Typwechsel **0** (vollständige Überholung).
- **6-Tage-Vertrag (D-06/D-07, Plan 02):** `calculatePartTimeVacation()`
  (`contexts/absence/vacation-calc.ts`) rechnet den Basiswert jetzt proportional auch ÜBER die
  5-Tage-Referenzwoche hoch (Deckel entfernt) — Basis 30 → **36** bei 6 Tagen. Die Äquivalenz für
  ≤5 Tage ist byte-gleich zum Vorzustand; der gesetzliche Mindesturlaub (`workDaysPerWeek × 4`) war
  nie gedeckelt und bleibt unverändert.
- **Elternzeit-Kürzung (D-08..D-12, A-1/A-2, Pläne 04/06/07):** neues additives Modell
  `ParentalLeaveReduction`, verankert auf einem genehmigten `LeaveRequest` vom Typ `PARENTAL` (A-1 —
  in dieser Codebase ist Elternzeit ein beantragter, kein angeordneter Vorgang; der ADR-0001-
  Zielbild-Absatz zu Abwesenheiten bleibt dadurch unverändert und weiterhin nicht umgesetzt).
  Vorschau/Buchung/Widerruf (`GET/POST /api/v1/leave/parental-reductions/:leaveRequestId`,
  `POST .../revoke`) hinter `leave-entitlement:update:ZUGEWIESEN` (dieselbe Permission wie `PUT
/settings/vacation`); die Oberfläche hängt an der Detailansicht des genehmigten PARENTAL-Antrags
  (A-2). Die Kürzung beträgt ein Zwölftel des regulären Jahresanspruchs je vollem Kalendermonat der
  Elternzeit in diesem Jahr, § 5 Abs. 2 BUrlG-Rundung (#421) auf den VERBLEIBENDEN Anspruch, nie auf
  die Kürzung selbst angewendet. Die Buchung macht die Anspruchszeile menschen-eigentümerisch (die
  UPDATE-Audit setzt `isAutoCalculated` nie), wodurch #450s reaktive Neuberechnung die Zeile
  überspringt. Widerruf ist ausschließlich eine Korrekturbuchung (`ACTIVE -> REVOKED`,
  `revokedAt`/`revokedBy`), nie ein Löschen, und stellt den Anspruch um den GESPEICHERTEN
  `reducedDays`-Wert wieder her — nie eine Neuberechnung. Eine `/correct` oder eine
  Storno-Genehmigung des verankernden PARENTAL-Antrags ist gesperrt (409), solange eine `ACTIVE`-
  Kürzung besteht und die Änderung die Vollmonatszahl eines gekürzten Jahres ändern würde oder den
  Typ von PARENTAL wegbewegt; eine reine Datumsverschiebung ohne Monatszahl-Änderung bleibt erlaubt.
  Der reduzierte gesetzliche Mindesturlaub gilt identisch in `PUT /settings/vacation`, dessen `GET`-
  Vorschlag und im lesenden Prüfbericht (`audit-vacation-entitlements.ts`) — eine Regel für Lesen,
  Schreiben und Bericht.

### Was bewusst NICHT geschah

- **Keine automatische Elternzeit-Kürzung.** Vom Owner explizit abgelehnt (#451-Kommentar) —
  Elternzeit reduziert den Anspruch nur, wenn ein Mensch die Kürzung aktiv erklärt und bucht.
- **Kein Backfill von `overtimeCompMinutes` für Alt-Anträge.** Eine bereits genehmigte
  OVERTIME_COMP-Zeile ohne gespeicherten Wert bleibt ohne Rückwirkung; Storno/Korrektur fallen bei
  ihr protokolliert auf die aktuelle Formel zurück (A-4) — keine Migration schreibt den Wert
  rückwirkend.
- **Keine erneute § 9-Erkennung bei `/correct`.** Die Klassifikation arbeitet ausschließlich mit den
  bereits existierenden Gutschriften des Antrags; `/correct` erkennt keine NEUEN § 9-Überlappungen.
- **Der Hard-Delete-Pfad erbt die Phase-99-OB-05-Lücke unverändert** — außerhalb des Scopes dieser
  Phase.
- **`WorkSchedule.workDays`-Bestand wurde nicht angefasst** (Phase 95b, D-01 gilt weiterhin für jeden
  Vertragstyp).
- **Berichte/DATEV/Dashboard-Einzelberechnung (#451) wurden nicht konvergiert** — eigenes Issue.

### Auswirkung auf die Kontexte

- **Abwesenheiten:** alles — `scheduledLeaveMinutes()`, die § 9-Korrekturklassifikation, der
  6-Tage-Vertrag, das neue `ParentalLeaveReduction`-Modell und seine drei Routen.
- **Arbeitszeitkonto:** nur lesend über die Fassade (`calcLeaveAbsenceMinutesTz`,
  `contexts/working-time-account`) — keine eigene Codeänderung an der Saldo-Berechnung selbst.
- **Unterbau:** keine Feldänderung an einem bestehenden Modell; **neue Fremdschlüssel-Referenz**
  `ParentalLeaveReduction.employeeId -> Employee` (`onDelete: Restrict`) = neue
  Shared-Kernel-Abhängigkeit (ADR 0002, Entscheidung 4/7), mit Back-Relation
  `Employee.parentalLeaveReductions` im Prisma-Schema. `ParentalLeaveReduction.leaveRequestId ->
LeaveRequest` bleibt innerhalb des Kontexts Abwesenheiten, keine Unterbau-Abhängigkeit.
- **Zeiterfassung, Schichtplanung, Kompositionsschicht:** keine.

### Gemessen

- § 9-Korrektur (Plan 05): alle vier Issue-Arbeitsbeispiele grün — außerhalb 7, innerhalb 4
  (Regressionswächter), teilweise 5 (Korrekturgutschrift, Revisionskette geprüft bis `revision + 2`),
  Typwechsel 0 (vollständige Überholung); 18 neue Tests (7 rein + 11 Integration).
- 6-Tage-Vertrag (Plan 02): Basis 30 → 36 bei 6 Tagen; Äquivalenz ≤5 Tage byte-gleich.
- Elternzeit-Kürzung (Pläne 04/06/07): 13 reine Tests (Monats-/Rundungs-Kern), 21 Routen-Tests
  (Vorschau/Buchung/Widerruf, Idempotenz, T-100-09-Durchlauf, Scope-Identität), 8
  Konsistenz-Guard-Tests (Korrektur-/Storno-Sperre, reduzierter Mindesturlaub in Guard/Vorschlag/
  Prüfbericht); ein 12-monatiger Fall reduziert den Anspruch auf exakt 0 und überlebt sowohl den
  #445-Nullwert-Heal als auch die #450-Neuberechnung.
- Überstundenausgleich (Pläne 01/03/08): 13 Tests Speicherbuchung/Reversal + Formel-Parität, 7 Tests
  Korrektur auf dem gespeicherten Wert; nach dem Merge mit Phase 433 zwei neue relationale
  MONTHLY_HOURS-Fälle (Juni 2027, 22 Mo–Fr-Arbeitstage: ein Dienstag kostet round(4800/22) = 218 min,
  gebucht als −3,63 h; die `defaultWorkDays`-Durchreichung bewiesen über einen Freitag, der in
  Mo–Fr, aber nicht in der mandantenweiten `[1,2,3,4]`-Stufe liegt).
- Merge mit `origin/main` (Phase 433 + Phase 450, Commit `8fbef761`): konfliktfrei außer einer
  automatisch zusammengeführten `schema.prisma`-Region; die 468-01-Migration
  (`20261003052042_leave_booking_issue_468`) bleibt nach Zeitstempel die letzte Migration;
  Post-Merge-Ankerprüfung für jede der Pläne 01–07 bestand.
- Finaler Gate-Lauf auf dem Phasen-HEAD (Plan 08, Task 2): volle API-Suite 445 Dateien, 7238
  bestanden, 3 übersprungen (7241 Tests), 0 Fehler; volle Web-Suite 97 Dateien, 1540 bestanden;
  `test:scripts` 3 Dateien, 152 bestanden. Alle projektweiten Gates grün: Typecheck (API+Web), Lint
  (API 0 Fehler/63 Warnungen vorbestehend, Web 0 Fehler/27 Warnungen vorbestehend),
  `lint:tenant-scoping`, Import-Ziele (1888 Spezifizierer), Facade-Signaturen, fremder Kontextzugriff
  (`--check 0`), Kontextgrenzen (`--check 0`; `--cycles --check 22`: 1 Komponente/22 Module,
  unverändert gegenüber dem CI-Pin), Guard-Vakuität (878 Dateien, 0 vakuos), E2E-Spec-Registry (24
  Dateien), T-100-09-Vollständigkeit (95 Routen klassifiziert), Rollenprüfungen (API 0/193, Web
  0/14), Saldo-Lock-Herleitung, Web-Token-/UI-Klassen-/Save-Pattern-Lints, Kommentarsprache (0 neue
  Verstöße, Baseline 221 unverändert); beide Builds (`tsc` API, SvelteKit-Adapter-Node Web) grün. Die
  Permission-Neutralitätsmatrix-Dateien unter `apps/api/src/__tests__/neutrality/recorded` sind
  gegenüber `origin/main` unverändert (`git diff --quiet` erfolgreich) — keine Datei wurde
  neu aufgezeichnet.

### Nachrechnen

```bash
pnpm --filter @clokr/api run test:setup
pnpm --filter @clokr/api exec vitest run src/__tests__/leave-overtime-comp-formula-468.test.ts src/__tests__/leave-overtime-comp-booking-468.test.ts src/__tests__/leave-correct-overtime-comp-468.test.ts
pnpm --filter @clokr/api exec vitest run src/contexts/absence/__tests__/section9-correction-plan-468.test.ts src/__tests__/leave-correct-section9-468.test.ts
pnpm --filter @clokr/api exec vitest run src/contexts/absence/__tests__/parental-leave-reduction-468.test.ts src/__tests__/parental-leave-reduction-468.test.ts src/__tests__/parental-leave-consistency-468.test.ts
pnpm --filter @clokr/api exec vitest run src/__tests__/leave.test.ts
pnpm --filter @clokr/api test
pnpm --filter @clokr/web test
```

## W — Azubi-Standard wird Berechnungsgrundlage des Urlaubsanspruchs (Issue #482)

**Schwere: Unterbau-Semantikänderung nach ADR 0002, Entscheidung 7**
(`TenantConfig.defaultApprenticeVacationDays` wechselt von Vorschlagswert (nur Anlage-Dialog) zu
Berechnungsgrundlage; keine Schemaänderung, keine Migration). Owner-Entscheidung = Issue #482
vom 2026-10-04.

### Warum dieser Eintrag existiert

Seit #435 (D-05) wurde `TenantConfig.defaultApprenticeVacationDays` ("Azubi-Standard", Admin →
Urlaubsverwaltung → Standards) ausschließlich zum Vorbefüllen des Anlage-Dialogs gelesen — die
eigentliche Berechnung des regulären Jahresanspruchs (`resolveVacationBaseDays()`) kannte
`Employee.classification` nicht und griff für jeden Mitarbeiter ohne eigenen Wert auf den
regulären Mandanten-Standard (`defaultVacationDays`) zurück. Jeder Auszubildende ohne eigenen Wert
bekam damit den Mandanten-Standard statt des Azubi-Standards — ohne Namen, ohne Bestandszahlen.

### Was sich geändert hat

- **Vierstufige Kette (G-1/G-2), eine Funktion:** `resolveVacationBaseDays()`
  (`apps/api/src/contexts/absence/leave-days.ts`) löst den Basiswert jetzt auf: (1)
  `Employee.annualVacationDays`, wenn gesetzt; (2) sonst, bei aktueller `classification = AZUBI`:
  `TenantConfig.defaultApprenticeVacationDays`; (3) sonst `TenantConfig.defaultVacationDays`; (4)
  sonst 30 — auch wenn der Mandant gar kein `TenantConfig`-Datensatz hat (G-1: die Kette nennt den
  TenantConfig-Wert, der dann nicht existiert). Der gesetzliche Mindesturlaub (§ 3 BUrlG / § 19
  JArbSchG) wird unverändert NACH diesem Basiswert angewendet
  (`computeRegularVacationDaysBySegments`). `classification` wird jeweils zum Zeitpunkt der
  Auflösung gelesen — es gibt keine Klassifikations-Historie (G-2); nach Ende der Ausbildung
  (Wechsel auf z. B. VOLLZEIT) nutzen NEU erzeugte oder geheilte Zeilen den Mandanten-Standard,
  bereits gespeicherte Zeilen bleiben unverändert.
- **Prüfbericht ohne zweiten Vergleichswert (G-6):** `audit-vacation-entitlements.ts` vergleicht
  `stored` nur noch gegen das EINE `target` (das jetzt bereits den Azubi-Standard einschließt) —
  der vormalige, zweite "Lehrlings-Vergleichswert" ist entfernt. Die `ABWEICHUNG_VERTRAG`-
  Unterdrückung bei fehlendem Geburtsdatum (#444) bleibt: ohne Geburtsdatum ist der § 19 JArbSchG-
  Mindesturlaub eines möglichen Minderjährigen unbekannt, ein zusätzlicher Befund auf dieser
  Grundlage wäre nur Rauschen.
- **Admin-UI erklärt die Wirkung (AC-6):** neue Hinweistexte unter Urlaubsverwaltung → Standards,
  im Anlage-Dialog und in den Stammdaten der Mitarbeiter-Detailseite benennen den Azubi-Standard
  als Berechnungsgrundlage, nicht nur als Vorschlag.
- **Anlage-Dialog folgt künftigen Standard-Änderungen (G-5):** ein Wert, der dem Standard der
  gewählten Klassifikation entspricht (AZUBI → Azubi-Standard, sonst Mandanten-Standard), wird als
  `null` gespeichert (spiegelt #435 D-13) — die Person folgt dann späteren Änderungen des
  Standards. Eine durch den Mindesturlaub angehobene Vorschlagszahl bleibt explizit gespeichert
  (unverändertes #435 D-11-Verhalten).
- **Web-Anzeigespiegel (G-7):** `apps/web/src/lib/vacation-base-default.ts`
  (`vacationBaseDefaultFor`/`annualVacationDaysPayload`/`vacationBaseDefaultPlaceholder`)
  entscheidet nur, welcher Standard angezeigt wird und wann ein Wert kollabiert — die Berechnung
  selbst bleibt serverseitig in `resolveVacationBaseDays()`.

### Was bewusst NICHT geschah

- **Keine Migration, kein Backfill, kein Datenschreibvorgang** — die Spalte existiert bereits
  (#435), nur ihre Bedeutung ändert sich.
- **Bestehende `LeaveEntitlement`-Zeilen bleiben unverändert** (#435 D-15 gilt weiter): eine
  Einstellungs- oder Klassifikationsänderung schreibt keine Zeile um sich selbst; nur eine NEUE
  Jahreszeile, der #445-Nullwert-Heal oder ein auditierter #447/#450-Recompute lesen den neuen
  Wert.
- **Keine Klassifikations-Historie** (G-2) — diese Phase fügt keine hinzu.
- **Auditierte #447/#450-Recomputes nutzen weiterhin DIE EINE Funktion** (G-3) — kein zweiter,
  legacy Auflösungsweg wird eingeführt; das würde "eine Stelle" widersprechen.
- **#445-Mehrdeutigkeits-Gate bleibt unverändert** (G-4): eine Nullwert-Zeile, deren Vorjahr einen
  abweichenden, nicht-platzhalter Wert trägt, wird NICHT automatisch geheilt, sondern als
  `needsReview` zurückgegeben.
- **Die separate, auditierte Korrektur der bereits auf 30 gesetzten prod-Zeile für 2027** läuft
  getrennt (laut Issue-Text "erfolgt getrennt") — kein Teil dieser Phase.
- **Explizit über den Anlage-Dialog gesetzte Personenwerte zwischen #435 und #482** bleiben
  Overrides — ein Leeren des Feldes bringt die Person zurück auf den (jetzt korrekt wirkenden)
  Standard.

### Auswirkung auf die Kontexte

- **Unterbau:** nur Bedeutungsänderung des Feldes `TenantConfig.defaultApprenticeVacationDays`
  (Vorschlagswert → Berechnungsgrundlage); keine Feld-, Relations- oder Enum-Änderung.
- **Abwesenheiten:** der Resolver (`resolveVacationBaseDays()`) und der Prüfbericht
  (`audit-vacation-entitlements.ts`).
- **Arbeitszeitkonto, Schichtplanung, Zeiterfassung, Kompositionsschicht:** keine.
- **Web-Oberfläche:** drei neue Hinweistexte (Standards, Anlage-Dialog, Stammdaten) und der neue
  Anzeigespiegel `vacation-base-default.ts`; der Anlage-Dialog kollabiert einen Standard-Wert auf
  `null`.

### Gemessen

- Task 1 (Resolver + Prüfbericht): 14 Testdateien, 204 Tests bestanden (RED-Lauf zuvor: 10
  erwartete Fehlschläge — B1, B5–B10 plus die zwei überholten Pins — 82 bestanden als Kontrollen).
  `lint:tenant-scoping`: 0 Funde.
- Task 2 (Web-Anzeigespiegel + UI-Verdrahtung): 4 Testdateien, 72 Tests bestanden; `svelte-check`
  für die drei geänderten Seiten vor und nach den Edits identisch (0/6/0 Fehler je Seite — Baseline
  vor dieser Phase gemessen, kein Anstieg).
- Task 3 (Gates): volle API-Suite 456 Dateien, 7324 bestanden, 11 fehlgeschlagen, 3 übersprungen
  (7338 Tests). Die 11 Fehlschläge verteilen sich auf 4 Dateien, KEINE davon in den
  `files_modified` dieser Phase (`src/__tests__/overtime-calc.test.ts`,
  `src/__tests__/snap-02-cross-year.test.ts`, `scripts/__tests__/audit-exit-month-saldo.test.ts`
  — alle Arbeitszeitkonto, unberührt von dieser Phase — und
  `scripts/__tests__/audit-vacation-entitlements.test.ts`, dort NUR der vorbestehende
  `Nullmutation`-Fall mit einem ungescopeten `app.prisma.auditLog.count()` über die GESAMTE
  Worker-Datenbank, nicht die beiden von dieser Phase geänderten Testfälle). Alle vier Dateien
  isoliert erneut gelaufen: 67/67 grün — bestätigt geteilte-Worker-DB-Nebenläufigkeit (dieselbe
  Fehlerklasse wie in `reference_api_test_time_bombs_and_db_residue`), keine durch diese Phase
  verursachte Regression. Volle Web-Suite 101 Dateien / 1586 Tests bestanden; `test:scripts` 3
  Dateien / 152 Tests bestanden. Typecheck (API+Web) grün; Lint (API 0 Fehler/64 Warnungen, Web 0
  Fehler/27 Warnungen — beide vorbestehend); `lint:tenant-scoping` (0 Funde, 4 Ausnahme-
  Zeilennummern wegen der Kommentar-Verschiebung dieser Phase nachgezogen), `lint:import-targets`
  (1929 Spezifizierer), `lint:facade-signatures` (130 Funktionen, 0 Funde), fremder Kontextzugriff
  (`--check 0`, 0 Funde), Kontextgrenzen (`--check 0`, 0 Workload), Guard-Vakuität (898 Dateien, 0
  vakuos), Rollenprüfungen (API 0/195), Kommentarsprache (0 neue Verstöße, Baseline 221
  unverändert); Web-Token-/UI-Klassen-/Save-Pattern-/UI-Lints grün; `prettier --check` über jede
  von dieser Phase geänderte Datei grün (`schema.prisma` separat per Diff auf Kommentarzeilen
  beschränkt geprüft, da Prettier keinen `.prisma`-Parser hat; ein `prisma format`-Testlauf zeigte
  vorbestehende, nicht von dieser Phase stammende Spalten-Ausrichtungs-Drift und wurde verworfen,
  nicht übernommen).

### Nachrechnen

```bash
pnpm --filter @clokr/api run test:setup
pnpm --filter @clokr/api exec vitest run src/contexts/absence/__tests__/azubi-vacation-standard-482.test.ts src/__tests__/employees.test.ts scripts/__tests__/audit-vacation-entitlements.test.ts
pnpm --filter @clokr/web exec vitest run src/lib/__tests__/vacation-base-default.test.ts
pnpm --filter @clokr/api test
pnpm --filter @clokr/web test
```

---

## X — Tagesbezogene Pausenprüfung über Salongrenzen, Tagespause und Quittung am Tag (Phase 80, Issue #80)

**Schwere: Semantikänderung des Unterbaus nach ADR 0002, Entscheidung 7, im Sinn einer neuen
Fremdschlüssel-Referenz auf den Unterbau: `DayBreak.employeeId -> Employee` und
`DayBreakAck.employeeId -> Employee` (beide `onDelete: Restrict`) sind eine neue
Shared-Kernel-Abhängigkeit (ADR 0002, Entscheidung 4/7). Owner-Entscheidung = die Entscheidungs-
kommentare auf Issue #80 vom 08.10.2026 (D-03). Dazu ein additiver Schlüssel
`BREAK_CROSS_SALON_VIOLATION` in der `NOTIFICATION_EMAIL_POLICY` des Unterbaus (Erweiterung, kein
bestehender Leser ändert sich) und ein bewusster Owner-Override von ADR 0002, Entscheidung 2 (D-02,
siehe unten).**

### Warum dieser Eintrag existiert

Die Pausenprüfung rechnete pro Eintrag (und pro Eintrag mit Lücken im selben Eintrag): 4 h in Salon A
plus 4 h in Salon B am selben Tag ohne Pause waren zwei unauffällige Einträge, obwohl § 4 ArbZG die
Ruhepause je ARBEITSTAG verlangt, nicht je Arbeitsort. Solange #70 offen ist, gibt es pro Mitarbeiter
und Tag nur einen Eintrag (partieller Unique-Index) — der Fehler ist heute nicht auslösbar, wird aber
mit #70 sofort real. Phase 80 baut die Regel deshalb jetzt einmal richtig, mit dem Beweis, dass sich
für alle heute möglichen Tage nichts ändert.

**Owner-Override von ADR 0002, Entscheidung 2 („keine Verallgemeinerung auf Verdacht“) — D-02.**
Die Tagespause (`DayBreak`) und ihre Quittung (`DayBreakAck`) sind Modelle für einen Fall, den es mit
den heutigen Daten noch nie gibt (eine Lücke zwischen zwei Einträgen). Der Owner hat entschieden, sie
trotzdem jetzt anzulegen: Das Recht (Pause je Arbeitstag, Fahrzeit ist Arbeitszeit, #92) steht fest,
der Tag, an dem #70 den ersten echten Mehr-Eintrag-Tag erzeugt, soll nicht der Tag sein, an dem die
Regel erst entworfen wird. Die Begründung ist Compliance, nicht Spekulation; sie gilt nur für diese
beiden Modelle und ist kein Präzedenzfall für andere Tabellen.

### Was sich geändert hat

- **Kern (Pläne 01/02):** `evaluateDayBreaks()` (`contexts/time-tracking/day-break-rule.ts`) ist die
  EINE Stelle der Tagesregel (§ 4 über alle Einträge des Tages, § 3 über die Tagessumme). Eine Lücke
  zwischen Einträgen in VERSCHIEDENEN Salons zählt nie als Pause (D-01), eine Lücke im selben Salon
  bis 120 Min zählt wie bisher. `checkArbZG` ruft den Kern, `dayLimitWarnings()` hält die § 3-Regel an
  einer Stelle. Seit D-22 liefert der Kern zusätzlich die Intervallsicht — Pausensegmente mit
  Herkunft (`entry-break`, `day-break`, `same-salon-gap`, `unplaced-entry-break`), Lücken und
  Arbeitsblöcke —; die Warnungen lesen weiterhin nur die Minutensummen. § 4 Satz 2 und 3 (#511) sind
  hier bewusst noch NICHT bewertet; #511 ergänzt sie als Regeln auf dieser Sicht, im selben Kern
  (seit Phase 511 bewertet, siehe Nachtrag am Ende dieses Eintrags).
- **Modelle (Plan 03):** `DayBreak` (Mitarbeiter + Tag + Zeitraum, kein Salon, kein Freitext) und
  `DayBreakAck` (Begründung, Snapshot der Tagesfakten als JSON, `acknowledgedBy`), beide mit Soft
  Delete und `onDelete: Restrict` auf `Employee`; Migration
  `20261008142201_day_break_models` (2 `CREATE TABLE`, 2 `CREATE INDEX`, 2 `FOREIGN KEY`, sonst
  nichts). Kein partieller Unique-Index auf `DayBreakAck`: ein solcher bräuchte handgeschriebenes
  SQL, und eine Quittung gilt nur, solange ihr Snapshot zum Tag passt.
- **Routen (Pläne 04/06/08):** `POST /api/v1/day-breaks`, `DELETE /api/v1/day-breaks/:id`,
  `POST /api/v1/day-breaks/acks`, `DELETE /api/v1/day-breaks/acks/:id`, `GET /api/v1/day-breaks/checks`
  in `api/day-breaks.ts`. Schreibzugriff über `time-entry:update`: EIGENE nur für den eigenen Tag,
  ZUGEWIESEN nur mit Scope über ALLE Einträge des Tages (`dayCoverage()`, `day-scope.ts`); die
  Quittung nie für den eigenen Tag; § 3 wird angezeigt, nie quittierbar. Jede Schreibaktion ist in
  derselben Transaktion auditiert (`DAY_BREAK_CREATE`, `DAY_BREAK_DELETE`, `DAY_BREAK_ACK`,
  `DAY_BREAK_ACK_REVOKE`, `SCOPE_ACCESS_DENIED`), ein Update gibt es nicht. `GET /checks` schwärzt
  nach Reichweite aus einer Whitelist (Teil-Scope: nur Tagessumme und Verstoß). Die Quittung
  verwirft die offenen `BREAK_CROSS_SALON_VIOLATION`-Mitteilungen dieses Mitarbeitertags für alle
  Empfänger (reaktiv, nach dem Commit); ein Widerruf erweckt sie nicht wieder, weil der Cron auf
  JEDE vorhandene Zeile deduped, auch eine verworfene.
- **Compliance-Haken (Plan 05):** Anonymisierung nullt `DayBreakAck.reason` (Zeilen bleiben),
  Hard-Delete räumt die Tagesmodelle vor dem Mitarbeiter, die jährliche Aufbewahrung archiviert sie
  per Soft Delete mit den Einträgen (`archiveDayBreakDataBefore`, gezählt in `archivedDayBreaks`).
  Alles über die Zeiterfassungs-Fassade, die der Unterbau ohnehin aufruft; `contexts/platform` ist
  dafür unverändert.
- **Monatsabschluss (Plan 07):** `cross-salon-days.ts` ist der eine Detektor. Unter
  `blockMonthCloseOnUnconfirmedBreak` blockiert ein unquittierter Tag den manuellen Abschluss (409
  `requiresCrossSalonAck`), verschiebt den automatischen und erscheint im Status als
  `crossSalonBreakDays` für jeden Vertragstyp. Der Saldo bleibt unberührt (AST-Wächter,
  byte-gleiche Saldodateien, unveränderte Vier-Pfad-Baseline).
- **Mitteilung am Folgetag (Plan 09):** Feature 10 des Attendance-Checkers, täglich 09:00 in der
  Mandantenzeitzone, schaut drei Tage zurück (Nachholen), meldet einmal je Empfänger, Mitarbeiter und
  Tag; Volltext nur für Empfänger, deren eigene Reichweite den ganzen Tag abdeckt, sonst Summe und
  Verstoß. Neutraler Mail-Betreff.
- **Web (Pläne 10/11):** `DayBreakPanel` auf der eigenen Zeitenseite und der Team-Seite
  (Deep-Link aus der Mitteilung), Hinweis beim Speichern, Chip im Monatsabschluss. Die Oberfläche
  entscheidet nichts; Angebote kommen aus den Flags des Servers.

### Was bewusst NICHT geschah

- **Kein Aufheben von „ein Eintrag pro Tag“ (#70).** Mit den heutigen Daten kann eine Tagespause
  deshalb nicht angelegt werden (die Route antwortet 409, es gibt keine Lücke); Monatsabschluss,
  Mitteilung und Anzeige bleiben ohne Wirkung. Das ist gewollt: #70 ändert danach nichts mehr an
  dieser Logik.
- **Kein Fahrzeitmodell (#92)** und keine Ansicht für Salonleiter (#85).
- **Keine automatische Korrektur.** Kein Zeiteintrag wird geschrieben, geändert oder gelöscht; die
  Quittung dokumentiert nur.
- **`api/time-entries.ts` unverändert**, ebenso die Neutralitätsaufzeichnungen
  (`__tests__/neutrality/recorded`) und die Saldodateien.
- **Keine neue Katalog-Permission** (die Routen nutzen `time-entry:update`/`read`) und kein
  partieller Unique-Index (siehe oben).
- **Freitext im Audit:** Die Begründung einer Quittung steht im Klartext im Audit-Eintrag, wie jede
  andere auditierte Begründung. Ob Audit-Freitext bei der Anonymisierung geschwärzt wird, ist eine
  systemweite Regel (#512) und wird hier nicht pro Entität vorweggenommen; `DayBreakAck.reason`
  selbst wird anonymisiert. Die Lücke `TimeEntry.breakWaivedReason` bleibt bei #508.
- **Keine Auswertung von § 4 Satz 2/3 ArbZG** (Aufteilung in Abschnitte von mindestens 15 Min;
  nicht länger als sechs Stunden am Stück ohne Ruhepause): #511 baut darauf auf der Intervallsicht (D-22) auf. Pausen am Eintrag erscheinen dort
  heute als „Lage unbekannt“, weil die Tagesabfrage die Einzelpausen nicht lädt (seit Phase 511 geladen
  und bewertet, siehe Nachtrag am Ende dieses Eintrags).

### Auswirkung auf die Kontexte

- **Zeiterfassung:** alles — Kern, beide Modelle, fünf Routen, Detektor, Cron-Mitteilung,
  Compliance-Haken. Neue Mitteilungsart `BREAK_CROSS_SALON_VIOLATION`.
- **Arbeitszeitkonto:** vier Monatsabschluss-Verbraucher (manueller Abschluss, Status,
  Auto-Abschluss, Reporter für verschobene Abschlüsse) lesen den Detektor über
  `contexts/time-tracking/index.ts` und blockieren oder verschieben nur; keine Saldo-Berechnung
  ändert sich (`close-employee-month.ts`, `month-saldo.ts`, `overtime-balance.ts`, `timezone.ts`
  byte-gleich zu `origin/main`).
- **Abwesenheiten:** keine.
- **Schichtplanung:** keine.
- **Unterbau:** zwei Rück-Relationen auf `Employee` (`dayBreaks`, `dayBreakAcks`) und der additive
  Schlüssel in `NOTIFICATION_EMAIL_POLICY`; keine Feldänderung an einem bestehenden Modell, keine
  geänderte Export-Signatur von `contexts/platform/index.ts`.
- **Kompositionsschicht:** `data-retention.ts` ruft `archiveDayBreakDataBefore` über den
  Zeiterfassungs-Index; die Wurzel `app.ts` registriert ein weiteres Routenmodul (Zähler der
  Wurzel-Ausnahme 52 → 53, Eintrag H).

### Gemessen

- Äquivalenzbeweis (80-AC6): Der Kern gegen die eingefrorene Kopie der Tageswarnungen aus `73838040`
  (Fixture und Test nur von `(80-01)`-Commits berührt): 6048 Ein-Eintrag-Fälle, 4000 Mehr-Eintrag-
  Fälle im selben Salon, 5139 Salonwechselfälle mit Fahrzeit und 2861 ohne — null Abweichungen; ein
  Sensitivitätstest (strikt `< 120`) unterscheidet sich in 40 Fällen. Ein Mutationsbeweis lässt die
  Matrizen rot werden.
- Intervallsicht (80-02): 28 Tests, 3000 Konsistenzfälle (1680 mit Salonwechsel-Lücke).
- Migration: 46 Migrationen, `migrate diff --exit-code` gegen eine frische Shadow-DB: „No
  difference detected“, Exit 0; `migrate status`: „Database schema is up to date!“.
- Routen: 23 Tests (Anlegen/Löschen), 27 Tests (Quittung/Widerruf, einschließlich Mitteilungs-
  Verwerfung), 23 Tests (Tagesprüfung inkl. Byte-Schwärzungsbeweis); T-100-09-Byte-Vergleich für
  `DELETE /:id` und `DELETE /acks/:id`.
- Monatsabschluss: 21 Integrationstests, 13 Detektor-Unit-Tests, Abfragebudget gemessen (0
  zusätzliche Abfragen ohne Zwei-Salon-Tag, genau eine je Modell sonst); Saldo-Wächter über 30
  Dateien mit Mutationsbeweis; `measure-saldo-path-parity.ts --check` gegen die unveränderte
  Baseline grün.
- Cron: 15 Integrationstests + 8 Builder-Tests; Empfängermatrix (Admin voll, Manager beider Salons
  voll, Manager eines Salons geschwärzt, Manager eines dritten Salons keine, der Mitarbeiter selbst
  keine).
- Finaler Gate-Lauf auf dem mit `origin/main` zusammengeführten Stand (Merge ohne Konflikt, keine
  Phase-80-Datei betroffen): volle API-Suite 496 Dateien, 7984 bestanden, 3 übersprungen (7987
  Tests), 0 Fehler; volle Web-Suite mit Abdeckung 109 Dateien, 1722 Tests; `test:scripts` 6
  Dateien, 313 Tests. Alle CI-Gates grün: Typecheck, Lint (0 Fehler), `lint:tenant-scoping`,
  Import-Ziele (2113 Spezifizierer), Facade-Signaturen (131 Funktionen, 17 Ausnahmen, 0 Funde),
  fremder Kontextzugriff und Kontextgrenzen (`--check 0`), Import-Zyklen (`--cycles --check 22`),
  Guard-Vakuität (963 Dateien, 0 vakuos), E2E-Spec-Registry (24 Dateien), T-100-09-Vollständigkeit
  (98 Routen), Rollenprüfungen, Saldo-Lock-Herleitung, Kommentarsprache (0 neue Verstöße), beide
  Builds. Der Gesamtlauf fand drei Dinge, die die Teilpläne nicht gesehen hatten: zwei
  Zählpins (131 Fassadenfunktionen, 18 Advisory-Lock-Schlüssel — auf die neuen, im Pin
  begründeten Werte gesetzt) und einen Zuwachs der Import-Zyklen von 22 auf 23 Module, den der
  Detektor `cross-salon-days.ts` durch einen Rück-Import des Arbeitszeitkonto-Index auslöste; er
  wurde an der Ursache beseitigt (der Tagesschlüssel wird dort direkt formatiert), der CI-Pin 22
  blieb unberührt. `measure-saldo-path-parity.ts --check` gegen die unveränderte Baseline grün.

### Nachrechnen

```bash
pnpm --filter @clokr/api run test:setup
pnpm --filter @clokr/api exec vitest run src/contexts/time-tracking/__tests__/day-break-equivalence-80.test.ts src/contexts/time-tracking/__tests__/day-break-rule.test.ts src/contexts/time-tracking/__tests__/day-break-intervals.test.ts
pnpm --filter @clokr/api exec vitest run src/contexts/time-tracking/api/__tests__/day-breaks.test.ts src/contexts/time-tracking/api/__tests__/day-break-acks.test.ts src/contexts/time-tracking/api/__tests__/day-break-checks.test.ts
pnpm --filter @clokr/api exec vitest run src/__tests__/cross-salon-month-close-80.test.ts src/__tests__/cross-salon-saldo-isolation-80.test.ts src/__tests__/cross-salon-break-notifications-80.test.ts src/__tests__/day-break-compliance-80.test.ts
pnpm --filter @clokr/api exec tsx scripts/measure-saldo-path-parity.ts --check
pnpm --filter @clokr/db exec prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code   # SHADOW_DATABASE_URL gesetzt
pnpm --filter @clokr/api test
pnpm --filter @clokr/web test
```

### Nachtrag 2026-10-09 (Phase 511, Issue #511): Satz 2 und 3, § 11 JArbSchG, Lage der automatischen Pause

**Schwere: Erweiterung des Unterbaus nach ADR 0002, Entscheidung 7 — ein additiver Schlüssel
`BREAK_PLACEMENT_VIOLATION` in der `NOTIFICATION_EMAIL_POLICY` (Schalter `emailOnMissingEntries`,
gleichgebaut wie der Schlüssel aus Phase 80); kein bestehender Leser ändert sich. Dazu ein additiver
Export `isMinorAtDate` im Index des Abwesenheitskontexts (`contexts/absence/minor-at-date.ts`, von
`jarbschg.ts` und `arbzg.ts` gelesen). Keine Schemaänderung, keine Migration, keine neue
Katalog-Permission (die neue Route `POST /api/v1/day-breaks/preview` nutzt `time-entry:update` bzw.
`time-entry:create`).**

**Was jetzt bewertet wird.** Der Tageskern (`evaluateDayBreaks()`) ruft `evaluatePlacement()`
(`contexts/time-tracking/day-break-placement.ts`) auf seiner Intervallsicht (D-22 aus Phase 80). Das ist
die EINE Stelle für § 4 Satz 2 ArbZG (Pausenabschnitt unter 15 Min zählt nicht; ein Abschnitt am
ersten Beginn oder letzten Ende zählt nie), § 4 Satz 3 ArbZG (höchstens sechs Stunden am Stück ohne
Ruhepause von mindestens 15 Min — auch dann, wenn die Summe nach Satz 1 erreicht ist) und für
Beschäftigte unter 18 am Arbeitstag § 11 JArbSchG über § 18 Abs. 2 ArbZG (30 Min ab 4,5 h, 60 Min ab
6 h, Abschnitte von mindestens 15 Min, höchstens 4,5 h am Stück, keine Ruhepause in der ersten oder
letzten Stunde). Die Schwellen stehen genau einmal in `break-regime.ts` (`BREAK_REGIMES`); das Regime
ist Eingabe des Kerns (`breakRegimeFor(isMinorAtDate(...))`, Alter am Arbeitstag, bei fehlendem
Geburtsdatum offen nach § 4 ArbZG, bei einem AZUBI mit Hinweis im Befund). Neue Warncodes
(`BREAK_SEGMENT_TOO_SHORT`, `BREAK_TOO_LATE`, `BREAK_OUTSIDE_WINDOW`, Hinweis
`BREAK_POSITION_UNKNOWN`) sind additive Mitglieder der bestehenden Union, Schwere stets `warning`
(Speichern wird nie blockiert). Die Summenprüfung nach Satz 1 bleibt die Compliance-Zahl; ein nicht
zählender Abschnitt ist nur dort Arbeitszeit, der Saldo (`entryDurations()`, Saldodateien) bleibt
unberührt. Der Kern bleibt für alle bisherigen Tage ausgabegleich: 6048 Ein-Eintrag-Fälle gegen die
eingefrorene Kopie von Phase 80, null Abweichungen der bisherigen Warnungen.

**Bewusste Abweichungen und Grenzen.**

- **Grenzen der Salonwechsel-Lücke (D-07).** Eine Lücke zwischen Einträgen verschiedener Salons
  enthält Fahrzeit (Arbeitszeit) und möglicherweise freie Zeit; das System kennt die Aufteilung nicht
  (#92). Der Kern rechnet deshalb zwei Grenzfälle (ganze Lücke Arbeitszeit; freier Anteil am Anfang
  und am Ende der Lücke). Beide regelkonform: konform. Beide verletzt: `VIOLATION`. Sonst
  `UNCLEAR` („Klärung nötig: Fahrzeit oder Pause?“). Aufgelöst wird nur durch eine erfasste
  `DayBreak` in der Lücke oder eine Quittung; ein Manager kann eine Lücke nicht ohne eines von beiden
  als konform markieren.
- **A4: Satz 1 bei Salonwechsel bleibt streng.** Die Minutenregel nach Satz 1 für Salonwechseltage
  (Phase 80) behält `VIOLATION` und kann damit zu streng sein — dieselbe Klasse wie die 120-Min-Grenze
  unten. Nur die neuen Satz-2/3-Befunde tragen `UNCLEAR`.
- **D-16: 120-Min-Grenze im selben Salon unverändert.** _(Überholt durch Nachtrag 2026-10-15, Issue #523: die Grenze ist entfallen.)_ Eine Lücke im selben Salon über 120 Min zählt
  für Satz 1 weiterhin nicht als Pause, obwohl eine Ruhepause nach § 4 ArbZG keine Höchstdauer hat
  (BAG 25.02.2015 – 5 AZR 886/12). Die Änderung würde die eingefrorene Äquivalenz-Fixture von Phase 80
  berühren (nie editiert) und braucht eine Owner-Entscheidung: Issue #523. Für Satz 3 beendet eine
  Lücke über 120 Min im selben Salon einen Arbeitsblock (schon vorher so).
- **D-08: „im Voraus feststehend“ nicht prüfbar.** § 4 Satz 1 verlangt, dass die Pausen im Voraus
  feststehen. Das lässt sich aus Zeitstempeln nicht erkennen; ein erfasstes, abgeschlossenes
  Pausensegment gilt als Ruhepause. Bekannte Grenze, auch in `docs/compliance.md`.
- **Ältere Pausen nur als Summe.** Ein Eintrag mit `breakMinutes`, aber ohne Break-Zeilen, hat keine
  bekannte Lage: Hinweis `BREAK_POSITION_UNKNOWN`, nie Verstoß, nie Kalendermarker, nie Mitteilung,
  nie Sperre des Monatsabschlusses (A5). Der Probelauf zählt diese Tage getrennt.
- **WAIVED am Einzelsalon-Tag.** Ein „durchgearbeitet“ am Eintrag (`breakStatus = WAIVED`) löst am
  Tag mit einem Salon die Listung im Monatsabschluss auf (Entscheidung im Detektor, dokumentiert:
  der Verzicht ist eine Entscheidung, der Befund bleibt sichtbar). Am Salonwechseltag gilt wie bisher
  nur eine aktuelle Quittung.
- **Quittung für jeden Befundtag (D-12).** Die Quittung gilt jetzt für jeden Tag mit quittierbarem
  Befund (`hasAckableFinding()`), auch mit einem Salon. Ihr Snapshot trägt einen Lageschlüssel (A8).
  Folge: eine vor Phase 511 gespeicherte Quittung eines Tages, der jetzt einen Lagebefund zeigt, liest
  sich als veraltet und öffnet den Tag erneut. Der Probelauf zählt das je Mandant (`staleAckTotal`);
  erwartet wird null oder nahe null, weil mit #70 offen kaum Salonwechseltage existieren.
- **D-20: Auto-Pause für Jugendliche.** Für Beschäftigte unter 18 ist die automatische Pause
  `max(konfiguriert, § 11 JArbSchG)` (30 Min ab 4,5 h, 60 Min ab 6 h) und greift schon ab 4,5 h
  Anwesenheit. Saldo-Wirkung nur für KÜNFTIGE automatische Pausen; gespeicherte Pausen und
  geschlossene Monate bleiben. Erwachsene: Menge unverändert.
- **Lage der automatischen Pause (D-17/D-19).** `placeAutoBreak()` setzt die Pause in
  Mandantenzeit (vorher wirkte `defaultBreakStart` als Serverzeit, im Container also UTC: ein
  Berliner Mandant mit „12:00“ bekam die Pause im Sommer um 14:00) und regelkonform zu Satz 2/3 an
  der Stelle nächst der konfigurierten Zeit; die Minutenzahl (und damit der Saldo) bleibt für
  Erwachsene gleich. Die Pause wird mit dem Eintrag in einer Transaktion geschrieben.
- **Nicht Teil dieser Phase.** § 8 JArbSchG (Tages- und Wochenhöchstzeit Jugendlicher) → #524;
  Fahrzeit-Erfassung → #92; verbleibende Client-Logik zu § 4 (Dashboard-Callout, Pausenvorschlag) →
  #525, bis dahin zwei benannte Ausnahmen im Web-Quellwächter.
- **Offenlegung der Minderjährigkeit.** Der Rechtsgrund im Befundtext („§ 11 JArbSchG“) lässt auf
  Minderjährigkeit schließen. Das ist angenommen; Geburtsdatum und Alter werden nie ausgegeben, und
  der geschwärzte Text (Teil-Reichweite) enthält weder Uhrzeit noch Salon.

**Mitteilung und Monatsabschluss.** Der Detektor heißt jetzt `break-finding-days.ts` (vorher
`cross-salon-days.ts`, ohne Alias; Wire-Felder `breakFindingDays`, `breakFindingCount`,
`requiresBreakFindingAck`, Aufschubgrund `BREAK_PLACEMENT`). Er listet jeden Tag mit quittierbarem,
nicht aufgelöstem Befund. Feature 10 (09:00 Mandantenzeit, 3-Tage-Nachholen) meldet dieselben Tage:
`BREAK_PLACEMENT_VIOLATION` für Satz 2/3 und § 11, `BREAK_CROSS_SALON_VIOLATION` (Text unverändert)
für die Satz-1-Lücke am Salonwechseltag; höchstens eine Mitteilung je Empfänger, Mitarbeiter und Tag
über beide Arten. Der Saldo bleibt unberührt (Wächter über die Saldodateien, byte-gleiche Dateien,
unveränderte Vier-Pfad-Baseline).

### Auswirkung auf die Kontexte (Nachtrag Phase 511)

- **Zeiterfassung:** Kern (`day-break-placement.ts`, `break-regime.ts`, `day-break-rule.ts`), Lader
  (`loadBreaksOfEntries`), `checkArbZG`, Routen (`acks`, `checks`, neu `preview`),
  Auto-Pausen-Lage (`place-auto-break.ts`, `auto-break-plan.ts`), Detektor, Cron-Mitteilung.
- **Abwesenheiten:** ein additiver Export (`isMinorAtDate` im Index); `jarbschg.ts` liest ihn. Sonst
  keine Änderung.
- **Schichtplanung:** keine.
- **Arbeitszeitkonto:** die vier Monatsabschluss-Verbraucher (manueller Abschluss, Status,
  Auto-Abschluss, Reporter) lesen den umbenannten Detektor über den Zeiterfassungs-Index und
  blockieren oder verschieben nur; keine Saldo-Berechnung ändert sich (`close-employee-month.ts`,
  `month-saldo.ts`, `overtime-balance.ts`, `timezone.ts`, `entry-durations.ts`, `break-effective.ts`
  byte-gleich zu `origin/main`).
- **Unterbau:** ein additiver Schlüssel in `NOTIFICATION_EMAIL_POLICY`; kein Modell, kein Feld, keine
  geänderte Export-Signatur.
- **Kompositionsschicht:** keine.

### Gemessen (Nachtrag Phase 511)

- Kern: Grenzmatrix 27 Fälle (0 Abweichungen, Kontrolllauf mit vier verfälschten Regeltabellen: jeweils
  mindestens 1 Abweichung); Äquivalenz 511: 6048 Ein-Eintrag-Fälle, Satz-1-Warnungen byte-gleich zur
  eingefrorenen Kopie, 756 Prädikat-Abweichungen bei verfälschtem Blocklimit.
- Auto-Pause: 6216 Platzierungen (3096 Erwachsene, 3120 Jugendliche, vier Startzeitpunkte inklusive
  beider Zeitumstellungen 2026), jede vom Kern ohne Satz-2/3-/Fensterbefund bewertet; Orakel-Kontrolle
  und Mutationsbeweis.
- Gate-Läufe auf dem Endstand (gegen `origin/main`, nichts nachzuführen): `test:scripts` 6 Dateien /
  314 Tests; Web 115 Dateien / 1835 Tests mit Abdeckung; Typecheck, Lint (0 Fehler),
  `lint:tenant-scoping` (515 Aufrufe, 45 Ausnahmen, 0 Funde), Import-Ziele (2175), Facade-Signaturen
  (131 Funktionen, 17 Ausnahmen, 0 Funde), fremder Kontextzugriff `--check 0` (201 Dateien),
  Kontextgrenzen `--check 0` (209 Dateien, 58 mit Ausnahme), Import-Zyklen `--cycles --check 22`,
  Guard-Vakuität (989 Dateien, 51 Guards, 0 vakuos), E2E-Spec-Registry (24 Dateien),
  T-100-09-Vollständigkeit (98 Routen), Rollenprüfungen (0 Funde), Saldo-Lock-Herleitung,
  Kommentarsprache (0 neue Verstöße), Web-Gates (`lint:ui`, `lint:ui-classes`, `lint:tokens`,
  `lint:save-pattern`, `lint:role-checks`), beide Builds, Prettier.
- Schema: `git diff origin/main -- packages/db/prisma` leer; `migrate diff --exit-code` gegen frische
  Shadow-DB „No difference detected“; `migrate status`: 46 Migrationen, „Database schema is up to
  date!“. `measure-saldo-path-parity.ts --check` gegen die unveränderte Baseline grün.
- Probelauf `audit-511-break-placement.ts` gegen die lokale Entwicklungsdatenbank (zwei Mandanten,
  17 Beschäftigte, Zeitraum 01.07. bis 08.10.2026): 0 Befunde, 1 Hinweistag `BREAK_POSITION_UNKNOWN` in
  einem geschlossenen Monat, `divergent=0`, `wouldBlock=0`, `staleAckTotal` 0. Die Entwicklungsdaten
  sagen nichts über das Volumen auf int und prod; dort ist der Lauf vor dem Deploy zu machen.

### Nachrechnen (Nachtrag Phase 511)

```bash
pnpm --filter @clokr/api run test:setup
pnpm --filter @clokr/api exec vitest run src/contexts/time-tracking/__tests__/day-break-placement-511.test.ts src/contexts/time-tracking/__tests__/day-break-placement-equivalence-511.test.ts src/contexts/time-tracking/__tests__/break-regime.test.ts src/contexts/time-tracking/__tests__/day-break-equivalence-80.test.ts
pnpm --filter @clokr/api exec vitest run src/contexts/time-tracking/__tests__/place-auto-break.test.ts src/__tests__/auto-break-placement-511.test.ts src/contexts/time-tracking/__tests__/auto-break-plan.test.ts
pnpm --filter @clokr/api exec vitest run src/contexts/time-tracking/api/__tests__/day-break-acks.test.ts src/contexts/time-tracking/api/__tests__/day-break-checks.test.ts src/contexts/time-tracking/api/__tests__/day-break-preview.test.ts
pnpm --filter @clokr/api exec vitest run src/__tests__/cross-salon-month-close-80.test.ts src/__tests__/cross-salon-saldo-isolation-80.test.ts src/__tests__/cross-salon-break-notifications-80.test.ts src/contexts/time-tracking/__tests__/break-finding-days.test.ts
pnpm --filter @clokr/api exec tsx scripts/measure-saldo-path-parity.ts --check
pnpm --filter @clokr/api exec tsx scripts/audit-511-break-placement.ts --all-tenants --from <JJJJ-MM-TT> --to <JJJJ-MM-TT>   # nur lesend
pnpm --filter @clokr/web exec vitest run src/lib/breaks
pnpm --filter @clokr/api test
pnpm --filter @clokr/web test
```

### Nachtrag 2026-10-13 (Phase 85b, Issue #85): Teilweise abgedeckter Tag nur mit neutralem Hinweis; Speicherwarnungen nach Reichweite

**Schwere: Verengung der Phase-80-Regel für Leser mit teilweiser Abdeckung (DSGVO Art. 5 Abs. 1 lit. c,
Akzeptanzkriterium „auch nicht als Summe“); keine Schemaänderung, keine Migration, keine neue Route, keine
neue Permission. Das Prüfwerk selbst ist unverändert: `evaluateDayBreaks()` und `evaluatePlacement()`
bewerten wie zuvor, geändert ist nur, was ein Leser mit teilweiser Abdeckung davon erfährt.**

**D-07 — ein neutraler Hinweis.** Phase 80 (D-11) und Phase 511 ließen einem Aufrufer, dessen Reichweite nur
einen Teil der Einträge eines Tages deckt, „die Summen und den Befund“. Das legte Schwellen fremder Zeit
offen (zum Beispiel „mehr als 10 Stunden“ als Befundkategorie, „Erfasst: N Min.“, Blockdauern der
Pausenlage). Jetzt trägt `GET /day-breaks/checks` für einen solchen Tag genau ein Objekt aus einer
zahlenfreien Positivliste (`redactedDayCheck`, erhält keine Auswertung) mit dem einen Hinweis
`FINDING_WITHHELD`: „Für diesen Tag liegt ein Prüfhinweis vor; die Klärung erfolgt über den Stammsalon.“
Der Hinweis ist an jedem teilweise abgedeckten Tag derselbe, mit oder ohne Befund; ein solcher Tag hat
immer mindestens zwei Einträge und wird immer aufgelistet, also verrät weder die Auflistung noch der Hinweis
einen Befund. Die Benachrichtigung des nächsten Tages (Feature 10) nutzt für diese Empfänger denselben
neutralen Text (Titel „Prüfhinweis zu einem Arbeitstag“, Betreff der Mail ebenso), für die Familie
`BREAK_CROSS_SALON_VIOLATION` wie für `BREAK_PLACEMENT_VIOLATION`. Die redigierte Variante von
`placementWarnings()` (Anzahl und Dauer statt Uhrzeiten) hatte danach keinen Aufrufer mehr und wurde
entfernt, damit ihr summenhaltiger Text nicht versehentlich wiederverwendet wird; der eine Fall T-511-07
in `placement-warnings-511.test.ts` ist mit einer Notiz zu Phase 85b D-07 geändert und hält die Entfernung
fest. `day-break-equivalence-80` ist nicht angefasst.

**D-12 — Speicherantworten nach Reichweite.** `PUT` und `POST /time-entries`, das Ausstempeln im Auftrag
und die Freigabe eines Zeitnachtrags mit Korrektur des Managers nannten Wochensumme, Ruhezeit oder
24-Wochen-Schnitt über alle Einträge der Person, auch fremder Salons. `warningsVisibleToCaller()`
(`contexts/time-tracking/warning-visibility.ts`) ist jetzt die EINE Stelle: eine Warnung bleibt nur, wenn
jeder nicht gelöschte Eintrag der Person in ihrem Fenster (Tag; Tag−1 bis Tag+1 bei der Ruhezeit; ISO-Woche;
168 Tage beim 24-Wochen-Schnitt) in der `time-entry:read`-Reichweite des Aufrufers liegt, sonst werden alle
zurückgehaltenen Warnungen zu einem einzigen `FINDING_WITHHELD` zusammengefasst. Die Person selbst und ein
Aufrufer mit ganzem Mandanten sind unverändert.

**Bewusst hingenommene Reste.** (1) Dass ein Befund existiert, bleibt sichtbar — im Hinweis der Tagesprüfung,
in der Benachrichtigung und im neutralen Eintrag der Speicherantwort; es steht keine Minute und keine
Schwelle darin, und der Hinweis ist ohne Befund derselbe. (2) Die Benachrichtigungsfamilie bleibt als `type`
gespeichert (`BREAK_CROSS_SALON_VIOLATION` oder `BREAK_PLACEMENT_VIOLATION`) und verrät damit, ob der Tag
salonübergreifend war; sie trägt weder eine Zahl noch eine Schwelle. Wer den Befund ganz sehen soll, braucht
die Reichweite über jeden Eintrag des Tages.

**Beleg.** `withheld-finding-85.test.ts`, `warning-visibility-85.test.ts`, `write-warnings-scope-85.test.ts`,
`cross-salon-springer-85.test.ts` (rekursiver Zahlenscan über zwölf Antworten, 122 Zahlenwerte),
`day-break-checks.test.ts`, `break-finding-notice.test.ts` und `cross-salon-break-notifications-80.test.ts`
(geänderte Fälle jeweils mit datiertem Nachtrag in der Kopfzeile); Mutationsnachweise stehen in den
Kopfzeilen der Testdateien.

### Nachrechnen (Nachtrag Phase 85b, Eintrag X)

```bash
pnpm --filter @clokr/api run test:setup
pnpm --filter @clokr/api exec vitest run src/contexts/time-tracking/__tests__/withheld-finding-85.test.ts src/contexts/time-tracking/__tests__/warning-visibility-85.test.ts src/__tests__/write-warnings-scope-85.test.ts src/contexts/time-tracking/api/__tests__/day-break-checks.test.ts src/contexts/time-tracking/__tests__/break-finding-notice.test.ts src/__tests__/cross-salon-break-notifications-80.test.ts src/contexts/time-tracking/__tests__/placement-warnings-511.test.ts src/contexts/time-tracking/__tests__/day-break-equivalence-80.test.ts
```

### Nachtrag 2026-10-15 (Phase 523, Issue #523): Lücke im selben Salon zählt ohne Höchstdauer

**Owner-Entscheidung 15.10.2026.** Eine Ruhepause hat nach § 4 ArbZG keine Höchstdauer (BAG 25.02.2015,
5 AZR 886/12, Rn. 21). Die 120-Minuten-Grenze für Lücken zwischen zwei Einträgen im selben Salon (Phase 80,
D-01; in Phase 511 als D-16 bewusst belassen) entfällt.

**Was sich geändert hat.**

- `listGaps()` (`contexts/time-tracking/day-break-rule.ts`) setzt `countsAsBreak` für jede positive Lücke
  im selben Salon; eine Lücke zwischen verschiedenen Salons zählt weiterhin nie (Fahrzeit, #92).
  `gapBreakMin`, `totalBreakMin`, die Segmentquelle `same-salon-gap` und die Arbeitsblöcke des Kerns
  folgen daraus; Arbeitszeit (`entryDurations()`), Saldo und Monatsabschluss-Rechnung sind unberührt.
- Eine erfasste Tagespause innerhalb einer Lücke im selben Salon addiert nichts (die Lücke ist schon das
  Segment) — vorher zählte sie in Lücken über 120 Min.
- `day-break-placement.ts` (#511): der Sonderweg „Trenner" (`separator`, Lücke über 120 Min beendet einen
  Block, trägt aber nichts zu Satz 1 bei) entfällt ersatzlos, weil keine Lücke mehr in ihn fällt. Eine
  lange Lücke im selben Salon ist jetzt ein gewöhnliches Segment: sie zählt für Satz 1, ist eine Ruhepause
  (`QUALIFYING`), wenn sie mindestens 15:00 lang ist und nicht den Rand der Arbeitsperiode berührt, und
  beendet damit den Arbeitsblock für Satz 3. Für Minderjährige gilt zusätzlich das Fenster des § 11 JArbSchG
  (vorher umging der Trenner es).
- Abgeschlossene Monate werden nicht neu bewertet; es gibt keine Migration und keinen Backfill.

**Äquivalenz-Matrix von Phase 80.** `fixtures/legacy-day-warnings-pre80.ts` bleibt unverändert. Die
Zellen, deren erwartetes Ergebnis sich mit Absicht ändert, stehen im neuen Nachtragsregister
`contexts/time-tracking/__tests__/fixtures/day-break-equivalence-80-amendments.json` (Regel
`SAME_SALON_GAP_OVER_CAP`: jeder Tag mit einer Lücke über 120 Min zwischen zwei Einträgen desselben
Salons; Begründung, Issue und Datum im Register). `day-break-equivalence-80.test.ts` wendet das Register an
(Muster wie `matrix-amendments.json`): ein Tag ohne Treffer wird weiter streng gegen die eingefrorene
Fixture verglichen, ein Treffer gegen die erwartete Legacy-Aussage mit genau dieser einen Änderung;
Untergrenzen für die Zahl der Treffer und ein Beweis, dass das Register nicht veraltet ist, sichern gegen
Vakuität. Die Testdatei selbst bekam dafür eine rein additive Änderung (Register laden, erwartete Aussage
wählen, Gruppe c1 rechnet gegen alle statt nur gegen die Lücken bis 120 Min); keine Behauptung wurde
abgeschwächt.

**Wirkung auf den Bestand.** Nur Tage mit einer Lücke über 120 Min im selben Salon ändern ihr Ergebnis, und
nur in Richtung weniger Befunde (die Pausensumme steigt). Ausgewiesen wird das read-only mit
`scripts/audit-511-break-placement.ts` (dieselbe Erkennung wie Monatsabschluss und Nachtjob): vor und nach
dem Deploy laufen lassen, die Differenz sind die Tage, die der Wegfall der Grenze von Befund zu Nicht-Befund
macht.

### Nachtrag 2026-10-16 (Phase 70b, Issue #70): Tage mit mehreren Einträgen gibt es jetzt

Die Formulierungen „Solange #70 offen ist, gibt es pro Mitarbeiter und Tag nur einen Eintrag“, „Kein Aufheben von ‚ein
Eintrag pro Tag‘ (#70)“ und die Erwartung „weil mit #70 offen kaum Salonwechseltage existieren“ beschreiben den Stand vor
#70 und gelten nicht mehr. Seit #70 (Eintrag AA) kann ein Mitarbeiter an einem Tag mehrere, sich nicht überschneidende
Einträge in verschiedenen Salons haben; damit wirkt, was Phase 80 vorbereitet hat:

- Die Tagesregel (`evaluateDayBreaks()`, `evaluatePlacement()`), die Tagespause, die Quittung, die Hinweise und das
  Gate des Monatsabschlusses sehen jetzt echte Tage. Die Route `POST /day-breaks` antwortet weiter 409 für einen Tag
  ohne Lücke und legt für einen Tag mit zwei Einträgen und einer Lücke die Tagespause an (belegt an echten Zeilen von
  `multi-entry-month-close-70`); der Monatsabschluss listet einen solchen Tag genau einmal (`findUnconfirmedBreakDays`
  führt jeden Tag einmal auf).
- Die Logik selbst bleibt unverändert: kein Eintrag im Nachtragsregister `day-break-equivalence-80-amendments.json`, die
  eingefrorene Fixture ist unberührt, und für Tage mit einem Eintrag ist jedes Ergebnis weiter gleich dem der Fassung vor
  Phase 80.
- Ein Tag mit Salonwechsel ohne erfasste Fahrzeit oder Tagespause bleibt bis #92 ein Klärungsfall („Fahrzeit oder
  Pause?“). Das ist der Grund, #70 und #92 gemeinsam auszuliefern (Eintrag AA, Auslieferung).
- Die Erwartung `staleAckTotal` ≈ 0 galt für den Bestand zum Zeitpunkt von Phase 511; Tage mit zwei Einträgen entstehen
  erst mit der Auslieferung von #70 und sind keine veralteten Quittungen.
- Neu ist der § 9 Abs. 1 Nr. 2 JArbSchG: Er vergleicht an einem Berufsschultag die Tagessumme statt den einzelnen Eintrag
  (Eintrag AA, Tagesregeln).

### Nachtrag 2026-10-16 (Phase 92b, Issue #92): Fahrzeit ist erfassbar

Die Aussagen „Kein Fahrzeitmodell (#92)“ (Was bewusst NICHT geschah), „Fahrzeit-Erfassung → #92“ und der Hinweis, die
Fahrzeit gehöre zu #92, beschreiben den Stand vor #92 und gelten nicht mehr. Seit #92 (Eintrag AB) wird eine Fahrt zwischen
zwei Salons als eigener Zeiteintrag der Art `TRAVEL` erfasst, und:

- **Die Klärungsfrage „Fahrzeit oder Pause?“ wird auch durch einen Fahrzeit-Eintrag aufgelöst.** Zu den beiden
  bisherigen Wegen (erfasste Tagespause, Quittung) kommt ein dritter: die erfasste Fahrt füllt die Lücke zwischen den
  Salons als gewöhnlicher Arbeitsblock, es bleibt keine Lücke zu beurteilen, der Befund `UNCLEAR` entfällt für diese Lücke.
  Der Kern (`evaluateDayBreaks()`, `evaluatePlacement()`) ist dafür **nicht verändert**; das Nachtragsregister
  `day-break-equivalence-80-amendments.json` und die eingefrorene Fixture sind unberührt, belegt an echten Zeilen
  (360/0 → 390/30 Minuten).
- **Eine nicht erfasste Lücke bleibt die Grenzfall-Rechnung** (ganze Lücke Arbeitszeit, freier Anteil am Anfang und am Ende
  der Lücke); das System erkennt eine Fahrt nicht selbst.
- **Das Erfassen, Ändern oder Löschen einer Fahrzeit ändert den Tagesstand.** Der Schnappschuss einer Quittung enthält die
  Ids der Einträge und die Nettominuten; eine schon erteilte `DayBreakAck` für diesen Tag wird dadurch veraltet und muss
  neu erteilt werden (der bestehende Mechanismus, keine neue Regel).
- Der Satz „Kein Fahrzeitmodell (#92)“ ist **überholt**; das Folge-Issue für ein Angebot „Lücke als Fahrzeit erfassen“ ist
  #660.

## Y — Betreiberkonto oberhalb des Mandanten und Mandantenverwaltung (Phase 88, Issue #88)

**Schwere: informativ. Nachtrag nach Auslieferung (D-06) — Unterbau-Erweiterung nach ADR 0002, Entscheidung 7.**

### Was sich geändert hat

Bis Phase 88 gab es oberhalb des Mandanten kein Konto: Mandanten entstanden per Seed oder
Datenbankzugriff. Phase 88 führt ein **Betreiberkonto** ein, das Mandanten anlegt, umbenennt,
deaktiviert und reaktivieren kann und dabei keine Mandantendaten sieht.

Unterbau-Erweiterung (additiv; kein bestehender Leser muss sich ändern, jeder vorhandene Mandant ist
aktiv): zwei neue Modelle `OperatorAccount` und `OperatorAuditLog` (`platform` 17 → 19), die Spalten
`Tenant.deactivatedAt`, `Tenant.deactivatedReason` und `Tenant.deactivatedByOperatorId`, ein eigener
Anmeldepfad (`contexts/platform/api/operator/auth.ts`, TOTP-Pflicht, eigenes optionales Geheimnis
`OPERATOR_JWT_SECRET`) und die Wächter `requireOperator` / `requireAuth`, die einander die Token
verweigern. Der Betreiber ist ein eigener Principal, keine `Role` und kein `User`.

Mandanten werden nie gelöscht. Deaktivierung (`contexts/platform/tenant-status.ts`,
`ACTIVE_TENANT_WHERE`) verweigert jeden Anmeldepfad und jede Anfrage bereits ausgestellter
Zugriffstoken, API-Schlüssel und Geräteschlüssel; schreibende Cron-Jobs überspringen den Mandanten,
die Aufbewahrungslöschung läuft bewusst weiter (§ 147 AO gilt unabhängig vom Vertrag).

Zusätzlich verschärft: `lint:tenant-scoping` kennt jetzt die Regel „kein nullbarer Mandantenwert in
einem Prisma-Aufruf“ (`lint-tenant-scoping-nullish-tenant.ts`), weil Prisma einen Filter mit
`undefined` stillschweigend fallen lässt und ein fehlender Mandantenkontext mit dem Betreiberkonto
erreichbar wird.

### Auswirkung auf die Kontexte

- **Zeiterfassung:** keine.
- **Abwesenheiten:** ein additiver Export, `ensureDefaultLeaveTypes()` (`contexts/absence/index.ts`,
  `facade/leave-types.ts`). Er legt die Standard-Abwesenheitsarten eines frisch angelegten Mandanten an
  und nutzt dafür die bestehende Einzeldefinition (`REQUESTABLE_CODES` / `leaveTypeFields`), nie eine
  zweite Kopie; idempotent, benennt nichts um. Der Urlaubsanspruch des ersten Admins im Eintrittsjahr
  entsteht über den bestehenden Pfad `ensureVacationEntitlementForYear`. Kein bestehender Leser ändert
  sich.
- **Schichtplanung:** keine — der Phorest-Abgleich überspringt deaktivierte Mandanten.
- **Arbeitszeitkonto:** keine — der automatische Monatsabschluss überspringt deaktivierte Mandanten; keine
  Saldo-Berechnung ändert sich.
- **Kompositionsschicht:** `app.ts` registriert drei weitere Module (`operatorAuthRoutes`,
  `tenantStatusPlugin`, `operatorTenantRoutes`); der Zähler der Wurzel-Ausnahme steigt von 53 auf 56
  (Eintrag H, `context-boundary-import-exceptions.json`, `composition-root`). Neu ist die Naht
  `composition/tenant-onboarding.ts`: Sie führt in einer Transaktion `provisionTenantWithAdmin`
  (Unterbau) und `ensureDefaultLeaveTypes` (Abwesenheiten) zusammen, besitzt kein Modell und trägt keine
  Fachregel; der Unterbau importiert den Abwesenheitskontext nicht, die Naht wird ihm als Option
  (`onTenantCreated`) übergeben.

### Abweichungen und Grenzen

- **Seeds tragen eine angepinnte Kopie der Provisionierungsregel (D-04a).** `packages/db` kann
  `apps/api` nicht importieren; ein gemeinsamer Code ist daher nicht möglich. `tenant-provisioning-88.test.ts`
  vergleicht die Seed-Kopie mit der Regel und wird rot, sobald sie auseinanderlaufen.
- **Erster Datenbank-Trigger des Projekts.** `OperatorAuditLog` ist per Trigger append-only (UPDATE,
  TRUNCATE und jedes DELETE außer dem Aufbewahrungslauf werden verweigert). Das schützt vor
  Anwendungsfehlern, **nicht** vor dem Tabelleneigentümer: wer die Tabelle besitzt, kann den Trigger
  entfernen. Insider-sicher ist das nicht.
- **Zustands-Cache höchstens 10 Sekunden je Prozess.** Aktivierung und Deaktivierung verwerfen den Eintrag
  im Prozess der Anfrage sofort (`app.invalidateTenantState()`); ein weiterer API-Prozess sieht die
  Änderung spätestens nach 10 Sekunden.
- **Die Lücke `tenantId: ""` ist mit #551 geschlossen (D-10, Issue #551; siehe Eintrag N, Nachtrag Issue #551).**
  Ein Benutzer ohne Employee hat keinen Mandanten; `isTenantDeactivated` antwortet für einen leeren
  Mandantenwert weiterhin „nicht deaktiviert“, weil Deaktivierung und Mandantenbesitz zwei getrennte
  Fragen sind. Ein solches Token wird aber früher abgewiesen, in `requireAuth`, mit 403 `TENANT_REQUIRED`.
  Der Randtest `operator-tenant-boundary-sweep-88.test.ts` beweist es auf jeder abgeleiteten Route.
- **Aufbewahrung des Betreiberprotokolls (D-07a).** Anmeldeereignisse 12 Monate, Lebenszyklus-Aktionen
  (Anlegen, Umbenennen, Deaktivieren, Reaktivieren, Konto-Verwaltung) 10 Jahre; die Löschung läuft mit
  der täglichen Aufbewahrungsprüfung (`composition/data-retention.ts`). Grundlage für die kurze Frist:
  Datensparsamkeit, Art. 5 Abs. 1 lit. e DSGVO.
- **Der erste Admin entsteht über die ausgelagerte Mitarbeiteranlage** (`employee-creation.ts`) mit dem
  Akteur `OPERATOR` im Mandanten-Audit; das ist die einzige Stelle, an der der Betreiber eine Zeile in den
  Mandanten-`AuditLog` schreibt. Die Einladungsregel (24 Stunden, Token gehasht) steht dort einmal.
- **Betreiberkonten werden bei der Auffrischung von int neutralisiert** (`pseudonymize-dump.ts`, D-11).

### Nachweise

`operator-audit-append-only-88`, `operator-credentials-88`, `operator-account`, `operator-config-88`,
`operator-auth-88`, `operator-surface-off-88`, `tenant-principal-guard-88`, `tenant-deactivation-88`,
`device-keys-deactivated-88`, `cron-deactivated-tenants-88`, `tenant-provisioning-88`,
`employee-creation-parity-88`, `operator-tenants-88`, `operator-tenant-boundary-sweep-88`,
`lint-tenant-scoping-nullish-tenant` sowie die erweiterten Tests `measure-foreign-context-access`,
`lint-tenant-scoping`, `lint-tenant-scoping-model-graph` und `access-context`. Betrieb:
`docs/runbooks/operator-accounts.md`.

### Nachtrag (Issue #557, 2026-10-13): MFA-Rücksetzung und Deaktivierung beenden jedes ausgestellte Betreibertoken sofort

**Schwere: informativ. Unterbau-Erweiterung nach ADR 0002, Entscheidung 7 (additiv; kein bestehender Leser
muss sich ändern; die Freigabe ist das Erreichen von `Ready`).**

Vorher blieben nach `resetOperatorMfa` ein bereits ausgestelltes 15-Minuten-Zugriffstoken und ein
ausstehendes 5-Minuten-Challenge-Token bis zum Ablauf gültig. Ein verlorenes oder kompromittiertes Gerät
verlor den Zugriff also nicht sofort (Art. 32 DSGVO: Fähigkeit, die Kontrolle wiederherzustellen).

#### Was sich geändert hat

- **Neue Spalte `OperatorAccount.tokenVersion`** (`Int`, Standard 0, eine additive Migration). Jedes
  Betreibertoken trägt sie als Anspruch `ver`; `signOperatorToken()` nimmt sie als Pflichtparameter.
- **Prüfung bei jeder Anfrage, ohne Zwischenspeicher.** `requireOperator` liest die Version je Anfrage aus
  der Datenbank; die Sperre wirkt dadurch in jedem API-Prozess sofort — anders als der 10-Sekunden-Cache
  des Mandantenstatus. Die Antwort bleibt `401 {error: "Unauthorized"}`, ohne Hinweis auf den Grund.
- **Prüfung in `/verify`.** Eine vor der Rücksetzung ausgestellte Challenge wird abgewiesen
  (`OPERATOR_MFA_FAILED`, Grund `STALE_CHALLENGE`), auch mit gültigem Code des neuen Geheimnisses; das
  zählt weder als Fehlversuch noch verbraucht es einen TOTP-Schritt. Das Zugriffstoken wird mit der
  aktuellen Version signiert.
- **Vergleich an genau einer Stelle:** `operatorTokenIsCurrent()` in `contexts/platform/operator-auth.ts`
  (strikte Gleichheit; eine niedrigere und eine höhere Version werden beide abgewiesen).
- **Erhöhung in derselben Transaktion wie die Auditzeile.** `resetOperatorMfa` und
  `deactivateOperatorAccount` erhöhen die Version zusammen mit `OPERATOR_MFA_RESET` /
  `OPERATOR_DEACTIVATED`; die Zeile trägt `newValue.sessionsRevoked: true` sowie `tokenVersion` vorher und
  nachher. Schlägt das Schreiben der Auditzeile fehl, bleiben Version, Geheimnis und `isActive`
  unverändert.

#### Auswirkung auf die Kontexte

- **Zeiterfassung:** keine.
- **Abwesenheiten:** keine.
- **Schichtplanung:** keine.
- **Arbeitszeitkonto:** keine.
- **Kompositionsschicht:** keine — kein neuer Endpunkt, keine neue Datei im Quellbaum.

#### Grenzen

- **Einmal neu anmelden nach dem Deploy.** Token aus der Zeit vor diesem Stand tragen kein `ver` und werden
  abgewiesen; betroffen sind höchstens Token der letzten 15 Minuten.
- **`requireAuth` bleibt unverändert.** Es weist ein Betreibertoken an einer Mandantenroute weiterhin nach
  der Signaturprüfung mit 403 ab; dort wird nichts gewährt, eine Versionsprüfung änderte kein Ergebnis.
- **Rennen zwischen Rücksetzung und `/verify`.** Die Verbrauchs-Updates (TOTP-Schritt, Wiederherstellungscode)
  sind an die gelesene Version gebunden; eine dazwischen committete Rücksetzung trifft null Zeilen, und
  die Anmeldung wird abgewiesen.

#### Nachweis

`operator-token-version-557` (Zugriffstoken und Challenge nach Rücksetzung und Deaktivierung, Anspruchsformen
mit Gegenprobe, Atomarität der Transaktion, vier Mutationsproben).

### Nachtrag (Phase 89, Issue #89, 2026-10-13): Betreiberkonsole `/betreiber`, Salon- und Kopplungsverwaltung durch den Betreiber

**Schwere: informativ. Unterbau-Erweiterung nach ADR 0002, Entscheidung 7 (additiv; kein bestehender Leser
muss sich ändern; die Freigabe ist das Erreichen von `Ready`).**

Phase 89 liefert die Oberfläche des Betreibers (`/betreiber`: Mandantenliste, Mandant anlegen, umbenennen,
deaktivieren, reaktivieren, Einladung erneut senden) und die Salonverwaltung je Mandant (anlegen, bearbeiten,
deaktivieren, reaktivieren; Phorest-Kopplung setzen, ersetzen, entfernen). Ein Salon wird nie gelöscht.

#### Was sich geändert hat

- **D-01 — gleicher Ursprung, Restrisiko.** Die Konsole ist die Routengruppe `(operator)` derselben
  SvelteKit-Anwendung. Ein Skript, das im Mandanten-Frontend (XSS) läuft, teilt damit den Ursprung mit der
  Konsole und könnte deren Token lesen. Gemindert durch die vorhandene Nonce-CSP (`hooks.server.ts`), das
  Token in `sessionStorage` (endet mit dem Tab) mit 15 Minuten Laufzeit ohne Auffrischung, durch das Fehlen
  jedes `{@html}` in der Konsole und durch `frame-ancestors 'none'` samt `X-Frame-Options: DENY` auf
  `/betreiber`. Das Restrisiko bleibt bewusst bestehen (T-89-53, akzeptiert). **Option:** ein eigener Host
  für die Betreiberoberfläche, falls das Risiko als zu hoch bewertet wird; das berührt Routing, Build und
  Deployment, aber keine Daten.
- **Erweiterung des Betreiber→Mandant-Audit-Anschlusses.** Der Betreiber schreibt jetzt nicht mehr nur die
  Zeile zur Anlage der ersten Administration in den Mandanten-`AuditLog`, sondern auch Salon- und
  Kopplungsänderungen (`CREATE`/`UPDATE`/`DEACTIVATE`/`ACTIVATE` auf `Salon`, `CREATE`/`DELETE` auf
  `SalonCoupling`, `END` auf `EmployeeSalonAssignment` bei der Deaktivierung eines Salons). **Grund:**
  Diese Änderungen betreffen die Stammdaten des Mandanten (Bundesland = Feiertagsort nach § 2 EFZG,
  Einsatzsalon-Zuordnungen). Sie müssen innerhalb der eigenen Aufzeichnungen des Mandanten nachvollziehbar
  sein (Revisionssicherheit, § 147 AO / GoBD), nicht nur im Betreiberprotokoll. Jede Änderung schreibt die
  `SALON_*`-Zeilen des `OperatorAuditLog` und die Mandanten-Zeilen in derselben Transaktion; schlägt eine
  der beiden fehl, bleibt nichts bestehen (Rücknahmetests je Route).
- **D-09a — Sichtbarkeit für den Mandanten.** Die Zeilen tragen `newValue.actor = { type: "OPERATOR",
operatorId, tenantId }`. `GET /api/v1/audit-logs` (Liste und Einzelabruf) liest zusätzlich genau die
  Zeilen mit diesem Stempel für den eigenen Mandanten; die Auditseite beschriftet den Akteur mit
  „Betreiber“. Das gilt für Salon- und Kopplungszeilen **und seit Phase 89 auch für die Zeilen zur Anlage
  der ersten Administration** eines vom Betreiber angelegten Mandanten (Revision R-1): eine Fabrik, die
  `provisionTenantWithAdmin` aufruft, sobald die Mandantenzeile existiert, setzt den Stempel. Vor Phase 89
  geschriebene Betreiberzeilen tragen keinen Stempel und bleiben für den Mandanten unsichtbar (der
  `AuditLog` ist anfügend, es gibt keine Nachbefüllung). Eine echte Spalte `AuditLog.tenantId` wäre das
  sauberere Modell, ist aber eine spätere Unterbau-Änderung (etwa 15 Leser unter dem Tenant-Scoping-Gate).
- **D-09b — eine Schreibdatei.** `contexts/platform/operator-tenant-audit.ts` ist die einzige Datei, die
  Betreiberzeilen in einen Mandanten-`AuditLog` schreibt (der Satz „die einzige Stelle“ in diesem Eintrag
  gilt jetzt für diese Datei, nicht mehr für den Anschluss der Mitarbeiteranlage allein).
  `operator-tenant-audit-89.test.ts` fällt, sobald eine zweite Datei die Akteurform schreibt. Die
  Betreiber-Routen rufen den Schreiber direkt auf, kein `app.audit(` in Betreiberdateien.
- **Tenant-Scoping-Gate.** Der Leseweg braucht zwei Formen, die das Gate vorher nicht erkannte: ein `OR`
  zählt nur, wenn jeder Zweig mandantengebunden ist, und ein Json-Pfad-Stempel nur in der Form
  `{ path: [..., "tenantId"], equals: <Mandant des Aufrufers> }` ohne weiteren Schlüssel. Das Gate folgt
  weiterhin keinen Hilfsfunktionen; die Ausnahmeliste ist unverändert (neun neue Gate-Fälle,
  `lint-tenant-scoping-verdict.test.ts`).
- **D-14a — keine Zahlen in Betreiberantworten.** Die Betreiber-Salon-Antworten tragen stammdatenartige
  Felder des Salons einschließlich der Filialkennung der Kopplung, aber keine Zählwerte über Mandantendaten.
  Eine Ablehnung (`HOME_SALON_IN_USE`, `LAST_ACTIVE_SALON`, `FEDERAL_STATE_IN_USE`, …) hat genau die
  Schlüssel `error` und `code`; die Zähler der Fassade erreichen die Antwort nie. Die Zeiterfassungs-
  Zählfunktion wird über den Port gelesen, ihr Ergebnis dient nur der Entscheidung.
- **D-11 — Phorest oder keine Kopplung.** Studiolution erscheint erst mit seiner Integration (Eintrag M);
  eine Auswahl ohne Wirkung wäre ein totes Bedienelement.
- **D-12a — Kopplung eingebettet.** Die Kopplung wird in `POST`/`PATCH` des Salons mitgeschrieben
  (`coupling: null | { externalBranchId }`), die Regeln stehen einmal in `scheduling/facade/couplings.ts`;
  die Mandantenrouten und der Betreiber-Anschluss (`composition/operator-salon-ports.ts`) nutzen dieselbe
  Umsetzung.
- **D-07a — Bundesland ist Pflicht** beim Anlegen eines Salons durch den Betreiber (keine stille Vererbung).
- **Datenminimierung im Mandanten-Protokoll (Verifikation Phase 89).** Die Zeile im `AuditLog` des Mandanten trägt weder IP-Adresse noch User-Agent des Betreibers (Art. 5 Abs. 1 lit. c DSGVO). Der Mandant erfährt, dass der Betreiber etwas geändert hat und was. Die Anfrage-Metadaten stehen nur in der eigenen `OperatorAuditLog`-Zeile, beide Datensätze verbindet die `operatorId`. Belegt durch `operator-salons-89.test.ts`.
- **Spiegel und Öffnungszeiten (Nachtrag zu Eintrag L).** Der Betreiber bearbeitet seit Phase 89
  `Salon.openingHours`; der Hinweis bei genau einem aktiven Salon erklärt den Spiegel. Eine Oberfläche für
  die Salonverwaltung im Mandanten und der Wegfall des Spiegels gehören zu #563 (umgesetzt in Phase 563,
  siehe Nachtrag Phase 563 unter Eintrag L).

#### Auswirkung auf die Kontexte

- **Zeiterfassung:** keine — nur die Zählfunktion der Einträge je Salon wird über den Port gelesen.
- **Abwesenheiten:** keine.
- **Schichtplanung:** Kopplungs-Fassade `facade/couplings.ts` mit denselben Regeln wie zuvor in der
  Mandantenroute; Drahtverhalten der Mandantenrouten unverändert.
- **Arbeitszeitkonto:** keine.
- **Kompositionsschicht:** ein Port-Bündel (`operator-salon-ports.ts`), keine Fachregel.
- **Unterbau:** neue Betreiberrouten, sechs neue Audit-Aktionen (`SALON_*`), ein zusätzlicher Lesezweig in
  `GET /audit-logs` (Mandanten sehen zusätzlich die Betreiberzeilen des eigenen Mandanten).

#### Grenzen

- **Abmelden widerruft das Token nicht serverseitig.** „Abmelden“ löscht die Sitzung des Tabs; das Token
  verfällt nach seiner Laufzeit von 15 Minuten (T-89-14, akzeptiert). Eine MFA-Rücksetzung oder Deaktivierung
  beendet es sofort (Nachtrag #557).
- **Offene Folgearbeiten:** #567 (Klassifizierung von `SLUG_TAKEN`/`EMAIL_TAKEN`, wenn Prisma kein
  `meta.target` liefert), #570 (`.card-animate` hält eine Transformation, die feststehende Dialoge in der
  Karte einfängt), #563 (Salonverwaltung im Mandanten, Wegfall von `storeHours`; umgesetzt in Phase 563, siehe Nachtrag Phase 563
  unter Eintrag L), #566 (Pakete je Mandant).

#### Nachweis

`operator-salons-89`, `operator-salons-boundary-89`, `operator-tenant-audit-89`,
`audit-log-operator-visibility-89`, `facade-couplings`, `lint-tenant-scoping-verdict` (web:
`operator-isolation-89`, `hooks-frame-ancestors-89`) sowie die Playwright-Spezifikation
`operator-console.spec.ts` (Anmeldung, Mandanten- und Salonlebenszyklus, Geometrie von 1440 bis 360 px,
axe in hell und dunkel). Die Neutralitätsmatrix (1712 Zellen) ist unverändert.

### Nachtrag (Issue #90, 2026-10-15): Betreiber-Übersicht mit aggregierten Mandantenkennzahlen

**Schwere: informativ. Keine Unterbau-Änderung im Sinne von ADR 0002, Entscheidung 7 (kein Feld, keine
Relation, keine Migration, keine geänderte Ausfuhr von `contexts/platform/index.ts`). Bewusste Abweichung
von D-14a (Nachtrag Phase 89).**

Issue #90 gibt dem Betreiber eine Übersicht der Mandantenlage: je Mandant die Zahl der aktiven und aller
Salons, die aktiven Mitarbeitenden und den Tag der letzten Anmeldung, dazu Summen und ein Kennzeichen
„inaktiv“.

#### Was sich geändert hat

- **Route.** `GET /api/v1/operator/dashboard` (`contexts/platform/api/operator/dashboard.ts`,
  `requireOperator`, Lese-Ratenlimit 60 pro Minute). Die Antwort wird aus ausdrücklich benannten Schlüsseln
  gebaut (`buildOperatorDashboardBody`), nie aus einem durchgereichten Datenbankobjekt.
- **Fassade.** `operatorTenantMetrics(db, now)` in `contexts/platform/facade/operator-metrics.ts` ist die
  einzige Stelle, die diese Zahlen bildet. Sie liegt im Unterbau und ist bewusst nicht aus `index.ts`
  ausgeführt. Fünf Anweisungen für alle Mandanten zusammen (Mandanten, zwei Salon-Gruppierungen, eine
  Mitarbeiter-Gruppierung, ein `MAX(lastLoginAt)`-Join), die Anzahl hängt nicht von der Zahl der Mandanten ab.
- **Zählregeln.** Aktive Mitarbeitende = nicht anonymisiert und nicht vor heute (UTC) ausgetreten; der
  Ausschluss anonymisierter Zeilen nutzt dieselbe Marke wie `NOT_ANONYMIZED_EMPLOYEE_WHERE`. Letzte Aktivität
  = UTC-Tag der jüngsten Anmeldung irgendeines Benutzers des Mandanten, ohne Uhrzeit. Inaktiv ist nur ein
  nicht deaktivierter Mandant ohne Anmeldung oder mit einer älteren als `OPERATOR_INACTIVITY_DAYS` (30) Tage;
  genau 30 Tage gelten noch als aktiv. Die Schwelle steht einmal in der Konstante und wird als
  `inactivityDays` ausgeliefert, die Konsole liest sie dort. Die Summen der Salons, Mitarbeitenden und
  inaktiven Mandanten laufen über nicht deaktivierte Mandanten.
- **Protokoll.** `DASHBOARD_VIEWED` in `operator-audit.ts`, Aufbewahrungsklasse `AUTH_EVENT` (12 Monate),
  geschrieben in derselben Transaktion wie die Lesung (RepeatableRead); jeder erfolgreiche Aufruf erzeugt
  genau eine Zeile.
- **Konsole.** Die Startseite zeigt eine „Übersicht“ (vier Kennzahlen), die Mandantenliste die Spalten
  Salons, Mitarbeitende und Letzte Aktivität mit einem Kennzeichen „Inaktiv“. Beide Anfragen laufen
  gemeinsam (`listTenants` und `getDashboard`), ein Fehler einer von beiden zeigt einen Fehlerzustand mit
  erneutem Laden. Unter 768 px ist die Tabelle die gestapelte Liste (statt wie zuvor unter 640 px: acht
  Spalten passen nicht in eine Tabelle von 640 bis 767 px), von 768 bis 1099 px eine kompakte Tabelle. Zwei
  Kontrastwerte unter WCAG AA wurden angehoben (Kennzahlbeschriftung, Text des Kennzeichens).

#### Abweichung von D-14a und Begründung

D-14a (Phase 89) schloss Zahlen in Betreiberantworten aus. Die Übersicht ist die **eine** dokumentierte
Ausnahme; D-14a gilt für jede andere Betreiberantwort unverändert und die Übersicht ist kein Präzedenzfall
für eine weitere Zahl.

- **Datenminimierung, Art. 5 Abs. 1 lit. c DSGVO.** Es gibt nur Summen und Zählwerte je Mandant, nie eine
  Person, eine Personenkennung, einen Zeiteintrag oder einen Saldo; die Aktivität steht in Tagesgenauigkeit
  statt als Anmeldezeitpunkt. Die Betreiberdateien lesen die Personenmodelle weiterhin nicht selbst, das
  tut allein die Fassade, und sie gibt nur Zahlen und einen Tag zurück (Whitelist-Test auf die Schlüssel).
- **Auftragsverarbeitung, Art. 28 DSGVO.** Der Betreiber braucht die Nutzungslage der Mandanten, um den
  Dienst zu betreiben (Lizenz- und Betreuungsentscheidungen, Erkennen verwaister Mandanten), nicht die
  Personen dahinter.
- **Protokollierung, Art. 32 DSGVO.** Jeder Aufruf wird als `DASHBOARD_VIEWED` festgehalten und wie
  Anmeldeereignisse zwölf Monate aufbewahrt; ein Lesen ohne Spur ist nicht möglich, weil der Schreibvorgang
  und die Lesung eine Transaktion bilden.

#### Auswirkung auf die Kontexte

- **Zeiterfassung:** keine — die Fassade liest bewusst keine `TimeEntry`-Zeilen.
- **Abwesenheiten:** keine.
- **Schichtplanung:** keine.
- **Arbeitszeitkonto:** keine.
- **Kompositionsschicht:** `app.ts` registriert eine Route mehr; der Zähler der Kompositionswurzel in
  `context-boundary-import-exceptions.json` steigt von 57 auf 58. Keine Fachregel.
- **Unterbau:** neue Fassade außerhalb von `index.ts`, eine neue Betreiberroute, eine neue Audit-Aktion. Kein
  Feld, keine Migration, keine Änderung einer bestehenden Ausfuhr — damit keine Unterbau-Änderung im Sinne
  von Entscheidung 7.

#### Grenzen

- **Nur am Terminal stempelnde Mandanten gelten als inaktiv.** Die Aktivität ist die letzte Anmeldung eines
  Benutzers; die Fassade liest keine Zeiteinträge (Absicht, siehe Zeiterfassung), ein Mandant, dessen Personal
  nur per NFC-Karte stempelt, erscheint daher als „inaktiv“.
- **„Heute“ und der Aktivitätstag in UTC.** Die Mitarbeiterzählung (Austritt) und die Tagesgrenze der Schwelle
  laufen nicht in der Zeitzone des Mandanten.
- **Summen über aktive Mandanten.** Deaktivierte Mandanten zählen weder in die Summen noch gelten sie je als
  inaktiv; ihre Zeile zeigt ihre Zahlen.
- **Kein Verlauf.** Die Übersicht ist ein Momentbild, es wird nichts gespeichert außer der Protokollzeile.

#### Nachweis

API: `operator-dashboard-90.test.ts` (15 Tests: Zählungen, Tag der letzten Anmeldung, nie angemeldet,
Schwelle bei 30 Tagen und 30 Tagen plus 1 ms mit eingespeister Uhr, Ausschluss anonymisierter Benutzer,
deaktivierter Mandant und Summen, Sortierung, Whitelist der Schlüssel, 401/403 samt
`TENANT_PRINCIPAL_REFUSED`, zwei Aufrufe gleich zwei Protokollzeilen, konstante Zahl der Anweisungen,
Quelltextgrenzen), `operator-surface-off-88` (Route ohne Betreibergeheimnis nicht vorhanden),
`operator-audit-append-only-88`, `lint-facade-signatures` (143 Funktionen / 17 Ausnahmen / 0 Funde), die
Importgrenzen-Messung (Kompositionswurzel 58). Web: `OperatorOverview.test.ts` (7), `TenantTable.test.ts`
(sechs neue Fälle zu den Spalten), `operator-isolation-89`. E2E: die Beschreibung „operator console -
dashboard (#90)“ in `operator-console.spec.ts` (fünf neue Fälle, 119 von 119 grün gegen den gebauten
Teststack, einschließlich axe in hell und dunkel). Die Neutralitätsmatrix (1712 Zellen) ist unverändert.

### Nachtrag (Issue #93, 2026-10-15): Support-Zugriff — befristete, protokollierte Einsicht

**Schwere: hoch (zweite dokumentierte Ausnahme zu D-14a, personenbezogene Daten in Betreiberantworten).
Unterbau-Änderung nach ADR 0002, Entscheidung 7 — eine Erweiterung (neues Modell `SupportAccess`, additive
Migration, keine Änderung eines bestehenden Lesers). Freigabe durch das Erreichen von `Ready`; eine
Semantikänderung liegt nicht vor.**

Issue #93 gibt dem Betreiber die Möglichkeit, für die Fehlersuche in einem Mandanten dessen Personendaten
einzusehen — unter drei Bedingungen: der Zugriff ist begründet und befristet, er ist lesend und auf einen
kuratierten Umfang beschränkt, und der Mandant (der Verantwortliche) sieht jeden Abruf und kann den Zugriff
sofort beenden. Ausgangslage war D-14a (Phase 89): Betreiberantworten tragen weder Personendaten noch Zahlen
(Ausnahme #90: aggregierte Kennzahlen).

#### Rechtsrahmen

- **Art. 28 Abs. 3 lit. a DSGVO:** Der Betreiber ist Auftragsverarbeiter und verarbeitet Personendaten nur auf
  dokumentierte Weisung des Verantwortlichen. Ein Support-Zugriff ist ein solcher Weisungsfall und deshalb an
  einen Grund und eine Frist gebunden; das Weisungsrecht des Mandanten ist als „Zugriff beenden“ umgesetzt.
- **Art. 5 Abs. 1 lit. b, c DSGVO:** Zweckbindung und Datenminimierung — ein kuratierter, lesender Umfang statt
  der ganzen Mandanten-App; Freitexte und Dokumente sind ausgeschlossen.
- **Art. 28 Abs. 3 lit. h und Art. 5 Abs. 2 DSGVO:** Nachweisfähigkeit — jeder Abruf wird mit Wer, Wann,
  Mandant, Datenkategorie und Grund festgehalten, unveränderbar, und dem Mandanten in der App zugänglich gemacht.
- **Art. 32 DSGVO:** Vertraulichkeit und Nachvollziehbarkeit. **Art. 9 DSGVO:** Krankheitsdaten — es werden nur
  Art-Kürzel, Status und Tage gelesen, nie Atteste oder Notizen.
- **§ 26 BDSG / Art. 88 DSGVO:** Beschäftigtendaten — Hebel ist die Transparenz gegenüber dem Verantwortlichen.

#### Entscheidungen (Kurzform; das Addendum nach der Recherche ist maßgeblich)

- **D-01 Eigene, nur lesende Betreiber-Endpunkte, keine Mandanten-Sitzung.** Der Betreiber erhält nie ein
  Mandanten-Token. Die Trennung aus #88 bleibt vollständig; ein Impersonations-Token würde jede Mandanten-Leseroute
  öffnen und „welche Daten“ im Protokoll unscharf machen.
- **D-02/D-03 `SupportAccess`** (Unterbau): Mandant, Betreiber, Grund (10–500 Zeichen, getrimmt), Beginn, Ende,
  vorzeitiges Ende. Dauer 1, 4, 8 oder 24 Stunden (Vorgabe 1), nie eine freie Endzeit. Aktiv ⇔ `endedAt` leer und
  `expiresAt` in der Zukunft, bei jeder Anfrage mit der Anwendungsuhr geprüft, kein Cron (D-22). Pro Betreiber und
  Mandant höchstens ein aktiver Zugriff (409 `SUPPORT_ACCESS_ALREADY_ACTIVE`, kein stilles Verlängern).
- **D-04/D-28 Nur für aktive Mandanten.** Ein deaktivierter Mandant wird beim Antrag und bei jedem Abruf abgelehnt
  (409 `TENANT_DEACTIVATED`, mit Ablehnungszeile). Das **Beenden** eines laufenden Zugriffs bleibt auch bei
  deaktiviertem Mandanten möglich (Änderung in 93b-08: Beenden verengt den Zugriff nur).
- **D-05 Kuratierter Umfang:** Mitarbeitendenliste (ohne E-Mail, Geburtsdatum, NFC-Kennung, Anschrift),
  Monatsansicht je Person (Zeiteinträge samt Löschkennzeichen und Pausen, Anträge, Abwesenheiten, Tagespausen,
  Soll/Ist/Saldo über `computeMonthReportFigures()`, Abschlussstatus), Vertragshistorie, Änderungsprotokoll des
  Mandanten. Ausgeschlossen: jede Notiz, jede Begründung (`breakWaivedReason`, `DayBreakAck.reason`), Dokumente
  und Atteste. Sieben Betreiberrouten: drei für den Lebenszyklus (`POST`, `GET` Verlauf, `POST …/:accessId/end`
  unter `/support-access`), vier Lesungen (`GET` unter `/support/…`); keine Schreibmethode unter `/support/`.
- **D-06/D-19 Doppelt protokolliert, erst protokollieren, dann lesen.** Beide Zeilen (`OperatorAuditLog` mit IP,
  Mandanten-`AuditLog` ohne IP, Akteur gestempelt) werden in einer Transaktion vor der Lesung geschrieben; scheitert
  das Protokoll, wird nichts gelesen. Ein Abruf ohne aktiven Zugriff ist 403 `SUPPORT_ACCESS_REQUIRED` mit einer
  Zeile `SUPPORT_ACCESS_REFUSED`. Antworten tragen `Cache-Control: no-store` (D-11).
- **D-07/D-25 Unveränderbarkeit.** Der zweite Datenbank-Trigger des Projekts (nach dem des `OperatorAuditLog`,
  Eintrag Y): `SupportAccess` wird nie gelöscht und nie geändert, außer durch den einmaligen Übergang von leer auf
  einen Wert bei `endedAt`/`endedBy`/`endedByUserId`; DELETE nur unter dem gekennzeichneten Aufbewahrungslauf und
  erst nach 120 Monaten (Boden im Trigger), TRUNCATE ist verboten. Dazu drei CHECK-Regeln (`endedBy`, Paar-Regel,
  Zeitfenster). `purgeExpiredSupportAccess` läuft im täglichen Lauf von `composition/data-retention.ts`, auch für
  deaktivierte Mandanten.
- **D-08/D-27/D-29 Sichtbarkeit und Kontrolle für den Mandanten.** `GET /api/v1/support-accesses` und `/:id`
  (`audit-log:read`) und `POST /api/v1/support-accesses/:id/end` (`tenant-settings:update`), jeweils mandantenweit,
  keine neuen Katalogschlüssel. Der Mandant sieht den Anzeigenamen des Betreiberkontos (nie E-Mail oder IP). Die
  Betreiberzeile eines Mandanten-Endes hat `operatorId` leer; der Mandantennutzer steht im `newValue`. Die Admin-Seite
  „Support-Zugriffe“ liegt in der Gruppe COMPLIANCE hinter „Audit & Log“. Beim Start geht eine In-App-Mitteilung an
  jeden mandantenweiten Inhaber von `tenant-settings:update` (E-Mail-Richtlinie „nie“); der Link steht nur bei
  Empfängern, die auch `audit-log:read` mandantenweit halten (kein toter Link). Beim Ende werden die offenen
  Mitteilungen ausgeblendet.
- **D-09/D-21 Betreiberkonsole.** Abschnitt „Support-Zugriff“ auf der Mandantenseite, Leseansichten unter
  `/betreiber/mandanten/[id]/support/…` mit durchgehendem Banner; ein 403 `SUPPORT_ACCESS_REQUIRED` meldet den
  Betreiber nicht ab. Die Konsole bleibt von der Mandanten-App isoliert (`operator-isolation-89`).
- **D-10/D-24 Ausnahmeregister.** Der **einzige** Betreiberpfad zu Personendaten ist
  `composition/operator-support-ports.ts` (Lesungen als `ports` in die Routen injiziert) hinter
  `assertActiveSupportAccess()` (`contexts/platform/support-access.ts`), der einen Entscheidungsstelle für „aktiv“.
  Die Routendateien lesen selbst weiterhin kein Personenmodell; `operator-auth-88` bleibt unverändert grün.
- **D-12/D-23 Gleichzeitigkeit.** Der Antrag sperrt die Mandantenzeile `FOR NO KEY UPDATE` in READ COMMITTED und
  prüft darunter „kein aktiver Zugriff“; von zwei parallelen Anträgen gelingt genau einer (Test beobachtet das
  Warten in `pg_blocking_pids`).
- **D-17 Schwärzung nach Typ (Erlaubnisliste).** In `oldValue`/`newValue` des gelesenen Änderungsprotokolls bleiben
  Zahlen, Wahrheitswerte, `null`, Datums- und Zeitangaben, UUIDs und UPPER_SNAKE-Kennwerte erhalten, dazu die
  Struktur; jeder andere Text wird zu „[ausgeblendet]“ (`redactSupportAuditValue`,
  `contexts/platform/support-audit-redaction.ts`). Eine Sperrliste nach Feldnamen würde das nächste neue Freitextfeld
  still durchlassen. Fenster Pflicht, höchstens 92 UTC-Kalendertage, 50 Einträge je Seite (D-26: Personenfilter über
  `entityId` oder `employeeId` im Wert).

#### Zweite dokumentierte Ausnahme zu D-14a und Begründung

D-14a schloss Personendaten und Zahlen in Betreiberantworten aus; Nachtrag #90 ließ aggregierte Kennzahlen zu.
Ein Support-Zugriff öffnet **personenbezogene** Daten, deshalb nur so weit und so lange, wie es der Grund trägt:
befristet (höchstens 24 Stunden), lesend, kuratiert, doppelt protokolliert und vom Verantwortlichen jederzeit
beendbar. D-14a gilt für jede andere Betreiberantwort unverändert, und weder #90 noch #93 sind ein Präzedenzfall
für eine weitere Ausnahme. Eine neue Lesung gehört in `operator-support-ports.ts`, bekommt eine Eintragszeile im
Grenztest `support-access-boundary-93.test.ts` und wird durch eine Fachentscheidung des Issues freigegeben.

#### Auswirkung auf die Kontexte

- **Zeiterfassung:** keine fachliche Änderung. Zwei zusätzliche, anhängende Lesefunktionen in der Fassade
  (Monatseinträge einschließlich Löschkennzeichen, Tagespausen), ohne Freitexte; die Zahl der Fassadenfunktionen
  steigt von 143 auf 146 (zusammen mit der Abwesenheits-Lesefunktion).
- **Abwesenheiten:** keine fachliche Änderung. Eine Lesefunktion für Anträge ohne Notizen und Atteste.
- **Schichtplanung:** keine.
- **Arbeitszeitkonto:** keine Änderung. Gelesen wird nur über `computeMonthReportFigures()`;
  `calcLeaveAbsenceMinutesTz()` und der `sbClaimed`-Satz bleiben unberührt.
- **Kompositionsschicht:** ein neues, regelfreies Lesemodul `composition/operator-support-ports.ts`. Es besitzt
  kein Modell und trägt keine Fachregel; `app.ts` registriert drei Routen-Plugins mehr (Zähler der
  Kompositionswurzel in `context-boundary-import-exceptions.json` 58 → 61).
- **Unterbau:** neues Modell `SupportAccess` (zwei Migrationen, rein additiv, kein Backfill), neue Funktionen in
  `contexts/platform/` (`support-access.ts`, `support-access-types.ts`, `support-audit-redaction.ts`), vier neue
  Betreiber-Audit-Aktionen, Mandanten-Routen `api/support-accesses.ts`. Ausfuhren aus `index.ts` kamen hinzu, keine
  bestehende änderte Signatur oder Bedeutung. Plattform-Modelle in `MODEL_OWNER`: 19 → 20 (gesamt 52 → 53).

#### Gates und Tests

- **API** (je Datei die Fälle der Akzeptanzkriterien): `support-access-decider-93` (Entscheiderfunktion,
  Antrag unter Sperre, `lockGrant`, Schreiber, Trigger), `support-access-grant-93` (Antrag, Dauer, 409, Ablauf mit
  eingespeister Uhr, Verlauf, Beenden, Warten eines Lesevorgangs auf ein Ende), `support-access-immutability-93`
  (Trigger- und CHECK-Matrix, Aufbewahrungslauf, keine Änderungsroute), `support-access-facades-93`
  (Schlüsselmengen und Marker der drei Fassadenlesungen), `support-access-reads-93` (Monat, Verträge,
  Änderungsprotokoll: Schlüssel-Whitelist, ausgeschlossene Felder, doppelte Protokollierung, geschlossen
  scheiternd, byte-gleiche 404), `support-audit-redaction-93` (Schwärzung, auch ein künftiges unbekanntes
  Textfeld), `support-access-tenant-93` (Liste, Detail, Beenden, Mitteilung, 403-Matrix),
  `support-access-boundary-93` (Quelltextscan: erst Entscheiderfunktion, erst Protokoll, nur GET, Ports mit
  Mandantenbezug), dazu `operator-surface-off-88` (ohne `OPERATOR_JWT_SECRET` keine Betreiberroute),
  `t100-09-oracle-probe` (zwei neue Mandantenrouten als `probe`, fremde Zugriffs-ID gleich unbekannter ID) und
  `permission-site-mapping`. Die Neutralitätsaufzeichnungen (`neutrality/recorded/`) sind unverändert; die neuen
  Routen stehen in `EXCLUDED_ROUTES` von `matrix-config.ts`.
- **Web:** Komponenten- und Hilfstests der Konsole (`SupportSection`, `SupportBanner`, `SupportEmployeeTable`,
  `SupportMonthView`, `SupportContracts`, `SupportAuditLog`, `support-audit`, `support-month`, `support-nav`) und der
  Mandantenseite (`SupportAccessList`, `SupportAccessDetail`, `support-access/labels`), `operator-isolation-89`,
  `admin-nav-visibility-83`, `admin-route-permissions`. **E2E:** die Beschreibung „operator console - support access
  (#93)“ in `operator-console.spec.ts` (24 Fälle, gesamte Datei 143 von 143 grün, einschließlich axe in hell und dunkel
  und 360 px). Sichtprüfung beider Oberflächen: 30 Aufnahmen in drei Breiten (Phase-Verzeichnis, nicht im Repo).
- **Gates:** `lint:tenant-scoping`, `lint:facade-signatures`, `lint:t100-09-routes --check`, `lint:role-checks`,
  `lint-guard-vacuity`, Importgrenzen- und Fremdzugriffsmessung, `lint-e2e-spec-registry`,
  `check-test-completeness` (Untergrenzen angehoben).

#### Grenzen

- **Ein Insider mit Tabelleneigentümer-Rechten kann die Trigger entfernen.** Beide Trigger schützen gegen
  Anwendungsfehler, nicht gegen den Besitzer der Tabelle; die Absicherung des direkten Datenbankzugriffs ist
  organisatorisch und ausdrücklich nicht Teil von #93.
- **Der Grund ist vom Betreiber verfasster Freitext** und wird dem Mandanten unverändert gezeigt (Länge 10–500, kein
  Markup-Rendering). Er ist eine Aussage des Betreibers, keine geprüfte Tatsache.
- **Art. 9: Rest der Art-Kürzel.** Die Leseansicht zeigt Anträge mit ihrem Art-Kürzel; `SICK`, `SICK_CHILD`,
  `MATERNITY` und `PARENTAL` verraten damit eine Krankheit, einen Mutterschutz oder eine Elternzeit. Das ist
  Bestandteil der Aufgabe (Fehlersuche an Saldo und Urlaub) und wird hingenommen; nie gelesen werden Atteste,
  Notizen und Dokumentpfade.
- **Zu viel statt zu wenig protokolliert.** Scheitert eine Lesung nach ihrer Protokollzeile, bleibt eine Zeile für
  einen versuchten Abruf (D-19, Protokoll zuerst). Das ist gewollt und ehrlicher als der umgekehrte Fehler.
- **Zwischen Protokollzeile und Lesung kann ein Ende noch festschreiben.** Die erneute Prüfung innerhalb der
  Protokolltransaktion unter `FOR SHARE` auf der Zugriffszeile schließt nur das Fenster **vor** der Protokollzeile
  (ein Ende wartet auf laufende Protokolltransaktionen, und nach einem festgeschriebenen Ende folgt keine
  Abrufzeile). Eine Lesung, deren Protokollzeile bereits festgeschrieben ist, läuft noch zu Ende (Beleg: ein beobachtetes
  Warten in `support-access-grant-93`, Fall g).
- **Ein 24-Stunden-Zugriff überlebt das 15-Minuten-Token.** Der Zugriff gehört zum Betreiberkonto, nicht zum
  Token; ein abgelaufenes Token verlangt eine neue Anmeldung mit TOTP, der Zugriff läuft weiter. Sperrt oder
  entzieht man das Konto (MFA-Zurücksetzen, Deaktivierung), enden die Token sofort (#557), der Zugriff selbst endet
  nur durch Ablauf oder ein ausdrückliches Ende.
- **Die Schwärzung bleibt bei UPPER_SNAKE und Zahlenketten stehen, auch wenn ein Mandant sie als Freitext
  getippt hat** (zum Beispiel ein einzelnes Wort in Großbuchstaben oder eine Ziffernfolge); ein Freitext kann sich
  von einem Kennwert nicht unterscheiden lassen. Die Regel ist deshalb eine Erlaubnisliste mit einem benannten Rest,
  keine Sperrliste.
- **Zeitfenster in UTC.** Das Fenster des Änderungsprotokolls (höchstens 92 Kalendertage) zählt in UTC-Tagen, nicht
  in der Zeitzone des Mandanten; die Konsole weist darauf hin und zeigt Zeiten in der Zone des Browsers.
- **`HEAD` zählt als Abruf.** Fastify beantwortet `HEAD` auf einer `GET`-Route; die Sicherung (Entscheidung, Protokoll,
  `no-store`) gilt unverändert, ein `HEAD` schreibt also ebenfalls die zwei Protokollzeilen.
- **Außerhalb von D-14:** eine vorherige Freigabe durch den Mandanten (würde den Support genau dann blockieren, wenn
  der Administrator ausgesperrt ist — ersetzt durch Transparenz und Beenden-Recht), eine E-Mail-Benachrichtigung,
  Dienstplan, Berichte und DATEV, und die Absicherung des direkten Datenbankzugriffs.

---

## Z — Gebuchte Pakete je Mandant (Phase 566, Issue #566)

**Schwere: informativ. Unterbau-Änderung nach ADR 0002, Entscheidung 7 — eine Erweiterung (zwei Spalten, ein
Aufzählungstyp) und eine Semantikänderung (neue Ablehnungen in `createSalon` und `activateSalon`). Freigabe der
Erweiterung durch das Erreichen von `Ready`; Freigabe der Semantikänderung durch die Owner-Entscheidung vom
13.10.2026 im Issue.**

### Ausgangslage

Bis Phase 566 kannte Clokr keinen Begriff dafür, was ein Mandant gebucht hat: Jeder Mandant konnte beliebig viele
Salons anlegen, Phorest koppeln, API-Schlüssel und NFC-Terminals erzeugen, WLAN-Anwesenheitsquellen einrichten und
die Tätigkeitsarten auswerten. Die Owner-Entscheidung vom 13.10.2026 trennt eine **Grundversion** von **Paketen**:

- **Grundversion** (immer enthalten, nie gesperrt): alles, was das Gesetz verlangt (Zeiterfassung, Pausen- und
  ArbZG-Prüfung, Urlaub, Monatsabschluss, Berichte, DATEV, DSGVO-Auskunft und -Anonymisierung, Aufbewahrung),
  die Systemrollen, die Dienstplanung und **ein** aktiver Salon.
- **Ketten-Paket** (`CHAIN`): mehrere aktive Salons bis zu einem vertraglichen Kontingent (`salonQuota`);
  dem Katalog nach gehören die erweiterten Rollen ebenfalls dazu, sie werden in dieser Phase aber nicht gesperrt (D-07).
- **Zusatzmodule:** Integrationen (`INTEGRATIONS`: Phorest-Kopplung, API-Schlüssel), Hardware-Stempeln
  (`HARDWARE_CLOCK`: NFC-Terminal, WLAN-Anwesenheitsquelle), Auswertungen (`ANALYTICS`: Tätigkeitsarten, Issue #81).

Es gibt keinen Lizenzschlüssel und keine Abrechnung; der Betreiber setzt die Pakete je Mandant (eine Instanz je Kunde).

### Entscheidung

- **D-01 — Ablage am Mandanten.** `Tenant.bookedModules TenantModule[]` (Standard leer) und `Tenant.salonQuota Int`
  (Standard 1, `CHECK ("salonQuota" >= 1)` namens `Tenant_salonQuota_positive`). Die Zeile des Mandanten existiert
  immer, ist der bestehende Sperranker (`FOR NO KEY UPDATE`, #568) und braucht kein neues Modell. Eine
  Änderungshistorie gibt es nicht als Tabelle, sie ist die doppelte Auditzeile (D-08).
- **D-02 — Kontingent gilt nur mit Ketten-Paket.** Das wirksame Salon-Limit ist `salonQuota` mit `CHAIN`, sonst 1.
  Das Kontingent bleibt wie eingegeben gespeichert, auch ohne `CHAIN`; wird `CHAIN` später gebucht, gilt es wieder.
- **D-03 — Eine Entscheidungsstelle.** `contexts/platform/tenant-packages.ts` (über `contexts/platform/index.ts`)
  ist die einzige Datei, die entscheidet, ob ein Paket gebucht ist: `isModuleBooked`, `salonLimit`,
  `assertSalonActivationAllowed(db, tenantId)` und `assertModuleBooked(db, tenantId, module)`. Abgelehnt wird mit
  `SalonQuotaReachedError` / `ModuleNotBookedError` (Basis `PackageRefusalError`), die `app.ts` an genau einer
  Stelle auf 409 `{ error, code: "SALON_QUOTA_REACHED" | "MODULE_NOT_BOOKED" }` mit deutschem Text abbildet.
  Das Web zeigt nur an.
- **D-04 — Rennfrei.** `createSalon` (nur für einen aktiven Salon) und `activateSalon` nehmen zuerst
  `SELECT "id" FROM "Tenant" WHERE "id" = $1 FOR NO KEY UPDATE`, zählen dann die aktiven Salons und schreiben
  danach; Sperrreihenfolge Mandant → Salon. Auch die Betreiberroute für die Pakete nimmt dieselbe Sperre, damit
  eine Änderung des Kontingents nicht an einer laufenden Aktivierung vorbeigeht. Für die Sperre der
  Mandantenzeile genügt `FOR NO KEY UPDATE`: Sie kollidiert mit sich selbst, nicht mit dem `FOR KEY SHARE`, das jede Anlage
  einer abhängigen Zeile nimmt. Beweis: `pg_blocking_pids` in `tenant-packages-566.test.ts` und
  `operator-packages-566.test.ts` (Mutationsproben: ohne Sperre werden die Fälle rot).
- **D-05 — Module sperren nur das Neu-Einrichten.** Neun Stellen, jeweils _vor_ dem Schreibaufruf und nach
  Validierung und Rechteprüfung: `createSalon` und `activateSalon`; `createSalonCoupling` und der Anlegezweig von
  `setSalonCoupling` (Ersetzen und Entfernen einer Kopplung bleiben frei) sowie der Anlegezweig von
  `PUT /integrations/phorest/config` (kein Umweg an der Fassade vorbei; eine Ablehnung rollt die ganze Anfrage
  zurück, Zugangsdaten eingeschlossen); `POST /api-keys`; `POST /terminals`; `POST /admin/presence-sources`; und die
  `activityMinutes` von `GET /time-entries/summary` (nicht gebucht: `null` mit
  `activityMinutesUnavailableReason: "MODULE_NOT_BOOKED"`, nach dem Muster von `sollUnavailableReason`; jede
  andere Summenzahl bleibt gleich, das Schreiben einer Tätigkeitsart bleibt frei).
  Frei bleiben Zuordnung von Geräten zu einer bestehenden Quelle, die Eigenregistrierung eines Geräts, Ingest,
  Terminal-Anmeldung, Stempeln, bestehende API-Schlüssel und das Speichern von Phorest-Zugangsdaten ohne neue
  Kopplung. Dieselbe Regel gilt für Mandanten- und Betreiberwege.
- **D-06 — Nie rückwirkend.** Eine Kündigung eines Moduls oder ein Kontingent unter der Zahl der aktiven Salons ist
  erlaubt (die Betreiberkonsole warnt nur) und ändert sonst nichts: kein Salon wird deaktiviert, kein Schlüssel,
  Terminal, keine Quelle, Kopplung widerrufen oder gesperrt, Synchronisation und Anmeldung bleiben, Lesen, Berichte,
  PDF, DATEV und Export sind immer verfügbar. Beweis: `tenant-packages-never-retroactive-566.test.ts` (Mandant mit
  drei aktiven Salons, Schlüsseln, Terminal, Quelle, Kopplung und einem wirklich geschlossenen Monat; vorher/nachher
  gleich bis auf die zwei Schlüssel der Auswertung).
- **D-07 — Erweiterte Rollen nicht gesperrt.** Eine Sperre von Kundenrollen und Bereichszuweisungen könnte
  bestehenden Zugriff entziehen; Folge-Issue #624 (nur Neuanlage, nie die Auflösung).
- **D-08 — Betreiber-Schnittstelle.** `PUT /api/v1/operator/tenants/:id/packages` (streng validiert: `bookedModules`
  höchstens vier bekannte Module, `salonQuota` ganzzahlig 1 bis 500; Ratenbegrenzung; `requireOperator`; ein
  deaktivierter Mandant wird mit 409 `TENANT_DEACTIVATED` abgewiesen). Eine tatsächliche Änderung schreibt in
  **einer** Transaktion die Zeile `TENANT_PACKAGES_CHANGED` in den `OperatorAuditLog` (Aufbewahrung wie
  Lebenszyklus-Aktionen) und eine Zeile mit Akteurstempel `OPERATOR` in den Mandanten-`AuditLog`
  (`operator-tenant-audit.ts`, Entität `TenantPackages`, alt/neu); ein unveränderter Körper (auch umsortiert oder mit
  Doppelten) schreibt nichts. Die Mandantenantworten des Betreibers tragen `packages` (`bookedModules`, `salonQuota`,
  `activeSalonCount`; die Zahl ist eine Stammdatenzahl über Salons, kein Zählwert über Mandantendaten, Eintrag Y/89
  D-14a). Die Konsole hat den Abschnitt „Pakete“ (kein `animate`, #570).
- **D-09 — Bestandsschutz.** Die Migration `20261013233636_tenant_packages` ergänzt die Spalten und führt genau eine
  `UPDATE`-Anweisung aus, die jedem vorhandenen Mandanten (auch deaktivierten) gibt, was er nutzt: `salonQuota` =
  Zahl aktiver Salons (mindestens 1); `CHAIN` bei mehr als einem Salon in beliebigem Zustand, einer Kundenrolle,
  einer Rollenzuweisung mit Bereich `SALONS`/`PERSONS` oder einer Einsatz-Zuordnung; `INTEGRATIONS` bei
  Kopplung, API-Schlüssel (auch widerrufen) oder Phorest-Zugangsdaten; `HARDWARE_CLOCK` bei Terminal-Schlüssel oder
  Anwesenheitsquelle in jedem Zustand; `ANALYTICS` bei klassifiziertem Eintrag oder Tätigkeitsanteil. Das
  überschreibt absichtlich zu großzügig (weiche Löschung und Widerruf zählen); der Betreiber korrigiert danach. Ein
  zweiter Lauf ist wirkungslos, ein vom Betreiber bereits bearbeiteter Mandant bleibt unberührt. Neue Mandanten
  bekommen die Grundversion ausdrücklich (`createTenantWithConfig`). Weil die Tätigkeitsarten (Phase 81) im selben
  Release ausgeliefert werden, kann `ANALYTICS` auf int und prod nicht auslösen. Die Vorschau
  `apps/api/scripts/audit-566-package-backfill.ts` ist eine unabhängige, rein lesende Umsetzung (nur Lesezugriffe,
  kein Schreib-Schalter, nur Ids, Zahlen, Modul- und Signalnamen) und prüft vor dem Deploy lesend, ob die
  Tätigkeitsart-Spalten schon existieren; sonst meldet sie `analytics=not-evaluable`. Anleitung: `docs/migrations.md`,
  Abschnitt „Phase 566“.
- **D-10 — Neutrale Testdaten.** `seedTestData`, der Neutralitäts-Bootstrap und `test-bootstrap.ts` buchen alle
  Module mit Kontingent 500 (`FIXTURE_PACKAGES`), damit die aufgezeichneten Matrixzellen unverändert bleiben (nichts
  neu aufgezeichnet). Paket-Tests bauen ihren Mandanten mit `seedGrundversionTenant`. Die Seeds buchen, was die Demo
  zeigt (alle vier Module, Kontingent 5).
- **D-11 — Quellwächter für den gesetzlichen Kern.** `packages-legal-core-isolation-566.test.ts` (TypeScript-AST,
  nicht vakuös: Untergrenzen der durchsuchten Dateien, benannte Dateien, Positivkontrolle des Detektors,
  Kontrolllauf an der Entscheidungsstelle) beweist, dass `contexts/absence/**`, `contexts/working-time-account/**`,
  `services/clock/**`, `services/phorest/**`, der Scheduler, Ingest, Authentifizierung und Berechtigungen,
  Anonymisierung (einschließlich der DSGVO-Löschroute in `employees.ts`), Aufbewahrung, Berichte, PDF, Dashboard,
  Auditlog sowie Rollen kein Paket lesen. In `contexts/time-tracking/**` und `contexts/scheduling/**` sind nur die
  benannten Einrichtungsstellen erlaubt; der Wächter prüft für alle neun Stellen, dass genau ein Gate genau einmal
  _vor_ dem Schreibaufruf in derselben Funktion steht (Positivkontrolle mit synthetischen Quellen) und dass nur die
  bekannten Dateien eine Kopplung, einen Salon, einen Schlüssel, eine Quelle oder ein Terminal anlegen.
- **D-12 — Web (Mandantenseite).** `GET /api/v1/me/context` liefert additiv `packages` (`bookedModules`,
  `salonLimit`; nur Anzeige, keine neue Berechtigung). `moduleBooked()` im Store `$stores/salon-context` liefert
  bei unbekanntem Zustand `null` und blendet dann nichts aus; die Pakete liegen nie in `base`, `showSalonOptions()`
  und `isMultiSalonTenant()` lesen sie nicht. `ModuleHint` ersetzt das Anlegen-Bedienelement an genau vier Stellen
  unter `/admin` (NFC-Terminals und API-Schlüssel in `/admin/system`, Anwesenheitsquellen in `/admin/integrations`,
  neue Phorest-Kopplung in `/admin/phorest`); bestehende Einträge bleiben sichtbar und bedienbar. Nie im Stempeln,
  Kalender oder Dashboard, nie als Dialog. Eine 409-Ablehnung zeigt weiterhin den Text des Servers.

### Auswirkung auf die Kontexte

- **Zeiterfassung:** neue Terminals und neue Anwesenheitsquellen sowie die Auswertung der Tätigkeitsarten in
  `GET /time-entries/summary` sind an Module gebunden. Stempeln, Ingest, Erfassung und Korrektur sind unverändert,
  ebenso jede Zahl der Summe außer `activityMinutes`.
- **Abwesenheiten:** keine.
- **Schichtplanung:** eine neue Phorest-Kopplung ist an Integrationen gebunden (`facade/couplings.ts`,
  `api/integrations.ts`); bestehende Kopplungen, ihr Ersetzen, Entfernen und der Abgleich sind unverändert.
- **Arbeitszeitkonto:** keine — kein Saldo, kein Monatsabschluss und keine Soll-Berechnung liest ein Paket
  (vom Wächter bewiesen).
- **Kompositionsschicht:** keine Regel. Berichte, PDF, DATEV und Dashboard sind paketfrei (vom Wächter bewiesen);
  `app.ts` bildet die zwei Ablehnungen auf 409 ab, das ist die einzige Ergänzung.
- **Unterbau:** zwei Spalten und der Typ `TenantModule` am Mandanten, `tenant-packages.ts`, die neue Betreiberroute
  und die Audit-Aktion `TENANT_PACKAGES_CHANGED`. **Semantikänderung:** `createSalon` (für einen aktiven Salon) und
  `activateSalon` lehnen jetzt oberhalb des Limits mit 409 ab — für jeden Aufrufer (Mandantenroute,
  Betreiberanschluss, Provisionierung; dessen erster Salon besteht, weil das Limit 1 ist und der Mandant noch
  keinen aktiven Salon hat). Die Fassadensignaturen sind unverändert (`lint:facade-signatures` weiterhin 142).

### Grenzen

- **Letzter Schreiber gewinnt.** Schreiben zwei Betreiber gleichzeitig dieselben Pakete, gilt die zuletzt
  festgeschriebene Änderung; beide stehen im `OperatorAuditLog`. Es gibt kein `If-Match`.
- **Die Betreiberkonsole hat eigene Hinweistexte.** `SALON_QUOTA_REACHED` und `MODULE_NOT_BOOKED` werden dort
  nach dem Code in neutraler Betreibersprache erklärt, nicht mit dem Satz des Servers (der den Mandanten anspricht).
- **Kein Salon-Hinweis im Mandanten bis #563.** Es gibt keine Salonverwaltung für Mandanten-Admins; eine
  Ablehnung beim Anlegen oder Aktivieren erreicht den Mandanten nur über die API-Antwort. Der Hinweis wird mit
  #563 ergänzt (anzeigen mit `packagesForDisplay` / `moduleBooked`; der Server antwortet weiter mit 409).
  (Umgesetzt in Phase 563, siehe Nachtrag Phase 563 unter Eintrag L: der Hinweis steht beim Anlegen; beim
  Aktivieren zeigt die Seite den 409-Text des Servers.)
- **Großzügige Zuteilung ist gewollt.** Die Bestandsschutz-Migration rechnet weiche Löschungen und Widerrufe mit;
  die Zuteilung ist ein Ausgangspunkt für den Betreiber, keine Rechnungsgrundlage.
- **Der Wächter sieht nur die benannten Verzeichnisse.** Greift eine Datei des gesetzlichen Kerns über einen Helfer
  mit unbeteiligtem Namen auf Paketzustand zu, ohne die verbotenen Namen zu tragen, sieht der Wächter das nicht
  (im Kopfkommentar des Tests benannt).
- **Die Vorschau vor dem Deploy läuft mit dem Image des neuen Release.** Sie darf den Standard-Einstiegspunkt dieses
  Images nicht starten (er führt `prisma migrate deploy` aus); Befehl und Begründung in `docs/migrations.md`.

### Folge-Issues

- **#624** — Erweiterte Rollen an das Ketten-Paket binden (nur Neuanlage, nie Auflösung; D-07).
- **#563** — Salonverwaltung für Mandanten-Admins; bekommt den Ketten-Paket-Hinweis am Anlegen/Aktivieren
  (Kommentar am Issue). (Umgesetzt in Phase 563, siehe Nachtrag Phase 563 unter Eintrag L.)

### Nachweis

`tenant-packages-566` (Entscheidung, Sperre, Rennen), `operator-packages-566`, `tenant-packages-addons-566`
(Gates und was frei bleibt), `tenant-packages-never-retroactive-566`, `packages-legal-core-isolation-566`,
`tenant-packages-migration-566` und `scripts/__tests__/audit-566-package-backfill.test.ts` (Migration gegen die
Vorschau, Mandant für Mandant), `tenant-provisioning-88` (Grundversion, Seeds), `me-context-82`; Web:
`tenant-modules`, `ModuleHint`, `PackagesSection`, `module-teaser-placement-566`, `salon-context`; Playwright
`operator-console.spec.ts` (Abschnitt „Pakete“, 360 px, axe). Die Neutralitätsmatrix (1712 Zellen) und die
Ausnahmeliste des Tenant-Scoping-Gates (44) sind unverändert.

---

## AA — Mehrere Zeiteinträge pro Mitarbeiter und Tag (Phase 70b, Issue #70)

**Schwere: Änderung einer Festlegung von ADR 0001 („Zeiterfassung: minutengenau, eine Zeile pro Mitarbeiter und
Tag“) — Akzeptanzkriterium von Issue #70, daher als eigener Eintrag mit Nachträgen zu den Einträgen L, O und X und zu
`0001-drei-kontexte.md`. Kein Eingriff in den Unterbau nach ADR 0002, Entscheidung 7 (kein Feld, Modell oder Export des
Unterbaus ändert sich; `holiday-resolution.ts` bekam nur Kommentare). Owner-Entscheidung = die Kommentare auf Issue #70
vom 16.10.2026. Auslieferung nur gemeinsam mit #92 (v1.16.0).**

### Ausgangslage

ADR 0001 definiert die Zeiterfassung als „eine Zeile pro Mitarbeiter und Tag“. Durchgesetzt wurde das von einem
einzigen Datenbankobjekt, dem partiellen Unique-Index `TimeEntry_employeeId_date_unique_not_deleted`, und im Code von
`checkOneEntryPerDay`, drei Abbildungen von `P2002` auf 409, dem Stempel-Resolver (nur Wiedereröffnen am gebuchten Tag)
und der Konsolidierung. Wer vormittags in Salon A und nachmittags in Salon B arbeitet, konnte das nicht abbilden: Seit
#87 antwortete der Server auf einen ausdrücklich anderen Salon mit 409 `SALON_DIFFERS_FROM_DAY_ENTRY`. Und die
Fahrzeit zwischen zwei Salons (#92, rechtlich Arbeitszeit, BAG 12.12.2012 – 5 AZR 355/12) braucht einen eigenen Eintrag
zwischen den beiden.

### Entscheidung (Owner, 16.10.2026)

- **D-01 — Mehrere Einträge je Mitarbeiter und Tag, nie überlappend.** Der Index und `checkOneEntryPerDay` entfallen;
  an ihre Stelle tritt die Regel „keine zwei nicht gelöschten Einträge derselben Person überschneiden sich“. Der Salon
  hängt am Eintrag, nicht am Tag (#68).
- **D-02/D-03 — Stempeln und Konsolidierung.** Ein ausdrücklich anderer Salon beginnt einen neuen Eintrag; die
  Konsolidierung führt nie Einträge verschiedener Salons zusammen.
- **D-05 — Saldoneutral.** Die Migration schreibt und ändert keine Zeile; ein auf zwei Einträge geteilter Tag ergibt
  denselben Saldo wie ein einzelner.
- **D-07/D-12 — Oberfläche nur für Mandanten mit Salonauswahl** (Regel aus #64, `showSalonOptions`); Mandanten mit
  einem Salon sehen keine Änderung.
- **D-13 — Auslieferung nur gemeinsam mit #92.** Ohne erfassbare Fahrzeit wäre jeder Tag mit Salonwechsel ein
  Klärungsfall („Fahrzeit oder Pause?“, #80/#511).

### Durchsetzung — vier Ebenen

Gemessen im Probelauf (Spike S1/S2) und gewählt wurde **Weg A**, die Ausschlussbedingung. Sie besteht aus zwei von Hand
geschriebenen Migrationen (`20261016130000_time_entry_multi_entry_per_day` erzeugt, `20261016130001_time_entry_no_overlap`
von Hand):

1. **Ausschlussbedingung** `TimeEntry_no_overlap_closed` (`EXCLUDE USING gist ("employeeId" WITH =,
tstzrange("startTime","endTime",'[)') WITH &&) WHERE ("deletedAt" IS NULL AND "endTime" IS NOT NULL)`, Erweiterung
   `btree_gist`): zwei nicht gelöschte **abgeschlossene** Einträge einer Person überschneiden sich an keinem Datum
   (auch über Mitternacht); halboffen, direkt anschließende Einträge sind erlaubt, ein Eintrag der Länge null ist leer
   und kollidiert mit nichts. Offene Einträge stehen bewusst außerhalb: ein unbegrenzter Bereich ließe ein vergessenes
   Ausstempeln jeden Folgetag sperren (die Regression von v1.8.13).
2. **Partieller Unique-Index** `TimeEntry_employeeId_date_open_unique` (`WHERE "deletedAt" IS NULL AND "endTime" IS
NULL`): höchstens ein **offener** Eintrag je Person und Tag. Er erhält den Vertrag des Resolvers (ein gleichzeitiges
   zweites Einstempeln ist `ALREADY_CLOCKED_IN`). Dazu ein einfacher Index `TimeEntry_employeeId_date_idx`.
3. **Zeilensperre `lockEmployeeForEntryWrite`** (`contexts/time-tracking/entry-write-lock.ts`): die EINE Sperre der
   Mitarbeiterzeile (`FOR UPDATE`, mit Mandantenklausel) ist die erste Anweisung jeder Transaktion, die ein Intervall
   anlegt oder verschiebt — POST (drei Zweige), PUT, Revalidierung mit Korrektur, Stempel-Resolver, Freigabe eines
   Zeitnachtrags und CSV-Import. Sie schließt auch die Lücke offen-gegen-abgeschlossen, die die Bedingung nicht sieht.
4. **`checkOverlap` in derselben Transaktion** (`recheckOverlapInTx`, nach der Sperre): der Treffer wird mit dem Text
   des Aufrufers beantwortet (siehe Datenschutz), die Datenbank ist nur noch der Rückhalt.

Wie ein Datenbankfehler erkannt wird (strukturiert, nie über `err.message`): Überschneidung = Prisma-Code `P2039`,
`cause.originalCode` `23P01` und der Name `TimeEntry_no_overlap_closed` im Text des Treibers; zweiter offener Eintrag =
`P2002` mit `cause.constraint.index` `TimeEntry_employeeId_date_open_unique` (`entry-overlap-error.ts`).

**Ein vertauschter Eintrag (Ende vor Beginn) wird von der Datenbank abgelehnt (`P2039`, SQLSTATE `22000`, Bereichs-
konstruktor) und bewusst NICHT als Überschneidung gemeldet.** Kein Schreibweg kann ihn erzeugen, weil jeder vorab
Ende > Beginn verlangt; käme er trotzdem vor, soll er ein sichtbarer Serverfehler bleiben und nicht als gewöhnlicher 409
verschwinden.

### Stempelregeln

Die Entscheidung trifft der Resolver (`services/clock/resolver.ts`); welcher Eintrag eines Tages gemeint ist, bestimmen
ausschließlich `openEntryOf()` und `latestEndingClosed()` (`contexts/time-tracking/day-entries.ts`; Phase 92b ergänzt dort
das Überspringen von Fahrzeiteinträgen):

| Lage                                                            | Ergebnis                                                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Offener Eintrag am Tag, beliebiger Salon genannt                | `ALREADY_CLOCKED_IN` (kein Salon-Orakel)                                                              |
| Abgeschlossener Tag, kein Salon oder Salon des letzten Eintrags | der Eintrag mit dem spätesten Ende wird wieder geöffnet (wie bisher)                                  |
| Abgeschlossener Tag, ausdrücklich anderer, aktiver Salon        | **neuer Eintrag** in diesem Salon; der erste bleibt unverändert                                       |
| Fremder / unbekannter Salon                                     | identische 404, inaktiver Salon 400 `SALON_INACTIVE`                                                  |
| NFC / WLAN                                                      | nehmen keine Salonangabe entgegen: setzen den letzten Eintrag fort (Salonbindung des Terminals: #541) |

Vor **jedem** START prüft der Resolver Monatssperre und Überschneidung, bevor er etwas schreibt: ein Tag mit einem
gesperrten Eintrag oder ein Tag in einem abgeschlossenen Monat ergibt `MONTH_LOCKED` (auch bei einem anderen Salon);
ein Zeitpunkt innerhalb eines abgeschlossenen Eintrags — oder **vor einem späteren abgeschlossenen Eintrag desselben
Tages** — ergibt `ENTRY_OVERLAP` (409). Der zweite Fall folgt aus der Regel, dass ein offener Eintrag bis zum Ende
seines Tages „läuft“; die Lücke wird über das Formular erfasst. Ein Wiedereröffnen, dessen letzter Eintrag nach dem
Zeitpunkt endet, wird abgelehnt statt eine negative Pause zu schreiben. Auch das Ausstempeln kann an der Bedingung
scheitern und antwortet dann 409 `ENTRY_OVERLAP`; die WLAN-Pfade melden einen Konflikt nur im Log (nie 409/500).

### Revisionssicherheit

Der Monatsabschluss gilt je Eintrag und je Tag: Ein zweiter Eintrag in einem gesperrten Tag oder abgeschlossenen
Monat ist 403 (manuell) bzw. `MONTH_LOCKED` (Stempeln); ein gesperrter Eintrag bleibt unveränderbar. Keine Zeile wird
durch die Migration oder durch das Stempeln eines weiteren Eintrags geändert; jeder neue Eintrag hat genau eine
`CREATE`-Auditzeile (der CSV-Import schreibt sie jetzt in derselben Transaktion wie den Eintrag). Weiche Löschung
bleibt: ein gelöschter Eintrag gibt sein Intervall frei (auf Datenbankebene würde das Zurücksetzen von `deletedAt`
auf ein besetztes Intervall abgelehnt).

### Konsolidierung

`consolidateSameDayEntries` führt nie Einträge verschiedener Salons zusammen (`merge_skipped`, Grund
`different_salon`; das Ausstempeln selbst bleibt erhalten). Innerhalb eines Salons ist die Schreibreihenfolge
umgekehrt: erst den Nachfolger weich löschen, dann den Vorgänger verlängern — die Bedingung wird nach jeder Anweisung
geprüft, die alte Reihenfolge hätte jedes zulässige Zusammenführen als Überschneidung zurückgerollt.

### Tagesregeln

Die Kerne (`entryDurations()`, `evaluateDayBreaks()`, `evaluatePlacement()`, Saldo, DATEV, Berichte, Dashboard) rechneten
bereits tageweise über alle Einträge (#69/#79/#80/#511) und bleiben unverändert. Lücken zwischen Einträgen
verschiedener Salons zählen nie als Pause, Lücken im selben Salon schon (#523). Geändert wurden die Ränder:

- `findUnconfirmedBreakDays` führt jeden Tag einmal auf (die Variante je Eintrag bleibt).
- **§ 9 Abs. 1 Nr. 2 JArbSchG (Berufsschultag) vergleicht die Tagessumme.** Vor #70 war ein Tag gleich ein Eintrag; eine
  Aufteilung in zwei Einträge hätte die Grenze umgehen können. `otherWorkingMinutesOfDay()` wird in POST, PUT und der
  Freigabe eines Zeitnachtrags mit korrigierten Zeiten zur geplanten Netto-Arbeitszeit addiert (ohne weiteren Eintrag
  ist der Wert 0 — Einzeleintragstage unverändert). Diese Stelle stand nicht im Recherche-Inventar, sie wurde bei der
  Planung gefunden.
- **Ruhezeit (§ 5 ArbZG)** misst ab dem spätesten Ende des Vortags und bis zum frühesten Beginn des Folgetags.

### Feiertagsort

Bei mehreren Einträgen eines Tages ist der **Salon des Eintrags mit dem frühesten Beginn** der Arbeitsort des Tages
(§ 2 EFZG); der Feiertag wird einmal je Tag aufgelöst, nie je Eintrag. Das war in Eintrag O eine Übergangsregel
(`// MULTI-ENTRY:`) und ist jetzt **endgültig** (Owner-Entscheidung 16.10.2026). Nur Kommentare im Unterbau.

### Zeitnachtrag

Der Zeitnachtrag bleibt vorerst **ein Antrag je Mitarbeiter und Tag** (Owner-Entscheidung). Ein ausstehender Antrag
des heutigen Tages blockiert weiterhin das Stempeln (`RETRO_PENDING`). Die Freigabe mit korrigierten Zeiten sperrt die
Mitarbeiterzeile und prüft die Überschneidung in derselben Transaktion; bei einem Treffer bleibt der Antrag `PENDING`
und nichts wird geschrieben. Folge-Issue: #657 (Antrag je Eintrag).

### Oberfläche

Nur wo `showSalonOptions()` gilt (mehr als ein aktiver Salon im Mandanten UND mehr als einer erreichbar): Dashboard-
Karte („In anderem Salon einstempeln“, „Eingestempelt in {Salon}“, Tagessummen, „2 Einträge heute“ und die kompakte
Liste), Zeiterfassung und Team-Zeiterfassung (Feld „Salon“, Spalte „Salon“, „Weiteren Eintrag an diesem Tag“,
Kalenderzelle nach Zahl der Einträge). Die Salonoptionen des Formulars sind die erreichbaren Salons aus dem
Salon-Kontext (#82); die Auswahl im Kopf entscheidet nichts (Präsentation, kein Zugriffsrand). Mandanten mit einem
Salon und Tage mit einem Eintrag rendern wie zuvor (Einzelsalon-Basisbilder der Sichtprüfung unverändert).
`GET /time-entries` liefert zusätzlich `salonName` je Zeile (Anzeigewert, keine weitere Id).

### Datenschutz

Die Überschneidungsmeldung nennt Datum und Zeiten des Konfliktseintrags nur der Person selbst, einem Leser mit
`time-entry:read` für den ganzen Mandanten und einem Leser, dessen Bereich den Eintrag enthält
(`overlapMessageForCaller()`, die EINE Formulierungsregel; gleiche Bausteine wie `warningsVisibleToCaller()`, #85);
jeder andere bekommt „Überschneidung mit einem bestehenden Eintrag dieses Tages.“, das den Konflikt bestätigt und sonst nichts. Eine
Ablehnung durch die Datenbank trägt keinen Konfliktseintrag und ist immer neutral. Das Prüfskript nennt nur Ids und
Kalendertage.

### Gemessen

- **Probelauf vor dem Bau (16.10.2026):** `prisma migrate diff --from-migrations … --to-schema … --exit-code` gegen
  eine frische Schattendatenbank: Exit 0 („No difference detected“), die `--script`-Form ist leer — die CI-Driftprüfung
  trägt beide handgeschriebenen Objekte, der Trigger-Weg war nicht nötig. Fehlerformen (Prisma 7, Treiberadapter) wie
  oben, mit und ohne Transaktion; Mitternachtsfall erkannt, direkt anschließende Einträge, Länge null, gelöschter Eintrag
  und andere Person akzeptiert. Die gesamte Migrationskette läuft auf PostgreSQL 17.11 (`btree_gist` 1.7, wie prod) und
  18.3 (`btree_gist` 1.8, wie int und CI) mit identischem Katalog.
- **Abweichung vom Plan:** Prisma sieht partielle Indizes nicht; das Entfernen des `@@unique` erzeugt kein `DROP
INDEX`. Das `DROP INDEX` des alten Index steht daher von Hand als erste Anweisung der zweiten Migration.
- **Betriebsprobe (nur lesend, 16.10.2026):** `btree_gist` ist auf int (PostgreSQL 18.4) und prod (17.9) verfügbar; der
  Datenbanknutzer der Anwendung ist Eigentümer und Superuser; auf beiden Stufen gibt es keine überlappenden
  abgeschlossenen Einträge und je Person und Tag höchstens einen offenen. Das Prüfskript auf der Entwicklungsdatenbank:
  Exit 0.
- **Migration saldoneutral (AC-70-5):** `time-entry-multi-entry-migration-70` führt die echten Anweisungen beider
  Migrationen in einer zurückgerollten Transaktion über einen Altdatensatz (2 Mandanten × 2 Mitarbeiter × 8 Einträge,
  Nachtschicht, ungültiger und gelöschter Eintrag, laufender Eintrag, geschlossener Februar mit Schnappschuss) aus; sechs
  Hash-Gruppen vorher und nachher bytegleich, eine Kontrolländerung bewegt den Hash.
- **Teilung ergibt dieselben Zahlen (AC-70-3):** `multi-entry-saldo-equality-70` vergleicht einen Tag 08:00–17:00 mit
  zwei Einträgen 08:00–12:00 (Salon A) und 13:00–17:00 (Salon B) für `FIXED_SCHEDULE`, `SHIFT_BASED`,
  `MONTHLY_HOURS` und `FLEXTIME` über Monatssaldo, Livesaldo, Monatsabschluss samt gespeichertem Schnappschuss,
  Monatsbericht, PDF-Summe, DATEV, Zeitraumsumme und Dashboard: gleich bis auf die Identität. Der wörtliche Fall des
  Issues (4 h + 3 h) ergibt 420 Arbeitsminuten und hebt die Monats-Ist um genau diese Zahl.
- **Rennen:** zwei gleichzeitige überlappende POST → `[201, 409]`; zwei PUT auf dasselbe Intervall → eins gewinnt;
  ein START gegen einen gehaltenen manuellen Schreibvorgang wartet (`pg_blocking_pids` beobachtet) und endet mit
  `ENTRY_OVERLAP`; auf Datenbankebene wartet der zweite Schreiber und wird nach dem Commit abgelehnt. Mutationsproben:
  ohne Sperre und erneute Prüfung, ohne Monatssperre, ohne die Überschneidungsprüfung des START bzw. des Wiedereröffnens,
  ohne Salonwächter der Konsolidierung, ohne Bedingung (zurückgerollt) werden die jeweiligen Fälle rot.
- **Neutralität:** die drei Neutralitätstests (`permission-neutrality-matrix`, `notification-recipients-neutrality`,
  `activity-auth-neutrality`) bestehen mit 1752 Fällen und **0 geänderten Zellen**; nichts neu aufgezeichnet, kein
  Nachtragsregister berührt. Die eingefrorenen Tests (`golden-matrix`, `day-break-equivalence-80` samt Fixture,
  `saldo-neutrality-characterisation-79`, …) blieben unberührt grün.
- **Testbestand:** Ausgangswert vor Phase 70b 607 API-Dateien / 9716 Fälle / 3 übersprungen und 201 Web-Dateien /
  3150 Fälle; kein Test gelöscht, übersprungen oder abgeschwächt, jede bewusste Änderung eines Testes trägt einen
  datierten Kopfkommentar „Amended 2026-10-16 for #70“ bei gleicher oder höherer Fallzahl. Endstand: siehe
  `apps/api/scripts/check-test-completeness.mjs` (Untergrenzen angehoben).
- **Browser:** `apps/e2e/tests/multi-entry-day.spec.ts` (e2e-ci, zwei Tests): zwei Salons, 08:00–12:00 und 13:00–16:00,
  Liste mit Salonspalte, Zelle „2 Einträge“, überlappender dritter Eintrag mit 409 und Text, Einzelsalon-Mandant ohne
  neue Elemente. Sichtprüfung der Stempelkarte (12 Bilder) und der Zeiterfassungsseiten (16 Bilder), 390 und 360 px,
  hell und dunkel; dabei gefunden und behoben: ein falsches „§ 4 ArbZG verletzt“ auf Tagen mit zwei Einträgen, ein
  umbrechender Zähler und eine kontrastlose Schaltfläche im Dunkelmodus.

### Was bewusst NICHT geschah

- **Kein „Salon wechseln“ per Klick.** Der Wechsel ist ein neues Einstempeln im anderen Salon; die Lücke ist bis #92
  ein Klärungsfall.
- **Kein Salon je Eintrag in den PDFs.** Berichte und DATEV rechnen je Tag.
- **Die automatische Pause bleibt je Eintrag** (`placeAutoBreak`, #81); die Pause zwischen Salons ist weiter eine
  erfasste Tagespause (`DayBreak`) oder Quittung.
- **Kein Zeitnachtrag je Eintrag** (siehe oben), **keine Fahrzeit** (#92), **keine Salonbindung von NFC und WLAN** (#541).
- **Keine Neuberechnung und kein Backfill:** geschlossene Monate werden nie neu bewertet.
- **Entfallen sind** `checkOneEntryPerDay`, `SALON_DIFFERS_FROM_DAY_ENTRY`, das Bereinigungsskript
  `cleanup-time-entry-duplicates.ts` (es hätte rechtmäßige zweite Einträge weich gelöscht) und alle
  `// MULTI-ENTRY:`-Markierungen samt ihrer Tabelle im Wächtertest, der jetzt prüft, dass keine mehr vorkommt.

### Akzeptierte Restrisiken

- **Ein alter offener Eintrag, der später über einen neueren Eintrag hinweg geschlossen wird**, wird beim Ausstempeln
  abgelehnt (die Bedingung sieht dann den Überschnitt); die Korrektur ist eine Zeitkorrektur (`PUT`).
- **Ein CSV-Import desselben Tages mit anderen Zeiten legt einen zweiten Eintrag an** (es gibt keine Tageseindeutigkeit
  mehr); identische oder überlappende Zeilen werden je Zeile als Fehler gemeldet.
- **Salonoptionen des Formulars = erreichbare Salons**, während die Stempelkarte jeden aktiven Salon anbietet; der
  Server entscheidet in beiden Fällen (`resolveEntrySalon`).
- **Nur vorwärts:** Sobald ein Tag mit mehreren Einträgen existiert, kann der alte Unique-Index nie wieder angelegt
  werden (Rollback-Hinweis in `docs/migrations.md`).
- **Ein START zwischen zwei Einträgen eines Tages ist abgelehnt**, bis die Lücke erfasst ist (oben).
- **Die JArbSchG-Prüfung** läuft weiter nur in den drei manuellen Schreibwegen, nicht beim Stempeln (unverändert, #655).

### Auswirkung auf die Kontexte

- **Zeiterfassung:** Datenmodell (Ausschlussbedingung statt Eindeutigkeit je Tag), Stempeln, Konsolidierung, Erfassung,
  Import, Zeitnachtrag, Oberfläche.
- **Abwesenheiten:** keine.
- **Schichtplanung:** keine.
- **Arbeitszeitkonto:** keine Codeänderung; der Gleichheitstest belegt, dass `calcLeaveAbsenceMinutesTz()` und die
  Einmal-Regel („ein Tag mindert das Soll genau einmal“) unberührt bleiben.
- **Unterbau:** keine. Die Feiertagsauflösung bleibt „Salon des frühesten Eintrags“ (nur Kommentare).
- **Kompositionsschicht:** keine Regel.

### Auslieferung

Die beiden Migrationen laufen beim API-Start (`prisma migrate deploy`); **vorher** läuft das lesende Prüfskript
`apps/api/scripts/audit-70-entry-overlaps.ts` auf int UND prod (Exit 0 erwartet). Das Anlegen der Bedingung hält kurz
eine ACCESS EXCLUSIVE-Sperre auf `TimeEntry`: Deploy außerhalb der Öffnungszeiten. Anleitung, Prüfung nach dem Deploy
und Rollback-SQL: `docs/migrations.md`, Abschnitt „Phase 70b“. **#70 und #92 erscheinen im selben Release.**

### Nachweis

API: `time-entry-multi-entry-70`, `time-entry-overlap-message-70`, `time-entry-locked-day-70`, `clock-second-salon-70`,
`day-entries-selectors-70`, `retro-approve-overlap-70`, `imports-multi-entry-70`, `find-unconfirmed-break-days-70`,
`jarbschg-day-sum-70`, `time-entry-multi-entry-migration-70`, `time-entry-overlap-constraint-70`,
`multi-entry-saldo-equality-70`, `multi-entry-month-close-70`, `clock-salon-choice-70`,
`time-entry-list-salon-name-70` und `scripts/__tests__/audit-70-entry-overlaps.test.ts`; Web:
`clock-card-multi-entry-70`, `day-entry-actions`, `time-entries-multi-entry-wiring-70`; Playwright
`multi-entry-day.spec.ts`.

### Nachtrag 2026-10-16 (Phase 92b, Issue #92): Auswahlfunktionen überspringen Fahrzeit, Konsolidierung nie über eine Fahrt

Die Aussagen „keine Fahrzeit (#92)“ und „die Lücke ist bis #92 ein Klärungsfall“ (Was bewusst NICHT geschah) beschreiben
den Stand vor #92 und gelten nicht mehr (Eintrag AB). Für die Regeln dieses Eintrags folgt daraus:

- **`openEntryOf()` / `latestEndingClosed()`** (`contexts/time-tracking/day-entries.ts`) überspringen Zeilen der Art
  `TRAVEL`; `openEntryOf` bleibt unverändert, weil eine Fahrt nach der Bedingung `TimeEntry_travel_shape_check` nie offen
  ist. Die Web-Spiegelung `resolveDayState()` folgt einschließlich der Gleichstandsregel. Weil die Schreibregeln sicherstellen,
  dass nach einer Fahrt immer ein Eintrag im Zielsalon folgt, ist die Regel Verteidigung in der Tiefe.
- **Die Konsolidierung führt nie in oder über eine Fahrt hinweg zusammen** (`merge_skipped`, Grund `travel_row`, vor dem
  Salonwächter; das Ausstempeln selbst bleibt erhalten).
- Eine Fahrzeit ist eine abgeschlossene Zeile und fällt unter die Ausschlussbedingung `TimeEntry_no_overlap_closed` und
  die Zeilensperre `lockEmployeeForEntryWrite()`; ein START zwischen einer Fahrt und ihrem Zieleintrag wird von der
  Überschneidungsregel mit `ENTRY_OVERLAP` abgelehnt, ohne Zusatzcode.
- Der **Feiertagsort** (Salon des Eintrags mit dem frühesten Beginn) bleibt unberührt: eine Fahrt ist nie die früheste Zeile
  eines Tages.
- Der Zeitnachtrag bleibt ein Antrag je Tag; eine Fahrt ist als Zeitnachtrag nicht beantragbar (409
  `TRAVEL_NOT_AS_RETRO_REQUEST`, Hinweis am Folge-Issue #657).

## AB — Fahrzeit zwischen Salons als eigener Zeiteintrag (Phase 92b, Issue #92)

**Schwere: Neue Abhängigkeit auf den Unterbau (Fremdschlüssel `TimeEntry.travelToSalonId → Salon`), nach ADR 0002,
Entscheidung 7 eine Erweiterung: additiv, kein bestehender Leser muss sich ändern, genehmigt dadurch, dass Issue #92 mit
dem Abschnitt „Auswirkung auf die Kontexte“ auf `Ready` stand. Keine Semantikänderung des Unterbaus, kein Eingriff in
Kerne, Arbeitszeitkonto oder Kompositionsschicht. Owner-Entscheidung = die Kommentare auf Issue #92 vom 16.10.2026.
Auslieferung nur gemeinsam mit #70 (Eintrag AA, v1.16.0).**

### Ausgangslage

Seit #80/#511 rechnet der Tageskern eine nicht erfasste Lücke zwischen zwei Salons als Grenzfall: ganze Lücke
Arbeitszeit, freier Anteil am Anfang und am Ende der Lücke; ist nicht beides regelkonform oder beides verletzt, ist der
Befund `UNCLEAR` („Klärung nötig: Fahrzeit oder Pause?“). Mit #70 (Eintrag AA) gibt es Tage mit mehreren Einträgen in
verschiedenen Salons. Die Fahrt dazwischen ist Arbeitszeit, hatte aber keinen Ort, an dem sie erfasst werden konnte.

### Rechtslage

- **§ 2 Abs. 1 ArbZG; BAG 12.12.2012 – 5 AZR 355/12, Rn. 16** (<https://www.bundesarbeitsgericht.de/?p=1148442>):
  Wegezeiten für die Fahrt vom Betriebssitz zu einer auswärtigen Arbeitsstätte werden – anders als der Weg von der Wohnung
  zum Betrieb – arbeitszeitschutzrechtlich der Arbeitszeit zugerechnet; die Fahrt auf Weisung ist primär fremdnützig.
  Damit zählt die Fahrt zwischen zwei Salons für § 3 (Tageshöchstgrenze) und § 4 (Pausenschwellen) und ist selbst keine
  Ruhepause (BAG 25.02.2015 – 5 AZR 886/12, <https://www.bundesarbeitsgericht.de/?p=1150836>).
- **EuGH 10.09.2015 – C-266/14 (Tyco)** (<https://curia.europa.eu/jcms/upload/docs/application/pdf/2015-09/cp150099de.pdf>)
  wertet für Beschäftigte **ohne festen oder gewöhnlichen Arbeitsort** auch die erste und die letzte Fahrt als Arbeitszeit.
  **Nicht angewandt**, weil jede Person in Clokr genau einen wirksamen Stammsalon hat (`EmployeeSalonAssignment`).
  Restrisiko siehe unten.
- **EuGH 09.10.2025 – C-110/24** (<https://www.hensche.de/hin-und-rueckfahrt-zu-einsatzorten-als-arbeitszeit-eugh-urteil-vom-09.10.2025-c-110-24.html>,
  <https://www.lto.de/recht/hintergruende/h/eugh-c11024-reisezeit-arbeit-mitfahrer>) bestätigt die Richtung (vom
  Arbeitgeber vorgegebene Fahrt als Arbeitszeit, auch für Mitfahrer); gelesen über Zusammenfassungen, nicht im
  Volltext, und nicht Voraussetzung dieser Entscheidung.
- Der Weg Wohnung ↔ erster/letzter Salon bleibt Wegezeit und ist keine Arbeitszeit (Issue #92, „Nicht Teil davon“).

### Entscheidung (Owner, 16.10.2026)

- **D-05 — Ein eigener Zeiteintrag.** Eine Fahrzeit ist eine gewöhnliche, abgeschlossene `WORK`-Zeile mit
  `activityKind = TRAVEL` (neuer letzter Wert des Enums). `salonId` ist der **Abfahrtssalon**, das neue nullable Feld
  `TimeEntry.travelToSalonId` der **Zielsalon** (Fremdschlüssel auf `Salon`, `ON DELETE RESTRICT`, indiziert; auf `Salon`
  nur die Prisma-Gegenrelation `travelEntriesTo`, keine Spalte). Weil die Fahrzeit ein gewöhnlicher Eintrag ist, rechnen
  Saldo, § 3 und § 4 sie ohne zweite Berechnung mit (D-03). Die Art wird **serverseitig aus dem Ziel abgeleitet**, nie
  vom Client gesendet und nach dem Anlegen nicht änderbar.
- **D-06 — Ein Prüfer.** Eine Fahrzeit liegt zwischen zwei Einträgen desselben Tages, so ist der Weg von und nach Hause
  nicht erfassbar (AC-92-6).
- **D-07 — Getrennt auswertbar.** `GET /time-entries/summary` liefert `activityMinutes.TRAVEL`, dem Abfahrtssalon
  zugerechnet; die Auswertung steht hinter dem Modul „Auswertungen“ (`ANALYTICS`, #566), die **Erfassung nie**.
- **D-08 — Oberfläche minimal.** Nur für Mandanten mit Salonauswahl (#64) in Zeiterfassung und Team-Zeiterfassung;
  vom Mandantenschalter aus #529 ausgenommen, weil Erfassung Arbeitszeiterfassung ist und keine Auswertung.
- **D-09 — Zusammenspiel mit #80/#511** (nächster Abschnitt).

### Verworfen

- **Fahrzeit als Anteil innerhalb eines Eintrags** (`TimeEntryActivityShare`, Art `TRAVEL`): ein Anteil liegt innerhalb
  der erfassten Anwesenheit eines Eintrags und kann eine Fahrt in der **Lücke** zwischen zwei Einträgen nicht abbilden,
  die mit #70 der Normalfall ist.
- **Eigene Tabelle:** eine zweite Quelle von Arbeitszeit neben `TimeEntry`; jeder Leser (Saldo, Berichte, DATEV,
  Dashboard) müsste sie kennen und in der Tagessumme einmal zählen. Genau das verhindert der Gleichheitstest jetzt für
  den einen Eintrag.

### Durchsetzung

1. **`validateTravelEntry()`** (`contexts/time-tracking/travel-entry.ts`, die EINE Stelle der Schreibregel; läuft in der
   Schreibtransaktion nach `lockEmployeeForEntryWrite()` und der Überschneidungsprüfung): beide Salons gehören zum
   Mandanten (ein fremder oder unbekannter Salon ist die **identische** 404, ein inaktiver Zielsalon 400
   `SALON_INACTIVE`, Abfahrts- und Zielsalon verschieden), die **Reichweite des Aufrufers über alle Einträge des Tages**
   (`dayCoverage` „all“; die Person selbst braucht keine; ein nicht erreichbarer Tag antwortet mit dem eigenen
   Nicht-gefunden-Text der Route, kein 201/409-Orakel), die **Verankerung** (die Fahrt liegt nach einem Nicht-Fahrzeit-
   Eintrag im Abfahrtssalon und vor einem im Zielsalon, `TRAVEL_NOT_BETWEEN_SALON_ENTRIES`; eine noch nicht freigegebene
   Zeile eines Zeitnachtrags verankert nie) und keine Überschneidung mit einer erfassten Tagespause
   (`TRAVEL_OVERLAPS_DAY_BREAK`). Form: Ende gesetzt, keine Pause, keine Pausenzeilen, keine Tätigkeitsanteile
   (`TRAVEL_SHAPE`, `TRAVEL_KIND_DERIVED`, `TRAVEL_KIND_IMMUTABLE`, `TRAVEL_SAME_SALON`, `TRAVEL_SALONS_REQUIRED`).
2. **`checkTravelNeighbours()`**, die EINE Nachbarschaftsprüfung als **harte Sperre auf jedem Schreibweg**: POST (einfach,
   Freigabe-Zweig, Zeitnachtrag-Zweig), PUT (auch Datums- und Salonwechsel), DELETE, `POST /:id/breaks`,
   `PATCH /:id/break-status`, `PATCH /:id/revalidate` mit Korrektur, die Freigabe eines Zeitnachtrags und der CSV-Import.
   Kein Schreibvorgang darf eine Fahrt ohne ihre beiden Einträge zurücklassen (409 `TRAVEL_NEEDS_NEIGHBOUR`). Sie
   verweigert nur Fahrten, die der Schreibvorgang **neu** verwaist (Waisen danach minus Waisen davor), damit ein bereits
   inkonsistenter Tag keine unabhängige Korrektur blockiert.
3. **Prüfbedingung `TimeEntry_travel_shape_check`** (von Hand geschrieben, Prisma modelliert keine CHECK-Bedingung, die
   Driftprüfung bleibt leer; Vorbild `Tenant_salonQuota_positive`): Art `TRAVEL` genau dann, wenn ein Ziel gesetzt ist;
   Ziel ≠ Abfahrtssalon, `type = 'WORK'`, abgeschlossen, Ende nach Beginn, `breakMinutes = 0`. Sie ist der **Rückhalt der
   Form** für jeden Schreiber, auch einen künftigen, nicht die Schnittstelle (die Anwendung antwortet mit den deutschen
   Codes oben). Über die Empfehlung der Recherche hinaus gewählt, weil 70b handgeschriebene Bedingungen als Weg
   etabliert hat und der Owner-Auftrag die nachhaltigste Variante verlangt.
4. **Auswahlfunktionen:** `latestEndingClosed()` überspringt Fahrzeit (und die Web-Spiegelung `resolveDayState()`),
   die Konsolidierung führt nie in oder über eine Fahrt hinweg zusammen (`merge_skipped`, Grund `travel_row`). Das ist
   **Verteidigung in der Tiefe**: weil die Schreibregeln sicherstellen, dass nach einer Fahrt immer ein Eintrag im Zielsalon
   folgt, ist eine Fahrt nie die zuletzt endende Zeile; nur eine von Hand erzeugte verwaiste Fahrt (Test) erreicht den
   Überspringen-Zweig. Ein START zwischen Fahrt und Zieleintrag wird ohne Zusatzcode von der Überschneidungsregel
   abgelehnt (`ENTRY_OVERLAP`, belegt).

### Zusammenspiel mit #80/#511

- Eine **erfasste** Fahrzeit füllt die Lücke zwischen den Salons als gewöhnlicher Arbeitsblock. Der Kern bleibt
  unverändert (kein Eintrag im Nachtragsregister `day-break-equivalence-80-amendments.json`): Tagessumme 390 statt 360
  Minuten, Pflichtpause 30 Minuten statt 0, **keine Lücke mehr zu beurteilen, also kein `UNCLEAR`** (gemessen an echten
  Zeilen, Plan 92b-01). Ein Tag mit Fahrzeit und ohne Pause über 6 Stunden wird damit ein **eindeutiger** Befund
  (`BREAK_TOO_SHORT`); `MAX_DAILY_EXCEEDED` entsteht bei 630 Minuten (5 h + 30 Min + 5 h).
- Eine **nicht erfasste** Lücke bleibt die Klärungsfrage „Fahrzeit oder Pause?“ (Grenzfall-Rechnung). Das System erkennt
  eine Fahrt nicht selbst; ein Angebot „Lücke als Fahrzeit erfassen“ ist das Folge-Issue #660.
- **Das Erfassen, Ändern oder Löschen einer Fahrzeit ändert den Tagesstand.** Der Schnappschuss einer Quittung
  (`DayBreakAck`) enthält die Ids der Einträge und die Nettominuten des Tages (`DaySnapshot`, D-17 des Tageskerns). Eine
  schon erteilte Quittung für diesen Tag wird dadurch **veraltet** und muss neu erteilt werden; das ist der bestehende
  Mechanismus „eine veraltete Quittung entlastet nie“, keine neue Regel. Der Hinweis steht in `docs/user-guide.md`.

### Auswertung

`activityMinutes` hat vier Schlüssel (`UNSPECIFIED`, `PRODUCTIVE`, `SETUP_CLEANING`, `TRAVEL`), alle ganze Minuten, nie
Beträge, Quoten oder Anteile. Eine Fahrzeit ist ein **ganzer Eintrag** und nie ein Anteil (`ACTIVITY_SHARE_KINDS`
enthält `TRAVEL` nicht, ein Anteil der Art `TRAVEL` ist 400). Der Salonfilter rechnet die Fahrzeit dem Abfahrtssalon zu;
`entryCount` zählt Fahrten mit. Hinter dem Modul „Auswertungen“ liefert die Antwort ohne Buchung wie bisher `null` mit
`activityMinutesUnavailableReason: MODULE_NOT_BOOKED`; Erfassen, Ändern und Löschen sind nie vom Paket abhängig.
Betriebsrat: Minuten je Person und Art sind objektiv geeignet, Verhalten zu überwachen (§ 87 Abs. 1 Nr. 6 BetrVG);
Hinweis in `docs/compliance.md`, Abschnitt „Fahrzeit zwischen Salons“ – die Erfassung ist Pflicht, die Auswertung
mitbestimmungspflichtig.

### Oberfläche

Nur wo die #64-Regel `showSalonOptions()` gilt: Schalter „Fahrzeit zwischen Salons“ mit „Von Salon“ und „Nach Salon“
beim neuen Eintrag (ersetzt das Feld „Salon“, blendet Pausen- und Endzeit-Schalter aus), „Fahrzeit bearbeiten“ im
Bearbeiten-Dialog, Kennzeichen „Fahrzeit“ und die Strecke „Von → Nach“ in der Salonspalte, in der Salonansicht der
Führungskraft und in der Heute-Liste des Dashboards. Beide Seiten teilen eine reine Präsentationsdatei
(`travel-entry-form.ts`); die Web-Seite rechnet keine Regel. Eine Fahrzeit wird im Web nie als Zeitnachtrag-Antrag
gestellt (die Seite zeigt einen Text statt des Zeitnachtrag-Formulars). Mandanten mit einem Salon sehen keine Änderung
(Einzelsalon-Basisbilder unverändert).

### Gemessen

- **Migrationen** (Plan 92b-01): drei Verzeichnisse, additiv, die erzeugten Dateien byte-gleich der Ausgabe von
  `prisma migrate diff` gegen eine frische Schattendatenbank (Naming der bestehenden Relation erzeugt keinen SQL);
  Drift-Prüfung „No difference detected“, die `--script`-Form leer. Die gesamte Kette (59 Migrationen) läuft auf
  **PostgreSQL 17.11 und 18.3** mit identischem Katalog (Enum-Labels, Spalte, Fremdschlüssel `confdeltype r`, Index,
  Bedingung). `travel-migration-92.test.ts`: die Bedingung lehnt sieben falsche Formen ab (Fahrt ohne Ziel, Ziel an
  gewöhnlicher Zeile, Ziel = Abfahrtssalon, offene Fahrt, Pause 15 Min, Typ `OVERTIME`, Ende = Beginn), mit entfernter
  Bedingung (zurückgerollt) werden zwei davon angenommen; ein Altdatensatz (26 `TimeEntry`-Zeilen, 8 Fassadenlesungen
  für 4 Personen zweier Mandanten) ist nach den echten Anweisungen **byte-gleich** in allen Saldo-Eingaben (AC-92-8).
- **Sperrzeit** (Wegwerf-Datenbank, PostgreSQL 18.3, 1 000 000 Einträge, 16.10.2026): Enum-Wert 0,6 ms, Spalte 0,4 ms,
  Index 124 ms, Fremdschlüssel 49 ms, CHECK 59 ms (`docs/migrations.md`, „Phase 92b“).
- **Kernbelege an echten Zeilen** (`travel-entry-tracer-92.test.ts`, 17 Fälle): ohne Fahrt 360 Minuten/0 Pause, eine
  Lücke, `crossSalon`; mit der 30-Minuten-Fahrt **390/30**, keine Lücke, kein `UNCLEAR`; Livesaldo genau + 30;
  `GET /time-entries/summary` 360 → 390; 5 h + 5 h mit 30-Minuten-Fahrt → `MAX_DAILY_EXCEEDED` bei 630. Weg von Hause,
  nach Hause und über einen Eintrag im falschen Salon: je 409, nichts geschrieben.
- **Schreibwege** (Pläne 92b-02/03): Reichweite (Mutationsprobe: ohne Abdeckungsprüfung werden genau die zwei Fälle der
  Salonleitung rot), identische 404 (Bytevergleich fremd/unbekannt), Freigabe verbraucht (`USED`), Rennen
  Löschen/Anlegen mit genau einem Gewinner und leerer Waisenliste, Nachbarsperre in allen Wegen, Stempeln und
  Konsolidierung (Mutationsprobe des Überspringens: 5 Fälle rot), Feiertagsort (Fronleichnam: Fahrt von BY nach NI am
  Tag, kein Feiertag im umgekehrten Fall; die Fahrt ist nie die früheste Zeile, kein Unterbau-Commit).
- **Auswertung und Saldo** (Plan 92b-04): `activityMinutes.TRAVEL` unfiltert 30, Abfahrtssalon 30, Zielsalon 0,
  Grundversion `null`; **A/B-Gleichheit** `travel-saldo-equality-92.test.ts` (Zwillinge, neun Tage): Livesaldo,
  Monatssaldo offen und abgeschlossen, Monatsbericht, PDF-Nutzlast, DATEV, Zeitraumsumme, `checkArbZG` je Tag,
  Tagesprüfung, Dashboard, Monatsabschluss samt Schnappschuss – alles gleich; der einzige beabsichtigte Unterschied
  (`activityMinutes.TRAVEL` 270 = 9 × 30) ist ausdrücklich geprüft. Wächter `travel-saldo-isolation-92.test.ts`
  (AST, 6 Fälle; Geschwister des #81-Wächters): Lauf über `contexts/working-time-account` mit 31 gemessenen Dateien
  (Untergrenze 30), neun geschützte Dateien, Positiv- und Kontrolllauf, zwei Mutationsproben (Konto, Fassade) und
  eine Empfindlichkeitsprobe des Gleichheitstests (fünf von sechs Fällen rot). Die **Fassade** `facade/time-entries.ts`
  hat genau **einen** erlaubten Import aus `travel-entry` (`checkTravelNeighbours`, `TravelRefusalError` für den
  CSV-Import-Schreiber) und liest kein Fahrzeit-Feld.
- **Neutralität:** `permission-neutrality-matrix`, `notification-recipients-neutrality`, `activity-auth-neutrality`
  bestehen mit 1752 Fällen und **0 geänderten Zellen**; nichts neu aufgezeichnet, kein Nachtragsregister berührt.
  Eingefrorene Tests (`golden-matrix`, `day-break-equivalence-80`, `saldo-neutrality-characterisation-79`, …) blieben
  unberührt grün; kein Commit der Phase in den Kernen, dem Arbeitszeitkonto, der Kompositionsschicht oder dem Unterbau.
- **Bewusst angepasste Tests** (datierte Kopfkommentare „Amended 2026-10-16 for #92“, Fallzahl je Datei gleich):
  Formen von `activityMinutes` (nun vier Schlüssel) in acht Dateien, Schlüsselmenge der Listenzeile
  (`travelToSalonName`, `travelToSalonId: null`) in drei Dateien, die Fixture von `activity-81`; keine Aufzeichnung neu
  erstellt, keine Zusicherung gelockert.
- **Browser:** `apps/e2e/tests/travel-between-salons.spec.ts` (e2e-ci, zwei Tests): zwei Salons, 08:00–12:00 und 12:30–16:00,
  die Fahrt 12:00–12:30 wird erfasst (HTTP 201, drei Zeilen, genau ein Kennzeichen „Fahrzeit“, Strecke „Von → Nach“),
  dieselbe Fahrt von Hause (07:00–07:30) wird mit 409 und dem Text zum Weg von und nach Hause abgewiesen; Einzelsalon-
  Mandant ohne Schalter. Vier Läufe hintereinander grün (3,2–3,8 s), die gesamte e2e-ci-Auswahl 228 bestanden, 1
  übersprungen (bedingt, vorbestehend). Sichtprüfung des Formulars und der Liste mit Fahrt (8 Bilder, 390/360 px, hell
  und dunkel); dabei gefunden und behoben: ein Zeilenumbruch mitten im Wort der Strecke und ein zu enger Schalter.
- **Nicht im Browser belegt** (Server-Seite jeweils belegt): die Fahrt auf der Team-Seite (Verdrahtungstest und
  gemeinsame Präsentationsdatei), das Bearbeiten und das Löschen einer Fahrt, der Fall außerhalb der Erfassungsfrist.

### Was bewusst NICHT geschah

- **Kein Geld:** keine Kilometer-, Reisekosten- oder Spesenabrechnung; **keine Standorterkennung**; **keine Wegezeit**
  Wohnung ↔ Salon.
- **Kein Lücken-Angebot:** „Als Fahrzeit erfassen“ für eine nicht aufgelöste Lücke (D-08, nur Folge-Issue #660).
- **Keine Fahrzeit als Zeitnachtrag** (409 `TRAVEL_NOT_AS_RETRO_REQUEST`; solange ein Zeitnachtrag je Tag gilt, Folge-Issue
  #657). **Keine Fahrzeit per CSV-Import oder Stempelereignis.**
- **Berichte, PDFs, DATEV und Dashboard** zeigen die Fahrzeit als gewöhnliche Arbeitszeitzeile; es gibt weder eine eigene
  Spalte noch einen eigenen Bericht.
- **Keine Neuberechnung und kein Backfill:** die Migration schreibt keine Zeile, geschlossene Monate werden nie neu
  bewertet.
- **Keine Änderung der Reichweite gewöhnlicher Einträge** durch diese Phase: für die Fahrzeit gilt die Reichweite über
  den ganzen Tag, die des gewöhnlichen Eintrags regelt #658.

### Akzeptierte Restrisiken

- **Echte Springer ohne gewöhnlichen Arbeitsort** (Tyco): Wege von und zu Hause wären dort Arbeitszeit und werden nicht
  erfasst; die rechtliche Bewertung liegt beim Arbeitgeber, kein Modellwechsel.
- **Eine privat genutzte Lücke kann als Fahrzeit erfasst werden** (die Person trägt die Fahrt selbst ein; das System kann
  das nicht unterscheiden); die Korrektur ist Sache der Führungskraft (Korrektur mit Begründung, Audit), die
  Protokollierung lässt jede Fahrt nachvollziehen.
- **Ein 409 der Nachbarschaftssperre** (`TRAVEL_NEEDS_NEIGHBOUR`) verrät einer Salonleitung, dass an dem Eintrag eine
  Fahrzeit hängt (ohne Zeit und Salon); die ältere Überschneidungsmeldung aus #70 nennt wie bisher nur neutral, dass ein
  Eintrag existiert.
- **Der Name des Zielsalons** ist für jeden Leser der Zeile sichtbar (die Strecke ist der Inhalt der Zeile, die Zeile liegt
  in seiner Reichweite, ein Salonname ist Stammdatum des Mandanten; dasselbe Prinzip wie `salonName` in #70).
- **Ein Image vor diesem Release kann eine Zeile mit `TRAVEL` nicht lesen**; der Rückschritt ist daher vorwärts
  gerichtet, sobald die erste Fahrzeit existiert (`docs/migrations.md`, „Phase 92b“, Rollback).
- **Verteidigung in der Tiefe, nicht Schutz:** das Überspringen in `latestEndingClosed()` ist nur durch eine von Hand
  verwaist erzeugte Fahrt erreichbar; ohne die Schreibregeln hätte es Wirkung.

### Neue Shared-Kernel-Abhängigkeit

`TimeEntry.travelToSalonId → Salon` (Fremdschlüssel, `ON DELETE RESTRICT`, Mandantengleichheit durch die Anwendung wie bei
`salonId`, `Salon` wird nie hart gelöscht). Eine **Erweiterung** nach ADR 0002, Entscheidung 7: additiv; am Unterbau
ändert sich keine Spalte, kein Export von `contexts/platform/index.ts` und kein bestehender Leser (keine Änderung von
`holiday-resolution.ts`; eine Fahrt ist nie die früheste Zeile eines Tages). Genehmigt dadurch, dass Issue #92 mit dem
Abschnitt „Auswirkung auf die Kontexte“ auf `Ready` stand; ein Nachtrag zu Semantikänderungen entfällt.

### Auswirkung auf die Kontexte

- **Unterbau:** neue eingehende Beziehung `Salon` ← `TimeEntry.travelToSalonId` (Erweiterung, additiv).
- **Zeiterfassung:** neuer Wert `TRAVEL` der Tätigkeitsart, der Prüfer `validateTravelEntry` samt Nachbarsperre,
  Auswahlfunktionen, Konsolidierung, Auswertung in `GET /time-entries/summary`, Oberfläche.
- **Abwesenheiten:** keine.
- **Schichtplanung:** keine.
- **Arbeitszeitkonto:** keine Codeänderung. Eine Fahrzeit zählt als gewöhnlicher Arbeitseintrag; der Gleichheitstest
  belegt es, der Wächter hält die Felder heraus; `calcLeaveAbsenceMinutesTz()` und die Einmal-Regel („ein Tag mindert das
  Soll genau einmal“) bleiben unberührt.
- **Kompositionsschicht:** keine Regel.

### Auslieferung

**Gemeinsam mit #70** (v1.16.0, ein Pull-Request): die drei Migrationen laufen beim API-Start (`prisma migrate deploy`) im
selben Deploy wie die zwei Migrationen aus Eintrag AA. Vorher `audit-70-entry-overlaps.ts` auf int UND prod; Deploy
außerhalb der Öffnungszeiten; Prüfung nach dem Deploy und Rollback-Regel: `docs/migrations.md`, Abschnitt „Phase 92b“.
Ohne #92 wäre jeder Tag mit Salonwechsel aus #70 ein Klärungsfall.

### Nachweis

API: `travel-activity-kind-92`, `travel-entry-tracer-92`, `travel-migration-92`, `travel-entry-92`,
`time-entries-travel-92`, `time-entries-travel-lifecycle-92`, `travel-neighbour-writers-92`,
`travel-clock-selectors-92`, `time-entries-travel-list-92`, `time-entries-travel-summary-92`,
`travel-saldo-isolation-92`, `travel-saldo-equality-92`; Web: `travel-entry-form`, `today-entries-travel-92`,
`time-entries-travel-wiring-92`; Playwright `travel-between-salons.spec.ts`.
