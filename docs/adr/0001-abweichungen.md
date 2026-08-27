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

| Stelle                                                | Was passiert                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/api/src/routes/leave.ts:884`                    | `updateMany` auf `TimeEntry` **selektiert** über `invalidReason: "Urlaubsstornierung ausstehend"` |
| `apps/api/src/routes/leave.ts:1787`                   | dasselbe, zweiter Pfad                                                                            |
| `apps/api/src/routes/time-entries.ts:1735`            | `existing.invalidReason === "Ausstempeln fehlt"` **steuert Verhalten**                            |
| `apps/api/src/routes/time-entries.ts:1244, 1322`      | schreiben `"Urlaubsstornierung ausstehend"`                                                       |
| `apps/api/src/services/clock/resolver.ts:91`          | schreibt `"Urlaubsstornierung ausstehend"`                                                        |
| `apps/api/src/plugins/attendance-checker.ts:303, 314` | schreiben `"Ausstempeln fehlt"`                                                                   |

**Korrektur gegenüber dem Voranalyse-Bericht vom 2026-08-27:** Dort waren drei Stellen genannt. Es
sind **sieben**. `resolver.ts` und `attendance-checker.ts` waren nicht erfasst — der Befund ist also
breiter, nicht schmaler.

### A.2 Typidentität über den Anzeigenamen

`LeaveType` ist eine **mandantenbezogene Tabelle**; die Zuordnung zu den hartkodierten `TYPE_CODES`
(`leave.ts:59-70`) läuft über einen **Namensvergleich**:

- `leave.ts:101` — `findFirst({ where: { tenantId, name: def.name } })`
- `leave.ts:108` — Umbenennen alter Seed-Namen über `LEGACY_ALIASES` (`leave.ts:88`)
- `leave.ts:759, 803, 2071, 2273, 2340` — `TYPE_CODES.find((c) => LEAVE_TYPE_DEFS[c].name === r.leaveType.name)`

Fünf Vergleichsstellen, nicht eine. Ein Mandant, der „Urlaub" umbenennt, verliert die Typzuordnung
— aufgefangen nur durch die Alias-Liste, die jede künftige Umbenennung mitpflegen müsste.

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

| Leser                                                | Verhalten bei `Absence.SICK`                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `apps/api/src/utils/leave-check.ts:39`               | **ignoriert** sie — liest aus `Absence` nur `MATERNITY` und `PARENTAL`                     |
| `apps/api/src/utils/close-employee-month.ts:613-639` | **kreditiert** sie — der Kommentar sagt ausdrücklich „ALL absence types are credited here" |

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

| #   | Punkt                                                | Schwere     | Zeitpunkt                          |
| --- | ---------------------------------------------------- | ----------- | ---------------------------------- |
| A   | Anzeigetexte als Steuerwerte (7 + 5 Stellen)         | hoch        | **vor** dem Kettenumbau            |
| E   | Kontingentbuchung rechnet selbst, jahresübergreifend | mittel–hoch | vor dem Kettenumbau prüfen         |
| C   | Kein Beschäftigungsobjekt                            | mittel      | **im** Kettenumbau                 |
| B   | `Absence.SICK` nur im Demo-Seed, zwei Leser          | mittel      | vor der nächsten Saldo-Fehlersuche |
| D   | Ungenutzte `TimeEntryType`-Werte                     | niedrig     | danach oder nie                    |

Punkt A ist nicht zufällig oben: Er ist die Voraussetzung dafür, dass irgendeine der ADR-Regeln
überhaupt überprüfbar wird.
