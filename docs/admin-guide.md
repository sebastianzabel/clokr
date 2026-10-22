# Administratorhandbuch

## Mitarbeiterverwaltung

### Mitarbeiter anlegen

1. **Admin → Mitarbeiter → + Mitarbeiter anlegen**
2. Pflichtfelder: Vorname, Nachname, E-Mail, Rolle, Eintrittsdatum
3. Optional: Personalnummer, Bundesland (für Feiertage), Arbeitszeitmodell
4. Nach dem Speichern wird automatisch eine Einladungs-E-Mail versandt

### Arbeitszeitmodelle

Zwei Modelle stehen zur Verfügung:

**Feste Wochenstunden (FIXED_WEEKLY)**

- Wöchentliche Stunden mit Verteilung auf Wochentage
- Beispiel: 40 h/Woche, Mo–Fr je 8 h
- Saldo-Berechnung täglich, Feiertage und Urlaub reduzieren Sollstunden

**Monatsstunden (MONTHLY_HOURS)**

- Monats-Soll (geschuldet) für flexible Arbeit / Minijob
- Urlaub, Krankheit, angeordnete Abwesenheit und Feiertage an Arbeitstagen mindern das Soll
  anteilig (Monatsstunden ÷ Arbeitstage des Monats; ein halber Tag mindert um die Hälfte)
- Kein tägliches Soll, keine tägliche +/- Anzeige im Kalender
- Optional: ohne Stundenwert (reine Zeiterfassung)

### Mitarbeiter bearbeiten

Über **Bearbeiten** in der Mitarbeiterliste können alle Stammdaten und das Arbeitszeitmodell angepasst werden. Änderungen am Arbeitszeitmodell wirken sich auf die Saldo-Berechnung ab dem Änderungsdatum aus.

### DSGVO: Mitarbeiter löschen (Anonymisierung)

Ausgeschiedene Mitarbeiter werden **nicht hard-gelöscht**, sondern anonymisiert (Art. 17 DSGVO):

- Name → „Gelöscht / GELÖSCHT-XXX"; die **Personalnummer bleibt erhalten** und wird nicht neu vergeben
- Beschäftigung endet: ein leeres Austrittsdatum wird auf heute gesetzt, Urlaube und Berufsschultage danach werden storniert bzw. gekürzt (abgeschlossene Monate bleiben unverändert)
- E-Mail → anonymisiert, Login deaktiviert
- NFC-Karte → entfernt
- Zeiteinträge, Urlaub, Überstunden → **bleiben erhalten** (gesetzliche Aufbewahrungspflicht)

---

## Urlaubsverwaltung (Admin)

### Urlaubsansprüche konfigurieren

**Admin → Urlaubsverwaltung** — der jahresbezogene Überblick; die Urlaubskonfiguration pro Mitarbeiter liegt auf der Mitarbeiter-Detailseite (Admin → Mitarbeitende → Mitarbeiter):

- Jahresanspruch in Tagen
- Übertrag aus dem Vorjahr (manuell oder automatisch nach Monatsabschluss)
- Verfallsdatum für Resturlaub (Standard: 31. März des Folgejahres)
- **Übertragsgrund** (Tab „Urlaub" auf der Mitarbeiter-Detailseite, Issue #451/#445): bei einem
  verlängerten Verfallsdatum kann ein Grund mit Notiz dokumentiert werden — Krankheit
  (EuGH C-684/16/C-214/10, automatisch 31. März des Folgejahres), Mutterschutz (§ 24 S. 2 MuSchG),
  Elternzeit (§ 17 Abs. 2 BEEG) oder Sonstiges (erfordert eine Notiz). Das Feld wird wie alle Felder
  dieses Abschnitts über den **Speichern**-Button des Tabs übernommen, nicht sofort beim Auswählen.
- Der im Admin angezeigte **Resturlaub** (verbleibend, verfallen, gefährdet) kommt aus derselben
  einen Funktion wie die Berichte und das Dashboard (Issue #451, siehe unten). In den Berichten
  (**Admin → Berichte**) zeigt die Urlaubsübersicht nur den **Urlaub** (keine Krankheit und keine
  Sonderurlaubsarten) mit den Spalten Anspruch, Übertrag (wirksam), Verfügbar, Genommen, Genehmigt,
  Beantragt und Resturlaub. „Übertrag (wirksam)" ist der **wirksame** (FIFO-bereinigte, nicht verfallene)
  Übertrag; **Verfügbar** ist Anspruch plus wirksamer Übertrag; **Resturlaub** ist Verfügbar abzüglich
  Genommen und Genehmigt — beantragte Tage werden nicht abgezogen. Die Verfall-Warnung zeigt die
  **gefährdeten** Tage — den Teil des Übertrags, der ohne weitere Buchung bis zum Verfallsdatum verfällt.

### Genehmigungen

Ausstehende Urlaubsanträge erscheinen im Posteingang unter **Team → Anträge**. Manager können genehmigen oder ablehnen. Stornierungsanfragen müssen von einem **anderen** Manager bearbeitet werden (kein Selbst-Genehmigen).

---

## Schichtplanung

**Admin → Schichtplan** — Wochenpläne pro Mitarbeiter:

- Schichtvorlagen erstellen (Name, Beginn, Ende, Pausen)
- Wochenplan zuweisen
- Abweichungen einzelner Tage überschreiben

---

## Sonderurlaub

**Admin → Urlaubsverwaltung → Tab „Sonderurlaub"** — Konfiguration der Sonderurlaubstypen:

- Typ, gesetzliche Grundlage, Anzahl Tage
- Beispiele: Hochzeit (2 Tage), Umzug (1 Tag), Todesfall (3 Tage)

---

## Betriebsurlaub

**Admin → Betriebsurlaub** — firmenweite Schließzeiten:

- Zeitraum und Name eintragen
- Ausnahmen für einzelne Mitarbeiter möglich
- Betriebsurlaub wird automatisch vom Urlaubsanspruch abgezogen

---

## Monatsabschluss

Der Monatsabschluss friert den Überstunden-Saldo eines Monats ein:

1. **Admin → Monatsabschluss → Monat auswählen**
2. Alle Mitarbeiter prüfen (fehlende Einträge, offene Genehmigungen)
3. **Abschließen** — der Monat ist danach gesperrt (unveränderlich)

> Gesperrte Monate können nur durch Entsperren + Korrektur + erneuten Abschluss geändert werden. Jede Änderung wird im Audit-Log protokolliert.

---

## Import

**Admin → CSV Import** — Massendaten importieren per CSV:

- **Mitarbeiter-Import**: Name, E-Mail, Rolle, Eintrittsdatum, Arbeitsstunden
- **Zeiteintrags-Import**: Mitarbeiternummer, Datum, Beginn, Ende, Pausen

CSV-Vorlagen stehen zum Download bereit.

---

## Berichte und Monatsexport

**Berichte** (Issue #612) hat einen einzigen Zeitraum für die ganze Seite. Er steht in der **Periodenleiste** oben und in
der Adresse (`/reports?from=2026-07&to=2026-09&tab=zeiten`), sodass ein Neuladen oder ein weitergegebener Link genau diese
Ansicht öffnet.

- **Zeitraum wählen:** die Pfeile ◀ und ▶ springen je nach Art des Zeitraums um einen Monat, ein Quartal, ein Jahr oder
  um dessen Länge; ein Zukunftsmonat ist gesperrt. Die Schnellauswahl bietet „Dieser Monat“, „Vormonat“, „Quartal“,
  „Jahr“ und „Letzte 3 Monate“, „Zeitraum…“ öffnet ein Fenster für beliebige Monate von bis. Es sind **höchstens 12
  Monate** auf einmal; der Standard ist der laufende Monat.
- **Kennzahlen:** Ist, Soll, Saldo im Zeitraum und Gesamtsaldo am Ende, dazu Urlaub genommen, genehmigt und Anspruch
  sowie Krankheitstage. Jede Zahl ist die Summe der Monatszahlen des Arbeitszeitkontos; die Seite rechnet nichts neu.
  Soll und Saldo erscheinen nur für Personen, die die Berechtigung „Salden im zugewiesenen Bereich lesen“ abdeckt;
  sonst steht dort „Keine Berechtigung“ und das Ist bleibt sichtbar.
- **Zeiten & Konten:** eine Zeile je Person mit Soll, Ist, Saldo Beginn, Saldo im Zeitraum, Saldo Ende und Status. Der
  Status ist „Bestätigt“, wenn jeder Monat abgeschlossen ist, sonst „Prognose“ mit „k von m Monaten bestätigt“ (der
  bestätigte Nachweis bleibt erkennbar). Die Tabelle lässt sich sortieren und durchsuchen; darunter steht der
  Teammedian der Endsalden, Personen ohne Saldo, nur mit Zeiterfassung oder ohne Erfassung stehen mit Grund daneben.
  Ausgetretene Personen tragen ihren Austrittstag; ihr Stand von heute steht in einem eigenen Abschnitt „Stand heute,
  unabhängig vom Zeitraum“.
- **Person öffnen:** Ein Klick auf den Namen öffnet ein breites Fenster mit der Monatsreihe, dem Urlaub und, mit der
  Berechtigung „Zeiteinträge im zugewiesenen Bereich lesen“, der Tagesliste. Die Adresse enthält `person=…`; „Zurück“ im Browser schließt das
  Fenster. Dort stehen auch **DATEV (Person)** und der **Stundennachweis (PDF)**.
- **Urlaub & Abwesenheit:** die Urlaubsübersicht je Kalenderjahr des Zeitraums (Anspruch, Übertrag, genommen,
  genehmigt, beantragt, verbleibend, gefährdeter Resturlaub), Stand zum letzten Tag des Zeitraums in diesem Jahr,
  höchstens bis gestern. Die Spalte **Verfall** zeigt Frist und gefährdete Tage; **Hinweis senden** (Berechtigung „Vor verfallendem
  Resturlaub warnen“) schreibt die betroffene Person an, solange die Frist heute oder später liegt. Darunter stehen die
  Abwesenheiten nach Art (Summe der Monate, Arbeitstage; Krankheit in Kalendertagen).
- **Heute:** die Anwesenheit des laufenden Tages (Berechtigung „Team-Übersichten im zugewiesenen Bereich sehen“), unabhängig vom Zeitraum.
- **Exportieren:** ein einziges Fenster hinter der Schaltfläche „Exportieren“ (Berechtigung „DATEV- und PDF-Exporte im zugewiesenen Bereich erstellen“)
  mit drei Blöcken: **Monatsexport** als PDF und **DATEV** für einen wählbaren Monat des Zeitraums und die **Tabelle
  als CSV** für den ganzen Zeitraum. Die CSV hat die Spalten der Tabelle (Stunden mit Dezimalkomma, UTF-8, Trennzeichen
  Semikolon) und wird wie jeder Export protokolliert (Zeitraum, Salon, Personenzahl).
- **Salon:** folgt der Salonauswahl in der Kopfleiste (nur bei Mandanten mit Salonauswahl). Die Tabelle zeigt die Personen
  mit Stammsalon in diesem Salon am Ende des Zeitraums (bei einem Austritt im Zeitraum am Austrittstag), jede mit ihren
  ganzen Werten: Soll, Ist, Saldo, Urlaub und Krankheit sind Personenwerte und werden nie auf Salons aufgeteilt, der
  Hinweis „Personensaldo nach Stammsalon, nicht nach Salon aufgeteilt“ steht neben Kennzahlen und Tabelle. Wer im Zeitraum
  den Stammsalon gewechselt hat, zählt ganz zum Stammsalon am Ende. Eine Zahl nennt die Personen ohne Stammsalon in einem
  aktiven Salon; sie erscheinen nur unter „Alle Salons“. Getrennt davon zeigt **Im Salon gearbeitet** die Stunden, die im
  Salon gearbeitet wurden, mit dem Abschnitt **Aushilfen aus anderen Salons** (nur Name und Stunden, ohne Saldo und ohne
  Personenansicht). Die Urlaubstabelle und die CSV listen dieselben Personen wie die Tabelle. **DATEV gilt immer für alle
  Salons** der Reichweite (§ 41 EStG).
- **Personalabteilung:** sieht die Tabellen und Kennzahlen ohne Tagesliste und ohne Export. **Salonleitungen** sehen
  nur ihre Reichweite. Wer nur exportieren darf, bekommt die Periodenleiste mit „Exportieren“ und den Hinweis „Keine
  Auswertung freigegeben – Exporte verfügbar“.
- **Dauer:** Ein Zeitraum von zwölf Monaten rechnet Monat für Monat und braucht bei 25 Personen gemessen rund 4 Sekunden; die Seite
  zeigt währenddessen einen Ladezustand mit Abbruch bei Zeitraumwechsel und „Erneut versuchen“ bei einem Fehler. Für
  sehr große Reichweiten ist die Beschleunigung Issue #688.

Die beiden PDF-Dokumente und die Datei für DATEV (Issue #617):

- **Monatsexport** — ein PDF für alle Mitarbeitenden eines Monats, die lesbare Fassung des DATEV-Exports:
  dieselben Personen und dieselben Abwesenheitstage wie in der DATEV-Datei, dazu Soll, Ist, Saldo, Status und
  Gesamtsaldo aus dem Arbeitszeitkonto und ein Abschnitt „Urlaubsjahr" mit dem Stand zum Monatsende (im
  laufenden Monat bis gestern). „DATEV-Std." sind die Normalstunden der DATEV-Datei; sie können vom Ist
  abweichen (Beschäftigungszeitraum, Berufsschul-Anrechnung, nur Einträge der Art Arbeit, gespeicherter
  Stand abgeschlossener Monate) — die Legende im Dokument nennt die Gründe. Das Dokument enthält Krankheitstage,
  weil es der Vorbereitung der Lohnabrechnung dient; es setzt wie DATEV die Berechtigung „Berichte exportieren" voraus.
- **Stundennachweis** — das PDF einer Person mit allen Einträgen des Monats sowie Abwesenheits- und Feiertagszeilen.
  Er ist das einzige Dokument mit einer Tagesliste.
- Die früheren PDFs Firmenweiter Monatsbericht, Urlaubsliste, Urlaubsbericht und Urlaubsübersicht gibt es nicht mehr;
  die Urlaubsübersicht steht in der App (Tab „Urlaub & Abwesenheit“), der Abschnitt „Urlaubsjahr" im Monatsexport.

---

## DATEV-Export

**Admin → DATEV Export** — Export der Lohn-/Zeitdaten im DATEV-CSV-Format für die Weitergabe an die Lohnbuchhaltung. Zeitraum (Monat) wählen, exportieren, CSV herunterladen.

Die exportierten **Urlaubs- und Abwesenheitstage** sind die vom System berechneten Tage —
Arbeitstage laut Vertrag, Feiertage, halbe Tage, Schichtvertrag (SHIFT_BASED) und
Berufsschultage werden alle berücksichtigt (Issue #451, D-01: dieselbe Funktion, die auch die
Urlaubsberechnung selbst nutzt, statt eines eigenen Mo-Fr-Kalenderlaufs im Export). Das betrifft
alle Abwesenheits-Lohnarten außer Krankheit — **Krankheitstage** werden weiterhin nach der
eigenen, unveränderten Tagesregel exportiert.

---

## Integrationen (WiFi-Präsenz)

**Admin → Integrationen** — Anwesenheitserkennung über WLAN-Präsenz (FRITZ!Box). Präsenzquellen konfigurieren und Geräte den Mitarbeitenden zuordnen. (Hinweis: Nicht zu verwechseln mit **Phorest** — das ist ein eigener Tab.)

---

## Phorest-Integration

**Admin → Phorest** — Import von Schichten aus der Salon-Software Phorest (eigener Admin-Tab, getrennt von „Integrationen").

- **Verbindung**: Business ID, Branch ID, API-Benutzername (E-Mail) und API-Passwort eintragen, dann **Verbindung testen**.
- **Import-Einstellungen**: Vor-/Nachbereitungszeit-Puffer (0–30 Min., tenant-global; pro Mitarbeiter auf der Mitarbeiter-Detailseite überschreibbar), Zeitfenster in Tagen (Standard 7) und optionaler automatischer Sync (Cron-Zeitplan).
- **Mitarbeiter-Zuordnung**: Phorest-Mitarbeiter mit clokr-Mitarbeitenden verbinden. Nicht zugeordnete Mitarbeitende werden beim Sync übersprungen.
- **Synchronisation**: Manuell („Jetzt synchronisieren") oder automatisch. Der Import ist einseitig (Phorest ist führend → clokr). Der Verlauf zeigt Status (Erfolg/Fehler/Verdächtig) sowie importierte/abgesagte/ersetzte und wegen Berufsschule übersprungene Schichten.

Termine (Appointments) werden nur als DSGVO-konformer, PII-freier Read-only-Cache vorgehalten; Kollisionswarnungen erscheinen schreibgeschützt in den Urlaubs-/Schicht-Flows. Ein Rückschreiben von Abwesenheiten nach Phorest ist nicht implementiert.

---

## Audit-Log

**Admin → Audit** — vollständige Protokollierung aller Änderungen:

- Wer hat was wann geändert (inkl. IP-Adresse)
- Vor- und Nachher-Werte bei Updates
- Nicht löschbar, nicht editierbar

Details zu rechtlichen Aufbewahrungsfristen, Anonymisierungs-Verhalten, ArbZG-Prüfungen und BUrlG-Regeln siehe [compliance.md](./compliance.md).

---

## Allgemein (Systemeinstellungen)

**Admin → Allgemein**:

| Einstellung     | Beschreibung                                      |
| --------------- | ------------------------------------------------- |
| Theme           | Erscheinungsbild (Pflaume, Nacht, Wald, Schiefer) |
| Bundesland      | Bestimmt gesetzliche Feiertage                    |
| Zeitzone        | Zuordnung von Zeitstempeln                        |
| 2FA             | E-Mail-OTP bei Login aktivieren                   |
| Session-Timeout | Automatische Abmeldung nach Inaktivität           |
| Account-Lockout | Sperrung nach X Fehlversuchen                     |
| SMTP            | E-Mail-Versand konfigurieren                      |
| API-Schlüssel   | Programmatischer Zugriff für externe Tools        |
