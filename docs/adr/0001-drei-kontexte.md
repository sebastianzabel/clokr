# ADR 0001 — Drei fachliche Kontexte und ein gemeinsamer Unterbau

**Status:** akzeptiert
**Datum:** 2026-08-28
**Codestand der Belege:** `main` @ `263ed0aa`

Alle Datei- und Zeilenangaben in diesem Dokument beziehen sich auf diesen Commit. Sie sind Belege,
keine Wegbeschreibung — beim Nachprüfen in einem späteren Stand kann die Zeile verschoben sein, die
Aussage muss es nicht.

---

## Kontext

Clokr ist über mehrere Jahre als geschichteter Monolith gewachsen: `routes/`, `utils/`, `plugins/`,
`middleware/`, ein einziges Prisma-Schema mit 41 Modellen, ein zentrales Migrationsverzeichnis.
Fachliche Grenzen existieren im Schema nur als Kommentartrenner (`// ZEITERFASSUNG`, `// URLAUB`,
`// ABWESENHEITEN` in `packages/db/prisma/schema.prisma`).

Diese Struktur hat bisher getragen, weil es faktisch nur einen Fachbereich gab. Sie trägt nicht
weiter, sobald ein zweiter dazukommt: Ein Bereich, der Annahmen über alle anderen trifft, wird zum
starren Kern, an den alles Weitere außen angeklebt wird. Genau das soll hier nicht entstehen.

Die Analyse des Ist-Zustands (2026-08-27/28) hat gezeigt, dass die fachlichen Grenzen im Code
**bereits existieren** — sie sind nur nirgends benannt und deshalb nicht geschützt. Dieses ADR
benennt sie.

---

## Entscheidung

Clokr hat **drei fachliche Kontexte** und **einen gemeinsamen Unterbau**.

### 1. Zeiterfassung

Stempeln, Korrektur, Gültigkeitsprüfung, ArbZG-Prüfung. **Zeichnet auf, was war.**
Minutengenau, eine Zeile pro Mitarbeiter und Tag.

### 2. Abwesenheiten

Antrag, Genehmigung, Kontingent, Resturlaub. **Ein Workflow mit Status, kein Aufzeichnungsvorgang.**
Von–Bis-Zeiträume in Tagen.

### 3. Arbeitszeitkonto

Soll gegen Ist, Saldo, Monatsabschluss. **Liest aus beiden.** Besitzt die Regel, dass das Soll pro
Tag genau einmal reduziert wird.

### Unterbau

Mandant, Salon, Beschäftigung, Berechtigungen. Wird von allen dreien benutzt, **gehört keinem.**
Berechtigungen werden einmal zentral gelöst, nicht pro Kontext neu erfunden.

---

## Warum dieser Schnitt

Der Schnitt folgt den üblichen Kriterien für Kontextgrenzen: eigene Sprache, eigene Daten, eigene
Regeln. Alle drei sind hier nachweisbar erfüllt.

### Eigene Sprache

Es gibt heute **zwei Vokabulare für dieselben Sachverhalte**:

- `TYPE_CODES` — 9 Werte, `apps/api/src/routes/leave.ts:59-70`
- `AbsenceType` — 8 Werte, `packages/db/prisma/schema.prisma:1057`

Sechs davon überlappen (SICK, SICK_CHILD, SPECIAL/SPECIAL_LEAVE, UNPAID/UNPAID_LEAVE, MATERNITY,
PARENTAL) — **ohne jede Abbildung zwischen beiden.** Zwei Vokabulare für einen Sachverhalt sind das
klassische Anzeichen, dass zwei Kontexte in einem Modell stecken.

### Eigene Daten

|           | Zeiterfassung                                                 | Abwesenheiten                               |
| --------- | ------------------------------------------------------------- | ------------------------------------------- |
| Auflösung | minutengenau (`startTime`/`endTime` `Timestamptz`)            | Tage (`days Decimal(5,2)`)                  |
| Zeitraum  | ein Tag, `@@unique([employeeId, date])` (`schema.prisma:441`) | Von–Bis (`startDate`/`endDate` `@db.Date`)  |
| Modell    | `TimeEntry` (`schema.prisma:415`)                             | `LeaveRequest` (`:655`), `Absence` (`:789`) |

Diese Formate lassen sich nicht ineinander überführen, ohne dass eine Seite Information verliert.

### Eigene Regeln

Auf der Abwesenheitsseite: Genehmigung mit Status (`LeaveRequestStatus`, `schema.prisma:1031`),
Vier-Augen-Regel über `reviewedBy` (`leave.ts:858`), Selbstgenehmigungssperre (`leave.ts:840-848`),
Kontingentführung (`LeaveEntitlement`, `schema.prisma:613`).

Auf der Zeiterfassungsseite: Gültigkeitsprüfung (`isInvalid`/`invalidReason`), ArbZG-Prüfung
(`apps/api/src/utils/arbzg.ts`), Stempel-Konsolidierung (`apps/api/src/services/clock/`).

**Die beiden Regelwerke berühren sich fast nicht.** Keine Regel der einen Seite ist auf der anderen
sinnvoll formulierbar.

---

## Warum das Arbeitszeitkonto ein eigener Kontext ist

Das ist der Punkt, der am ehesten vergessen wird — und der Grund, warum dieses ADR nicht bei zwei
Kontexten stehen bleibt.

Zwei Stellen im Code sind **absichtlich** für beide Modelle gemeinsam:

- `calcLeaveAbsenceMinutesTz()` — `apps/api/src/utils/timezone.ts:452`. Eine Funktion berechnet die
  Soll-Reduktion für Urlaub **und** für Abwesenheiten. Sechs Aufrufstellen:
  `close-employee-month.ts:602, 635, 743, 761` und `shifts.ts:1390, 1412`.
- Die tagesbasierte Dedup-Menge `sbClaimed` — `apps/api/src/utils/close-employee-month.ts:613-639`.
  Sie merkt sich, welche Kalendertage bereits ein Soll-Guthaben beansprucht haben, über Urlaub und
  Abwesenheit **hinweg**.

Der naheliegende Reflex ist, das als Altlast zu lesen: zwei Module teilen sich eine Funktion, das
gehört aufgeräumt. **Dieser Reflex ist falsch.**

Was dort steht, ist eine fachliche Invariante:

> **Ein Tag darf das Soll genau einmal reduzieren** — egal ob über Urlaub, Berufsschule oder beides.

Wird sie verletzt, entsteht kein Anzeigefehler, sondern ein falsches Arbeitszeitkonto. Ein Tag, der
zweimal reduziert, erzeugt Überstunden, die es nicht gibt; ein Tag, der gar nicht reduziert,
Minusstunden, die der Mitarbeiter nicht verschuldet hat. Beides ist lohnrelevant und
revisionsrelevant.

Und hier kommt der Schluss, um den es geht:

> **Eine Invariante, die über zwei Modulgrenzen läuft, ist ein Zeichen dafür, dass die Grenze falsch
> liegt.**

Läge die Grenze richtig, gäbe es keine Regel, die beide Seiten kennen müssen. Da es sie gibt, ist
die Rechenschicht **kein geteilter Kern zwischen Zeiterfassung und Abwesenheiten**, sondern die
Fachlogik eines **dritten Kontexts**, der von beiden liest und die Einmal-Reduktion besitzt.

Das erklärt auch, warum die Rechenschicht in den vergangenen Milestones wiederholt der Ort war, an
dem Saldo-Fehler auftraten: Sie hatte fachliche Verantwortung, aber keinen Namen und keine Grenze.

### Konsequenz für künftige Sessions

**`calcLeaveAbsenceMinutesTz()` wird nicht zerschnitten.** Wer sie aufteilen will — etwa um
Zeiterfassung und Abwesenheiten „sauber zu trennen" — muss vorher beweisen, dass die
Einmal-Reduktion anders gesichert ist. Ohne diesen Beweis ist die Aufteilung abzulehnen, auch wenn
sie strukturell aufgeräumter aussieht.

---

## Abgrenzung: Abwesenheit ist kein Zeiteintrag mit anderem Typ

Das ist der naheliegende Fehler. Er fühlt sich elegant an, weil beides den Tag füllt — ein
Urlaubstag und ein Arbeitstag belegen denselben Platz im Kalender.

Er geht trotzdem nicht:

- Ein Zeiteintrag kennt **keinen Status „beantragt".** Genehmigungsprozesse lassen sich darauf nicht
  aufsetzen, ohne dem Zeiteintrag einen zweiten Lebenszyklus anzuhängen.
- Ein genehmigter Urlaub für nächsten August ist **kein erfasster Zeitraum.** Er ist eine Zusage
  über die Zukunft; ein Zeiteintrag ist eine Aufzeichnung über die Vergangenheit.

**`TimeEntryType` bleibt frei von Abwesenheitswerten.** Der Enum hat heute drei Werte — `WORK`,
`OVERTIME`, `PUBLIC_HOLIDAY` (`schema.prisma:996`) — und bekommt keine weiteren, die eine
Abwesenheit bezeichnen.

---

## Die Trennlinie zwischen den zwei Abwesenheitsmodellen

Dass es zwei Modelle gibt, steht heute nirgends begründet. Hier ist die Begründung:

|                        | `LeaveRequest`                  | `Absence`                              |
| ---------------------- | ------------------------------- | -------------------------------------- |
| Bedeutung              | **beantragte** Abwesenheit      | **gesetzte** Abwesenheit               |
| Charakter              | wird beantragt und genehmigt    | tritt ein, wird nicht beantragt        |
| Status                 | ja (`LeaveRequestStatus`)       | nein                                   |
| Kontingent             | ja (`LeaveEntitlement`)         | nein                                   |
| Genehmiger, Vier-Augen | ja                              | nein                                   |
| Beispiele              | Urlaub, Krankheit, Sonderurlaub | Berufsschule, Mutterschutz, Elternzeit |

Das ist **keine nachträgliche Rechtfertigung, sondern das, was der Code bereits tut:**
`apps/api/src/utils/leave-check.ts:33-46` liest aus `Absence` genau zwei Typen — `MATERNITY` und
`PARENTAL`. Genau die beiden, die eintreten statt beantragt zu werden.

Damit sind die sechs überlappenden Enum-Werte **kein Vokabular-Chaos, sondern zwei Wege zum selben
Sachverhalt** — je nachdem, ob er beantragt oder gesetzt ist. Und **`SICK` gehört eindeutig zu
`LeaveRequest`.**

---

## Integration zwischen den Kontexten

Kontexte kommunizieren über **fachliche Ereignisse**, nicht über direkte Aufrufe in fremde Interna.

Das Ereignis wird dort veröffentlicht, wo es passiert; wer darauf reagiert, entscheidet der
Empfänger. Beispiele: „Zeiteintrag geändert", „Abwesenheit genehmigt" — das Arbeitszeitkonto hört zu
und rechnet neu.

Der Grund ist nicht Technik, sondern Richtung: Ruft die Zeiterfassung das Arbeitszeitkonto direkt
auf, muss sie ihren Empfänger kennen. Dann ist die Kopplung nicht aufgelöst, sondern nur verschoben.

**Für den Anfang genügt ein einfacher In-Process-Dispatcher.** Keine Message-Queue, kein Broker,
solange alles in einem Prozess läuft. Der Wert liegt in der Entkopplung, nicht in der Infrastruktur.

---

## Allgemeine Regeln

1. **Ein Datenbankschema pro Kontext.**
2. **Keine Fremdschlüssel über Kontextgrenzen.** Ein Kontext referenziert fremde Entitäten über
   deren ID, ohne Constraint.
3. **Kein direkter Tabellenzugriff auf fremde Schemas.** Zugriff nur über die öffentliche
   Schnittstelle des besitzenden Kontexts.
4. **Migrationen liegen beim Kontext**, nicht zentral.
5. **Keine Verallgemeinerung auf Vorrat.** Kein Plugin-System, kein generischer
   Erweiterungsmechanismus, keine Abstraktionsschicht ohne konkreten zweiten Anwendungsfall.
   Erweiterbarkeit wird verallgemeinert, wenn der **vierte** Kontext gebaut wird — nicht vorher.
   Eine zu früh gebaute Verallgemeinerung wird selbst zum starren Kern.
6. **Kein Aggregat-, Repository- oder CQRS-Gerüst.** Diese Entscheidung betrifft **Grenzen**, nicht
   Bausteine innerhalb der Grenzen. Wie ein Kontext innen gebaut ist, bleibt offen.

Der Punkt an den Regeln 1–4: Die Grenze ist dann nicht Vorsatz, sondern **man merkt beim Übertreten,
dass man sie übertritt.**

---

## Konsequenzen

**Positiv**

- Die drei Kontexte haben Namen. Ein neues Feature lässt sich zuordnen, statt irgendwo zu landen.
- Die Einmal-Reduktion ist als Invariante benannt und damit gegen gutgemeinte Refactorings geschützt.
- Der Unterbau ist als eigene Ebene benannt — Berechtigungen werden einmal gelöst.
- Die zwei Abwesenheitsmodelle haben eine Begründung. Sie sind kein Versehen mehr.

**Negativ / einzupreisen**

- Der heutige Code erfüllt die Regeln 1–4 **nicht**. Es gibt ein Schema, ein Migrationsverzeichnis
  und Fremdschlüssel quer über alle Grenzen. Siehe `0001-abweichungen.md`.
- Regel 3 (kein direkter Fremdzugriff) kollidiert mit der Revisionssicherheits-Vorgabe in
  `CLAUDE.md`, dass kritische Relationen `onDelete: Restrict` tragen. Ein Fremdschlüssel ist dort
  eine **Compliance-Kontrolle**, keine Modellierungsentscheidung. Das ist offen — siehe unten.
- Ereignis-Integration existiert heute nicht. Es gibt keinen Dispatcher, keinen Emitter, keine Hooks.
- Der Umbau ist nicht Teil dieser Entscheidung. Dieses ADR sagt, wohin — nicht wann.

---

## Offene Fragen

Diese Punkte sind **nicht** entschieden und werden hier bewusst nicht beantwortet:

1. **Fremdschlüssel als Compliance-Kontrolle.** `CLAUDE.md` schreibt für
   `Employee → TimeEntry/LeaveRequest/Absence` ausdrücklich `onDelete: Restrict` vor, um stille
   Kaskadenlöschung zu verhindern. Regel 2 dieses ADR verlangt, genau solche Fremdschlüssel über
   Kontextgrenzen aufzugeben. Damit wandert eine Garantie aus der Datenbank in Anwendungscode — und
   ein Betriebsprüfer bewertet beides unterschiedlich. Wie dieser Konflikt aufzulösen ist, ist offen.
2. **Wo genau verläuft die Grenze zwischen Zeiterfassung und Arbeitszeitkonto?** Dass das
   Arbeitszeitkonto ein eigener Kontext ist, ist entschieden. Welche der 57 Dateien in
   `apps/api/src/utils/` zu welchem Kontext gehören, ist es nicht.
3. **Gehört `Absence` als generisches Modell weitergebaut, oder ist es faktisch die
   Berufsschul-Tabelle?** `schema.prisma:730-740` nennt die Bereinigung „a separate, deferred
   phase", sagt aber nicht, in welche Richtung.

---

## Status

**Akzeptiert** am 2026-08-28.

Diese Entscheidung beschreibt ein **Zielbild**. Sie ist nicht der Bericht über einen erreichten
Zustand. Der Abstand zwischen beidem steht in `0001-abweichungen.md` und ist dort bewusst
ungeschönt festgehalten.
