# Clokr — Roadmap / TODO

## Done (v0.3.0)

- [x] Passwort vergessen / Reset Flow
- [x] PDF-Export (Monatsbericht, Urlaubsübersicht)
- [x] iCal-Export (persönlich + Team)
- [x] NFC-Verwaltungs-UI (Edit-Modal)
- [x] Dashboard Charts (Chart.js: Arbeitsstunden, Überstunden-Trend, Abwesenheiten)
- [x] Benachrichtigungen (In-App + E-Mail)
- [x] Bulk-Import (CSV für Mitarbeiter + Zeiteinträge)
- [x] Schichtplanung (Shift-Modell + Wochenplan-UI)

---

## Phase 2 — Next Up

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

### Security & Compliance
- [ ] CSRF-Token für formulare
- [ ] Content Security Policy verschärfen
- [ ] Session-Management (Max active sessions)
- [ ] Passwort-Richtlinien konfigurierbar (Mindestlänge, Komplexität)
- [ ] Login-Versuche: Account-Lockout nach X Fehlversuchen

### UX-Verbesserungen
- [ ] Onboarding-Wizard für neue Tenants
- [ ] Drag & Drop für Schichtplanung
- [ ] Keyboard-Shortcuts (z.B. Cmd+Enter für Stempeln)
- [ ] Dark Mode: System-Präferenz auto-detect
- [ ] Suchfunktion global (Cmd+K)
