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

- Monatliches Stundenbudget für flexible Arbeit / Minijob
- Kein tägliches Soll, keine Feiertags-Abzüge
- Optional: ohne Stundenlimit (reine Zeiterfassung)

### Mitarbeiter bearbeiten

Über **Bearbeiten** in der Mitarbeiterliste können alle Stammdaten und das Arbeitszeitmodell angepasst werden. Änderungen am Arbeitszeitmodell wirken sich auf die Saldo-Berechnung ab dem Änderungsdatum aus.

### DSGVO: Mitarbeiter löschen (Anonymisierung)

Ausgeschiedene Mitarbeiter werden **nicht hard-gelöscht**, sondern anonymisiert (Art. 17 DSGVO):

- Name → „Gelöscht / GELÖSCHT-XXX"
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

## DATEV-Export

**Admin → DATEV Export** — Export der Lohn-/Zeitdaten im DATEV-CSV-Format für die Weitergabe an die Lohnbuchhaltung. Zeitraum (Monat) wählen, exportieren, CSV herunterladen.

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
