# Benutzerhandbuch

## Dashboard

Das Dashboard zeigt auf einen Blick:

- **Einstempeln / Ausstempeln** — aktueller Status mit Uhrzeit
- **Heute** — geleistete Stunden des aktuellen Tages
- **Diese Woche** — Wochenstunden vs. Soll
- **Überstunden** — aktueller Gesamtsaldo
- **Resturlaub** — verbleibende Urlaubstage im Jahr
- **Meine Woche** — Kalenderübersicht der aktuellen Woche
- **Offene Vorgänge** — fehlende Zeiteinträge, ausstehende Genehmigungen

---

## Zeiterfassung

### Einstempeln & Ausstempeln

Über den **Einstempeln**-Button auf dem Dashboard oder per NFC-Karte am Terminal. Der aktuelle Status (Eingestempelt / Ausgestempelt) wird in Echtzeit angezeigt.

### Zeiteinträge manuell erfassen

1. **Zeiterfassung → + Eintrag hinzufügen**
2. Datum, Beginn, Ende und optional Pausen eintragen
3. Speichern

> Pro Tag ist genau ein Zeiteintrag erlaubt. Existiert bereits einer, öffnet sich automatisch das Bearbeitungsformular.

### Kalenderansicht

Die Monatsansicht zeigt:

- **Grün** — vollständiger Eintrag
- **Rot / –8:00 h** — fehlender Eintrag (Soll nicht erfüllt)
- **Urlaub / Feiertag** — entsprechend markiert
- **Heute** — lila umrandet

### Listenansicht

Tabellarische Übersicht aller Einträge des Monats mit Soll/Ist-Vergleich und Saldo.

### ArbZG-Hinweise

Clokr prüft automatisch:

- **§ 3** — Tägliche Höchstarbeitszeit (10 h absolutes Limit)
- **§ 4** — Pausenpflicht (> 6 h → 30 min, > 9 h → 45 min)
- **§ 5** — Mindestruhezeit (11 h zwischen Arbeitsende und nächstem Beginn)

Bei Verstößen erscheint ein Warnhinweis im Eintrag.

---

## Abwesenheiten & Urlaub

### Neuen Antrag stellen

1. **Abwesenheiten → + Neuer Antrag**
2. Abwesenheitstyp wählen (Urlaub, Krankheit, Sonderurlaub etc.)
3. Zeitraum auswählen
4. Absenden — der Antrag geht zur Genehmigung an den Manager

### Antragsstatus

| Status                   | Bedeutung                                              |
|--------------------------|--------------------------------------------------------|
| Ausstehend               | Wartet auf Genehmigung                                 |
| Genehmigt                | Bestätigt, wird im Kalender angezeigt                  |
| Abgelehnt                | Nicht genehmigt                                        |
| Stornierung angefragt    | Stornierung beantragt, wartet auf zweiten Manager      |
| Storniert                | Urlaub wurde rückgängig gemacht                        |

### Urlaubsanspruch

Die Zusammenfassung über dem Kalender zeigt:

- **Jahresanspruch** — gesetzlicher + vertraglicher Anspruch
- **Resturlaub** — Übertrag aus dem Vorjahr
- **Genommen** — bereits verbrauchte Tage
- **Geplant** — genehmigte, zukünftige Abwesenheiten
- **Verbleibend** — noch verfügbare Tage

### Urlaub stornieren

1. In **Meine Anträge** den genehmigten Antrag öffnen
2. **Stornierung beantragen** klicken
3. Ein anderer Manager muss die Stornierung bestätigen

> Während eine Stornierung aussteht, können Zeiteinträge für diesen Zeitraum angelegt werden — diese werden als ungültig markiert und erst nach Genehmigung der Stornierung aktiviert.

---

## Überstundenkonto

Unter **Zeiterfassung** (Monats-Saldo und Gesamt-Saldo) sowie im Überstundenkonto:

- **Saldo** = Geleistete Stunden − Sollstunden (seit Eintrittsdatum)
- Urlaub, Feiertage und Abwesenheiten reduzieren die Sollstunden
- Beim **Monatsabschluss** wird der Saldo eingefroren und als Snapshot gespeichert

---

## Persönliche Einstellungen

Unter **Einstellungen** (Profilbild oben links → Einstellungen):

- Passwort ändern
- Benachrichtigungseinstellungen
- Aktive Sessions verwalten (andere Geräte abmelden)
