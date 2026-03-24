# Clokr – Feature-Übersicht

> Stand: März 2026

---

## Stack

| Schicht | Technologie |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Frontend | SvelteKit + Svelte 5 (Runes), Port 5174 |
| Backend | Fastify 5, Port 4000 |
| Datenbank | PostgreSQL via Prisma 7 |
| Auth | JWT (Access + Refresh Token) + optionales E-Mail-OTP (2FA) |
| Mailing | Nodemailer (SMTP konfigurierbar per UI) |

---

## Datenmodell (Prisma)

`Tenant` · `TenantConfig` · `User` · `RefreshToken` · `OtpToken` · `Invitation` · `Employee` · `WorkSchedule` · `TimeEntry` · `OvertimeAccount` · `OvertimeTransaction` · `OvertimePlan` · `LeaveType` · `LeaveEntitlement` · `LeaveRequest` · `Absence` · `PublicHoliday` · `AuditLog`

---

## Rollen

| Rolle | Kürzel | Rechte |
|---|---|---|
| Administrator | ADMIN | Alles inkl. MA-Verwaltung, Systemeinstellungen |
| Manager | MANAGER | Urlaubsanträge genehmigen, Berichte, Admin-Bereich |
| Mitarbeiter | EMPLOYEE | Eigene Zeiterfassung, Abwesenheiten, Überstunden |

---

## Authentifizierung (`/auth`)

| Endpunkt | Beschreibung |
|---|---|
| `POST /auth/login` | Login mit E-Mail + Passwort; bei aktiviertem 2FA → 202 + userId |
| `POST /auth/verify-otp` | OTP-Code (6-stellig) prüfen → JWT ausstellen |
| `POST /auth/resend-otp` | Neuen OTP-Code senden |
| `POST /auth/refresh` | Access-Token per Refresh-Token erneuern |
| `POST /auth/logout` | Refresh-Token invalidieren |

**Frontend-Seiten:** `/login` · `/otp` · `/einladung?token=…`

---

## Mitarbeiterverwaltung (`/employees`)

| Endpunkt | Beschreibung |
|---|---|
| `GET /employees` | Liste aller Mitarbeiter inkl. invitationStatus |
| `POST /employees` | MA anlegen (kein Passwort) → Einladungsmail |
| `PATCH /employees/:id` | Profil bearbeiten (Name, Rolle, MA-Nr.) |
| `PATCH /employees/:id/deactivate` | Deaktivieren + alle Tokens sperren |
| `POST /employees/:id/resend-invitation` | Einladungslink neu senden |
| `DELETE /employees/:id` | DSGVO-Hard-Delete (AuditLog anonymisiert) |

**Frontend:** `/admin/employees` mit Suche + Rollen- + Statusfilter

**Einladungsflow:** Neuer MA bekommt E-Mail mit 24h-Link → setzt eigenes Passwort unter `/einladung?token=…`

---

## Zeiterfassung (`/time-entries`)

| Endpunkt | Beschreibung |
|---|---|
| `POST /time-entries/clock-in` | Einstempeln |
| `POST /time-entries/:id/clock-out` | Ausstempeln |
| `GET /time-entries` | Einträge abfragen (from/to Filter) |
| `POST /time-entries` | Manuellen Eintrag anlegen |
| `PUT /time-entries/:id` | Eintrag bearbeiten |
| `DELETE /time-entries/:id` | Eintrag löschen |

**Frontend:** `/time-entries` – Kalenderansicht mit Monatsnavigation, Tages-Detail mit Einträgen, ArbZG-Warnungen, Überstunden-Anzeige

---

## Abwesenheiten / Urlaub (`/leave`)

| Endpunkt | Beschreibung |
|---|---|
| `POST /leave/requests` | Antrag stellen |
| `GET /leave/requests` | Anträge laden (eigene + alle für Manager) |
| `PATCH /leave/requests/:id/review` | Genehmigen / Ablehnen (Manager) |
| `PATCH /leave/requests/:id` | Antrag bearbeiten |
| `DELETE /leave/requests/:id` | Antrag löschen / stornieren |
| `PATCH /leave/requests/:id/attest` | Krankmeldungs-Attest erfassen |
| `GET /leave/calendar` | Kalenderansicht aller Abwesenheiten |
| `GET /leave/hours-preview` | Stunden-Vorschau für Antragsformular |
| `GET /leave/overtime-balance` | Überstundensaldo für Ausgleich |
| `GET /leave/entitlements/:employeeId` | Urlaubsanspruch laden |
| `GET /leave/overlap` | Überschneidungen prüfen |

**Abwesenheitstypen:** Urlaub · Überstundenausgleich · Sonderurlaub · Bildungsurlaub · Krankmeldung · Kinderkrank · Unbezahlter Urlaub

**Frontend:** `/leave` – Kalender- + Listenansicht, Antragsformular mit Stunden-Preview + Überschneidungswarnung, Urlaubskonto-Zusammenfassung, Filter nach Status + Art

---

## Überstundenkonto (`/overtime`)

| Endpunkt | Beschreibung |
|---|---|
| `GET /overtime/:employeeId` | Kontostand + Transaktionsverlauf |
| `POST /overtime/plans` | Überstundenplan anlegen |
| `POST /overtime/payout` | Auszahlung buchen |

**Status:** NORMAL · ELEVATED · CRITICAL (konfigurierbare Schwelle)

**Frontend:** `/overtime` – Balken-Anzeige, Verlaufstabelle mit Filter nach Buchungsart

---

## Berichte (`/reports`)

| Endpunkt | Beschreibung |
|---|---|
| `GET /reports/monthly` | Monatsauswertung pro Mitarbeiter |
| `GET /reports/leave-overview` | Urlaubsübersicht |
| `GET /reports/datev` | DATEV-Export (CSV) |

**Frontend:** `/reports`

---

## Einstellungen (`/settings`)

| Endpunkt | Beschreibung |
|---|---|
| `GET/PUT /settings/work` | Globale Arbeitszeiten, Bundesland, Überstunden-Schwelle |
| `GET/PUT /settings/work/:employeeId` | Individuelle Arbeitszeiten pro MA |
| `GET/PUT /settings/vacation/:employeeId` | Urlaubsanspruch + Übertrag-Frist |
| `GET/PUT /settings/smtp` | SMTP-Konfiguration |
| `POST /settings/smtp/test` | Testmail senden |
| `GET/PUT /settings/security` | 2FA-Toggle |
| `GET /settings/employees` | Mitarbeiterliste für Dropdown |

**Frontend-Admin-Bereich** (`/admin` – nur ADMIN/MANAGER):

| Unterseite | Inhalt |
|---|---|
| `/admin/employees` | MA-Tabelle mit Filtern, Anlegen/Bearbeiten/Deaktivieren/Löschen |
| `/admin/vacation` | Globale + individuelle Arbeitszeiten, Urlaubsanspruch pro MA |
| `/admin/system` | Theme-Auswahl, Bundesland, SMTP, 2FA-Toggle |

---

## Feiertage (`/holidays`)

- `GET /holidays?year=…` – gesetzliche Feiertage per Bundesland (konfiguriert in TenantConfig)
- 16 Bundesländer unterstützt

---

## Einladungs-Flow (`/invitations`)

- `POST /invitations/accept` – Token prüfen, Passwort setzen, Account aktivieren
- Token: 32-Byte-Hex, 24h gültig, Einmal-Nutzung

---

## UI / Frontend

### Themes
4 Farbschemas, umschaltbar unter Admin → System:

| Theme | Farbe | Beschreibung |
|---|---|---|
| Pflaume | `#80377B` | Standard, warme Beige-Töne |
| Nacht | `#9D85F2` | Dark Mode, `color-scheme: dark` |
| Wald | `#2D6A4F` | Naturgrün |
| Schiefer | `#1E3A5F` | Professionelles Navy |

Theme wird in `localStorage` gespeichert.

### Design-System (`app.css`)
- CSS Custom Properties für alle Farben, Shadows, Radii
- Easing-Variablen (`--ease-out`, `--spring` etc.)
- `prefers-reduced-motion` Support
- `touch-action: manipulation` auf allen Interaktionselementen
- `font-variant-numeric: tabular-nums` auf Tabellen-Zellen
- `text-wrap: balance` auf Headings
- Skeleton-Loading-States
- Filter-Bar Utility-Klassen (`.filter-bar`, `.filter-search`, `.filter-select`, `.filter-count`)

### Navigation
- Desktop: feste Sidebar (240px)
- Mobile: Bottom Navigation Bar
- Admin-Bereich mit 3 Tab-Unterseiten (nur ADMIN/MANAGER sichtbar)

---

## Noch nicht umgesetzt (aus ursprünglichem Plan)

- [ ] NFC-Karten-Unterstützung (Endpunkte vorbereitet, kein Frontend)
- [ ] Push-Benachrichtigungen
- [ ] Multi-Tenant (Datenmodell vorhanden, aber UI nur Single-Tenant)
- [ ] Passwort-Reset-Flow (nur Einladungsflow, kein "Passwort vergessen")
- [ ] Mobile App / PWA
