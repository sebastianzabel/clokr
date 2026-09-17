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
