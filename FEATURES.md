# Clokr – Feature-Übersicht

> Stand: März 2026 · v1.0.0

---

## Stack

| Schicht    | Technologie                                                |
| ---------- | ---------------------------------------------------------- |
| Monorepo   | pnpm workspaces                                            |
| Frontend   | SvelteKit + Svelte 5 (Runes)                               |
| Backend    | Fastify 5, TypeScript                                      |
| Datenbank  | PostgreSQL 16 via Prisma 7                                 |
| Cache      | Redis 7                                                    |
| Storage    | MinIO (S3-kompatibel)                                      |
| Auth       | JWT (Access + Refresh Token) + optionales E-Mail-OTP (2FA) |
| Mailing    | Nodemailer (SMTP konfigurierbar per UI)                    |
| Deployment | Docker Compose (API + Web + Postgres + Redis + MinIO)      |
| Linting    | ESLint + Prettier + Husky pre-commit hooks                 |
| MCP        | Claude Code Integration (Clokr MCP Server)                 |

---

## Datenmodell (Prisma)

`Tenant` · `TenantConfig` · `User` · `RefreshToken` · `OtpToken` · `Invitation` · `Employee` · `WorkSchedule` · `TimeEntry` · `OvertimeAccount` · `OvertimeTransaction` · `OvertimePlan` · `LeaveType` · `LeaveEntitlement` · `LeaveRequest` · `Absence` · `PublicHoliday` · `AuditLog` · `Notification` · `ShiftTemplate` · `Shift` · `CompanyShutdown` · `CompanyShutdownException`

---

## Rollen

| Rolle         | Kürzel   | Rechte                                                            |
| ------------- | -------- | ----------------------------------------------------------------- |
| Administrator | ADMIN    | Alles inkl. MA-Verwaltung, Systemeinstellungen, Audit Log, Import |
| Manager       | MANAGER  | Urlaubsanträge genehmigen, Berichte, Schichtplanung               |
| Mitarbeiter   | EMPLOYEE | Eigene Zeiterfassung, Abwesenheiten, Überstunden                  |

---

## Authentifizierung (`/auth`)

| Endpunkt                     | Beschreibung                                                    |
| ---------------------------- | --------------------------------------------------------------- |
| `POST /auth/login`           | Login mit E-Mail + Passwort; bei aktiviertem 2FA → 202 + userId |
| `POST /auth/verify-otp`      | OTP-Code (6-stellig) prüfen → JWT ausstellen                    |
| `POST /auth/resend-otp`      | Neuen OTP-Code senden                                           |
| `POST /auth/refresh`         | Access-Token per Refresh-Token erneuern                         |
| `POST /auth/logout`          | Refresh-Token invalidieren                                      |
| `POST /auth/forgot-password` | Passwort-Reset-Link per E-Mail senden                           |
| `POST /auth/reset-password`  | Neues Passwort setzen (mit Reset-Token)                         |

**Frontend-Seiten:** `/login` · `/otp` · `/einladung?token=…` · `/forgot-password` · `/reset-password?token=…`

---

## Mitarbeiterverwaltung (`/employees`)

| Endpunkt                                | Beschreibung                                             |
| --------------------------------------- | -------------------------------------------------------- |
| `GET /employees`                        | Liste aller Mitarbeiter inkl. invitationStatus           |
| `POST /employees`                       | MA anlegen (mit/ohne Passwort) → optional Einladungsmail |
| `PATCH /employees/:id`                  | Profil bearbeiten (Name, Rolle, MA-Nr.)                  |
| `PATCH /employees/:id/deactivate`       | Deaktivieren + alle Tokens sperren                       |
| `POST /employees/:id/resend-invitation` | Einladungslink neu senden                                |
| `DELETE /employees/:id`                 | DSGVO-Hard-Delete (AuditLog anonymisiert)                |

**Frontend:** `/admin/employees` mit Suche + Rollen- + Statusfilter

**Anlage-Modi:**

1. Einladung per E-Mail (MA setzt eigenes Passwort)
2. Direkte Anlage mit voreingestelltem Passwort

---

## Zeiterfassung (`/time-entries`)

| Endpunkt                           | Beschreibung                       |
| ---------------------------------- | ---------------------------------- |
| `POST /time-entries/clock-in`      | Einstempeln                        |
| `POST /time-entries/:id/clock-out` | Ausstempeln                        |
| `GET /time-entries`                | Einträge abfragen (from/to Filter) |
| `POST /time-entries`               | Manuellen Eintrag anlegen          |
| `PUT /time-entries/:id`            | Eintrag bearbeiten                 |
| `DELETE /time-entries/:id`         | Eintrag löschen                    |

**Frontend:** `/time-entries` – Kalenderansicht mit Monatsnavigation, Tages-Detail mit Einträgen, ArbZG-Warnungen, Überstunden-Anzeige

---

## Abwesenheiten / Urlaub (`/leave`)

| Endpunkt                           | Beschreibung                              |
| ---------------------------------- | ----------------------------------------- |
| `POST /leave/requests`             | Antrag stellen                            |
| `GET /leave/requests`              | Anträge laden (eigene + alle für Manager) |
| `PATCH /leave/requests/:id/review` | Genehmigen / Ablehnen (Manager)           |
| `PATCH /leave/requests/:id`        | Antrag bearbeiten                         |
| `DELETE /leave/requests/:id`       | Antrag löschen / stornieren               |
| `PATCH /leave/requests/:id/attest` | Krankmeldungs-Attest erfassen             |
| `GET /leave/calendar`              | Kalenderansicht aller Abwesenheiten       |
| `GET /leave/ical/personal`         | iCal-Export eigene Abwesenheiten          |
| `GET /leave/ical/team`             | iCal-Export Team-Abwesenheiten (Manager)  |

**Abwesenheitstypen:** Urlaub · Überstundenausgleich · Sonderurlaub · Bildungsurlaub · Krankmeldung · Kinderkrank · Unbezahlter Urlaub · Mutterschutz · Elternzeit

**Frontend:** `/leave` – Kalender- + Listenansicht, Antragsformular, iCal-Export-Buttons, Filter nach Status + Art

---

## Überstundenkonto (`/overtime`)

| Endpunkt                    | Beschreibung                     |
| --------------------------- | -------------------------------- |
| `GET /overtime/:employeeId` | Kontostand + Transaktionsverlauf |
| `POST /overtime/plans`      | Überstundenplan anlegen          |
| `POST /overtime/payout`     | Auszahlung buchen                |

**Frontend:** `/overtime` – Balken-Anzeige, Verlaufstabelle mit Filter

---

## Schichtplanung (`/shifts`)

| Endpunkt                       | Beschreibung              |
| ------------------------------ | ------------------------- |
| `GET /shifts/templates`        | Schichtvorlagen laden     |
| `POST /shifts/templates`       | Vorlage erstellen         |
| `DELETE /shifts/templates/:id` | Vorlage löschen           |
| `GET /shifts/week`             | Wochenansicht laden       |
| `POST /shifts`                 | Schicht anlegen           |
| `POST /shifts/bulk`            | Mehrere Schichten anlegen |
| `DELETE /shifts/:id`           | Schicht löschen           |

**Frontend:** `/admin/shifts` – Wochengrid (Mitarbeiter × Tage), Vorlagenverwaltung, Quick-Assign

---

## Berichte (`/reports`)

| Endpunkt                          | Beschreibung                     |
| --------------------------------- | -------------------------------- |
| `GET /reports/monthly`            | Monatsauswertung pro Mitarbeiter |
| `GET /reports/monthly/pdf`        | PDF-Export Monatsbericht         |
| `GET /reports/leave-overview`     | Urlaubsübersicht                 |
| `GET /reports/leave-overview/pdf` | PDF-Export Urlaubsübersicht      |
| `GET /reports/datev`              | DATEV-Export (CSV)               |

**Frontend:** `/reports` – Monatsauswertung, DATEV-Download, PDF-Exporte

---

## Benachrichtigungen (`/notifications`)

| Endpunkt                        | Beschreibung                                     |
| ------------------------------- | ------------------------------------------------ |
| `GET /notifications`            | Letzte 50 Benachrichtigungen + ungelesene Anzahl |
| `PATCH /notifications/:id/read` | Als gelesen markieren                            |
| `PATCH /notifications/read-all` | Alle als gelesen markieren                       |

**Trigger:** Neuer Urlaubsantrag → Manager benachrichtigt · Genehmigung/Ablehnung → Mitarbeiter benachrichtigt

**Frontend:** Glocken-Icon in Sidebar mit Badge, Dropdown mit Benachrichtigungsliste, 60s Polling

---

## Bulk-Import (`/imports`)

| Endpunkt                     | Beschreibung                                     |
| ---------------------------- | ------------------------------------------------ |
| `POST /imports/employees`    | Mitarbeiter-CSV-Import (mit optionalem Passwort) |
| `POST /imports/time-entries` | Zeiteinträge-CSV-Import                          |

**Frontend:** `/admin/import` – CSV-Textarea, Vorschau-Tabelle, Ergebnis-Zusammenfassung

---

## Audit Log (`/audit-logs`)

| Endpunkt          | Beschreibung                                              |
| ----------------- | --------------------------------------------------------- |
| `GET /audit-logs` | Paginiert, filterbar nach Action/Entity/User (ADMIN only) |

**Frontend:** `/admin/audit` – Tabelle mit aufklappbaren JSON-Details (oldValue/newValue)

---

## Dashboard (`/dashboard`)

- Tagesübersicht: Einträge, Arbeitsstunden, offene Stempelung
- Wochenübersicht: IST vs. SOLL Stunden
- Überstundensaldo + Resturlaub
- Charts: Arbeitsstunden (6 Monate), Überstunden-Trend, Abwesenheiten
- **Team-Wochenübersicht** (nur ADMIN/MANAGER): Anwesenheit aller Mitarbeiter pro Wochentag
- Schnellzugriff-Karten

---

## Einstellungen (`/settings`)

| Endpunkt                                 | Beschreibung                                            |
| ---------------------------------------- | ------------------------------------------------------- |
| `GET/PUT /settings/work`                 | Globale Arbeitszeiten, Bundesland, Überstunden-Schwelle |
| `GET/PUT /settings/work/:employeeId`     | Individuelle Arbeitszeiten pro MA                       |
| `GET/PUT /settings/vacation/:employeeId` | Urlaubsanspruch + Übertrag-Frist                        |
| `GET/PUT /settings/smtp`                 | SMTP-Konfiguration                                      |
| `POST /settings/smtp/test`               | Testmail senden                                         |
| `GET/PUT /settings/security`             | 2FA-Toggle                                              |
| `GET/PUT /settings/timezone`             | Zeitzone pro Tenant                                     |

**Frontend-Admin-Bereich** (`/admin` – nur ADMIN/MANAGER):

| Unterseite         | Inhalt                                                          |
| ------------------ | --------------------------------------------------------------- |
| `/admin/employees` | MA-Tabelle mit Filtern, Anlegen/Bearbeiten/Deaktivieren/Löschen |
| `/admin/vacation`  | Globale + individuelle Arbeitszeiten, Urlaubsanspruch           |
| `/admin/system`    | Theme, Bundesland, Zeitzone, SMTP, 2FA                          |
| `/admin/shifts`    | Wochenbasierte Schichtplanung                                   |
| `/admin/import`    | CSV-Import (Mitarbeiter + Zeiteinträge)                         |
| `/admin/audit`     | Audit Log (nur ADMIN)                                           |

---

## UI / Frontend

### Themes

4 Farbschemas, umschaltbar unter Admin → System:

| Theme    | Farbe     | Beschreibung                    |
| -------- | --------- | ------------------------------- |
| Pflaume  | `#80377B` | Standard, warme Beige-Töne      |
| Nacht    | `#9D85F2` | Dark Mode, `color-scheme: dark` |
| Wald     | `#2D6A4F` | Naturgrün                       |
| Schiefer | `#1E3A5F` | Professionelles Navy            |

### Design-System

- CSS Custom Properties für Farben, Shadows, Radii
- `prefers-reduced-motion` Support
- `touch-action: manipulation` auf Interaktionselementen
- `font-variant-numeric: tabular-nums` auf Tabellen
- Skeleton-Loading-States
- Filter-Bar Utility-Klassen

### Navigation

- Desktop: feste Sidebar (240px) mit Clokr-Logo
- Mobile: Bottom Navigation Bar
- Admin-Bereich mit 6 Tab-Unterseiten

---

## MCP Server (Claude Code Integration)

Der Clokr MCP Server (`packages/mcp/`) ermöglicht die direkte Interaktion mit der Clokr API aus Claude Code heraus.

**Verfügbare Tools:**

| Tool                     | Beschreibung                    |
| ------------------------ | ------------------------------- |
| `login`                  | Bei Clokr API anmelden          |
| `dashboard`              | Dashboard-Daten abrufen         |
| `list_employees`         | Alle Mitarbeiter auflisten      |
| `list_time_entries`      | Zeiteinträge für Zeitraum laden |
| `clock_in` / `clock_out` | Ein-/Ausstempeln                |
| `list_shifts`            | Schichtplan der Woche           |
| `list_leave_requests`    | Abwesenheitsanträge             |
| `monthly_report`         | Monatsbericht                   |
| `overtime_account`       | Überstundenkonto                |
| `notifications`          | Benachrichtigungen              |
| `api_request`            | Beliebiger API-Aufruf           |

Konfiguration über `.mcp.json` im Projekt-Root. Startet automatisch in Claude Code.

---

## Zeitzonen & Sommer-/Winterzeit

- Zeitzone pro Tenant konfigurierbar (Standard: Europe/Berlin)
- Korrekte DST-Behandlung bei Monats-/Tagesberechnungen
- Alle Zeitstempel intern als UTC, Umrechnung bei Anzeige

---

## Noch nicht umgesetzt

- [ ] NFC-Karten-UI (API-Endpunkte vorhanden)
- [ ] Push-Benachrichtigungen (Web Push)
- [ ] Multi-Tenant UI (Datenmodell vorhanden, UI nur Single-Tenant)
- [ ] PWA / Mobile App
- [ ] Betriebsrat-Export
- [ ] i18n (aktuell nur Deutsch)
