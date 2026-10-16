# Compliance & Rechtliche Grundlagen

Clokr ist als **revisionssichere** Zeiterfassung für den deutschen Rechtsraum konzipiert. Diese Seite dokumentiert alle implementierten gesetzlichen Prüfungen und Aufbewahrungsregeln.

> **Status:** Stand v1.9 (aktuell 1.9.2, 2026-08-03). Geprüft gegen den Code unter `apps/api/src/contexts/time-tracking/arbzg.ts`, `apps/api/src/contexts/absence/vacation-calc.ts`, `apps/api/src/composition/data-retention.ts`.

---

## § 3 / § 4 / § 5 ArbZG — Arbeitszeitprüfungen

Implementiert in [`apps/api/src/contexts/time-tracking/arbzg.ts`](../apps/api/src/contexts/time-tracking/arbzg.ts). Wird automatisch nach jedem TimeEntry-Insert/Update ausgeführt und liefert Warnungen an die UI zurück. Warnungen **blockieren das Speichern nicht** (Audit-Hinweis statt Hard-Block, damit Korrektur-Workflows möglich bleiben).

### Regelwerk

| Paragraph                                  | Regel                                                                                                                                                                 | Implementierung                                                                                                           | Severity                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **§ 3 ArbZG**                              | Tägliche Höchstarbeitszeit netto **10h absolut**                                                                                                                      | `if (netWorkedMin > 10 * 60)` → `MAX_DAILY_EXCEEDED`                                                                      | `error`                     |
| **§ 3 ArbZG**                              | 8h-Regel = 24-Wochen-/6-Monats-Durchschnitt, **kein** Tageslimit                                                                                                      | Keine Tageswarnung für 8–10h Tage — nur als Rolling-Average prüfen                                                        | `warning` (avg)             |
| **§ 3 ArbZG**                              | Wöchentliche Höchstarbeitszeit **48h** (Mo–Sa = 6 Werktage)                                                                                                           | `if (weekMin > 48 * 60)` → `MAX_WEEKLY_EXCEEDED`                                                                          | `error`                     |
| **§ 4 ArbZG**                              | Bei **>6h** Arbeit: min. **30min Pause**                                                                                                                              | `if (netWorked > 6h && totalBreak < 30)` → `BREAK_TOO_SHORT`                                                              | `warning`                   |
| **§ 4 ArbZG**                              | Bei **>9h** Arbeit: min. **45min Pause**                                                                                                                              | `if (netWorked > 9h && totalBreak < 45)` → `BREAK_TOO_SHORT`                                                              | `error`                     |
| **§ 5 ArbZG**                              | **11h Mindestruhe** zwischen Arbeitsende und nächstem Beginn                                                                                                          | Prüfung gegen Vortag UND Folgetag                                                                                         | `warning`                   |
| **§ 4 S. 2 ArbZG**                         | Ein Pausenabschnitt unter **15 Min** zählt nicht als Ruhepause (ebenso nicht am ersten Beginn oder letzten Ende des Arbeitstags)                                      | `evaluatePlacement()` → `BREAK_SEGMENT_TOO_SHORT`                                                                         | `warning`                   |
| **§ 4 S. 3 ArbZG**                         | Höchstens **6h am Stück** ohne Ruhepause von mind. 15 Min — auch wenn die Summe nach Satz 1 erreicht ist                                                              | `evaluatePlacement()` → `BREAK_TOO_LATE`                                                                                  | `warning`                   |
| **§ 11 JArbSchG** (über § 18 Abs. 2 ArbZG) | Unter 18 am Arbeitstag: **30 Min** ab 4,5h, **60 Min** ab 6h, Abschnitte mind. 15 Min, höchstens **4,5h am Stück**, keine Ruhepause in der ersten oder letzten Stunde | `BREAK_REGIMES.JARBSCHG_11` → `BREAK_TOO_SHORT`, `BREAK_SEGMENT_TOO_SHORT`, `BREAK_TOO_LATE`, `BREAK_OUTSIDE_WINDOW`      | `warning` (60 Min: `error`) |
| Hinweis                                    | Pause nur als Summe gespeichert (`breakMinutes` ohne Pausenzeilen): Lage unbekannt                                                                                    | `BREAK_POSITION_UNKNOWN` — nie ein Verstoß, nie ein Kalendermarker, nie eine Mitteilung, sperrt den Monatsabschluss nicht | Hinweis                     |

### Pausenzählung (`totalBreakMin`)

Eine Pause ist die Summe aus:

1. **Explizite Pausen:** `breakMinutes` jedes TimeEntry-Slots
2. **Implizite Gaps:** Lücken zwischen aufeinanderfolgenden Slots am selben Tag
   - Gap **> 0 und ≤ 2h** → zählt als Pause
   - Gap **> 2h** → gilt als separate Schicht, NICHT als Pause
3. **Abschnittsregel (§ 4 Satz 2, seit Phase 511):** Für die Lage-Prüfung zählt ein Pausenabschnitt nur, wenn er mindestens **15 Min** lang ist, im Arbeitszeitraum des Tages liegt und weder den ersten Beginn noch das letzte Ende berührt (Jugendliche: zusätzlich nicht in der ersten oder letzten Stunde). Aneinandergrenzende Abschnitte gelten als eine Ruhepause. Ein nicht zählender Abschnitt bleibt Arbeitszeit für die Compliance-Zahl; der Saldo ändert sich nicht.
4. **Lücken zwischen Einträgen:** Im selben Salon zählt eine Lücke immer, gleich wie lang (Issue #523: die frühere Grenze von 120 Min ist entfallen, eine Ruhepause hat nach § 4 ArbZG keine Höchstdauer). Zwischen **verschiedenen Salons** zählt eine Lücke nie als Pause (Fahrzeit ist Arbeitszeit), es sei denn, die freie Zeit ist als Tagespause erfasst. Weil das System die Aufteilung in Fahrzeit und freie Zeit nicht kennt, rechnet es zwei Grenzfälle: ganze Lücke Arbeitszeit, freier Anteil am Anfang und am Ende der Lücke. Beide regelkonform → konform; beide verletzt → Verstoß; sonst Befund mit Sicherheit `UNCLEAR` („Klärung nötig: Fahrzeit oder Pause?“). Aufgelöst wird durch eine erfasste Tagespause, eine erfasste Fahrzeit oder eine Quittung der Führungskraft. Ist die Fahrt zwischen den beiden Salons als eigener Eintrag erfasst (Issue #92, Abschnitt „Fahrzeit zwischen Salons“), ist die Lücke Arbeitszeit und kein Grenzfall mehr: es gibt dann keine Lücke zu beurteilen, die Frage „Fahrzeit oder Pause?“ entfällt für diese Lücke, und die Tagessumme enthält die Fahrt.

### Auto-Break (opt-in pro Tenant)

Wenn `TenantConfig.autoBreakEnabled = true` und beim Clock-out (oder beim manuellen Anlegen) **keine Pause eingetragen** wurde, setzt Clokr automatisch:

- `30min` bei >6h Arbeit
- `45min` bei >9h Arbeit
- **Jugendliche (unter 18 am Arbeitstag):** mindestens die Menge nach § 11 JArbSchG — `30min` ab 4,5h, `60min` ab 6h; größer als die konfigurierte Menge wird sie angehoben, kleiner nie. Die Pause greift für Jugendliche schon ab 4,5h Anwesenheit und wirkt auf den Saldo nur bei künftigen automatischen Pausen.

**Lage (seit Phase 511):** Die Pause wird in **Mandantenzeit** gesetzt und ist konform zu § 4 Satz 2/3 ArbZG (bzw. § 11 JArbSchG): jedes Teilstück mindestens 15 Min, kein Arbeitsblock über 6h (Jugendliche 4,5h), keine Pause am Anfang oder Ende (Jugendliche: nicht in der ersten oder letzten Stunde). Gewählt wird die konforme Lage, die der konfigurierten `TenantConfig.defaultBreakStart` am nächsten liegt, sonst die Mitte des Eintrags. Bei sehr langen Tagen entstehen mehrere Teilstücke gleicher Gesamtminutenzahl. Die Minutenzahl (und damit der Saldo) bleibt für Erwachsene unverändert. Vor Phase 511 wurde `defaultBreakStart` als Serverzeit (im Container UTC) gelesen — ein Berliner Mandant mit „12:00“ bekam die Pause im Sommer um 14:00.

Sobald MA bereits eine Pause eingegeben hat (z.B. nur 15min), greift Auto-Break NICHT — nur die ArbZG-Warnung erscheint. Das Erfassungsformular zeigt in der Vorschau „mit automatischer Pause“, wenn die Speicherung eine Pause setzen wird.

### Bekanntes Edge-Case-Verhalten

**Bei eingetragener kürzerer Pause als gesetzlich vorgeschrieben:** ERROR-Warnung erscheint im Eintrag, aber Speichern wird zugelassen. Begründung: Korrektur-Workflow für Manager (z.B. Notfall, falsche Slot-Zeit) darf nicht hart blockiert werden. Der Verstoß ist im AuditLog dokumentiert und kann via Reports nachvollzogen werden.

### Bekannte Grenzen der Pausenprüfung

- **„Im Voraus feststehend“ (§ 4 Satz 1):** Die Pausen müssen im Voraus feststehen. Das lässt sich aus Zeitstempeln nicht prüfen; ein erfasstes, abgeschlossenes Pausensegment gilt als Ruhepause.
- **Ältere Einträge ohne Pausenlage:** Nur als Summe gespeicherte Pausen erzeugen den Hinweis `BREAK_POSITION_UNKNOWN`, nie einen Verstoß. Vor dem Einschalten von `blockMonthCloseOnUnconfirmedBreak` den Probelauf `audit-511-break-placement.ts` lesen.
- **Fahrzeit zwischen Salons:** wird seit Issue #92 als eigener Eintrag erfasst (Abschnitt „Fahrzeit zwischen Salons“). Eine Lücke zwischen zwei Salons, für die keine Fahrzeit erfasst ist, bleibt die Grenzfall-Rechnung (`UNCLEAR`); das System erkennt eine Fahrt nicht selbst.
- **Jugendliche:** § 8 JArbSchG (Tages- und Wochenhöchstzeit) wird nicht geprüft (Issue #524). Fehlt das Geburtsdatum, gilt § 4 ArbZG; bei Auszubildenden weist der Befund darauf hin.
- **Geschlossene Monate** werden nie neu bewertet.
- **Tätigkeitsart (#81):** Die Tätigkeitsart ändert keine Arbeitszeit-, Pausen- oder Ruhezeitprüfung. Ein Fahrzeiteintrag (#92) zählt wie jeder Eintrag voll als Arbeitszeit; die Art „Fahrzeit“ selbst verändert auch hier keine Prüfung.
- **Rechtsgrund im Befund:** Der Verweis auf § 11 JArbSchG im Befundtext lässt auf Minderjährigkeit schließen; Geburtsdatum und Alter werden nie ausgegeben.

---

## Tätigkeitsart am Zeiteintrag (Issue #81) — Auswertungsdimension

Ein Zeiteintrag trägt eine Tätigkeitsart (`nicht angegeben`, `Produktive Zeit am Kunden`, `Rüst-, Reinigungs- und Vorbereitungszeit`) und optional Minutenanteile je Art. Die Unterscheidung ist eine reine Auswertungsdimension, keine Bewertung.

### Arbeitszeit

- Rüst-, Umkleide- und Reinigungszeit ist **vergütungspflichtige Arbeitszeit**: BAG 19.09.2012 – 5 AZR 678/11, BAG 26.10.2016 – 5 AZR 168/16, BAG 10.11.2009 – 1 ABR 54/08. Dass sie für § 3 / § 4 / § 5 ArbZG voll zählt, folgt aus § 2 Abs. 1 ArbZG (Arbeitszeit = Zeit vom Beginn bis zum Ende der Arbeit ohne Ruhepausen).
- Saldo, Monatsabschluss, Berichte und die Prüfungen nach § 3 / § 4 / § 5 ArbZG lesen die Tätigkeitsart **nie**. Abgesichert durch einen Quelltext-Wächter (`activity-kind-saldo-isolation-81.test.ts`) und einen Vorher-Nachher-Vergleich aller Kennzahlen samt Monatsabschluss (`activity-kind-saldo-equality-81.test.ts`).
- Bestandsdaten bekommen den Vorgabewert „nicht angegeben“; kein Datensatz wird umgeschrieben, kein Saldo ändert sich.

### Mitbestimmung

- Minuten produktiver Zeit je Person sind **objektiv geeignet**, Leistung oder Verhalten zu überwachen; nach § 87 Abs. 1 Nr. 6 BetrVG kommt es auf diese Eignung an, nicht auf die Absicht (BAG 08.03.2022 – 1 ABR 20/21).
- Die Tätigkeitsart gehört nicht zur gesetzlichen Pflicht der Arbeitszeiterfassung (zu dieser Pflicht BAG 13.09.2022 – 1 ABR 22/21); sie ist eine freiwillige Erweiterung.
- Ein Mandant mit Betriebsrat beteiligt diesen, **bevor** Erfassung oder Auswertung der Tätigkeitsart genutzt wird.

### Datenschutz

- Rechtsgrundlage ist Art. 6 Abs. 1 lit. b bzw. f DSGVO unmittelbar; § 26 Abs. 1 S. 1 BDSG bleibt unangewendet (EuGH 30.03.2023 – C-34/21; BAG 08.05.2025 – 8 AZR 209/21).
- Die Beschäftigten sind nach **Art. 13 DSGVO** über Zweck und Umfang zu informieren (Zweck: Auswertungsdimension, keine Leistungsbewertung).
- Datenminimierung und datenschutzfreundliche Voreinstellungen (Art. 5 Abs. 1 lit. c, Art. 25 DSGVO): Vorgabe „nicht angegeben“; erfasst wird nur, was ein Client ausdrücklich sendet; die Auswertung liefert nur Minuten, keine Quoten, Beträge oder Ranglisten; es gelten dieselben Leserechte wie für die Zeiteinträge selbst.
- Ob eine Datenschutz-Folgenabschätzung (Art. 35 DSGVO) nötig ist, beurteilt der Mandant als Verantwortlicher. Personenbezogene Ranglisten, die jemand aus den Daten bildet, sind eine Verarbeitung des Mandanten.
- Kein Freitext — bei der Anonymisierung (Art. 17) ist nichts zu tun; die Anteile werden wie der Eintrag aufbewahrt.

### Mandantenschalter

Diese Version hat keine Oberfläche für die Tätigkeitsart. Erfassung und Auswertung in der Oberfläche kommen mit einem Schalter je Mandant, Vorgabe **aus**, samt Hinweis auf Betriebsrat und Art. 13 DSGVO: Issue #529. Die einzige Oberfläche in dieser Version ist die Erfassung einer Fahrzeit zwischen zwei Salons (nächster Abschnitt); sie ist vom Schalter ausgenommen.

---

## Fahrzeit zwischen Salons (Issue #92)

### Rechtsgrund

- Die Fahrt zwischen zwei Arbeitsstätten während des Arbeitstags, auf Weisung des Arbeitgebers, ist **Arbeitszeit** nach § 2 Abs. 1 ArbZG; sie zählt für die Tageshöchstgrenze (§ 3) und für die Pausenschwellen (§ 4). BAG 12.12.2012 – 5 AZR 355/12, Rn. 16: Wegezeiten für die Fahrt vom Betriebssitz zu einer auswärtigen Arbeitsstätte werden – anders als der Weg von der Wohnung zum Betrieb – arbeitszeitschutzrechtlich der Arbeitszeit zugerechnet. Eine Ruhepause ist die Fahrt nicht (BAG 25.02.2015 – 5 AZR 886/12).
- EuGH 09.10.2025 – C-110/24 bestätigt die Richtung (vom Arbeitgeber vorgegebene gemeinsame Fahrt zum Einsatzort ist Arbeitszeit, auch für Mitfahrer).
- EuGH 10.09.2015 – C-266/14 (Tyco) wertet für Beschäftigte **ohne festen oder gewöhnlichen Arbeitsort** auch die erste und die letzte Fahrt des Tages als Arbeitszeit. Das wird hier **nicht angewandt**, weil jede Person einen Stammsalon hat. Restrisiko: ein Mandant mit echten Springern ohne gewöhnlichen Arbeitsort muss die Wege von und zu Hause selbst bewerten; Clokr erfasst sie nicht.

### Regel

- Erfasst wird eine Fahrzeit **nur zwischen zwei Einträgen desselben Tages**: nach einem Eintrag im Abfahrtssalon und vor einem Eintrag im Zielsalon. Der Weg von zu Hause zum ersten Salon und vom letzten Salon nach Hause ist keine Arbeitszeit und lässt sich nicht erfassen (die Eingabe wird mit einer Fehlermeldung abgelehnt).
- Die Fahrzeit ist ein gewöhnlicher abgeschlossener Arbeitseintrag mit Abfahrts- und Zielsalon, ohne Pause. Saldo, Monatsabschluss, Berichte, DATEV sowie die Prüfungen nach § 3 / § 4 / § 5 ArbZG rechnen sie wie jeden Eintrag mit, ohne zweite Berechnung; ein Gleichheitstest belegt das (`travel-saldo-equality-92.test.ts`), ein Quelltext-Wächter hält die Fahrzeit-Felder aus Saldo und Kernen heraus (`travel-saldo-isolation-92.test.ts`).
- Revisionssicherheit, Monatssperre, Aufbewahrung und Anonymisierung gelten wie für jeden Zeiteintrag: Erfassen, Ändern und Löschen sind protokolliert; ein gesperrter Eintrag bleibt unveränderbar. Eine Fahrzeit lässt sich nicht als Zeitnachtrag beantragen (der Antrag würde einen gewöhnlichen Eintrag anlegen); außerhalb der Erfassungsfrist ist sie nur mit einer erteilten Freigabe der Führungskraft erfassbar.
- Wer den Eintrag vor oder nach der Fahrzeit löscht oder verschiebt, so dass die Fahrzeit nicht mehr zwischen zwei Salon-Einträgen liegt, wird mit 409 abgewiesen; erst die Fahrzeit löschen, dann den Eintrag.
- Erfassen, Ändern oder Löschen einer Fahrzeit ändert den Tagesstand der Pausenprüfung. Eine schon erteilte Quittung für diesen Tag wird dadurch veraltet und muss neu erteilt werden (bestehender Mechanismus der Quittung, keine neue Regel).

### Auswertung und Mitbestimmung

- Die Fahrzeit ist getrennt von produktiver Zeit und Rüstzeit auswertbar: `GET /time-entries/summary` liefert `activityMinutes.TRAVEL`, dem Abfahrtssalon zugerechnet; nur Minuten, keine Beträge, Quoten oder Ranglisten. Die Auswertung gehört zum Modul „Auswertungen“ (`ANALYTICS`); ohne gebuchtes Modul liefert sie `null`.
- **Hinweis Betriebsrat:** Minuten je Person und Art sind – wie die übrigen Werte der Tätigkeitsart (siehe Abschnitt oben) – objektiv geeignet, Verhalten zu überwachen (§ 87 Abs. 1 Nr. 6 BetrVG; BAG 08.03.2022 – 1 ABR 20/21). Ein Mandant mit Betriebsrat beteiligt diesen, **bevor** die Auswertung der Fahrzeit genutzt wird. Die **Erfassung** der Fahrzeit ist dagegen Teil der gesetzlichen Pflicht, die Arbeitszeit zu erfassen (BAG 13.09.2022 – 1 ABR 22/21); sie ist deshalb nicht vom Mandantenschalter aus Issue #529 abhängig und wird nie durch ein Modul gesperrt.
- Der Name des Zielsalons ist für jeden sichtbar, der die Zeile lesen darf (Stammdaten des Mandanten, keine personenbezogene Angabe).
- Berichte, PDFs und DATEV zeigen die Fahrzeit als gewöhnliche Arbeitszeitzeile; es gibt keine Kilometer-, Reisekosten- oder Spesenabrechnung und keine Standorterkennung.

### Oberfläche

Die Erfassung steht nur Mandanten mit Salonauswahl zur Verfügung (Zeiterfassung und Team-Zeiterfassung: „Weiteren Eintrag an diesem Tag“, Schalter „Fahrzeit zwischen Salons“, „Von Salon“ und „Nach Salon“). Mandanten mit einem Salon sehen keine Änderung.

---

## § 8 BUrlG — Urlaub & Zeiterfassung

Implementiert in [`apps/api/src/contexts/absence/api/leave.ts`](../apps/api/src/contexts/absence/api/leave.ts) und [`apps/api/src/contexts/absence/vacation-calc.ts`](../apps/api/src/contexts/absence/vacation-calc.ts).

### Antrag-Status-Lebenszyklus

```
SUBMITTED → APPROVED → CANCELLATION_REQUESTED → CANCELLED
                    ↘  (rejected)              ↘ APPROVED (zurück)
                       REJECTED
```

### Wechselwirkung mit Zeiterfassung

| Urlaubsstatus                       | TimeEntry erlaubt?         | Verhalten                                                                 |
| ----------------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| `SUBMITTED` (pending)               | ja                         | normaler Eintrag möglich                                                  |
| `APPROVED`                          | **NEIN**                   | Hard-Block via 409; MA muss erst Stornierung beantragen                   |
| `CANCELLATION_REQUESTED`            | ja, aber `isInvalid: true` | Eintrag mit Hinweis „Urlaubsstornierung ausstehend"; zählt nicht im Saldo |
| `CANCELLED` (cancellation approved) | ja, Auto-Revalidierung     | invalide Einträge werden automatisch gültig                               |
| `REJECTED` (cancellation rejected)  | Einträge bleiben invalid   | Manager muss manuell handhaben                                            |

Stornierungen erfordern **Vier-Augen-Prinzip**: Approval durch einen anderen Manager (Self-Approval blockiert).

### § 7 Abs. 3 — Übertrag und Verfall

- Urlaub MUSS im Kalenderjahr genommen werden
- Übertrag ins Folgejahr **nur mit Grund** (Krankheit, betriebliche Notwendigkeit)
- Verfall am **31. März** des Folgejahres (konfigurierbar pro Tenant)
- **Langzeitkrankheit**: Übertrag bis 15 Monate (EuGH C-214/10 „KHS")

### Hinweispflicht (EuGH C-684/16)

Clokr versendet automatische Reminder:

- **Oktober:** Erinnerung an MA, wenn Verfall droht
- **November:** Eskalation an Manager
- **Dezember:** finale Warnung

Ohne dokumentierte Hinweise verfällt Urlaub gesetzlich **nicht** — das System protokolliert jeden Reminder.

### § 3 BUrlG — Gesetzlicher Mindesturlaub

| Wochenarbeitstage | Mindesturlaub/Jahr |
| ----------------- | ------------------ |
| 5 Tage            | 20 Tage            |
| 6 Tage            | 24 Tage            |
| 4 Tage            | 16 Tage            |

Berechnung: `Arbeitstage/Woche × 4`. Bei Teilzeit wird der Anspruch automatisch reduziert.

### Cross-Year Booking

Urlaub vom 30.12. – 5.1. wird automatisch gesplittet (2 Tage altes Jahr + 3 Tage neues Jahr). Beide Jahre werden separat geprüft. Stornierung dreht beide um.

### § 5 BUrlG — Austrittsjahr (Issue #447)

Das Austrittsjahr und das Eintrittsjahr sind **eine Zwölftelung über eine Beschäftigungsspanne**
(Eintritt–Austritt), nicht zwei getrennte Rechnungen — ein Eintritt und ein Austritt im selben
Jahr werden genau einmal zwölftel, nicht zweimal nacheinander.

- **Teilurlaub:** 1/12 je vollem Beschäftigungsmonat der Spanne Eintritt–Austritt. Ein Monat gilt
  als voll, wenn der Eintritt an oder vor dessen letztem Tag liegt bzw. der Austritt an oder nach
  dessen letztem Tag liegt.
- **Austritt vor erfüllter Wartezeit (§ 4 BUrlG, 6 Monate):** immer anteilig — auch wenn der
  Austritt in der zweiten Jahreshälfte liegt.
- **Austritt nach erfüllter Wartezeit:** Austritt in der ersten Jahreshälfte (Januar–Juni) →
  anteilig; Austritt in der zweiten Jahreshälfte (Juli–Dezember) → voller Anspruch.
- **Gesetzlicher Mindesturlaub** (§ 3 BUrlG/§ 19 JArbSchG) folgt derselben Zwölftelung wie der
  reguläre Anspruch — kein eigener Rechenweg.
- **Rundung** nach § 5 Abs. 2 BUrlG: ein Bruchteil ab einem halben Tag wird auf einen vollen Tag
  aufgerundet; darunter bleibt der exakte Bruchteil (2 Nachkommastellen) erhalten.
- **Übertrag aus dem Vorjahr wird nie gekürzt** (§ 7 Abs. 3 BUrlG) — die Zwölftelung betrifft nur
  den im Austrittsjahr neu erworbenen Anspruch.
- **Kein Rückforderungstext:** wurde im Austrittsjahr mehr Urlaub genommen als zusteht, zeigt das
  System einen neutralen Hinweis nach § 5 Abs. 3 BUrlG — keine Rückforderungs-Formulierung.

Implementiert in der einen Funktion `employmentYearVacationDays()` (`vacation-calc.ts`), auf die
sowohl `computeRegularVacationDays()` als auch der Mindesturlaubs-Schwellenwert delegieren.

---

## DSGVO — Datenschutz & Anonymisierung

### Art. 17 — „Recht auf Vergessenwerden"

Mitarbeiter werden **anonymisiert, nicht hard-gelöscht** (siehe `CLAUDE.md` „DSGVO Employee Deletion = Anonymization"):

| Feld                                                  | Anonymisierung                                         |
| ----------------------------------------------------- | ------------------------------------------------------ |
| `Employee.firstName`                                  | „Gelöscht"                                             |
| `Employee.lastName`, `employeeNumber`                 | „GELÖSCHT-XXX"                                         |
| `Employee.nfcCardId`, `wifiMacs`                      | `null` / `[]`                                          |
| `User.email`                                          | anonymisiert (`gelöscht-<hash>@anon.local`)            |
| `User.passwordHash`, `isActive`                       | `"ANONYMIZED"`, `false`                                |
| `TimeEntry.note`, `LeaveRequest.note`, `Absence.note` | `null`                                                 |
| `Absence.documentPath`                                | `null` (Dateien im S3 gelöscht)                        |
| `Invitation`, `OtpCode`, `RefreshToken`               | hart gelöscht (nicht aufbewahrungspflichtig)           |
| `AuditLog.userId`                                     | `null` (anonymisiert, nicht gelöscht — Audit-Pflicht!) |

**Erhalten bleiben** (gesetzliche Aufbewahrungspflicht):

- TimeEntries, LeaveRequests, Absences, Schedules, OvertimeAccount, SaldoSnapshots

### Art. 6 Abs. 1 lit. a — Einwilligung (WiFi-Presence)

WiFi-basiertes Auto-Stempeln (v1.4, Phase 25):

- **Opt-In erforderlich** pro MA — Default `wifiPresenceEnabled = false`
- Einwilligungszeitpunkt in `Employee.wifiOptInAt` festgehalten (auch nach Widerruf erhalten als Beleg)
- MA kann jederzeit widerrufen via `/settings → Meine Geräte`
- Bei Admin-Zuweisung eines Geräts: Opt-In wird automatisch aktiviert (über Betriebsvereinbarung gedeckt) — Audit-Log `WIFI_OPT_IN_BY_ADMIN`
- Bei Aufheben der letzten Zuweisung: Opt-In automatisch deaktiviert — Audit-Log `WIFI_OPT_OUT_BY_ADMIN`

### Art. 5 Abs. 1 lit. e — Speicherbegrenzung

WiFi-Presence-Events ohne TimeEntry (Unknown MAC, Outside Window, No Shift, Opt-out) werden mit `AuditLog.purgeable = true` markiert und **nach 90 Tagen automatisch gelöscht** durch Daily-Cron (`runPurgeableAuditLogs`). Implementiert in `data-retention.ts`.

---

## Aufbewahrungsfristen (Deutschland)

| Grundlage                           | Frist                  | Norm                 |
| ----------------------------------- | ---------------------- | -------------------- |
| Arbeitszeitnachweis                 | 2 Jahre                | § 16 Abs. 2 ArbZG    |
| Lohnkonten                          | 6 Jahre                | § 41 EStG            |
| Buchungsbelege (lohnsteuerrelevant) | **10 Jahre**           | § 147 AO / § 257 HGB |
| Personalakten / Vertragsdaten       | bis Austritt + 3 Jahre | BGB                  |
| Krankmeldungen (eAU)                | Ende des Folgejahres   | § 24c SGB V          |

**Default in Clokr:** 10 Jahre (konfigurierbar pro Tenant via `TenantConfig`, Minimum 2 Jahre).

- Aufbewahrung startet **am Ende des Kalenderjahres** der Erstellung
- Löschung **NICHT rolling**, sondern jährlich zum Stichtag (z.B. 1.1. für Datensätze, deren Frist am 31.12. abgelaufen ist)
- Implementiert in `data-retention.ts:runRetention()` (jährlich am 2.1. um 03:00)

---

## Audit-Trail / Revisionssicherheit

Implementiert in [`apps/api/src/contexts/platform/plugins/audit.ts`](../apps/api/src/contexts/platform/plugins/audit.ts).

### Grundprinzipien

1. **Keine Hard-Deletes** auf TimeEntry, LeaveRequest, Absence, Employee → Soft-Delete via `deletedAt`
2. **Alle Mutationen** (CREATE/UPDATE/DELETE) erzeugen einen `AuditLog`-Eintrag mit:
   - `userId`, `tenantId`, `timestamp`, `ipAddress`, `userAgent`
   - `entity`, `entityId`, `action`
   - `oldValue` und `newValue` als JSONB
3. **Locked Months** (`TimeEntry.isLocked`; Monats-Snapshot via `SaldoSnapshot.closedAt`) sind nach Abschluss **immutable** — auch für Admins
4. **Korrekturen** an gesperrten Monaten erzeugen einen neuen Eintrag (`TimeEntry.source = CORRECTION`) mit Referenz auf das Original, nie Inplace-Update
5. **CASCADE = Restrict** für kritische Relationen (Employee → TimeEntry/LeaveRequest/Absence)

### AuditLog Actions (Auswahl)

| Action                                                                     | Entity                | Zweck                            |
| -------------------------------------------------------------------------- | --------------------- | -------------------------------- |
| `CREATE`, `UPDATE`, `DELETE`                                               | beliebig              | Standard-CRUD                    |
| `WIFI_CLOCK_IN`, `WIFI_CLOCK_OUT`                                          | TimeEntry             | Auto-Stempel via WiFi            |
| `WIFI_UNKNOWN_MAC`, `WIFI_OPT_OUT`, `WIFI_OUTSIDE_WINDOW`, `WIFI_NO_SHIFT` | PresenceEvent         | Nicht-Stempel-Events (purgeable) |
| `WIFI_OPT_IN_BY_ADMIN`, `WIFI_OPT_OUT_BY_ADMIN`                            | Employee              | Admin setzt/widerruft Opt-In     |
| `ASSIGN_DEVICE`, `UNASSIGN_DEVICE`                                         | PresenceDevice        | MAC↔MA-Mapping                   |
| `MANAGER_CREATED`                                                          | LeaveRequest, Absence | Manager-on-behalf-of (v1.4)      |
| `CREATE`, `UNLOCK`                                                         | SaldoSnapshot         | Monatsabschluss / Wiederöffnung  |

---

## Migrations- und Datenintegrität

- **Schema-Änderungen:** Versionierte Prisma-Migrationen (`prisma migrate diff` gegen eine Wegwerf-Shadow-DB → `migrate deploy`), **nicht** `db push` und **nicht** `prisma migrate dev` (setzt bei Drift die Zieldatenbank ohne Rückfrage zurück). Siehe `CLAUDE.md` und `docs/migrations.md`.
- **CASCADE-Verhalten:** Critical Relations (`Employee → TimeEntry`, `Employee → LeaveRequest`, `Employee → Absence`) verwenden `onDelete: Restrict` — verhindert versehentlichen Cascade-Delete
- **Soft-Delete-Queries:** ALLE Queries auf `TimeEntry`, `LeaveRequest`, `Absence` MÜSSEN `deletedAt: null` im `where` enthalten (Projektregel, enforced in Code-Reviews)

---

## Code-Referenzen

| Bereich                             | Datei                                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| ArbZG-Prüfungen                     | `apps/api/src/contexts/time-tracking/arbzg.ts`                                                                             |
| ArbZG-Tests (33 Cases)              | `apps/api/src/contexts/time-tracking/__tests__/arbzg.test.ts`                                                              |
| Urlaubsberechnung                   | `apps/api/src/contexts/absence/vacation-calc.ts`                                                                           |
| Audit-Plugin                        | `apps/api/src/contexts/platform/plugins/audit.ts`                                                                          |
| Data-Retention (jährlich + täglich) | `apps/api/src/composition/data-retention.ts`                                                                               |
| Auto-Break-Logik                    | `apps/api/src/contexts/time-tracking/api/time-entries.ts` (Suche `autoBreakMin`)                                           |
| WiFi-Presence (Opt-In, Webhook)     | `apps/api/src/contexts/time-tracking/api/presence.ts`, `apps/api/src/contexts/time-tracking/api/admin-presence-sources.ts` |
| Projektregeln                       | `CLAUDE.md` (Sektionen „Audit-Proof", „Data Retention", „ArbZG", „BUrlG")                                                  |

---

### Phorest-Schichtimport & §615 (v1.9)

Aus Phorest importierte Schichten können den Roster-Soll um eine Vor-/Nachbereitungszeit erweitern (`TenantConfig.phorestPrepMinutes`/`phorestWrapupMinutes`, pro Mitarbeiter via `phorestPrepMinutesOverride`/`phorestWrapupMinutesOverride` überschreibbar). Dieser gepaddete Roster fließt in den SHIFT_BASED-Saldo (§615 Annahmeverzug, `apps/api/src/contexts/working-time-account/shift-based-saldo.ts`) ein. Berufsschul-Abwesenheiten (`Absence.type = VOCATIONAL_SCHOOL`) haben Vorrang vor kollidierenden Phorest-Schichten (Schicht wird beim Import übersprungen). Der Import ist einseitig (Phorest führend); ein Rückschreiben nach Phorest findet nicht statt.

---

## Disclaimer

Diese Dokumentation beschreibt den **implementierten Stand** von Clokr v1.9. Sie ersetzt keine rechtliche Beratung. Tenants sind selbst verantwortlich für die korrekte Konfiguration (Aufbewahrungsfristen, Bundesland, Arbeitszeitmodelle, Betriebsvereinbarungen).

Bei rechtlichen Änderungen (z.B. Anpassungen am ArbZG, neuen EuGH-Urteilen zu BUrlG) ist eine Code-Anpassung erforderlich — die Test-Suite (`pnpm --filter @clokr/api test arbzg`) dient als Regression-Schutz.
