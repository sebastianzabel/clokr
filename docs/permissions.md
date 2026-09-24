# Permission-Katalog: Ressource × Aktion × Reichweite

**Status:** gültig ab Phase 72b (Issue #72)
**Codestand der Belege:** `main` @ `bea6b5c7`

Alle Datei- und Zeilenangaben in diesem Dokument beziehen sich auf diesen Commit. Sie sind Belege,
keine Wegbeschreibung — in einem späteren Stand kann die Zeile verschoben sein, die Zuordnung muss
es nicht. Der Vollständigkeitstest (`apps/api/src/__tests__/permission-site-mapping.test.ts`)
vergleicht deshalb die ANZAHL der Stellen pro Datei mit der Anzahl der Zeilen in diesem Dokument,
nicht die Zeilennummern: Kommt eine Stelle hinzu oder fällt eine weg, wird er rot; eine reine
Verschiebung um ein paar Zeilen lässt ihn grün.

---

## Zweck

Der Katalog selbst ist Code: `apps/api/src/contexts/platform/permission-catalog.ts`, exportiert über
`contexts/platform/index.ts`. Er zählt jede Berechtigung als Tripel Ressource × Aktion × Reichweite
auf — keine Tabelle, keine Migration.

Dieses Dokument ordnet jeder heutigen Rollenprüfung genau eine Permission zu: jeder Aufrufstelle von
`requireRole` und jeder Rollenprüfung im Handler. Nur mit dieser Zuordnung kann #75 die Aufrufstellen
rechteneutral auf Permissions umstellen. Die 58 Routen, die nur eine Anmeldung verlangen
(`requireAuth`), stehen nicht einzeln hier: Sie bedienen die eigenen Daten des angemeldeten
Mitarbeiters und sind durch die `EIGENE`-Permissions abgedeckt. Wo eine solche Route im Handler
nach Rolle unterscheidet, steht diese Prüfung einzeln im Abschnitt „Handler-Prüfungen“.

Nicht Teil dieses Dokuments: Rollen als Bündel von Permissions (#73), Zuweisung und Scope (#74), die
Umstellung der Aufrufstellen (#75) und die Durchsetzung des Scopes (#91).

## Dimensionen

Jede Permission hat drei Dimensionen:

- **Ressource** — der fachliche Gegenstand, z. B. `time-entry`, `leave-request`, `tenant-settings`.
  Jede Ressource gehört zu genau einem Kontext (ADR 0001).
- **Aktion** — was mit der Ressource geschieht, z. B. `read`, `update`, `approve`, `close-year`.
- **Reichweite** — `EIGENE` erlaubt die Aktion nur auf den eigenen Daten des angemeldeten
  Mitarbeiters; `ZUGEWIESEN` erlaubt sie auf allen Daten im Scope der Rollenzuweisung (#74). Es gibt
  genau diese zwei Werte.

Zusätzlich hat jede Ressource einen **Bezug**: `PERSON` (die Daten gehören einem Mitarbeiter) oder
`MANDANT` (die Daten gelten für den ganzen Mandanten, z. B. Einstellungen, Feiertage, API-Schlüssel).
Mandant-Ressourcen gibt es nur mit `ZUGEWIESEN`, und sie wirken nur bei einer Zuweisung mit Scope
Mandant (Durchsetzung: #91).

`contract`, `overtime` und `month-close` sind bewusst eigene Ressourcen und nicht Teil von
`time-entry`: Wer Zeiteinträge lesen darf, sieht damit noch keine Vertragsdaten und keinen Saldo
(#76, Datenminimierung nach DSGVO Art. 5 Abs. 1 lit. c).

## Aufrufstellen von requireRole

Jede Zeile ist eine Aufrufstelle des Rollen-Guards `requireRole` (`middleware/auth.ts`). Pfade sind
relativ zu `apps/api/src/`; die Route steht ohne das Präfix aus `app.ts`. Die Spalte „heute“ nennt
die Rollen, die der Guard heute durchlässt: `A` = ADMIN, `M` = MANAGER, `E` = EMPLOYEE.

| Stelle                                                     | Route                                      | heute   | Permission                     | Reichweite                                   |
| ---------------------------------------------------------- | ------------------------------------------ | ------- | ------------------------------ | -------------------------------------------- |
| `composition/dashboard.ts:347`                             | `GET /team-week`                           | A, M    | `team-overview:read`           | ZUGEWIESEN                                   |
| `composition/dashboard.ts:575`                             | `GET /today-attendance`                    | A, M    | `team-overview:read`           | ZUGEWIESEN                                   |
| `composition/dashboard.ts:752`                             | `GET /overtime-overview`                   | A, M    | `team-overview:read`           | ZUGEWIESEN                                   |
| `composition/reports.ts:924`                               | `GET /monthly`                             | A, M    | `report:read`                  | ZUGEWIESEN                                   |
| `composition/reports.ts:1023`                              | `GET /leave-overview`                      | A, M    | `report:read`                  | ZUGEWIESEN                                   |
| `composition/reports.ts:1068`                              | `GET /carryover-at-risk`                   | A, M    | `report:read`                  | ZUGEWIESEN                                   |
| `composition/reports.ts:1151`                              | `POST /carryover-warn`                     | A, M    | `report:notify`                | ZUGEWIESEN                                   |
| `composition/reports.ts:1191`                              | `GET /datev`                               | A, M    | `report:export`                | ZUGEWIESEN                                   |
| `composition/reports.ts:1322`                              | `GET /datev/employee`                      | A, M    | `report:export`                | ZUGEWIESEN                                   |
| `composition/reports.ts:1562`                              | `GET /monthly/pdf/all`                     | A, M    | `report:export`                | ZUGEWIESEN                                   |
| `composition/reports.ts:1689`                              | `GET /leave-list/pdf`                      | A, M    | `report:export`                | ZUGEWIESEN                                   |
| `composition/reports.ts:1770`                              | `GET /vacation/pdf`                        | A, M    | `report:export`                | ZUGEWIESEN                                   |
| `composition/reports.ts:1902`                              | `GET /leave-overview/pdf`                  | A, M    | `report:export`                | ZUGEWIESEN                                   |
| `contexts/absence/api/company-shutdowns.ts:47`             | `POST /`                                   | A       | `company-shutdown:manage`      | ZUGEWIESEN                                   |
| `contexts/absence/api/company-shutdowns.ts:80`             | `PATCH /:id`                               | A       | `company-shutdown:manage`      | ZUGEWIESEN                                   |
| `contexts/absence/api/company-shutdowns.ts:124`            | `DELETE /:id`                              | A       | `company-shutdown:manage`      | ZUGEWIESEN                                   |
| `contexts/absence/api/company-shutdowns.ts:147`            | `POST /:id/exceptions`                     | A       | `company-shutdown:manage`      | ZUGEWIESEN                                   |
| `contexts/absence/api/company-shutdowns.ts:185`            | `DELETE /:id/exceptions/:employeeId`       | A       | `company-shutdown:manage`      | ZUGEWIESEN                                   |
| `contexts/absence/api/leave-settings.ts:26`                | `GET /vacation/:employeeId`                | A, M    | `leave-entitlement:read`       | ZUGEWIESEN                                   |
| `contexts/absence/api/leave-settings.ts:74`                | `PUT /vacation/:employeeId`                | A, M    | `leave-entitlement:update`     | ZUGEWIESEN                                   |
| `contexts/absence/api/leave-settings.ts:196`               | `GET /leave-types`                         | A, M    | `leave-config:read`            | ZUGEWIESEN                                   |
| `contexts/absence/api/leave-settings.ts:206`               | `PUT /leave-types/:id`                     | A       | `leave-config:manage`          | ZUGEWIESEN                                   |
| `contexts/absence/api/leave.ts:963`                        | `PATCH /requests/:id/review`               | A, M    | `leave-request:approve`        | ZUGEWIESEN                                   |
| `contexts/absence/api/leave.ts:1745`                       | `PATCH /requests/:id/correct`              | A, M    | `leave-request:correct`        | ZUGEWIESEN                                   |
| `contexts/absence/api/leave.ts:2153`                       | `PATCH /requests/:id/attest`               | A, M    | `leave-request:attest`         | ZUGEWIESEN                                   |
| `contexts/absence/api/leave.ts:2587`                       | `GET /ical/team`                           | A, M    | `leave-request:read`           | ZUGEWIESEN                                   |
| `contexts/absence/api/leave.ts:3001`                       | `POST /section9/:id/confirm`               | A, M    | `section9:decide`              | ZUGEWIESEN                                   |
| `contexts/absence/api/leave.ts:3264`                       | `POST /section9/:id/reject`                | A, M    | `section9:decide`              | ZUGEWIESEN                                   |
| `contexts/absence/api/leave.ts:3342`                       | `POST /section9/:id/reopen`                | A, M    | `section9:decide`              | ZUGEWIESEN                                   |
| `contexts/absence/api/special-leave.ts:96`                 | `POST /rules`                              | A       | `leave-config:manage`          | ZUGEWIESEN                                   |
| `contexts/absence/api/special-leave.ts:129`                | `PUT /rules/:id`                           | A       | `leave-config:manage`          | ZUGEWIESEN                                   |
| `contexts/absence/api/special-leave.ts:173`                | `DELETE /rules/:id`                        | A       | `leave-config:manage`          | ZUGEWIESEN                                   |
| `contexts/absence/api/vocational-school-pattern.ts:168`    | `PUT /:id/vocational-school-pattern`       | A, M    | `vocational-school:manage`     | ZUGEWIESEN                                   |
| `contexts/absence/api/vocational-school.ts:125`            | `POST /generate`                           | A, M    | `vocational-school:manage`     | ZUGEWIESEN                                   |
| `contexts/absence/api/vocational-school.ts:147`            | `GET /preview`                             | A, M    | `vocational-school:manage`     | ZUGEWIESEN                                   |
| `contexts/absence/api/vocational-school.ts:190`            | `GET /upcoming`                            | A, M, E | `vocational-school:read`       | ZUGEWIESEN; EIGENE über Handler-Prüfung :199 |
| `contexts/absence/api/vocational-school.ts:261`            | `POST /manual-insert`                      | A, M    | `vocational-school:manage`     | ZUGEWIESEN                                   |
| `contexts/absence/api/vocational-school.ts:387`            | `DELETE /:absenceId`                       | A, M    | `vocational-school:manage`     | ZUGEWIESEN                                   |
| `contexts/absence/api/vocational-school.ts:480`            | `GET /retroactive-preview`                 | A, M    | `vocational-school:manage`     | ZUGEWIESEN                                   |
| `contexts/absence/api/vocational-school.ts:522`            | `POST /retroactive-apply`                  | A, M    | `vocational-school:manage`     | ZUGEWIESEN                                   |
| `contexts/platform/api/admin/school-holidays.ts:26`        | `GET /`                                    | A       | `holiday:manage`               | ZUGEWIESEN                                   |
| `contexts/platform/api/admin/school-holidays.ts:48`        | `POST /refresh`                            | A       | `holiday:manage`               | ZUGEWIESEN                                   |
| `contexts/platform/api/api-keys.ts:28`                     | `GET /`                                    | A       | `api-key:manage`               | ZUGEWIESEN                                   |
| `contexts/platform/api/api-keys.ts:52`                     | `POST /`                                   | A       | `api-key:manage`               | ZUGEWIESEN                                   |
| `contexts/platform/api/api-keys.ts:91`                     | `DELETE /:id`                              | A       | `api-key:manage`               | ZUGEWIESEN                                   |
| `contexts/platform/api/api-keys.ts:121`                    | `GET /scopes`                              | A       | `api-key:manage`               | ZUGEWIESEN                                   |
| `contexts/platform/api/audit-logs.ts:19`                   | `GET /`                                    | A       | `audit-log:read`               | ZUGEWIESEN                                   |
| `contexts/platform/api/audit-logs.ts:51`                   | `GET /:id`                                 | A       | `audit-log:read`               | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:263`                   | `GET /`                                    | A, M    | `employee:read`                | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:338`                   | `POST /`                                   | A       | `employee:create`              | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:525`                   | `PATCH /:id`                               | A       | `employee:update`              | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:758`                   | `PATCH /:id/unlock`                        | A       | `employee:manage-access`       | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:797`                   | `PATCH /:id/deactivate`                    | A       | `employee:manage-access`       | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:856`                   | `PATCH /:id/reactivate`                    | A       | `employee:manage-access`       | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:917`                   | `POST /:id/resend-invitation`              | A       | `employee:manage-access`       | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:977`                   | `DELETE /:id`                              | A       | `employee:anonymize`           | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:1065`                  | `POST /:id/hard-delete/authorize`          | A       | `employee:anonymize`           | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:1096`                  | `DELETE /:id/hard-delete`                  | A       | `employee:anonymize`           | ZUGEWIESEN                                   |
| `contexts/platform/api/holidays.ts:105`                    | `POST /`                                   | A       | `holiday:manage`               | ZUGEWIESEN                                   |
| `contexts/platform/api/holidays.ts:163`                    | `DELETE /:id`                              | A       | `holiday:manage`               | ZUGEWIESEN                                   |
| `contexts/platform/api/imports.ts:74`                      | `POST /employees`                          | A       | `employee:import`              | ZUGEWIESEN                                   |
| `contexts/platform/api/imports.ts:176`                     | `POST /time-entries`                       | A       | `time-entry:import`            | ZUGEWIESEN                                   |
| `contexts/platform/api/settings.ts:637`                    | `PUT /work`                                | A       | `tenant-settings:update`       | ZUGEWIESEN                                   |
| `contexts/platform/api/settings.ts:937`                    | `PUT /work/:employeeId`                    | A, M    | `contract:update`              | ZUGEWIESEN                                   |
| `contexts/platform/api/settings.ts:1247`                   | `GET /smtp`                                | A       | `tenant-settings:read`         | ZUGEWIESEN                                   |
| `contexts/platform/api/settings.ts:1266`                   | `PUT /smtp`                                | A       | `tenant-settings:update`       | ZUGEWIESEN                                   |
| `contexts/platform/api/settings.ts:1326`                   | `POST /smtp/test`                          | A       | `tenant-settings:update`       | ZUGEWIESEN                                   |
| `contexts/platform/api/settings.ts:1342`                   | `GET /security`                            | A       | `tenant-settings:read`         | ZUGEWIESEN                                   |
| `contexts/platform/api/settings.ts:1353`                   | `PUT /security`                            | A       | `tenant-settings:update`       | ZUGEWIESEN                                   |
| `contexts/platform/api/settings.ts:1384`                   | `GET /work/:employeeId/history`            | A, M    | `contract:read`                | ZUGEWIESEN                                   |
| `contexts/platform/api/settings.ts:1419`                   | `GET /employees`                           | A, M    | `employee:read`                | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:119`              | `GET /phorest/config`                      | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:146`              | `PUT /phorest/config`                      | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:200`              | `POST /phorest/test`                       | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:277`              | `GET /phorest/staff`                       | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:351`              | `GET /phorest/mappings`                    | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:372`              | `POST /phorest/mappings`                   | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:435`              | `DELETE /phorest/mappings/:phorestStaffId` | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:467`              | `GET /phorest/sync-runs`                   | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:492`              | `POST /phorest/sync-shifts`                | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shift-patterns.ts:70`             | `PUT /:id/shift-patterns`                  | A, M    | `shift-pattern:update`         | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shift-patterns.ts:170`            | `GET /tenant`                              | A, M    | `shift-pattern:read`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:592`                    | `POST /templates`                          | A       | `shift-config:manage`          | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:613`                    | `PUT /templates/:id`                       | A       | `shift-config:manage`          | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:646`                    | `DELETE /templates/:id`                    | A       | `shift-config:manage`          | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:682`                    | `POST /coverage-rules`                     | A       | `shift-config:manage`          | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:716`                    | `PUT /coverage-rules/:id`                  | A       | `shift-config:manage`          | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:752`                    | `DELETE /coverage-rules/:id`               | A       | `shift-config:manage`          | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:793`                    | `GET /week`                                | A, M    | `shift:read`                   | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:1749`                   | `POST /`                                   | A, M    | `shift:plan`                   | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:2049`                   | `PUT /:id`                                 | A, M    | `shift:plan`                   | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:2390`                   | `POST /generate-week`                      | A, M    | `shift:plan`                   | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:2731`                   | `POST /copy-week`                          | A, M    | `shift:plan`                   | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:3061`                   | `POST /bulk`                               | A, M    | `shift:plan`                   | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:3144`                   | `DELETE /:id`                              | A, M    | `shift:plan`                   | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:3232`                   | `GET /conflicts`                           | A, M    | `shift:read`                   | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:3279`                   | `POST /:id/restore`                        | A, M    | `shift:plan`                   | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/admin-presence-sources.ts:16`  | `GET /opted-in`                            | A       | `presence-source:manage`       | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/admin-presence-sources.ts:40`  | `GET /`                                    | A       | `presence-source:manage`       | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/admin-presence-sources.ts:63`  | `POST /`                                   | A       | `presence-source:manage`       | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/admin-presence-sources.ts:113` | `PATCH /:id`                               | A       | `presence-source:manage`       | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/admin-presence-sources.ts:187` | `DELETE /:id`                              | A       | `presence-source:manage`       | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/admin-presence-sources.ts:219` | `GET /:id/devices`                         | A       | `presence-source:manage`       | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/admin-presence-sources.ts:330` | `POST /:id/devices/:mac/assign`            | A       | `presence-source:manage`       | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/admin-presence-sources.ts:417` | `DELETE /:id/devices/:mac`                 | A       | `presence-source:manage`       | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/retro-entry-requests.ts:176`   | `GET /`                                    | A, M    | `retro-request:read`           | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/terminals.ts:14`               | `GET /`                                    | A       | `terminal:manage`              | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/terminals.ts:35`               | `POST /`                                   | A       | `terminal:manage`              | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/terminals.ts:126`              | `DELETE /:id`                              | A       | `terminal:manage`              | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/time-entries.ts:1849`          | `PATCH /:id/revalidate`                    | A, M    | `time-entry:revalidate`        | ZUGEWIESEN                                   |
| `contexts/working-time-account/api/overtime.ts:240`        | `POST /plans`                              | A, M    | `overtime:settle`              | ZUGEWIESEN                                   |
| `contexts/working-time-account/api/overtime.ts:286`        | `POST /payout`                             | A, M    | `overtime:settle`              | ZUGEWIESEN                                   |
| `contexts/working-time-account/api/overtime.ts:405`        | `GET /close-month/deferred`                | A, M    | `month-close:read`             | ZUGEWIESEN                                   |
| `contexts/working-time-account/api/overtime.ts:420`        | `GET /close-month/status`                  | A, M    | `month-close:read`             | ZUGEWIESEN                                   |
| `contexts/working-time-account/api/overtime.ts:655`        | `GET /close-month/year-status`             | A, M    | `month-close:read`             | ZUGEWIESEN                                   |
| `contexts/working-time-account/api/overtime.ts:962`        | `POST /close-month`                        | A, M    | `month-close:close`            | ZUGEWIESEN                                   |
| `contexts/working-time-account/api/overtime.ts:1423`       | `POST /unlock-month`                       | A       | `month-close:unlock`           | ZUGEWIESEN                                   |
| `contexts/working-time-account/api/overtime.ts:1542`       | `POST /close-year`                         | A       | `month-close:close-year`       | ZUGEWIESEN                                   |
| `contexts/working-time-account/api/overtime.ts:1716`       | `POST /opening-balance`                    | A       | `overtime:set-opening-balance` | ZUGEWIESEN                                   |

## Handler-Prüfungen

Diese Prüfungen stehen im Handler selbst. Die meisten entscheiden, ob der Aufrufer die Aktion auf
allen Daten ausführen darf (`ZUGEWIESEN`) oder nur auf seinen eigenen (`EIGENE`); die Zeilen mit
nur `ZUGEWIESEN` schalten eine Funktion ganz frei oder ab.

| Stelle                                                   | Route                                             | heute                                         | Permission               | Reichweite               |
| -------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------- | ------------------------ | ------------------------ |
| `composition/activity.ts:67`                             | `GET /`                                           | nur A: Audit-Feed                             | `audit-log:read`         | ZUGEWIESEN               |
| `composition/activity.ts:212`                            | `GET /`                                           | nur M: Team-Ereignisse                        | `team-overview:read`     | ZUGEWIESEN               |
| `composition/dashboard.ts:1033`                          | `GET /open-items`                                 | A, M: Team-Posten; E: nur eigene Posten       | `team-overview:read`     | ZUGEWIESEN               |
| `composition/reports.ts:1449`                            | `GET /monthly/pdf`                                | A, M: alle; E: nur eigenes PDF                | `report:export`          | ZUGEWIESEN; sonst EIGENE |
| `contexts/absence/api/leave.ts:335`                      | Helfer canSeeLeaveType, genutzt in :946 und :2331 | A, M: Art sichtbar; E: nur bei eigenem Antrag | `leave-request:read`     | ZUGEWIESEN; sonst EIGENE |
| `contexts/absence/api/leave.ts:351`                      | `POST /requests`                                  | A, M: auch für andere; E: nur für sich        | `leave-request:create`   | ZUGEWIESEN; sonst EIGENE |
| `contexts/absence/api/leave.ts:785`                      | `GET /requests`                                   | A, M: alle; E: nur eigene                     | `leave-request:read`     | ZUGEWIESEN; sonst EIGENE |
| `contexts/absence/api/leave.ts:946`                      | `GET /overlap`                                    | A, M: Art sichtbar; E: Art verborgen          | `leave-request:read`     | ZUGEWIESEN; sonst EIGENE |
| `contexts/absence/api/leave.ts:2106`                     | `DELETE /requests/:id`                            | A, M: alle; E: nur eigene                     | `leave-request:cancel`   | ZUGEWIESEN; sonst EIGENE |
| `contexts/absence/api/leave.ts:2331`                     | `GET /calendar`                                   | A, M: Art sichtbar; E: nur bei eigenem Antrag | `leave-request:read`     | ZUGEWIESEN; sonst EIGENE |
| `contexts/absence/api/leave.ts:2678`                     | `GET /entitlements/:employeeId`                   | A, M: alle; E: nur eigene                     | `leave-entitlement:read` | ZUGEWIESEN; sonst EIGENE |
| `contexts/absence/api/leave.ts:2860`                     | `GET /section9`                                   | A, M: alle; E: nur eigene                     | `section9:read`          | ZUGEWIESEN; sonst EIGENE |
| `contexts/absence/api/leave.ts:2921`                     | `GET /section9/:id`                               | A, M: alle; E: nur eigene                     | `section9:read`          | ZUGEWIESEN; sonst EIGENE |
| `contexts/absence/api/section9-documents.ts:73`          | `POST /:creditId`                                 | A, M: alle; E: nur eigene                     | `section9:upload`        | ZUGEWIESEN; sonst EIGENE |
| `contexts/absence/api/section9-documents.ts:195`         | `GET /:creditId`                                  | A, M: alle; E: nur eigene                     | `section9:read`          | ZUGEWIESEN; sonst EIGENE |
| `contexts/absence/api/vocational-school-pattern.ts:136`  | `GET /:id/vocational-school-pattern`              | A, M: alle; E: nur eigene                     | `vocational-school:read` | ZUGEWIESEN; sonst EIGENE |
| `contexts/absence/api/vocational-school.ts:199`          | `GET /upcoming`                                   | A, M: alle; E: nur eigene                     | `vocational-school:read` | ZUGEWIESEN; sonst EIGENE |
| `contexts/platform/api/avatars.ts:18`                    | `POST /:employeeId`                               | A, M: alle; E: nur eigenes Bild               | `employee:update-avatar` | ZUGEWIESEN; sonst EIGENE |
| `contexts/platform/api/avatars.ts:141`                   | `DELETE /:employeeId`                             | A, M: alle; E: nur eigenes Bild               | `employee:update-avatar` | ZUGEWIESEN; sonst EIGENE |
| `contexts/platform/api/employees.ts:271`                 | `GET /`                                           | nur A: Anonymisierte einblenden               | `employee:anonymize`     | ZUGEWIESEN               |
| `contexts/platform/api/employees.ts:308`                 | `GET /:id`                                        | A, M: alle; E: nur eigene                     | `employee:read`          | ZUGEWIESEN; sonst EIGENE |
| `contexts/platform/api/settings.ts:894`                  | `GET /work/:employeeId`                           | A, M: alle; E: nur eigene                     | `contract:read`          | ZUGEWIESEN; sonst EIGENE |
| `contexts/scheduling/api/availability.ts:125`            | `GET /:id/availability`                           | A, M: alle; E: nur eigene                     | `availability:read`      | ZUGEWIESEN; sonst EIGENE |
| `contexts/scheduling/api/availability.ts:165`            | `PUT /:id/availability`                           | A, M: alle; E: nur eigene                     | `availability:update`    | ZUGEWIESEN; sonst EIGENE |
| `contexts/scheduling/api/integrations.ts:545`            | `GET /phorest/appointment-collisions`             | A, M: alle; E: nur eigene                     | `shift:read`             | ZUGEWIESEN; sonst EIGENE |
| `contexts/scheduling/api/shift-patterns.ts:43`           | `GET /:id/shift-patterns`                         | A, M: alle; E: nur eigene                     | `shift-pattern:read`     | ZUGEWIESEN; sonst EIGENE |
| `contexts/scheduling/api/shifts.ts:1672`                 | `GET /range`                                      | A, M: alle; E: nur eigene                     | `shift:read`             | ZUGEWIESEN; sonst EIGENE |
| `contexts/time-tracking/api/retro-entry-requests.ts:94`  | `POST /`                                          | A, M: auch für andere; E: nur für sich        | `retro-request:create`   | ZUGEWIESEN; sonst EIGENE |
| `contexts/time-tracking/api/retro-entry-requests.ts:264` | `PATCH /:id/review`                               | nur A, M                                      | `retro-request:approve`  | ZUGEWIESEN               |
| `contexts/time-tracking/api/time-entries.ts:424`         | `POST /clock-in`                                  | A, M: auch für andere; E: nur für sich        | `time-entry:create`      | ZUGEWIESEN; sonst EIGENE |
| `contexts/time-tracking/api/time-entries.ts:757`         | `POST /:id/breaks`                                | A, M: alle; E: nur eigene                     | `time-entry:update`      | ZUGEWIESEN; sonst EIGENE |
| `contexts/time-tracking/api/time-entries.ts:833`         | `GET /`                                           | A, M: alle; E: nur eigene                     | `time-entry:read`        | ZUGEWIESEN; sonst EIGENE |
| `contexts/time-tracking/api/time-entries.ts:893`         | `POST /`                                          | A, M: auch für andere; E: nur für sich        | `time-entry:create`      | ZUGEWIESEN; sonst EIGENE |
| `contexts/time-tracking/api/time-entries.ts:1399`        | `PUT /:id`                                        | A, M: alle; E: nur eigene                     | `time-entry:update`      | ZUGEWIESEN; sonst EIGENE |
| `contexts/time-tracking/api/time-entries.ts:1950`        | `DELETE /:id`                                     | A, M: alle; E: nur eigene                     | `time-entry:delete`      | ZUGEWIESEN; sonst EIGENE |
| `contexts/time-tracking/api/time-entries.ts:2058`        | `PATCH /:id/break-status`                         | A, M: alle; E: nur eigene                     | `time-entry:update`      | ZUGEWIESEN; sonst EIGENE |
| `contexts/working-time-account/api/overtime.ts:135`      | `GET /:employeeId`                                | A, M: alle; E: nur eigene                     | `overtime:read`          | ZUGEWIESEN; sonst EIGENE |
| `contexts/working-time-account/api/overtime.ts:1508`     | `GET /snapshots/:employeeId`                      | A, M: alle; E: nur eigene                     | `overtime:read`          | ZUGEWIESEN; sonst EIGENE |
| `contexts/working-time-account/api/overtime.ts:1862`     | `GET /month-saldo/:employeeId`                    | A, M: alle; E: nur eigene                     | `overtime:read`          | ZUGEWIESEN; sonst EIGENE |

## Nicht gezählte Treffer

Die Suche nach Handler-Prüfungen ist bewusst breit: Sie findet jede Zeile, die `user.role` liest
oder `role` vergleicht. Die folgenden Treffer treffen keine Zugriffsentscheidung. Sie stehen trotzdem
hier, damit jeder NEUE Treffer derselben Suche eingeordnet werden muss — als Handler-Prüfung oder
hier, mit Begründung.

| Stelle                                                     | Grund                                                                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `app.ts:213`                                               | Die Rolle wird nur in den Log-Kontext der Anfrage geschrieben; keine Zugriffsentscheidung.                                   |
| `composition/activity.ts:59`                               | Die Rolle wird nur in eine lokale Variable gelesen; die Entscheidung fällt in :67 und :212 und ist dort gezählt.             |
| `composition/dashboard.ts:1032`                            | Die Rolle wird nur in eine lokale Variable gelesen; die Entscheidung fällt in der nächsten Zeile :1033 und ist dort gezählt. |
| `composition/reports.ts:1577`                              | Filterparameter nach der Rolle der aufgelisteten Mitarbeiter im Sammel-PDF; keine Zugriffsentscheidung über den Aufrufer.    |
| `composition/reports.ts:1650`                              | Die Rolle des aufgelisteten Mitarbeiters wird in die Berichtsdaten übernommen; keine Zugriffsentscheidung.                   |
| `contexts/absence/api/leave.ts:735`                        | Die Rolle des Antragstellers wird in den Audit-Eintrag geschrieben; keine Zugriffsentscheidung.                              |
| `contexts/platform/api/auth.ts:304`                        | Die Rolle wird beim Token-Refresh in das JWT übernommen; keine Zugriffsentscheidung.                                         |
| `contexts/platform/api/auth.ts:563`                        | Die Rolle wird im Helfer issueTokens (Anmeldung, OTP-Bestätigung) in das JWT übernommen; keine Zugriffsentscheidung.         |
| `contexts/platform/api/auth.ts:620`                        | Die Rolle wird im Helfer issueTokens in der Antwort an den Client zurückgegeben; keine Zugriffsentscheidung.                 |
| `contexts/platform/api/employees.ts:596`                   | Die Rolle wird hier gesetzt, nicht geprüft; künftig `role-assignment:manage`, die Route selbst ist über :525 erfasst.        |
| `contexts/time-tracking/plugins/attendance-checker.ts:169` | Auswahl der Benachrichtigungsempfänger im Cron-Job, kein Anfragekontext; gehört zu #75.                                      |
| `middleware/auth.ts:76`                                    | Die Implementierung des Rollen-Guards selbst; jede Aufrufstelle steht einzeln im Abschnitt zu requireRole.                   |
