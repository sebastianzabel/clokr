# Compliance & Rechtliche Grundlagen

Clokr ist als **revisionssichere** Zeiterfassung für den deutschen Rechtsraum konzipiert. Diese Seite dokumentiert alle implementierten gesetzlichen Prüfungen und Aufbewahrungsregeln.

> **Status:** Stand v1.4 (2026-05-11). Geprüft gegen den Code unter `apps/api/src/utils/arbzg.ts`, `apps/api/src/utils/vacation-calc.ts`, `apps/api/src/plugins/data-retention.ts`.

---

## § 3 / § 4 / § 5 ArbZG — Arbeitszeitprüfungen

Implementiert in [`apps/api/src/utils/arbzg.ts`](../apps/api/src/utils/arbzg.ts). Wird automatisch nach jedem TimeEntry-Insert/Update ausgeführt und liefert Warnungen an die UI zurück. Warnungen **blockieren das Speichern nicht** (Audit-Hinweis statt Hard-Block, damit Korrektur-Workflows möglich bleiben).

### Regelwerk

| Paragraph     | Regel                                                            | Implementierung                                                    | Severity        |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ | --------------- |
| **§ 3 ArbZG** | Tägliche Höchstarbeitszeit netto **10h absolut**                 | `if (netWorkedMin > 10 * 60)` → `MAX_DAILY_EXCEEDED`               | `error`         |
| **§ 3 ArbZG** | 8h-Regel = 24-Wochen-/6-Monats-Durchschnitt, **kein** Tageslimit | Keine Tageswarnung für 8–10h Tage — nur als Rolling-Average prüfen | `warning` (avg) |
| **§ 3 ArbZG** | Wöchentliche Höchstarbeitszeit **48h** (Mo–Sa = 6 Werktage)      | `if (weekMin > 48 * 60)` → `MAX_WEEKLY_EXCEEDED`                   | `error`         |
| **§ 4 ArbZG** | Bei **>6h** Arbeit: min. **30min Pause**                         | `if (netWorked > 6h && totalBreak < 30)` → `BREAK_TOO_SHORT`       | `warning`       |
| **§ 4 ArbZG** | Bei **>9h** Arbeit: min. **45min Pause**                         | `if (netWorked > 9h && totalBreak < 45)` → `BREAK_TOO_SHORT`       | `error`         |
| **§ 5 ArbZG** | **11h Mindestruhe** zwischen Arbeitsende und nächstem Beginn     | Prüfung gegen Vortag UND Folgetag                                  | `warning`       |

### Pausenzählung (`totalBreakMin`)

Eine Pause ist die Summe aus:

1. **Explizite Pausen:** `breakMinutes` jedes TimeEntry-Slots
2. **Implizite Gaps:** Lücken zwischen aufeinanderfolgenden Slots am selben Tag
   - Gap **> 0 und ≤ 2h** → zählt als Pause
   - Gap **> 2h** → gilt als separate Schicht, NICHT als Pause

### Auto-Break (opt-in pro Tenant)

Wenn `TenantConfig.autoBreakEnabled = true` und beim Clock-out **keine manuelle Pause eingetragen** wurde, setzt Clokr automatisch:

- `30min` bei >6h Arbeit
- `45min` bei >9h Arbeit

Eingefügt mittig in den Eintrag (oder zu `TenantConfig.defaultBreakStart`, falls gesetzt). Sobald MA bereits eine Pause eingegeben hat (z.B. nur 15min), greift Auto-Break NICHT — nur die ArbZG-Warnung erscheint.

### Bekanntes Edge-Case-Verhalten

**Bei eingetragener kürzerer Pause als gesetzlich vorgeschrieben:** ERROR-Warnung erscheint im Eintrag, aber Speichern wird zugelassen. Begründung: Korrektur-Workflow für Manager (z.B. Notfall, falsche Slot-Zeit) darf nicht hart blockiert werden. Der Verstoß ist im AuditLog dokumentiert und kann via Reports nachvollzogen werden.

---

## § 8 BUrlG — Urlaub & Zeiterfassung

Implementiert in [`apps/api/src/routes/leave.ts`](../apps/api/src/routes/leave.ts) und [`apps/api/src/utils/vacation-calc.ts`](../apps/api/src/utils/vacation-calc.ts).

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

### § 5 BUrlG — Juni-30-Regel (v1.4)

Bei Austritt nach dem 30. Juni: **voller Jahresanspruch** (statt 1/12-Regel der ersten Jahreshälfte). Implementiert in `vacation-calc.ts:applyJune30Rule()`.

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

Implementiert in [`apps/api/src/plugins/audit.ts`](../apps/api/src/plugins/audit.ts).

### Grundprinzipien

1. **Keine Hard-Deletes** auf TimeEntry, LeaveRequest, Absence, Employee → Soft-Delete via `deletedAt`
2. **Alle Mutationen** (CREATE/UPDATE/DELETE) erzeugen einen `AuditLog`-Eintrag mit:
   - `userId`, `tenantId`, `timestamp`, `ipAddress`, `userAgent`
   - `entity`, `entityId`, `action`
   - `oldValue` und `newValue` als JSONB
3. **Locked Months** (`MonthlyClose.isLocked`) sind nach Abschluss **immutable** — auch für Admins
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
| `LOCK_MONTH`, `UNLOCK_MONTH`                                               | MonthlyClose          | Monatsabschluss-Operationen      |

---

## Migrations- und Datenintegrität

- **Schema-Änderungen:** Prisma `db push` für dev, `prisma migrate` für Produktion (geplant, aktuell beides via push)
- **CASCADE-Verhalten:** Critical Relations (`Employee → TimeEntry`, `Employee → LeaveRequest`, `Employee → Absence`) verwenden `onDelete: Restrict` — verhindert versehentlichen Cascade-Delete
- **Soft-Delete-Queries:** ALLE Queries auf `TimeEntry`, `LeaveRequest`, `Absence` MÜSSEN `deletedAt: null` im `where` enthalten (Projektregel, enforced in Code-Reviews)

---

## Code-Referenzen

| Bereich                             | Datei                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| ArbZG-Prüfungen                     | `apps/api/src/utils/arbzg.ts`                                                      |
| ArbZG-Tests (33 Cases)              | `apps/api/src/routes/__tests__/arbzg.test.ts`                                      |
| Urlaubsberechnung                   | `apps/api/src/utils/vacation-calc.ts`                                              |
| Audit-Plugin                        | `apps/api/src/plugins/audit.ts`                                                    |
| Data-Retention (jährlich + täglich) | `apps/api/src/plugins/data-retention.ts`                                           |
| Auto-Break-Logik                    | `apps/api/src/routes/time-entries.ts` (Suche `autoBreakMin`)                       |
| WiFi-Presence (Opt-In, Webhook)     | `apps/api/src/routes/presence.ts`, `apps/api/src/routes/admin-presence-sources.ts` |
| Projektregeln                       | `CLAUDE.md` (Sektionen „Audit-Proof", „Data Retention", „ArbZG", „BUrlG")          |

---

## Disclaimer

Diese Dokumentation beschreibt den **implementierten Stand** von Clokr v1.4. Sie ersetzt keine rechtliche Beratung. Tenants sind selbst verantwortlich für die korrekte Konfiguration (Aufbewahrungsfristen, Bundesland, Arbeitszeitmodelle, Betriebsvereinbarungen).

Bei rechtlichen Änderungen (z.B. Anpassungen am ArbZG, neuen EuGH-Urteilen zu BUrlG) ist eine Code-Anpassung erforderlich — die Test-Suite (`pnpm --filter @clokr/api test arbzg`) dient als Regression-Schutz.
