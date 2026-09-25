# Permission-Katalog: Ressource × Aktion × Reichweite

**Status:** gültig ab Phase 72b (Issue #72)
**Codestand der Belege:** `main` @ `bea6b5c7`; die Zeilen für `contexts/platform/api/employees.ts`,
`imports.ts`, `salons.ts`, `salon-assignments.ts`, `roles.ts` und `role-assignments.ts` (alle unter
`contexts/platform/api/`) auf dem Stand von Phase 67b (Issue #67) auf Branch `feat/67-salonzuordnung`,
nach dem Zusammenführen mit Phase 74b (Issue #74) und den Review-Korrekturen neu gemessen

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

## Ressourcen

Jede Ressource des Katalogs mit ihrem Kontext (ADR 0001/0002) und ihrem Bezug; die Reihenfolge folgt
`PERMISSION_RESOURCES` in `permission-catalog.ts`.

| Ressource           | Kontext          | Bezug   | Inhalt                                                                                             |
| ------------------- | ---------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `employee`          | Unterbau         | Person  | Mitarbeiter-Stammdaten, Zugang und Profilbild                                                      |
| `contract`          | Unterbau         | Person  | Vertrag und Arbeitszeitmodell (`WorkSchedule`)                                                     |
| `tenant-settings`   | Unterbau         | Mandant | Mandanteneinstellungen: Vorgaben, SMTP, Sicherheit                                                 |
| `api-key`           | Unterbau         | Mandant | API-Schlüssel des Mandanten                                                                        |
| `audit-log`         | Unterbau         | Mandant | Audit-Protokoll                                                                                    |
| `holiday`           | Unterbau         | Mandant | Feiertage und Schulferien                                                                          |
| `salon`             | Unterbau         | Mandant | Salons (neu, #64)                                                                                  |
| `role`              | Unterbau         | Mandant | Rollen als Bündel von Permissions (neu, #73)                                                       |
| `role-assignment`   | Unterbau         | Mandant | Rollenzuweisungen mit Scope (neu, #74)                                                             |
| `time-entry`        | Zeiterfassung    | Person  | Zeiteinträge und Pausen                                                                            |
| `retro-request`     | Zeiterfassung    | Person  | Zeitnachträge                                                                                      |
| `presence-source`   | Zeiterfassung    | Mandant | Präsenzquellen (WLAN)                                                                              |
| `terminal`          | Zeiterfassung    | Mandant | NFC-Terminals                                                                                      |
| `leave-request`     | Abwesenheiten    | Person  | Urlaubs- und Abwesenheitsanträge                                                                   |
| `section9`          | Abwesenheiten    | Person  | § 9-Vorgänge (Krankheit im Urlaub) inkl. Dokumente                                                 |
| `leave-entitlement` | Abwesenheiten    | Person  | Urlaubsanspruch                                                                                    |
| `leave-config`      | Abwesenheiten    | Mandant | Abwesenheitsarten und Sonderurlaubsregeln                                                          |
| `company-shutdown`  | Abwesenheiten    | Mandant | Betriebsurlaub                                                                                     |
| `vocational-school` | Abwesenheiten    | Person  | Berufsschule (Tage und Muster)                                                                     |
| `overtime`          | Arbeitszeitkonto | Person  | Saldo und Überstundenkonto                                                                         |
| `month-close`       | Arbeitszeitkonto | Person  | Monats- und Jahresabschluss                                                                        |
| `shift`             | Schichtplanung   | Person  | Schichten im Dienstplan                                                                            |
| `shift-config`      | Schichtplanung   | Mandant | Schichtvorlagen und Besetzungsregeln                                                               |
| `shift-pattern`     | Schichtplanung   | Person  | Schicht-Wochenmuster                                                                               |
| `availability`      | Schichtplanung   | Person  | Verfügbarkeit                                                                                      |
| `integration`       | Schichtplanung   | Mandant | Phorest-Integration                                                                                |
| `report`            | Komposition      | Person  | Berichte und Exporte: Monatsbericht, DATEV, PDF, Urlaubsübersicht, Resturlaub-Warnung              |
| `team-overview`     | Komposition      | Person  | Team-Übersichten: Wochenansicht, Anwesenheit heute, Saldenübersicht, offene Punkte, Team-Aktivität |

## Permissions

Jede Permission des Katalogs steht hier genau einmal, als Schlüssel `resource:action:REACH` (die
Ausgabe von `permissionKey`), mit dem, was sie erlaubt, und dem, was sie ausdrücklich nicht erlaubt.

- `EIGENE` erlaubt die Aktion nur auf den eigenen Daten des angemeldeten Mitarbeiters.
- `ZUGEWIESEN` erlaubt sie auf den Daten im Scope der Rollenzuweisung (Mandant, Salons oder eine
  Personenliste, #74). `ZUGEWIESEN` heißt für sich allein nie „alle im Mandanten“ — wie weit die
  Permission reicht, entscheidet allein der Scope der Zuweisung.
- Eine Permission auf einer Ressource mit Bezug Mandant wirkt nur bei einer Zuweisung mit Scope
  Mandant (Durchsetzung: #91).

Routen stehen ohne das Präfix `/api/v1`. Die Spalte „erlaubt“ beschreibt, was die Stellen in den
Abschnitten „Aufrufstellen von requireRole“ und „Handler-Prüfungen“ heute schon freigeben, dazu die
Routen, die nur eine Anmeldung verlangen und auf die eigenen Daten filtern. `salon` (#64), `role`
(#73) und `role-assignment` (#74) haben echte Routen.

### `employee` — Mitarbeiter-Stammdaten

| Permission                          | erlaubt                                                                                                                                                                                                                                                                 | erlaubt ausdrücklich nicht                                                                                                                                                                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `employee:read:EIGENE`              | Die eigenen Stammdaten lesen (`GET /employees/:id` für sich selbst).                                                                                                                                                                                                    | Stammdaten anderer Mitarbeiter und die Mitarbeiterliste; den eigenen Vertrag (`contract:read`); die eigenen Stammdaten ändern (`employee:update`).                                                                                                                                                        |
| `employee:read:ZUGEWIESEN`          | Die Mitarbeiterliste und die Stammdaten der Mitarbeiter im Scope lesen (`GET /employees`, `GET /employees/:id`, `GET /settings/employees`), einschließlich der Salonzuordnungen eines Mitarbeiters (`GET /employees/:id/salon-assignments`, #67).                       | Anonymisierte Mitarbeiter einblenden (`employee:anonymize`); Verträge, Zeiteinträge, Saldo und Abwesenheiten — dafür gibt es eigene Permissions; nichts außerhalb des Scopes der Zuweisung.                                                                                                               |
| `employee:create:ZUGEWIESEN`        | Neue Mitarbeiter anlegen (`POST /employees`), einschließlich Einladung und erstem Arbeitszeitmodell ab dem Eintrittsdatum.                                                                                                                                              | Mitarbeiter per Datei importieren (`employee:import`); spätere Vertragswechsel (`contract:update`); Rollen vergeben — das Setzen der Rolle geht künftig über `role-assignment:manage` (#74).                                                                                                              |
| `employee:update:ZUGEWIESEN`        | Die Stammdaten eines Mitarbeiters im Scope ändern (`PATCH /employees/:id`), z. B. Name, Personalnummer, Eintritts- und Austrittsdatum, NFC-Karte; Stammsalon- und Einsatzsalon-Zuordnungen anlegen, ändern und beenden (`POST /employees/:id/salon-assignments…`, #67). | Die Rolle setzen oder ändern — künftig `role-assignment:manage`, heute noch über dieselbe Route (`employees.ts:726`); den Vertrag ändern (`contract:update`); den Zugang sperren oder freigeben (`employee:manage-access`); anonymisieren (`employee:anonymize`).                                         |
| `employee:manage-access:ZUGEWIESEN` | Den Zugang eines Mitarbeiters im Scope verwalten: Konto entsperren, deaktivieren, reaktivieren, Einladung erneut senden (`PATCH /employees/:id/unlock`, `…/deactivate`, `…/reactivate`, `POST /employees/:id/resend-invitation`).                                       | Stammdaten ändern (`employee:update`); Mitarbeiter anonymisieren oder löschen (`employee:anonymize`); Rollen zuweisen (`role-assignment:manage`).                                                                                                                                                         |
| `employee:anonymize:ZUGEWIESEN`     | Mitarbeiter nach DSGVO Art. 17 anonymisieren (`DELETE /employees/:id`), anonymisierte Mitarbeiter in der Liste einblenden und nach Ablauf der Aufbewahrungsfrist endgültig löschen (`POST /employees/:id/hard-delete/authorize`, `DELETE /employees/:id/hard-delete`).  | Ersetzt nicht die Freigabe durch einen zweiten Administrator: Eine endgültige Löschung innerhalb der Aufbewahrungsfrist verlangt immer zwei verschiedene Personen (Vier-Augen-Regel, keine Permission); aufbewahrungspflichtige Zeiteinträge, Anträge und Salden bleiben bei der Anonymisierung erhalten. |
| `employee:import:ZUGEWIESEN`        | Mitarbeiter per Datei importieren (`POST /imports/employees`).                                                                                                                                                                                                          | Zeiteinträge importieren (`time-entry:import`); einzelne Mitarbeiter anlegen oder ändern (`employee:create`, `employee:update`).                                                                                                                                                                          |
| `employee:update-avatar:EIGENE`     | Das eigene Profilbild hochladen und löschen (`POST /avatars/:employeeId`, `DELETE /avatars/:employeeId` für sich selbst).                                                                                                                                               | Profilbilder anderer Mitarbeiter ändern; andere eigene Stammdaten ändern (`employee:update`).                                                                                                                                                                                                             |
| `employee:update-avatar:ZUGEWIESEN` | Profilbilder der Mitarbeiter im Scope hochladen und löschen.                                                                                                                                                                                                            | Andere Stammdaten ändern (`employee:update`); nichts außerhalb des Scopes der Zuweisung.                                                                                                                                                                                                                  |

### `contract` — Vertrag und Arbeitszeitmodell

| Permission                   | erlaubt                                                                                                                                             | erlaubt ausdrücklich nicht                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract:read:EIGENE`       | Das eigene gültige Arbeitszeitmodell lesen (`GET /settings/work/:employeeId` für sich selbst): Modell, Wochenstunden, Arbeitstage.                  | Verträge anderer Mitarbeiter; die Vertragshistorie (`GET /settings/work/:employeeId/history` gibt es nur mit `ZUGEWIESEN`); den eigenen Vertrag ändern (`contract:update`). |
| `contract:read:ZUGEWIESEN`   | Arbeitszeitmodell und Vertragshistorie der Mitarbeiter im Scope lesen (`GET /settings/work/:employeeId`, `GET /settings/work/:employeeId/history`). | Zeiteinträge und Tageszeiten (`time-entry:read`); den Saldo (`overtime:read`); Verträge ändern (`contract:update`); nichts außerhalb des Scopes der Zuweisung.              |
| `contract:update:ZUGEWIESEN` | Einen Vertragswechsel für einen Mitarbeiter im Scope anlegen (`PUT /settings/work/:employeeId`), gültig ab einem Monatsersten.                      | Die mandantenweiten Arbeitszeit-Vorgaben ändern (`tenant-settings:update`); Zeiteinträge oder Saldo ändern; Stammdaten ändern (`employee:update`).                          |

### `tenant-settings` — Mandanteneinstellungen

| Permission                          | erlaubt                                                                                                                                                                                                                                                                   | erlaubt ausdrücklich nicht                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tenant-settings:read:ZUGEWIESEN`   | Mandanteneinstellungen lesen: SMTP-Konfiguration (`GET /settings/smtp`) und Sicherheitsrichtlinien (`GET /settings/security`).                                                                                                                                            | Einstellungen ändern (`tenant-settings:update`); API-Schlüssel (`api-key:manage`). Wirkt nur bei einer Zuweisung mit Scope Mandant (#91).                                      |
| `tenant-settings:update:ZUGEWIESEN` | Mandanteneinstellungen ändern: Arbeitszeit-Vorgaben des Mandanten, auf Wunsch auch für bestehende Arbeitszeitmodelle (`PUT /settings/work`), SMTP samt Testmail (`PUT /settings/smtp`, `POST /settings/smtp/test`) und Sicherheitsrichtlinien (`PUT /settings/security`). | Den Vertrag eines einzelnen Mitarbeiters gezielt ändern (`contract:update`); Abwesenheitsarten (`leave-config:manage`). Wirkt nur bei einer Zuweisung mit Scope Mandant (#91). |

### `api-key` — API-Schlüssel

| Permission                  | erlaubt                                                                                                                                                                                | erlaubt ausdrücklich nicht                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-key:manage:ZUGEWIESEN` | API-Schlüssel des Mandanten anlegen, auflisten und widerrufen und die verfügbaren Scopes abfragen (`GET /api-keys`, `POST /api-keys`, `DELETE /api-keys/:id`, `GET /api-keys/scopes`). | Terminal-Schlüssel (`terminal:manage`); die Scopes eines Schlüssels sind keine Permissions (#75). Wirkt nur bei einer Zuweisung mit Scope Mandant (#91). |

### `audit-log` — Audit-Protokoll

| Permission                  | erlaubt                                                                                                                            | erlaubt ausdrücklich nicht                                                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit-log:read:ZUGEWIESEN` | Das Audit-Protokoll des Mandanten lesen (`GET /audit-logs`, `GET /audit-logs/:id`) und den Audit-Feed der Aktivitätsansicht sehen. | Audit-Einträge ändern oder löschen — das erlaubt keine Permission; die Team-Ereignisse der Aktivitätsansicht (`team-overview:read`). Wirkt nur bei einer Zuweisung mit Scope Mandant (#91). |

### `holiday` — Feiertage und Schulferien

| Permission                  | erlaubt                                                                                                                                                                                  | erlaubt ausdrücklich nicht                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `holiday:manage:ZUGEWIESEN` | Feiertage anlegen und löschen (`POST /holidays`, `DELETE /holidays/:id`) sowie Schulferien einsehen und neu laden (`GET /admin/school-holidays`, `POST /admin/school-holidays/refresh`). | Betriebsurlaub (`company-shutdown:manage`); Berufsschultage (`vocational-school:manage`). Wirkt nur bei einer Zuweisung mit Scope Mandant (#91). |

### `salon` — Salons

| Permission                | erlaubt                                                                                | erlaubt ausdrücklich nicht                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `salon:read:ZUGEWIESEN`   | Die Salons des Mandanten und ihre Angaben lesen, über die Endpunkte, die #64 einführt. | Salons anlegen, ändern oder schließen (`salon:manage`); die Daten der Mitarbeiter eines Salons — dafür gelten die Permissions der Personen-Ressourcen. Wirkt nur bei einer Zuweisung mit Scope Mandant (#91). |
| `salon:manage:ZUGEWIESEN` | Salons anlegen, ändern und schließen, über die Endpunkte, die #64 einführt.            | Den Scope einer Rollenzuweisung auf Salons setzen (`role-assignment:manage`); Mitarbeiterdaten ändern. Wirkt nur bei einer Zuweisung mit Scope Mandant (#91).                                                 |

### `role` — Rollen

| Permission               | erlaubt                                                                                                                                                           | erlaubt ausdrücklich nicht                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `role:read:ZUGEWIESEN`   | Die Rollen des Mandanten und die darin gebündelten Permissions lesen (Systemrollen und die eigenen Rollen): `GET /roles`, `GET /roles/:id`.                       | Rollen anlegen oder ändern (`role:manage`); Rollen Personen zuweisen (`role-assignment:manage`). Wirkt nur bei einer Zuweisung mit Scope Mandant (#91).                                                                                                                                                                                                                              |
| `role:manage:ZUGEWIESEN` | Rollen anlegen, ändern, kopieren und löschen, also Permissions zu Rollen bündeln: `POST /roles`, `PATCH /roles/:id`, `POST /roles/:id/copy`, `DELETE /roles/:id`. | Rollen zuweisen (`role-assignment:manage`); die Sperren abschalten, die keine Permissions sind (Selbstgenehmigung, Vier-Augen-Regel) — sie gelten für jede Rolle (#78); Systemrollen ändern oder löschen — die sind gesperrt (409), nur Kopieren ist erlaubt; eine Rolle löschen, die noch Nutzern zugewiesen ist (409, #74). Wirkt nur bei einer Zuweisung mit Scope Mandant (#91). |

**Aussperrschutz (umgesetzt mit #74):** Halter einer Permission ist ein aktiver Nutzer mit
mindestens einer Zuweisung mit Scope Mandant, deren Rolle die Permission gewährt. Geschützt sind
`role:manage` und `role-assignment:manage`. Abgelehnt (409) wird nur eine Änderung, die die Zahl
der Halter einer dieser Permissions von mindestens 1 auf 0 senkt — ein Mandant, der noch keinen
Halter hat, wird bis #75 nicht blockiert. Geprüft wird beim Entziehen und Ändern einer Zuweisung
(`DELETE`/`PATCH /role-assignments/:id`), beim Ändern einer Kundenrolle (`PATCH /roles/:id`), beim
Deaktivieren (`PATCH /employees/:id/deactivate`), beim Anonymisieren (`DELETE /employees/:id`) und
beim endgültigen Löschen eines Mitarbeiters (`DELETE /employees/:id/hard-delete` — greift praktisch
schon an der Vorbedingung „zuerst anonymisieren“, weil anonymisierte Nutzer inaktiv sind und keine
Zuweisung mehr haben), jeweils durch denselben Helfer (`withRoleLockoutGuard`,
`contexts/platform/facade/role-assignments.ts`). Er sperrt die Zeile des Mandanten
(`FOR NO KEY UPDATE`: serialisiert geschützte Änderungen untereinander, hält aber gewöhnliche
Schreibzugriffe mit Fremdschlüssel auf den Mandanten nicht auf) und zählt in derselben Transaktion
vor und nach der Änderung; bei einem Verstoß wird die Änderung samt Audit-Eintrag zurückgerollt. Beim
Anonymisieren antwortet die Route mit 409, bevor Dateien im Objektspeicher gelöscht werden.

Deaktivieren behält die Zuweisungen des Nutzers — sie wirken nicht, solange er inaktiv ist, und die
Reaktivierung stellt sie wieder her. Anonymisieren (DSGVO Art. 17) entzieht sie: Jede Zuweisung wird
in der Anonymisierungs-Transaktion gelöscht, mit einem eigenen Audit-Eintrag (`DELETE`,
Begründung „Anonymisierung“). Personenlisten anderer Zuweisungen, die den anonymisierten
Mitarbeiter enthalten, bleiben unverändert; die Auflösung ignoriert anonymisierte Ziele. Hat ein
Nutzer beim endgültigen Löschen trotzdem noch Zuweisungen, werden sie vor dem Nutzer einzeln
gelöscht, jede mit Audit-Eintrag (Begründung „Endgültige Löschung“); die Kaskade am Fremdschlüssel
ist nur Rückfallsicherung. Eine neue Zuweisung (`POST /role-assignments`) nimmt dieselbe
Mandantensperre und prüft Nutzer und Rolle erst danach, sodass sie nicht an einer gleichzeitigen
Anonymisierung vorbei angelegt werden kann. Eine gespeicherte Zuweisung, die die Form-Regel verletzt
(etwa Scope Salons ohne Salon), gewährt nichts und zählt nicht als Halter. Hintergrundjobs (Aufbewahrung, `data-retention`) prüfen den Aussperrschutz nicht — sie betreffen
nur längst ausgeschiedene, anonymisierte Mitarbeiter (D-23).

**Zugewiesene Rolle (umgesetzt mit #74):** Eine Kundenrolle, die noch mindestens einem Nutzer
zugewiesen ist, lässt sich nicht löschen (`DELETE /roles/:id` → 409 „Die Rolle ist noch Nutzern
zugewiesen und kann nicht gelöscht werden.“). Die Prüfung läuft erst nach der Mandantenprüfung, eine
fremde Rolle antwortet also weiter mit 404. Der Fremdschlüssel (`onDelete: Restrict`) ist die
Rückfallsicherung und liefert dieselbe 409.

### `role-assignment` — Rollenzuweisungen

| Permission                          | erlaubt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | erlaubt ausdrücklich nicht                                                                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `role-assignment:manage:ZUGEWIESEN` | Rollen an Personen zuweisen, ändern und entziehen, samt Scope der Zuweisung (Mandant, Salons oder Personenliste): Zuweisungen auflisten (`GET /role-assignments`), eine lesen (`GET /role-assignments/:id`), eine Rolle mit Scope zuweisen (`POST /role-assignments`), Rolle oder Scope ändern (`PATCH /role-assignments/:id`) und entziehen (`DELETE /role-assignments/:id` — löschen, auditiert). Ersetzt künftig das Setzen von `User.role` über `PATCH /employees/:id` (`employees.ts:726`). Nur mit Scope Mandant: heute durch `role-assignment:manage:ZUGEWIESEN` erfüllt (die Zuweisung ist bisher immer mandantenweit); die Durchsetzung des Scopes folgt mit #91. | Rollen selbst definieren (`role:manage`); Stammdaten ändern (`employee:update`); den Nutzer einer bestehenden Zuweisung austauschen (dafür entziehen und neu zuweisen). Wirkt nur bei einer Zuweisung mit Scope Mandant (#91). |

### `time-entry` — Zeiteinträge und Pausen

| Permission                         | erlaubt                                                                                                                                                                       | erlaubt ausdrücklich nicht                                                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `time-entry:read:EIGENE`           | Eigene Zeiteinträge und Pausen lesen (Kalender, Tagesansicht, Liste über `GET /time-entries`).                                                                                | Zeiteinträge anderer Mitarbeiter; Saldo und Monatsabschluss (`overtime:read`, `month-close:read`); Vertragsdaten (`contract:read`).                                                               |
| `time-entry:read:ZUGEWIESEN`       | Zeiteinträge und Pausen der Mitarbeiter im Scope lesen (`GET /time-entries` für andere).                                                                                      | Saldo und Monatsabschluss (`overtime:read`, `month-close:read`); Vertragsdaten (`contract:read`); Abwesenheiten (`leave-request:read`); nichts außerhalb des Scopes der Zuweisung.                |
| `time-entry:create:EIGENE`         | Für sich selbst stempeln (`POST /time-entries/clock-in`) und eigene Zeiteinträge anlegen (`POST /time-entries`).                                                              | Für andere Mitarbeiter stempeln oder Einträge anlegen; Einträge in einem abgeschlossenen Monat; Zeitnachträge (`retro-request:create`).                                                           |
| `time-entry:create:ZUGEWIESEN`     | Zeiteinträge für Mitarbeiter im Scope anlegen und für sie stempeln (Stempeln im Auftrag).                                                                                     | Einträge in einem abgeschlossenen Monat — die Monatssperre gilt für jede Rolle; Zeiteinträge per Datei importieren (`time-entry:import`); nichts außerhalb des Scopes der Zuweisung.              |
| `time-entry:update:EIGENE`         | Eigene Zeiteinträge und Pausen bearbeiten und die eigene Pause bestätigen (`PUT /time-entries/:id`, `POST /time-entries/:id/breaks`, `PATCH /time-entries/:id/break-status`). | Einträge anderer Mitarbeiter; Einträge in einem abgeschlossenen Monat; ungültige Einträge wieder gültig setzen (`time-entry:revalidate`).                                                         |
| `time-entry:update:ZUGEWIESEN`     | Zeiteinträge, Pausen und Pausenbestätigung der Mitarbeiter im Scope bearbeiten.                                                                                               | Einträge in einem abgeschlossenen Monat — die Sperre gilt auch für Administratoren; ungültige Einträge wieder gültig setzen (`time-entry:revalidate`); nichts außerhalb des Scopes der Zuweisung. |
| `time-entry:delete:EIGENE`         | Eigene Zeiteinträge löschen (`DELETE /time-entries/:id`); der Eintrag bekommt einen Löschvermerk und bleibt nachvollziehbar erhalten.                                         | Einträge anderer Mitarbeiter löschen; Einträge in einem abgeschlossenen Monat; endgültiges Löschen — Zeiteinträge werden nie hart gelöscht.                                                       |
| `time-entry:delete:ZUGEWIESEN`     | Zeiteinträge der Mitarbeiter im Scope löschen, mit Löschvermerk.                                                                                                              | Einträge in einem abgeschlossenen Monat; endgültiges Löschen; nichts außerhalb des Scopes der Zuweisung.                                                                                          |
| `time-entry:revalidate:ZUGEWIESEN` | Als ungültig markierte Zeiteinträge der Mitarbeiter im Scope wieder gültig setzen (`PATCH /time-entries/:id/revalidate`).                                                     | Einträge inhaltlich ändern (`time-entry:update`); über Urlaubsstornierungen entscheiden (`leave-request:approve`); nichts außerhalb des Scopes der Zuweisung.                                     |
| `time-entry:import:ZUGEWIESEN`     | Zeiteinträge per Datei importieren (`POST /imports/time-entries`).                                                                                                            | Mitarbeiter importieren (`employee:import`); einzelne Einträge anlegen oder ändern (`time-entry:create`, `time-entry:update`); nichts außerhalb des Scopes der Zuweisung.                         |

### `retro-request` — Zeitnachträge

| Permission                         | erlaubt                                                                                                                                                              | erlaubt ausdrücklich nicht                                                                                                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retro-request:read:EIGENE`        | Die eigenen Zeitnachträge und ihren Stand sehen, als ausstehenden Eintrag in den eigenen Zeiteinträgen.                                                              | Zeitnachträge anderer Mitarbeiter; die Liste aller Nachträge (`GET /retro-entry-requests` gibt es nur mit `ZUGEWIESEN`); Nachträge genehmigen (`retro-request:approve`).                                          |
| `retro-request:read:ZUGEWIESEN`    | Die Zeitnachträge der Mitarbeiter im Scope auflisten (`GET /retro-entry-requests`).                                                                                  | Nachträge genehmigen oder ablehnen (`retro-request:approve`); nichts außerhalb des Scopes der Zuweisung.                                                                                                          |
| `retro-request:create:EIGENE`      | Eigene Zeitnachträge stellen (`POST /retro-entry-requests`) und offene eigene Nachträge zurückziehen (`DELETE /retro-entry-requests/:id`).                           | Nachträge für andere Mitarbeiter stellen; eigene Nachträge genehmigen — das ist für jede Rolle gesperrt.                                                                                                          |
| `retro-request:create:ZUGEWIESEN`  | Zeitnachträge im Auftrag von Mitarbeitern im Scope stellen.                                                                                                          | Nachträge genehmigen (`retro-request:approve`); eigene Nachträge genehmigen (Sperre für jede Rolle); nichts außerhalb des Scopes der Zuweisung.                                                                   |
| `retro-request:approve:ZUGEWIESEN` | Zeitnachträge der Mitarbeiter im Scope genehmigen oder ablehnen (`PATCH /retro-entry-requests/:id/review`); mit der Genehmigung wird der ausstehende Eintrag gültig. | Keine eigenen Anträge genehmigen — diese Sperre gilt für jede Rolle und ist keine Permission (`retro-entry-requests.ts:244`); Einträge in einem abgeschlossenen Monat; nichts außerhalb des Scopes der Zuweisung. |

### `presence-source` — Präsenzquellen (WLAN)

| Permission                          | erlaubt                                                                                                                                                                              | erlaubt ausdrücklich nicht                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presence-source:manage:ZUGEWIESEN` | Präsenzquellen (WLAN) anlegen, ändern und löschen, gemeldete Geräte einsehen und Mitarbeitern zuordnen, dazu die Liste der Mitarbeiter mit Einwilligung (`/admin/presence-sources`). | Zeiteinträge anlegen oder ändern (`time-entry:create`, `time-entry:update`); NFC-Terminals (`terminal:manage`). Wirkt nur bei einer Zuweisung mit Scope Mandant (#91). |

### `terminal` — NFC-Terminals

| Permission                   | erlaubt                                                                                                                                       | erlaubt ausdrücklich nicht                                                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal:manage:ZUGEWIESEN` | NFC-Terminals verwalten: Terminal-Schlüssel anlegen, auflisten und widerrufen (`GET /terminals`, `POST /terminals`, `DELETE /terminals/:id`). | Die Anmeldung eines Terminals mit seinem Schlüssel — sie ist keine Permission; NFC-Karten der Mitarbeiter zuordnen (`employee:update`); allgemeine API-Schlüssel (`api-key:manage`). Wirkt nur bei einer Zuweisung mit Scope Mandant (#91). |

### `leave-request` — Urlaubs- und Abwesenheitsanträge

| Permission                         | erlaubt                                                                                                                                                                                                         | erlaubt ausdrücklich nicht                                                                                                                                                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `leave-request:read:EIGENE`        | Eigene Anträge mit Abwesenheitsart und Status lesen (`GET /leave/requests`, Kalender, eigener iCal-Feed `GET /leave/ical/personal`).                                                                            | Anträge anderer Mitarbeiter; bei fremden Abwesenheiten im Kalender und in der Überschneidungsprüfung die Abwesenheitsart (etwa Krankheit) — sie bleibt verborgen; den Team-iCal-Feed (`GET /leave/ical/team`).                                                 |
| `leave-request:read:ZUGEWIESEN`    | Anträge der Mitarbeiter im Scope lesen, einschließlich der Abwesenheitsart — also auch, dass jemand krank ist (Gesundheitsdaten, DSGVO Art. 9); dazu Team-Kalender und Team-iCal-Feed (`GET /leave/ical/team`). | Anträge genehmigen, korrigieren oder stornieren (eigene Permissions); Zeiteinträge und Saldo (`time-entry:read`, `overtime:read`); nichts außerhalb des Scopes der Zuweisung.                                                                                  |
| `leave-request:create:EIGENE`      | Eigene Anträge stellen (`POST /leave/requests`) und offene eigene Anträge ändern (`PATCH /leave/requests/:id`).                                                                                                 | Anträge für andere Mitarbeiter stellen; eigene Anträge genehmigen — das ist für jede Rolle gesperrt.                                                                                                                                                           |
| `leave-request:create:ZUGEWIESEN`  | Anträge im Auftrag von Mitarbeitern im Scope stellen.                                                                                                                                                           | Anträge genehmigen (`leave-request:approve`); eigene Anträge genehmigen (Sperre für jede Rolle); nichts außerhalb des Scopes der Zuweisung.                                                                                                                    |
| `leave-request:approve:ZUGEWIESEN` | Anträge der Mitarbeiter im Scope genehmigen oder ablehnen und über Stornierungsanfragen entscheiden (`PATCH /leave/requests/:id/review`).                                                                       | Keine eigenen Anträge genehmigen; keine Stornierung genehmigen, die man selbst beantragt hat — beide Sperren gelten für jede Rolle und sind keine Permissions (`leave.ts:988-996`, `leave.ts:1000`); genehmigte Anträge korrigieren (`leave-request:correct`). |
| `leave-request:correct:ZUGEWIESEN` | Bereits genehmigte Anträge der Mitarbeiter im Scope korrigieren, etwa eine lange Abwesenheit verkürzen (`PATCH /leave/requests/:id/correct`); der Saldo wird dabei neu berechnet.                               | Tage in einem abgeschlossenen Monat verändern — die Monatssperre gilt für jede Rolle; offene Anträge genehmigen (`leave-request:approve`); nichts außerhalb des Scopes der Zuweisung.                                                                          |
| `leave-request:attest:ZUGEWIESEN`  | Die Attest-Angaben eines Antrags der Mitarbeiter im Scope setzen (`PATCH /leave/requests/:id/attest`).                                                                                                          | Den Antrag genehmigen oder ändern (`leave-request:approve`, `leave-request:correct`); Dokumente zu § 9-Vorgängen (`section9:read`, `section9:upload`); nichts außerhalb des Scopes der Zuweisung.                                                              |
| `leave-request:cancel:EIGENE`      | Eigene offene Anträge zurückziehen und für eigene genehmigte Anträge eine Stornierung beantragen (`DELETE /leave/requests/:id`).                                                                                | Anträge anderer Mitarbeiter stornieren; die eigene Stornierung genehmigen — das muss ein anderer Manager tun (Sperre für jede Rolle).                                                                                                                          |
| `leave-request:cancel:ZUGEWIESEN`  | Anträge der Mitarbeiter im Scope zurückziehen oder ihre Stornierung beantragen.                                                                                                                                 | Eine selbst beantragte Stornierung danach selbst genehmigen — das muss ein anderer Manager tun (Sperre für jede Rolle, keine Permission); nichts außerhalb des Scopes der Zuweisung.                                                                           |

### `section9` — § 9-Vorgänge (Krankheit im Urlaub)

| Permission                   | erlaubt                                                                                                                                          | erlaubt ausdrücklich nicht                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `section9:read:EIGENE`       | Eigene § 9-Vorgänge und die zugehörigen Dokumente lesen (`GET /leave/section9`, `GET /leave/section9/:id`, `GET /section9-documents/:creditId`). | Vorgänge und Dokumente anderer Mitarbeiter; über Vorgänge entscheiden (`section9:decide`).                                                                    |
| `section9:read:ZUGEWIESEN`   | § 9-Vorgänge der Mitarbeiter im Scope samt Dokumenten (ärztliche Bescheinigungen) lesen — Gesundheitsdaten nach DSGVO Art. 9.                    | Über Vorgänge entscheiden (`section9:decide`); Dokumente hochladen (`section9:upload`); nichts außerhalb des Scopes der Zuweisung.                            |
| `section9:upload:EIGENE`     | Zu einem eigenen § 9-Vorgang ein Dokument hochladen (`POST /section9-documents/:creditId`).                                                      | Dokumente zu Vorgängen anderer Mitarbeiter hochladen; den Vorgang bestätigen oder ablehnen (`section9:decide`).                                               |
| `section9:upload:ZUGEWIESEN` | Zu § 9-Vorgängen der Mitarbeiter im Scope Dokumente hochladen.                                                                                   | Über den Vorgang entscheiden (`section9:decide`); nichts außerhalb des Scopes der Zuweisung.                                                                  |
| `section9:decide:ZUGEWIESEN` | § 9-Vorgänge der Mitarbeiter im Scope bestätigen, ablehnen oder wieder öffnen (`POST /leave/section9/:id/confirm`, `…/reject`, `…/reopen`).      | Vorgänge oder Dokumente lesen, ohne `section9:read` zu haben; Urlaubsanträge genehmigen (`leave-request:approve`); nichts außerhalb des Scopes der Zuweisung. |

### `leave-entitlement` — Urlaubsanspruch

| Permission                            | erlaubt                                                                                                                        | erlaubt ausdrücklich nicht                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `leave-entitlement:read:EIGENE`       | Den eigenen Urlaubsanspruch mit Resturlaub und Übertrag lesen (`GET /leave/entitlements/:employeeId` für sich selbst).         | Ansprüche anderer Mitarbeiter; den eigenen Anspruch ändern (`leave-entitlement:update`).                                                           |
| `leave-entitlement:read:ZUGEWIESEN`   | Urlaubsansprüche der Mitarbeiter im Scope lesen (`GET /leave/entitlements/:employeeId`, `GET /settings/vacation/:employeeId`). | Ansprüche ändern (`leave-entitlement:update`); die Anträge selbst (`leave-request:read`); nichts außerhalb des Scopes der Zuweisung.               |
| `leave-entitlement:update:ZUGEWIESEN` | Den Urlaubsanspruch der Mitarbeiter im Scope festlegen (`PUT /settings/vacation/:employeeId`).                                 | Abwesenheitsarten und Sonderurlaubsregeln (`leave-config:manage`); Anträge genehmigen oder korrigieren; nichts außerhalb des Scopes der Zuweisung. |

### `leave-config` — Abwesenheitsarten und Sonderurlaubsregeln

| Permission                       | erlaubt                                                                                                                                  | erlaubt ausdrücklich nicht                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `leave-config:read:ZUGEWIESEN`   | Die Konfiguration der Abwesenheitsarten des Mandanten lesen (`GET /settings/leave-types`).                                               | Abwesenheitsarten oder Sonderurlaubsregeln ändern (`leave-config:manage`); Anträge (`leave-request:read`). Wirkt nur bei einer Zuweisung mit Scope Mandant (#91).       |
| `leave-config:manage:ZUGEWIESEN` | Abwesenheitsarten ändern (`PUT /settings/leave-types/:id`) und Sonderurlaubsregeln anlegen, ändern und löschen (`/special-leave/rules`). | Urlaubsansprüche einzelner Mitarbeiter (`leave-entitlement:update`); Betriebsurlaub (`company-shutdown:manage`). Wirkt nur bei einer Zuweisung mit Scope Mandant (#91). |

### `company-shutdown` — Betriebsurlaub

| Permission                           | erlaubt                                                                                                                         | erlaubt ausdrücklich nicht                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `company-shutdown:manage:ZUGEWIESEN` | Betriebsurlaub anlegen, ändern und löschen und einzelne Mitarbeiter davon ausnehmen (`/company-shutdowns`, `…/:id/exceptions`). | Einzelne Urlaubsanträge genehmigen (`leave-request:approve`); Feiertage (`holiday:manage`). Wirkt nur bei einer Zuweisung mit Scope Mandant (#91). |

### `vocational-school` — Berufsschule

| Permission                            | erlaubt                                                                                                                                                                                                                                 | erlaubt ausdrücklich nicht                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vocational-school:read:EIGENE`       | Die eigenen kommenden Berufsschultage und das eigene Berufsschulmuster lesen (`GET /vocational-school/upcoming`, `GET /employees/:id/vocational-school-pattern` für sich selbst).                                                       | Berufsschultage anderer Mitarbeiter; Tage oder Muster ändern (`vocational-school:manage`).                                                              |
| `vocational-school:read:ZUGEWIESEN`   | Berufsschultage und Berufsschulmuster der Mitarbeiter im Scope lesen.                                                                                                                                                                   | Tage erzeugen, eintragen oder löschen und Muster ändern (`vocational-school:manage`); nichts außerhalb des Scopes der Zuweisung.                        |
| `vocational-school:manage:ZUGEWIESEN` | Berufsschultage der Mitarbeiter im Scope aus dem Muster erzeugen, vorab ansehen, einzeln eintragen, löschen und rückwirkend anwenden (`/vocational-school/…`) sowie das Muster ändern (`PUT /employees/:id/vocational-school-pattern`). | Tage in einem abgeschlossenen Monat verändern (Monatssperre für jede Rolle); Schulferien (`holiday:manage`); nichts außerhalb des Scopes der Zuweisung. |

### `overtime` — Saldo und Überstundenkonto

| Permission                                | erlaubt                                                                                                                                                                                                       | erlaubt ausdrücklich nicht                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overtime:read:EIGENE`                    | Den eigenen Saldo, die eigenen Monatssalden und die eigenen Monatsstände lesen (`GET /overtime/:employeeId`, `GET /overtime/month-saldo/:employeeId`, `GET /overtime/snapshots/:employeeId` für sich selbst). | Salden anderer Mitarbeiter; Überstunden ausgleichen oder auszahlen (`overtime:settle`); den Monatsabschluss (`month-close:read`).                                                                               |
| `overtime:read:ZUGEWIESEN`                | Salden, Monatssalden und Monatsstände der Mitarbeiter im Scope lesen.                                                                                                                                         | Tageszeiten und einzelne Zeiteinträge (`time-entry:read`); Vertragsdaten (`contract:read`); den Saldo verändern (`overtime:settle`, `overtime:set-opening-balance`); nichts außerhalb des Scopes der Zuweisung. |
| `overtime:settle:ZUGEWIESEN`              | Überstunden der Mitarbeiter im Scope ausgleichen oder auszahlen (`POST /overtime/plans`, `POST /overtime/payout`).                                                                                            | Einen Eröffnungssaldo setzen (`overtime:set-opening-balance`); Monate abschließen oder entsperren (`month-close:close`, `month-close:unlock`); nichts außerhalb des Scopes der Zuweisung.                       |
| `overtime:set-opening-balance:ZUGEWIESEN` | Den Eröffnungssaldo eines Mitarbeiters im Scope setzen (`POST /overtime/opening-balance`).                                                                                                                    | Überstunden ausgleichen oder auszahlen (`overtime:settle`); gesperrte Monate verändern; nichts außerhalb des Scopes der Zuweisung.                                                                              |

### `month-close` — Monats- und Jahresabschluss

| Permission                          | erlaubt                                                                                                                                         | erlaubt ausdrücklich nicht                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `month-close:read:ZUGEWIESEN`       | Den Stand des Monats- und Jahresabschlusses der Mitarbeiter im Scope lesen (`GET /overtime/close-month/status`, `…/deferred`, `…/year-status`). | Monate abschließen (`month-close:close`); entsperren (`month-close:unlock`); Tageszeiten (`time-entry:read`); nichts außerhalb des Scopes der Zuweisung.                    |
| `month-close:close:ZUGEWIESEN`      | Einen Monat für die Mitarbeiter im Scope abschließen (`POST /overtime/close-month`); danach sind die Einträge des Monats gesperrt.              | Einen abgeschlossenen Monat wieder entsperren (`month-close:unlock`); das Jahr abschließen (`month-close:close-year`); nichts außerhalb des Scopes der Zuweisung.           |
| `month-close:unlock:ZUGEWIESEN`     | Einen abgeschlossenen Monat wieder entsperren (`POST /overtime/unlock-month`).                                                                  | Einträge des Monats selbst ändern — dafür gelten die Permissions der Ressource; das Jahr abschließen (`month-close:close-year`); nichts außerhalb des Scopes der Zuweisung. |
| `month-close:close-year:ZUGEWIESEN` | Den Jahresübertrag für einen Mitarbeiter im Scope erstellen (`POST /overtime/close-year`).                                                      | Einzelne Monate abschließen oder entsperren (`month-close:close`, `month-close:unlock`); nichts außerhalb des Scopes der Zuweisung.                                         |

### `shift` — Schichten

| Permission              | erlaubt                                                                                                                                                                                                                                                                            | erlaubt ausdrücklich nicht                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shift:read:EIGENE`     | Die eigenen Schichten lesen (`GET /shifts/my-week`, `GET /shifts/range` für sich selbst) und eigene Terminüberschneidungen aus Phorest sehen (`GET /integrations/phorest/appointment-collisions`).                                                                                 | Schichten anderer Mitarbeiter und die Wochenplanung des Teams (`GET /shifts/week`); Schichten planen (`shift:plan`).                                              |
| `shift:read:ZUGEWIESEN` | Schichten und Wochenplanung der Mitarbeiter im Scope lesen, Konflikte und Terminüberschneidungen einsehen (`GET /shifts/week`, `GET /shifts/range`, `GET /shifts/conflicts`).                                                                                                      | Schichten anlegen, ändern oder löschen (`shift:plan`); Schichtvorlagen und Besetzungsregeln (`shift-config:manage`); nichts außerhalb des Scopes der Zuweisung.   |
| `shift:plan:ZUGEWIESEN` | Schichten der Mitarbeiter im Scope anlegen, ändern, löschen und wiederherstellen, Wochen erzeugen und kopieren (`POST /shifts`, `PUT /shifts/:id`, `DELETE /shifts/:id`, `POST /shifts/:id/restore`, `POST /shifts/generate-week`, `POST /shifts/copy-week`, `POST /shifts/bulk`). | Schichtvorlagen und Besetzungsregeln (`shift-config:manage`); Zeiteinträge (`time-entry:create`, `time-entry:update`); nichts außerhalb des Scopes der Zuweisung. |

### `shift-config` — Schichtvorlagen und Besetzungsregeln

| Permission                       | erlaubt                                                                                                           | erlaubt ausdrücklich nicht                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shift-config:manage:ZUGEWIESEN` | Schichtvorlagen und Besetzungsregeln anlegen, ändern und löschen (`/shifts/templates`, `/shifts/coverage-rules`). | Schichten planen (`shift:plan`); Schicht-Wochenmuster einzelner Mitarbeiter (`shift-pattern:update`). Wirkt nur bei einer Zuweisung mit Scope Mandant (#91). |

### `shift-pattern` — Schicht-Wochenmuster

| Permission                        | erlaubt                                                                                                                  | erlaubt ausdrücklich nicht                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `shift-pattern:read:EIGENE`       | Das eigene Schicht-Wochenmuster lesen (`GET /employees/:id/shift-patterns` für sich selbst).                             | Muster anderer Mitarbeiter und die Übersicht des Mandanten (`GET /shift-patterns/tenant`); das eigene Muster ändern (`shift-pattern:update`). |
| `shift-pattern:read:ZUGEWIESEN`   | Schicht-Wochenmuster der Mitarbeiter im Scope lesen (`GET /employees/:id/shift-patterns`, `GET /shift-patterns/tenant`). | Muster ändern (`shift-pattern:update`); nichts außerhalb des Scopes der Zuweisung.                                                            |
| `shift-pattern:update:ZUGEWIESEN` | Schicht-Wochenmuster der Mitarbeiter im Scope festlegen (`PUT /employees/:id/shift-patterns`).                           | Schichten planen (`shift:plan`); Schichtvorlagen (`shift-config:manage`); nichts außerhalb des Scopes der Zuweisung.                          |

### `availability` — Verfügbarkeit

| Permission                       | erlaubt                                                                                                       | erlaubt ausdrücklich nicht                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `availability:read:EIGENE`       | Die eigene Verfügbarkeit lesen (`GET /me/availability`, `GET /employees/:id/availability` für sich selbst).   | Verfügbarkeiten anderer Mitarbeiter; Schichten anderer (`shift:read`).                     |
| `availability:read:ZUGEWIESEN`   | Verfügbarkeiten der Mitarbeiter im Scope lesen (`GET /employees/:id/availability`).                           | Verfügbarkeiten ändern (`availability:update`); nichts außerhalb des Scopes der Zuweisung. |
| `availability:update:EIGENE`     | Die eigene Verfügbarkeit pflegen (`PUT /me/availability`, `PUT /employees/:id/availability` für sich selbst). | Verfügbarkeiten anderer Mitarbeiter ändern; Schichten planen (`shift:plan`).               |
| `availability:update:ZUGEWIESEN` | Verfügbarkeiten der Mitarbeiter im Scope pflegen (`PUT /employees/:id/availability`).                         | Schichten planen (`shift:plan`); nichts außerhalb des Scopes der Zuweisung.                |

### `integration` — Phorest-Integration

| Permission                      | erlaubt                                                                                                                                                                                                              | erlaubt ausdrücklich nicht                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration:manage:ZUGEWIESEN` | Die Phorest-Integration einrichten und betreiben: Konfiguration lesen und ändern, Verbindung testen, Mitarbeiter zuordnen, Synchronisationsläufe einsehen und Schichten synchronisieren (`/integrations/phorest/…`). | Schichten von Hand planen (`shift:plan`); Terminüberschneidungen einzelner Mitarbeiter (`shift:read`). Wirkt nur bei einer Zuweisung mit Scope Mandant (#91). |

### `report` — Berichte und Exporte

| Permission                 | erlaubt                                                                                                                                                                                                           | erlaubt ausdrücklich nicht                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `report:read:ZUGEWIESEN`   | Berichtsdaten der Mitarbeiter im Scope in der App lesen: Monatsbericht, Urlaubsübersicht, verfallsbedrohter Resturlaub (`GET /reports/monthly`, `GET /reports/leave-overview`, `GET /reports/carryover-at-risk`). | Dateien exportieren (`report:export`); Resturlaub-Warnungen versenden (`report:notify`); nichts außerhalb des Scopes der Zuweisung.                                     |
| `report:export:EIGENE`     | Den eigenen Monatsbericht als PDF herunterladen (`GET /reports/monthly/pdf` für sich selbst).                                                                                                                     | Berichte anderer Mitarbeiter; DATEV-Exporte und Sammel-PDFs; Berichtsdaten in der App (`report:read`).                                                                  |
| `report:export:ZUGEWIESEN` | Dateien für die Mitarbeiter im Scope exportieren: DATEV (`GET /reports/datev`, `GET /reports/datev/employee`) und PDFs (Monatsbericht einzeln und gesammelt, Urlaubsliste, Urlaubsübersicht, beide zusammen).     | Resturlaub-Warnungen versenden (`report:notify`); Daten ändern; nichts außerhalb des Scopes der Zuweisung.                                                              |
| `report:notify:ZUGEWIESEN` | Mitarbeiter im Scope vor verfallendem Resturlaub warnen (`POST /reports/carryover-warn`).                                                                                                                         | Berichtsdaten lesen oder exportieren (`report:read`, `report:export`); Urlaubsansprüche ändern (`leave-entitlement:update`); nichts außerhalb des Scopes der Zuweisung. |

### `team-overview` — Team-Übersichten

| Permission                      | erlaubt                                                                                                                                                                                                                                                                               | erlaubt ausdrücklich nicht                                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `team-overview:read:ZUGEWIESEN` | Team-Übersichten für die Mitarbeiter im Scope sehen: Wochenansicht, Anwesenheit heute, Saldenübersicht, offene Punkte des Teams und Team-Ereignisse der Aktivitätsansicht (`GET /dashboard/team-week`, `…/today-attendance`, `…/overtime-overview`, `…/open-items`, `GET /activity`). | Einzelne Zeiteinträge, Anträge oder Salden über die Übersicht hinaus (`time-entry:read`, `leave-request:read`, `overtime:read`); den Audit-Feed (`audit-log:read`); nichts außerhalb des Scopes der Zuweisung. |

## Aufrufstellen von requireRole

Jede Zeile ist eine Aufrufstelle des Rollen-Guards `requireRole` (`middleware/auth.ts`). Pfade sind
relativ zu `apps/api/src/`; die Route steht ohne das Präfix aus `app.ts`. Die Spalte „heute“ nennt
die Rollen, die der Guard heute durchlässt: `A` = ADMIN, `M` = MANAGER, `E` = EMPLOYEE.
Die Dateien `contexts/platform/api/salons.ts` (Präfix `/api/v1/salons`, Phase 64b),
`contexts/platform/api/roles.ts` (Präfix `/api/v1/roles`), `contexts/platform/api/role-assignments.ts`
(Präfix `/api/v1/role-assignments`, beide Phase 74b) und `contexts/platform/api/salon-assignments.ts`
(Präfix `/api/v1/employees`, Phase 67b) gibt es in `bea6b5c7` noch nicht. Ihre Zeilen und die von
`employees.ts` und `imports.ts` sind auf dem im Kopf genannten Stand von Phase 67b neu gemessen; jede
Zeilennummer zeigt auf den `requireRole`-Aufruf der Route.

Übergang in Phase 75b (Issue #75): Die Aufrufstellen werden Datei für Datei auf die Permission-Guards
`requirePermission` / `requireAnyPermission` (`contexts/platform/request-permissions.ts`) umgestellt.
Eine umgestellte Stelle behält ihre Zeile hier; die Spalte „heute“ bleibt der Neutralitätsvertrag,
die Spalte „Permission“ ist jetzt die tatsächlich geprüfte. Umgestellt und auf Branch
`feat/75-permissions-umstellung` neu gemessen: `contexts/platform/api/audit-logs.ts`. Plan 75b-12
benennt diesen Abschnitt um, wenn keine `requireRole`-Stelle mehr übrig ist.

| Stelle                                                     | Route                                           | heute   | Permission                     | Reichweite                                   |
| ---------------------------------------------------------- | ----------------------------------------------- | ------- | ------------------------------ | -------------------------------------------- |
| `composition/dashboard.ts:358`                             | `GET /team-week`                                | A, M    | `team-overview:read`           | ZUGEWIESEN                                   |
| `composition/dashboard.ts:587`                             | `GET /today-attendance`                         | A, M    | `team-overview:read`           | ZUGEWIESEN                                   |
| `composition/dashboard.ts:765`                             | `GET /overtime-overview`                        | A, M    | `team-overview:read`           | ZUGEWIESEN                                   |
| `composition/reports.ts:924`                               | `GET /monthly`                                  | A, M    | `report:read`                  | ZUGEWIESEN                                   |
| `composition/reports.ts:1023`                              | `GET /leave-overview`                           | A, M    | `report:read`                  | ZUGEWIESEN                                   |
| `composition/reports.ts:1068`                              | `GET /carryover-at-risk`                        | A, M    | `report:read`                  | ZUGEWIESEN                                   |
| `composition/reports.ts:1151`                              | `POST /carryover-warn`                          | A, M    | `report:notify`                | ZUGEWIESEN                                   |
| `composition/reports.ts:1191`                              | `GET /datev`                                    | A, M    | `report:export`                | ZUGEWIESEN                                   |
| `composition/reports.ts:1322`                              | `GET /datev/employee`                           | A, M    | `report:export`                | ZUGEWIESEN                                   |
| `composition/reports.ts:1562`                              | `GET /monthly/pdf/all`                          | A, M    | `report:export`                | ZUGEWIESEN                                   |
| `composition/reports.ts:1689`                              | `GET /leave-list/pdf`                           | A, M    | `report:export`                | ZUGEWIESEN                                   |
| `composition/reports.ts:1770`                              | `GET /vacation/pdf`                             | A, M    | `report:export`                | ZUGEWIESEN                                   |
| `composition/reports.ts:1902`                              | `GET /leave-overview/pdf`                       | A, M    | `report:export`                | ZUGEWIESEN                                   |
| `contexts/absence/api/company-shutdowns.ts:47`             | `POST /`                                        | A       | `company-shutdown:manage`      | ZUGEWIESEN                                   |
| `contexts/absence/api/company-shutdowns.ts:80`             | `PATCH /:id`                                    | A       | `company-shutdown:manage`      | ZUGEWIESEN                                   |
| `contexts/absence/api/company-shutdowns.ts:124`            | `DELETE /:id`                                   | A       | `company-shutdown:manage`      | ZUGEWIESEN                                   |
| `contexts/absence/api/company-shutdowns.ts:147`            | `POST /:id/exceptions`                          | A       | `company-shutdown:manage`      | ZUGEWIESEN                                   |
| `contexts/absence/api/company-shutdowns.ts:185`            | `DELETE /:id/exceptions/:employeeId`            | A       | `company-shutdown:manage`      | ZUGEWIESEN                                   |
| `contexts/absence/api/leave-settings.ts:26`                | `GET /vacation/:employeeId`                     | A, M    | `leave-entitlement:read`       | ZUGEWIESEN                                   |
| `contexts/absence/api/leave-settings.ts:74`                | `PUT /vacation/:employeeId`                     | A, M    | `leave-entitlement:update`     | ZUGEWIESEN                                   |
| `contexts/absence/api/leave-settings.ts:196`               | `GET /leave-types`                              | A, M    | `leave-config:read`            | ZUGEWIESEN                                   |
| `contexts/absence/api/leave-settings.ts:206`               | `PUT /leave-types/:id`                          | A       | `leave-config:manage`          | ZUGEWIESEN                                   |
| `contexts/absence/api/leave.ts:963`                        | `PATCH /requests/:id/review`                    | A, M    | `leave-request:approve`        | ZUGEWIESEN                                   |
| `contexts/absence/api/leave.ts:1745`                       | `PATCH /requests/:id/correct`                   | A, M    | `leave-request:correct`        | ZUGEWIESEN                                   |
| `contexts/absence/api/leave.ts:2153`                       | `PATCH /requests/:id/attest`                    | A, M    | `leave-request:attest`         | ZUGEWIESEN                                   |
| `contexts/absence/api/leave.ts:2587`                       | `GET /ical/team`                                | A, M    | `leave-request:read`           | ZUGEWIESEN                                   |
| `contexts/absence/api/leave.ts:3001`                       | `POST /section9/:id/confirm`                    | A, M    | `section9:decide`              | ZUGEWIESEN                                   |
| `contexts/absence/api/leave.ts:3264`                       | `POST /section9/:id/reject`                     | A, M    | `section9:decide`              | ZUGEWIESEN                                   |
| `contexts/absence/api/leave.ts:3342`                       | `POST /section9/:id/reopen`                     | A, M    | `section9:decide`              | ZUGEWIESEN                                   |
| `contexts/absence/api/special-leave.ts:96`                 | `POST /rules`                                   | A       | `leave-config:manage`          | ZUGEWIESEN                                   |
| `contexts/absence/api/special-leave.ts:129`                | `PUT /rules/:id`                                | A       | `leave-config:manage`          | ZUGEWIESEN                                   |
| `contexts/absence/api/special-leave.ts:173`                | `DELETE /rules/:id`                             | A       | `leave-config:manage`          | ZUGEWIESEN                                   |
| `contexts/absence/api/vocational-school-pattern.ts:168`    | `PUT /:id/vocational-school-pattern`            | A, M    | `vocational-school:manage`     | ZUGEWIESEN                                   |
| `contexts/absence/api/vocational-school.ts:125`            | `POST /generate`                                | A, M    | `vocational-school:manage`     | ZUGEWIESEN                                   |
| `contexts/absence/api/vocational-school.ts:147`            | `GET /preview`                                  | A, M    | `vocational-school:manage`     | ZUGEWIESEN                                   |
| `contexts/absence/api/vocational-school.ts:190`            | `GET /upcoming`                                 | A, M, E | `vocational-school:read`       | ZUGEWIESEN; EIGENE über Handler-Prüfung :199 |
| `contexts/absence/api/vocational-school.ts:261`            | `POST /manual-insert`                           | A, M    | `vocational-school:manage`     | ZUGEWIESEN                                   |
| `contexts/absence/api/vocational-school.ts:387`            | `DELETE /:absenceId`                            | A, M    | `vocational-school:manage`     | ZUGEWIESEN                                   |
| `contexts/absence/api/vocational-school.ts:480`            | `GET /retroactive-preview`                      | A, M    | `vocational-school:manage`     | ZUGEWIESEN                                   |
| `contexts/absence/api/vocational-school.ts:522`            | `POST /retroactive-apply`                       | A, M    | `vocational-school:manage`     | ZUGEWIESEN                                   |
| `contexts/platform/api/admin/school-holidays.ts:27`        | `GET /`                                         | A       | `holiday:manage`               | ZUGEWIESEN                                   |
| `contexts/platform/api/admin/school-holidays.ts:49`        | `POST /refresh`                                 | A       | `holiday:manage`               | ZUGEWIESEN                                   |
| `contexts/platform/api/api-keys.ts:28`                     | `GET /`                                         | A       | `api-key:manage`               | ZUGEWIESEN                                   |
| `contexts/platform/api/api-keys.ts:52`                     | `POST /`                                        | A       | `api-key:manage`               | ZUGEWIESEN                                   |
| `contexts/platform/api/api-keys.ts:91`                     | `DELETE /:id`                                   | A       | `api-key:manage`               | ZUGEWIESEN                                   |
| `contexts/platform/api/api-keys.ts:121`                    | `GET /scopes`                                   | A       | `api-key:manage`               | ZUGEWIESEN                                   |
| `contexts/platform/api/audit-logs.ts:21`                   | `GET /`                                         | A       | `audit-log:read`               | ZUGEWIESEN                                   |
| `contexts/platform/api/audit-logs.ts:57`                   | `GET /:id`                                      | A       | `audit-log:read`               | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:318`                   | `GET /`                                         | A, M    | `employee:read`                | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:393`                   | `POST /`                                        | A       | `employee:create`              | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:644`                   | `PATCH /:id`                                    | A       | `employee:update`              | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:912`                   | `PATCH /:id/unlock`                             | A       | `employee:manage-access`       | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:951`                   | `PATCH /:id/deactivate`                         | A       | `employee:manage-access`       | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:1026`                  | `PATCH /:id/reactivate`                         | A       | `employee:manage-access`       | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:1087`                  | `POST /:id/resend-invitation`                   | A       | `employee:manage-access`       | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:1147`                  | `DELETE /:id`                                   | A       | `employee:anonymize`           | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:1258`                  | `POST /:id/hard-delete/authorize`               | A       | `employee:anonymize`           | ZUGEWIESEN                                   |
| `contexts/platform/api/employees.ts:1289`                  | `DELETE /:id/hard-delete`                       | A       | `employee:anonymize`           | ZUGEWIESEN                                   |
| `contexts/platform/api/salon-assignments.ts:166`           | `GET /:id/salon-assignments`                    | A, M    | `employee:read`                | ZUGEWIESEN                                   |
| `contexts/platform/api/salon-assignments.ts:186`           | `POST /:id/salon-assignments`                   | A       | `employee:update`              | ZUGEWIESEN                                   |
| `contexts/platform/api/salon-assignments.ts:251`           | `POST /:id/salon-assignments/home`              | A       | `employee:update`              | ZUGEWIESEN                                   |
| `contexts/platform/api/salon-assignments.ts:325`           | `POST /:id/salon-assignments/:assignmentId/end` | A       | `employee:update`              | ZUGEWIESEN                                   |
| `contexts/platform/api/holidays.ts:106`                    | `POST /`                                        | A       | `holiday:manage`               | ZUGEWIESEN                                   |
| `contexts/platform/api/holidays.ts:164`                    | `DELETE /:id`                                   | A       | `holiday:manage`               | ZUGEWIESEN                                   |
| `contexts/platform/api/imports.ts:82`                      | `POST /employees`                               | A       | `employee:import`              | ZUGEWIESEN                                   |
| `contexts/platform/api/imports.ts:236`                     | `POST /time-entries`                            | A       | `time-entry:import`            | ZUGEWIESEN                                   |
| `contexts/platform/api/role-assignments.ts:284`            | `GET /`                                         | A       | `role-assignment:manage`       | ZUGEWIESEN                                   |
| `contexts/platform/api/role-assignments.ts:306`            | `POST /`                                        | A       | `role-assignment:manage`       | ZUGEWIESEN                                   |
| `contexts/platform/api/role-assignments.ts:402`            | `GET /:id`                                      | A       | `role-assignment:manage`       | ZUGEWIESEN                                   |
| `contexts/platform/api/role-assignments.ts:429`            | `PATCH /:id`                                    | A       | `role-assignment:manage`       | ZUGEWIESEN                                   |
| `contexts/platform/api/role-assignments.ts:558`            | `DELETE /:id`                                   | A       | `role-assignment:manage`       | ZUGEWIESEN                                   |
| `contexts/platform/api/roles.ts:133`                       | `GET /`                                         | A       | `role:read`                    | ZUGEWIESEN                                   |
| `contexts/platform/api/roles.ts:157`                       | `POST /`                                        | A       | `role:manage`                  | ZUGEWIESEN                                   |
| `contexts/platform/api/roles.ts:210`                       | `GET /:id`                                      | A       | `role:read`                    | ZUGEWIESEN                                   |
| `contexts/platform/api/roles.ts:236`                       | `PATCH /:id`                                    | A       | `role:manage`                  | ZUGEWIESEN                                   |
| `contexts/platform/api/roles.ts:330`                       | `DELETE /:id`                                   | A       | `role:manage`                  | ZUGEWIESEN                                   |
| `contexts/platform/api/roles.ts:404`                       | `POST /:id/copy`                                | A       | `role:manage`                  | ZUGEWIESEN                                   |
| `contexts/platform/api/salons.ts:123`                      | `GET /`                                         | A, M    | `salon:read`                   | ZUGEWIESEN                                   |
| `contexts/platform/api/salons.ts:141`                      | `GET /:id`                                      | A, M    | `salon:read`                   | ZUGEWIESEN                                   |
| `contexts/platform/api/salons.ts:157`                      | `POST /`                                        | A       | `salon:manage`                 | ZUGEWIESEN                                   |
| `contexts/platform/api/salons.ts:183`                      | `PATCH /:id`                                    | A       | `salon:manage`                 | ZUGEWIESEN                                   |
| `contexts/platform/api/salons.ts:221`                      | `POST /:id/deactivate`                          | A       | `salon:manage`                 | ZUGEWIESEN                                   |
| `contexts/platform/api/salons.ts:278`                      | `POST /:id/activate`                            | A       | `salon:manage`                 | ZUGEWIESEN                                   |
| `contexts/platform/api/settings.ts:647`                    | `PUT /work`                                     | A       | `tenant-settings:update`       | ZUGEWIESEN                                   |
| `contexts/platform/api/settings.ts:992`                    | `PUT /work/:employeeId`                         | A, M    | `contract:update`              | ZUGEWIESEN                                   |
| `contexts/platform/api/settings.ts:1303`                   | `GET /smtp`                                     | A       | `tenant-settings:read`         | ZUGEWIESEN                                   |
| `contexts/platform/api/settings.ts:1322`                   | `PUT /smtp`                                     | A       | `tenant-settings:update`       | ZUGEWIESEN                                   |
| `contexts/platform/api/settings.ts:1382`                   | `POST /smtp/test`                               | A       | `tenant-settings:update`       | ZUGEWIESEN                                   |
| `contexts/platform/api/settings.ts:1398`                   | `GET /security`                                 | A       | `tenant-settings:read`         | ZUGEWIESEN                                   |
| `contexts/platform/api/settings.ts:1409`                   | `PUT /security`                                 | A       | `tenant-settings:update`       | ZUGEWIESEN                                   |
| `contexts/platform/api/settings.ts:1440`                   | `GET /work/:employeeId/history`                 | A, M    | `contract:read`                | ZUGEWIESEN                                   |
| `contexts/platform/api/settings.ts:1475`                   | `GET /employees`                                | A, M    | `employee:read`                | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:258`              | `GET /phorest/couplings`                        | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:286`              | `POST /phorest/couplings`                       | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:376`              | `DELETE /phorest/couplings/:salonId`            | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:413`              | `GET /phorest/config`                           | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:458`              | `PUT /phorest/config`                           | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:594`              | `POST /phorest/test`                            | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:686`              | `GET /phorest/staff`                            | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:771`              | `GET /phorest/mappings`                         | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:792`              | `POST /phorest/mappings`                        | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:855`              | `DELETE /phorest/mappings/:phorestStaffId`      | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:890`              | `GET /phorest/sync-runs`                        | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/integrations.ts:929`              | `POST /phorest/sync-shifts`                     | A       | `integration:manage`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shift-patterns.ts:70`             | `PUT /:id/shift-patterns`                       | A, M    | `shift-pattern:update`         | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shift-patterns.ts:170`            | `GET /tenant`                                   | A, M    | `shift-pattern:read`           | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:592`                    | `POST /templates`                               | A       | `shift-config:manage`          | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:613`                    | `PUT /templates/:id`                            | A       | `shift-config:manage`          | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:646`                    | `DELETE /templates/:id`                         | A       | `shift-config:manage`          | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:682`                    | `POST /coverage-rules`                          | A       | `shift-config:manage`          | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:716`                    | `PUT /coverage-rules/:id`                       | A       | `shift-config:manage`          | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:752`                    | `DELETE /coverage-rules/:id`                    | A       | `shift-config:manage`          | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:793`                    | `GET /week`                                     | A, M    | `shift:read`                   | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:1749`                   | `POST /`                                        | A, M    | `shift:plan`                   | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:2049`                   | `PUT /:id`                                      | A, M    | `shift:plan`                   | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:2390`                   | `POST /generate-week`                           | A, M    | `shift:plan`                   | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:2731`                   | `POST /copy-week`                               | A, M    | `shift:plan`                   | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:3061`                   | `POST /bulk`                                    | A, M    | `shift:plan`                   | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:3144`                   | `DELETE /:id`                                   | A, M    | `shift:plan`                   | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:3232`                   | `GET /conflicts`                                | A, M    | `shift:read`                   | ZUGEWIESEN                                   |
| `contexts/scheduling/api/shifts.ts:3279`                   | `POST /:id/restore`                             | A, M    | `shift:plan`                   | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/admin-presence-sources.ts:16`  | `GET /opted-in`                                 | A       | `presence-source:manage`       | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/admin-presence-sources.ts:40`  | `GET /`                                         | A       | `presence-source:manage`       | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/admin-presence-sources.ts:63`  | `POST /`                                        | A       | `presence-source:manage`       | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/admin-presence-sources.ts:113` | `PATCH /:id`                                    | A       | `presence-source:manage`       | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/admin-presence-sources.ts:187` | `DELETE /:id`                                   | A       | `presence-source:manage`       | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/admin-presence-sources.ts:219` | `GET /:id/devices`                              | A       | `presence-source:manage`       | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/admin-presence-sources.ts:330` | `POST /:id/devices/:mac/assign`                 | A       | `presence-source:manage`       | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/admin-presence-sources.ts:417` | `DELETE /:id/devices/:mac`                      | A       | `presence-source:manage`       | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/retro-entry-requests.ts:176`   | `GET /`                                         | A, M    | `retro-request:read`           | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/terminals.ts:14`               | `GET /`                                         | A       | `terminal:manage`              | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/terminals.ts:35`               | `POST /`                                        | A       | `terminal:manage`              | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/terminals.ts:126`              | `DELETE /:id`                                   | A       | `terminal:manage`              | ZUGEWIESEN                                   |
| `contexts/time-tracking/api/time-entries.ts:1849`          | `PATCH /:id/revalidate`                         | A, M    | `time-entry:revalidate`        | ZUGEWIESEN                                   |
| `contexts/working-time-account/api/overtime.ts:240`        | `POST /plans`                                   | A, M    | `overtime:settle`              | ZUGEWIESEN                                   |
| `contexts/working-time-account/api/overtime.ts:286`        | `POST /payout`                                  | A, M    | `overtime:settle`              | ZUGEWIESEN                                   |
| `contexts/working-time-account/api/overtime.ts:405`        | `GET /close-month/deferred`                     | A, M    | `month-close:read`             | ZUGEWIESEN                                   |
| `contexts/working-time-account/api/overtime.ts:420`        | `GET /close-month/status`                       | A, M    | `month-close:read`             | ZUGEWIESEN                                   |
| `contexts/working-time-account/api/overtime.ts:655`        | `GET /close-month/year-status`                  | A, M    | `month-close:read`             | ZUGEWIESEN                                   |
| `contexts/working-time-account/api/overtime.ts:962`        | `POST /close-month`                             | A, M    | `month-close:close`            | ZUGEWIESEN                                   |
| `contexts/working-time-account/api/overtime.ts:1423`       | `POST /unlock-month`                            | A       | `month-close:unlock`           | ZUGEWIESEN                                   |
| `contexts/working-time-account/api/overtime.ts:1542`       | `POST /close-year`                              | A       | `month-close:close-year`       | ZUGEWIESEN                                   |
| `contexts/working-time-account/api/overtime.ts:1716`       | `POST /opening-balance`                         | A       | `overtime:set-opening-balance` | ZUGEWIESEN                                   |

## Handler-Prüfungen

Diese Prüfungen stehen im Handler selbst. Die meisten entscheiden, ob der Aufrufer die Aktion auf
allen Daten ausführen darf (`ZUGEWIESEN`) oder nur auf seinen eigenen (`EIGENE`); die Zeilen mit
nur `ZUGEWIESEN` schalten eine Funktion ganz frei oder ab.

| Stelle                                                   | Route                                             | heute                                         | Permission               | Reichweite                               |
| -------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------- | ------------------------ | ---------------------------------------- |
| `composition/activity.ts:69`                             | `GET /`                                           | nur A: Audit-Feed                             | `audit-log:read`         | ZUGEWIESEN                               |
| `composition/activity.ts:214`                            | `GET /`                                           | nur M: Team-Ereignisse                        | `team-overview:read`     | ZUGEWIESEN; Vorrang hat `audit-log:read` |
| `composition/dashboard.ts:1048`                          | `GET /open-items`                                 | A, M: Team-Posten; E: nur eigene Posten       | `team-overview:read`     | ZUGEWIESEN                               |
| `composition/reports.ts:1449`                            | `GET /monthly/pdf`                                | A, M: alle; E: nur eigenes PDF                | `report:export`          | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/absence/api/leave.ts:335`                      | Helfer canSeeLeaveType, genutzt in :946 und :2331 | A, M: Art sichtbar; E: nur bei eigenem Antrag | `leave-request:read`     | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/absence/api/leave.ts:351`                      | `POST /requests`                                  | A, M: auch für andere; E: nur für sich        | `leave-request:create`   | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/absence/api/leave.ts:785`                      | `GET /requests`                                   | A, M: alle; E: nur eigene                     | `leave-request:read`     | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/absence/api/leave.ts:946`                      | `GET /overlap`                                    | A, M: Art sichtbar; E: Art verborgen          | `leave-request:read`     | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/absence/api/leave.ts:2106`                     | `DELETE /requests/:id`                            | A, M: alle; E: nur eigene                     | `leave-request:cancel`   | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/absence/api/leave.ts:2331`                     | `GET /calendar`                                   | A, M: Art sichtbar; E: nur bei eigenem Antrag | `leave-request:read`     | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/absence/api/leave.ts:2678`                     | `GET /entitlements/:employeeId`                   | A, M: alle; E: nur eigene                     | `leave-entitlement:read` | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/absence/api/leave.ts:2860`                     | `GET /section9`                                   | A, M: alle; E: nur eigene                     | `section9:read`          | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/absence/api/leave.ts:2921`                     | `GET /section9/:id`                               | A, M: alle; E: nur eigene                     | `section9:read`          | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/absence/api/section9-documents.ts:73`          | `POST /:creditId`                                 | A, M: alle; E: nur eigene                     | `section9:upload`        | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/absence/api/section9-documents.ts:195`         | `GET /:creditId`                                  | A, M: alle; E: nur eigene                     | `section9:read`          | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/absence/api/vocational-school-pattern.ts:136`  | `GET /:id/vocational-school-pattern`              | A, M: alle; E: nur eigene                     | `vocational-school:read` | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/absence/api/vocational-school.ts:199`          | `GET /upcoming`                                   | A, M: alle; E: nur eigene                     | `vocational-school:read` | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/platform/api/avatars.ts:18`                    | `POST /:employeeId`                               | A, M: alle; E: nur eigenes Bild               | `employee:update-avatar` | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/platform/api/avatars.ts:141`                   | `DELETE /:employeeId`                             | A, M: alle; E: nur eigenes Bild               | `employee:update-avatar` | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/platform/api/employees.ts:326`                 | `GET /`                                           | nur A: Anonymisierte einblenden               | `employee:anonymize`     | ZUGEWIESEN                               |
| `contexts/platform/api/employees.ts:363`                 | `GET /:id`                                        | A, M: alle; E: nur eigene                     | `employee:read`          | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/platform/api/settings.ts:894`                  | `GET /work/:employeeId`                           | A, M: alle; E: nur eigene                     | `contract:read`          | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/scheduling/api/availability.ts:125`            | `GET /:id/availability`                           | A, M: alle; E: nur eigene                     | `availability:read`      | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/scheduling/api/availability.ts:165`            | `PUT /:id/availability`                           | A, M: alle; E: nur eigene                     | `availability:update`    | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/scheduling/api/integrations.ts:987`            | `GET /phorest/appointment-collisions`             | A, M: alle; E: nur eigene                     | `shift:read`             | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/scheduling/api/shift-patterns.ts:43`           | `GET /:id/shift-patterns`                         | A, M: alle; E: nur eigene                     | `shift-pattern:read`     | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/scheduling/api/shifts.ts:1672`                 | `GET /range`                                      | A, M: alle; E: nur eigene                     | `shift:read`             | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/time-tracking/api/retro-entry-requests.ts:94`  | `POST /`                                          | A, M: auch für andere; E: nur für sich        | `retro-request:create`   | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/time-tracking/api/retro-entry-requests.ts:264` | `PATCH /:id/review`                               | nur A, M                                      | `retro-request:approve`  | ZUGEWIESEN                               |
| `contexts/time-tracking/api/time-entries.ts:424`         | `POST /clock-in`                                  | A, M: auch für andere; E: nur für sich        | `time-entry:create`      | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/time-tracking/api/time-entries.ts:757`         | `POST /:id/breaks`                                | A, M: alle; E: nur eigene                     | `time-entry:update`      | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/time-tracking/api/time-entries.ts:833`         | `GET /`                                           | A, M: alle; E: nur eigene                     | `time-entry:read`        | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/time-tracking/api/time-entries.ts:893`         | `POST /`                                          | A, M: auch für andere; E: nur für sich        | `time-entry:create`      | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/time-tracking/api/time-entries.ts:1399`        | `PUT /:id`                                        | A, M: alle; E: nur eigene                     | `time-entry:update`      | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/time-tracking/api/time-entries.ts:1950`        | `DELETE /:id`                                     | A, M: alle; E: nur eigene                     | `time-entry:delete`      | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/time-tracking/api/time-entries.ts:2058`        | `PATCH /:id/break-status`                         | A, M: alle; E: nur eigene                     | `time-entry:update`      | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/working-time-account/api/overtime.ts:135`      | `GET /:employeeId`                                | A, M: alle; E: nur eigene                     | `overtime:read`          | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/working-time-account/api/overtime.ts:1508`     | `GET /snapshots/:employeeId`                      | A, M: alle; E: nur eigene                     | `overtime:read`          | ZUGEWIESEN; sonst EIGENE                 |
| `contexts/working-time-account/api/overtime.ts:1862`     | `GET /month-saldo/:employeeId`                    | A, M: alle; E: nur eigene                     | `overtime:read`          | ZUGEWIESEN; sonst EIGENE                 |

## Nicht gezählte Treffer

Die Suche nach Handler-Prüfungen ist bewusst breit: Sie findet jede Zeile, die `user.role` liest
oder `role` vergleicht. Die folgenden Treffer treffen keine Zugriffsentscheidung. Sie stehen trotzdem
hier, damit jeder NEUE Treffer derselben Suche eingeordnet werden muss — als Handler-Prüfung oder
hier, mit Begründung.

| Stelle                                                     | Grund                                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app.ts:213`                                               | Die Rolle wird nur in den Log-Kontext der Anfrage geschrieben; keine Zugriffsentscheidung.                                                                                                                                                       |
| `composition/reports.ts:1580`                              | Filterparameter nach der Rolle der aufgelisteten Mitarbeiter im Sammel-PDF; keine Zugriffsentscheidung über den Aufrufer.                                                                                                                        |
| `composition/reports.ts:1653`                              | Die Rolle des aufgelisteten Mitarbeiters wird in die Berichtsdaten übernommen; keine Zugriffsentscheidung.                                                                                                                                       |
| `contexts/absence/api/leave.ts:735`                        | Die Rolle des Antragstellers wird in den Audit-Eintrag geschrieben; keine Zugriffsentscheidung.                                                                                                                                                  |
| `contexts/platform/api/auth.ts:307`                        | Beim Token-Refresh wird die Kompatibilitätsrolle über `compatRoleForUser` abgeleitet (D-14) und in das JWT übernommen; die Spalte `User.role` ist nur der Rückfallwert für einen Nutzer ohne gespeicherte Zuweisung. Keine Zugriffsentscheidung. |
| `contexts/platform/api/auth.ts:570`                        | Im Helfer issueTokens (Anmeldung, OTP-Bestätigung) wird die Kompatibilitätsrolle einmal über `compatRoleForUser` abgeleitet (D-14) und in JWT und Antwort übernommen; die Spalte ist nur der Rückfallwert. Keine Zugriffsentscheidung.           |
| `contexts/platform/api/employees.ts:726`                   | Die Rolle wird hier gesetzt, nicht geprüft; künftig `role-assignment:manage`, die Route selbst ist über :644 erfasst.                                                                                                                            |
| `contexts/platform/request-permissions.ts:143`             | Implementierung der Permission-Prüfung: Der Altrollen-Rückfall (D-08) liest die Spalte `User.role` eines Nutzers ohne gespeicherte Zuweisung und übergibt sie an `systemRoleIdForLegacyRole`; keine eigene Rollenentscheidung.                   |
| `contexts/platform/request-permissions.ts:200`             | Implementierung der Permission-Prüfung: `permissionReach` fragt die ZUGEWIESEN-Permission über `hasPermission` ab; jede Aufrufstelle steht einzeln in ihrem Abschnitt.                                                                           |
| `contexts/platform/request-permissions.ts:201`             | Implementierung der Permission-Prüfung: `permissionReach` fragt die EIGENE-Permission über `hasPermission` ab; jede Aufrufstelle steht einzeln in ihrem Abschnitt.                                                                               |
| `contexts/platform/request-permissions.ts:216`             | Implementierung der Permission-Prüfung: der Guard `requirePermission` selbst; jede Aufrufstelle steht einzeln im Abschnitt zu den Guards.                                                                                                        |
| `contexts/platform/request-permissions.ts:236`             | Implementierung der Permission-Prüfung: der Guard `requireAnyPermission` selbst; jede Aufrufstelle steht einzeln im Abschnitt zu den Guards.                                                                                                     |
| `contexts/time-tracking/plugins/attendance-checker.ts:169` | Auswahl der Benachrichtigungsempfänger im Cron-Job, kein Anfragekontext; gehört zu #75.                                                                                                                                                          |
| `middleware/auth.ts:76`                                    | Die Implementierung des Rollen-Guards selbst; jede Aufrufstelle steht einzeln im Abschnitt zu requireRole.                                                                                                                                       |

## Keine Permissions

Folgende Regeln und Mechanismen stehen bewusst nicht im Katalog.

**Sperren, die für jede Rolle gelten.** Sie sind keine Permissions, weil sie sich sonst durch die
Zusammenstellung einer Rolle abschalten ließen — und genau das darf nicht gehen (#78). Wer eine
Genehmigungs-Permission hat, bleibt an sie gebunden:

- **Keine Selbstgenehmigung von Urlaubs- und Abwesenheitsanträgen** —
  `contexts/absence/api/leave.ts:988-996`: Wer einen Antrag prüft, darf nicht der Antragsteller
  sein.
- **Keine Selbstgenehmigung von Zeitnachträgen** —
  `contexts/time-tracking/api/retro-entry-requests.ts:244`: dieselbe Sperre für Zeitnachträge.
- **Stornierung durch einen anderen Manager** — `contexts/absence/api/leave.ts:1000`: Eine
  Stornierung genehmigt nie die Person, die sie beantragt hat.
- **Vier-Augen-Regel bei der endgültigen Löschung** — `contexts/platform/api/employees.ts:1253`
  (Freigabe durch einen Administrator) und `:1337` (die Löschung prüft, dass die Freigabe von einem
  ANDEREN Administrator stammt und höchstens 15 Minuten alt ist): Innerhalb der Aufbewahrungsfrist
  löscht niemand allein. `employee:anonymize` erlaubt die Löschkette, ersetzt diese Regel aber nicht.

**Eigene Systeme außerhalb des Katalogs:**

- **Scopes von API-Schlüsseln** (`ApiKey.scopes`, `packages/db/prisma/schema.prisma:1036`). Heute
  wertet `middleware/auth.ts:52-57` nur den Scope `admin` aus; jeder andere Schlüssel wirkt wie
  `MANAGER`, die übrigen Scopes werden nirgends geprüft. Die neutrale Abbildung auf Permissions
  übernimmt #75.
- **Anmeldung der NFC-Terminals** mit einem eigenen Terminal-Schlüssel
  (`contexts/time-tracking/api/terminals.ts:95`). Das ist Geräte-Authentifizierung, keine
  Berechtigung einer Person; verwaltet werden die Schlüssel über `terminal:manage`.
- **Die Abfragen, die Benachrichtigungsempfänger nach Rolle suchen** (etwa
  `role: { in: ["ADMIN", "MANAGER"] }`; Issue #72 zählt 16 solche Stellen). Sie wählen aus, wer eine
  Nachricht bekommt, und treffen keine Zugriffsentscheidung; ihre Umstellung gehört zu #75.
- **Ein Superadmin oberhalb des Mandanten** — das ist #88.

## Pflege

Dieses Dokument wird von zwei Tests gegen den Code gehalten:

- `apps/api/src/contexts/platform/__tests__/permission-catalog.test.ts` prüft den Katalog selbst:
  eindeutige Tripel, genau zwei Reichweiten, kein `EIGENE` auf einer Mandant-Ressource und den
  Abgleich mit der eingecheckten Tabelle aus Issue #72.
- `apps/api/src/__tests__/permission-site-mapping.test.ts` prüft dieses Dokument: die Aufrufstellen
  und Handler-Prüfungen gegen den Quellbaum, die Abschnitte „Ressourcen“ und „Permissions“ gegen den
  Katalog.

Ausführen:

```bash
pnpm --filter @clokr/api run test:setup
pnpm --filter @clokr/api exec vitest run src/__tests__/permission-site-mapping.test.ts src/contexts/platform/__tests__/permission-catalog.test.ts
```

Was eine rote Meldung bedeutet und was zu tun ist:

- **„a requireRole call site was added or removed“** oder **„a role check was added or removed“** —
  in der genannten Datei ist eine Stelle hinzugekommen oder weggefallen. Zeile im genannten
  Abschnitt ergänzen oder löschen; „Stelle“ ist die aktuelle Zeile, Permission und Reichweite kommen
  aus dem Katalog.
- **Ein neuer Treffer der Handler-Suche, der keine Zugriffsentscheidung trifft** (Rolle nur geloggt,
  ins Token geschrieben, gesetzt oder als Datenfilter benutzt) — Zeile im Abschnitt „Nicht gezählte
  Treffer“ mit Begründung.
- **„names a permission the catalog does not have“** — die Zeile nennt eine Permission oder
  Reichweite, die es im Katalog nicht gibt: Zeile korrigieren, nicht den Katalog passend machen.
- **Abschnitte „Permissions“ oder „Ressourcen“ passen nicht zum Katalog** — eine neue Permission oder
  Ressource (etwa aus #73 oder #74) braucht eine Zeile in „Permissions“ und, bei einer neuen
  Ressource, eine in „Ressourcen“; eine entfernte verliert ihre Zeilen. `ISSUE_72_TABLE` im
  Katalogtest wird nur zusammen mit dem Ticket erweitert, das die neue Permission begründet.
- **„unparseable rows“** — eine Tabellenzeile hat das falsche Format (fehlende Backticks, falsche
  Spaltenzahl, zu kurzer oder leerer Text). Zeile reparieren, nie den Parser lockern.

Zeilennummern sind Belege, keine Adressen: Eine reine Verschiebung macht die Tests nicht rot. Wer
Zeilen neu nachmisst, aktualisiert „Codestand der Belege“ im Kopf dieses Dokuments.

Bekannte Grenzen, ausdrücklich hingenommen:

1. Wandert eine Stelle innerhalb derselben Datei von einer Route zu einer anderen, ohne dass sich
   die Anzahl der Stellen in der Datei ändert, merkt der Test das nicht (D-10).
2. Eine Rollenprüfung in einer Form, die keine der beiden Suchen erkennt — etwa eine per
   Destrukturierung gelesene Rolle, die über `.includes(...)` verglichen wird — bleibt unsichtbar.
   Rollenprüfungen deshalb gegen `req.user.role` bzw. `user.role` schreiben.
3. Dieses Dokument wird auch von der API-Testsuite in CI gelesen. Deshalb steht es im Pfadfilter
   `api:` von `.github/workflows/ci.yml`; eine reine Änderung an diesem Dokument startet die
   API-Tests.
