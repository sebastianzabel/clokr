# Clokr — Roadmap / TODO

## Phase 1 — Current Sprint

### 1. Passwort vergessen / Reset
- [ ] POST `/api/v1/auth/forgot-password` — sendet Reset-Link per E-Mail
- [ ] POST `/api/v1/auth/reset-password` — Token + neues Passwort
- [ ] Frontend: "Passwort vergessen?" Link auf Login-Seite
- [ ] Frontend: Reset-Seite mit Token-Validierung

### 2. PDF-Export
- [ ] Monatsbericht als PDF (pro Mitarbeiter)
- [ ] Urlaubsübersicht als PDF
- [ ] Überstundenkonto-Auszug als PDF
- [ ] Download-Buttons in Reports-Seite

### 3. iCal-Export
- [ ] GET `/api/v1/leave/ical/:employeeId` — persönlicher Abwesenheits-Feed
- [ ] GET `/api/v1/leave/ical/team` — Team-Kalender (Manager/Admin)
- [ ] Abo-URL in UI anzeigen (kopierbar für Outlook/Google Calendar)

### 4. NFC-Verwaltungs-UI
- [ ] Admin-Seite: NFC-Karten-ID pro Mitarbeiter zuweisen/entfernen
- [ ] NFC-ID im Mitarbeiter-Bearbeiten-Modal
- [ ] Validierung: Duplikat-Check bei Zuweisung

### 5. Benachrichtigungen
- [ ] Fehlende Zeiteinträge: Erinnerung wenn kein Eintrag bis Feierabend
- [ ] Genehmigungsanfragen: Manager wird informiert bei neuem Urlaubsantrag
- [ ] Überstunden-Warnung: bei Schwellenwert-Überschreitung
- [ ] In-App Notification Center (Bell-Icon im Header)
- [ ] Optional: E-Mail-Benachrichtigungen

### 6. Bulk-Import
- [ ] CSV-Import für Mitarbeiter (Name, E-Mail, Nr., Eintrittsdatum, Rolle)
- [ ] CSV-Import für Zeiteinträge (Datum, Start, Ende, Pause)
- [ ] Upload-UI mit Vorschau + Validierung vor Import
- [ ] Fehlerprotokoll bei teilweise fehlgeschlagenem Import

### 7. Dashboard Charts
- [ ] Wöchentlicher Arbeitsstunden-Verlauf (Balkendiagramm)
- [ ] Überstunden-Trend (Liniendiagramm, letzte 6 Monate)
- [ ] Abwesenheits-Verteilung (Donut: Urlaub/Krank/Sonder/etc.)
- [ ] Team-Auslastung für Manager (Heatmap oder Balken)
- [ ] Lightweight Chart-Library (z.B. Chart.js oder uPlot)

### 8. Schichtplanung
- [ ] Neues DB-Model: Shift (employeeId, date, startTime, endTime, label)
- [ ] Wochenplan-Ansicht (Kalender-Grid, Drag & Drop)
- [ ] Schicht-Vorlagen (Früh/Spät/Nacht)
- [ ] Schichttausch-Anfragen zwischen Mitarbeitern
- [ ] Automatische Soll-Stunden aus Schichtplan statt Wochenstunden

---

## Phase 2 — Later

### Datei-Upload für Atteste
- [ ] Upload-Endpoint mit MinIO/S3 Storage
- [ ] Attest-Upload im Krankmeldungs-Dialog
- [ ] Download/Vorschau für Admin/Manager

### Multi-Tenant UI
- [ ] Tenant-Auswahl / Subdomain-Routing
- [ ] Tenant-Registrierung (Self-Service)
- [ ] Tenant-Admin Dashboard

### PWA / Offline
- [ ] Service Worker für Offline-Clock-In
- [ ] Install-Prompt (Add to Homescreen)
- [ ] Background Sync für offline erfasste Zeiten

### Integrationen
- [ ] Slack: Benachrichtigungen bei Genehmigungsanfragen
- [ ] Microsoft Teams: Webhook-Integration
- [ ] Google Calendar: Sync Abwesenheiten
- [ ] Weitere Lohnbuchhaltungs-Exporte (DATEV ist done)

### Erweiterte Reports
- [ ] Konfigurierbarer Report-Builder
- [ ] Geplante Reports per E-Mail (wöchentlich/monatlich)
- [ ] Excel-Export (.xlsx)
- [ ] Jahresübersicht pro Mitarbeiter
