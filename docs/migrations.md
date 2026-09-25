# Database Migrations

Clokr uses **versioned Prisma migrations** for all schema changes. This replaces the
old unversioned `prisma db push` boot behaviour.

## Why versioned migrations (audit finding F-C2 / OPS-V1814-01)

`prisma db push` compares the live database to `schema.prisma` and mutates the DB to
match — it can **drop columns/tables or reset data on boot** with no review and no
history. That is unacceptable for an audit-proof (revisionssicher) system.

Versioned migrations fix this:

- **Reviewable** — each change is a committed SQL file in
  `packages/db/prisma/migrations/`, visible in code review.
- **Audit-traceable** — the applied history lives in the `_prisma_migrations` table;
  who/when/what is reconstructable (Revisionssicherheit).
- **Fails _safely_** — running `migrate deploy` against a database that already has the
  schema but was never baselined fails with **P3005** and applies **nothing** (it drops
  nothing). Contrast with `db push`, which would silently "fix" the DB.

The baseline migration is `packages/db/prisma/migrations/0_init/` — a **CREATE-only**
snapshot of the schema as it existed when migrations were introduced. It contains no
`DROP`/`TRUNCATE`/`DELETE` and no destructive `ALTER`.

## Everyday dev workflow

Create and apply a migration locally:

```bash
pnpm --filter @clokr/db exec prisma migrate dev --name <short-description>
```

This:

1. generates a new timestamped migration folder under
   `packages/db/prisma/migrations/`,
2. applies it to your local dev database,
3. regenerates the Prisma client.

**Commit the generated migration folder.** Every environment then applies pending
migrations automatically via `prisma migrate deploy` (run by the container entrypoint,
`apps/api/docker-entrypoint.sh`).

> `migrate dev` needs a **shadow database** (Prisma creates and drops a temporary DB on
> the same server). The local docker `clokr` superuser can do this out of the box.
> `migrate dev` is **dev-only** — never run it against int/prod.

### ⚠️ `migrate dev` can reset your local dev database — dump first

`migrate dev` is not purely additive: when it detects drift between the live database and
the migration history (or a previously-failed migration), Prisma's own remedy is to
**reset the target database** — drop and recreate it, then replay every migration from
scratch. On local dev this happens **without a confirmation prompt** in a non-interactive
shell. This is not hypothetical: it happened on this project on 2026-08-19 (the timestamp
also carried by the `20260819094159_add_opening_balance` migration folder) and took every
piece of accumulated local fixture/demo data with it — no local backup existed at the
time.

**Take a dump before running `migrate dev` against local dev** (`backups/` is gitignored,
see `.gitignore:71`):

```bash
docker compose exec -T postgres pg_dump -U clokr -Fc clokr > backups/clokr-dev-$(date +%F-%H%M).dump
```

Restore it with:

```bash
docker compose exec -T postgres pg_restore --clean --if-exists -U clokr -d clokr < backups/clokr-dev-<timestamp>.dump
```

**Since Phase 101, a test run no longer writes to the dev database** (see
`docs/testing.md`) — `migrate dev` and other manual `packages/db` operations against a
`DATABASE_URL` pointed at `clokr` are now the only things that put local dev data at risk.

**In practice, this project mostly avoids `migrate dev` for exactly this reason.** Every
recent schema-adding phase (STATE.md decisions 85-01, 91-01, 96-01) deliberately used
`prisma migrate diff` against a throwaway shadow database (e.g. `clokr_shadow`) to generate
the migration SQL, then applied it with `migrate deploy` — never `migrate dev` — because
this project's local dev database has long-standing, pre-existing index drift that makes
`migrate dev` reset-prone on repeat offense, not just on 2026-08-19. **Prefer `migrate
diff` + `migrate deploy`** for any schema change once your local dev database has drifted
even once; reserve plain `migrate dev` for a genuinely fresh, never-drifted local database,
and take the dump above first regardless.

Apply pending migrations manually (normally the entrypoint does this):

```bash
pnpm --filter @clokr/db exec prisma migrate deploy
```

## Fresh / empty database (fresh dev, brand-new int)

On a genuinely empty database, `migrate deploy` simply runs `0_init` (and any later
migrations) in order — no prompts, no data loss. This is exactly what the container
entrypoint does on first boot.

## ⚠️ One-time int/prod baseline runbook — SAFETY-CRITICAL, HUMAN-EXECUTED (COMPLETED)

> **Historical / completed.** This one-time baselining was carried out once per
> environment during the v1.8.x migration-foundation rollout. Both int and prod are now
> baselined and run `migrate deploy` normally. The runbook is retained for reference and
> for any _future_ environment that starts from an un-baselined `db push` state.

At that time the int and prod databases **already contained the full schema** (created by
prior `db push`) but had **no `_prisma_migrations` table yet** — they were _un-baselined_.
Prisma had to be told that `0_init` was already applied, **without executing its DDL**.

**This was NOT automated by any code in this repo.** An operator ran it deliberately,
once per environment, at the post-migration-foundation checkpoint.

Steps (per environment — int first, then prod):

1. **Confirm the target and back up first.** Make sure `DATABASE_URL` points at the
   correct, already-populated environment, then take a full backup:

   ```bash
   pg_dump "$DATABASE_URL" > backup-<env>-$(date +%F).sql
   ```

2. **Record the baseline as applied — runs NO DDL** (creates/alters/drops nothing; it
   only inserts a row into `_prisma_migrations`):

   ```bash
   DATABASE_URL=<env-dsn> pnpm --filter @clokr/db exec prisma migrate resolve --applied 0_init
   ```

3. **Verify:**

   ```bash
   DATABASE_URL=<env-dsn> pnpm --filter @clokr/db exec prisma migrate status
   # Expect: "Database schema is up to date!"
   ```

**NEVER** run `prisma migrate deploy` or `prisma db push` against int/prod **before**
the `migrate resolve --applied 0_init` step above. Doing so risks touching live data.
After baselining, future migrations flow normally via `migrate deploy`.

## Failure semantics — P3005 is the SAFE failure

If `migrate deploy` reports:

```
P3005: The database schema is not empty.
```

…the database was **not baselined**. This is the _safe_ failure — Prisma applied
nothing and dropped nothing. **Do not** force it and **do not** `db push`. Run the
`migrate resolve --applied 0_init` step from the runbook above instead.

## Production entrypoint guard

`apps/api/docker-entrypoint.sh` runs `prisma migrate deploy` whenever a migrations
directory is present (now always, since `0_init` ships in the image). If no migrations
dir is present **and** `NODE_ENV=production`, the entrypoint prints a loud fatal error
and **exits 1** — it will **never** silently fall back to `db push` in production.
Dev/test keep the `db push` fallback for iteration speed.

## CI drift check

CI runs a drift guard that fails the build if `schema.prisma` has diverged from the
committed migrations history (e.g. someone edited the schema without `migrate dev`, or
regenerated `0_init`):

```bash
pnpm --filter @clokr/db exec prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema prisma/schema.prisma \
  --exit-code
```

Exit code `2` means drift → the job fails. Note: `--from-migrations` **replays** the
migrations into a **shadow database**, so this check needs a Postgres service and a
`SHADOW_DATABASE_URL` (wired up in `.github/workflows/ci.yml`; Prisma 7 reads the shadow
URL from `packages/db/prisma.config.ts`). It is **not** a purely offline check.

## Adding schema changes in later phases

Phases that add columns/indexes (e.g. 76.19/76.20/76.21) create a **new** `migrate dev`
migration on top of `0_init`. They **must never regenerate `0_init`** — that baseline is
frozen.

## Phase 97 — LeaveType.code (Rollout-Reihenfolge)

**0. Rollout-Einheit: die Migration darf nicht vor dem Schreibpfad ausgeliefert werden.**

Die drei Migrationen und die Umstellung der beiden Laufzeit-Schreibpfade (`ensureLeaveType()`,
`test-bootstrap.ts`) gehen **zwingend in dasselbe Release**. Der Grund ist nicht das kurze
Rolling-Deploy-Fenster, sondern die ganze Zeitspanne zwischen zwei Releases: solange das
ausgelieferte Image Abwesenheitsarten noch über den Anzeigenamen anlegt, erzeugt **jede**
Neuanlage — neuer Mandant, erstmalig genutzter Typ — eine Zeile ohne Code, die für jeden
code-basierten Leser dauerhaft unsichtbar ist. Auf int reagiert ArgoCD auf jeden Merge nach
`main`; „wir liefern das gleich hinterher" ist deshalb keine Zusicherung, sondern ein offenes
Fenster von unbestimmter Dauer.

Praktisch heisst das: **ein Merge, nicht drei.** Vor dem Merge prüfen:

```bash
# muss BEIDES liefern, sonst nicht mergen:
ls packages/db/prisma/migrations | grep leave_type_code          # die drei Ordner
grep -c 'leaveTypeFields' apps/api/src/contexts/absence/api/leave.ts apps/api/src/contexts/platform/api/test-bootstrap.ts
```

Liefert der zweite Befehl für eine der beiden Dateien `0`, ist der Schreibpfad noch nicht
umgestellt — dann darf die Migration nicht mit.

**1. Die drei Migrationen** gehen in EINEM Release (additive Spalte → Backfill → Unique-Index).
`SET NOT NULL` geht **nicht** mit — es ist ein eigener, späterer Schritt (Phase 97 Plan 10).

**2. Vor `migrate deploy` auf der Zielumgebung — Duplikat-Vorprüfung (lesend):**

```sql
SELECT "tenantId", name, count(*) FROM "LeaveType"
WHERE name IN ('Urlaub', 'Jahresurlaub', 'Urlaub (Jahresurlaub)')
GROUP BY "tenantId", name ORDER BY 1;
```

Erscheint für denselben `tenantId` mehr als eine dieser Zeilen, bildet der Backfill sie auf
denselben Code ab und `CREATE UNIQUE INDEX` schlägt fehl. Erst auflösen, dann deployen.

**3. Nach `migrate deploy`, sobald der ALTE Pod vollständig terminiert ist — Nachlauf-Sweep:**

Das alte Image kennt `code` nicht. Legt es im Rolling-Deploy-Fenster über `ensureLeaveType()`
einen bis dahin ungenutzten Typ an, entsteht eine Zeile mit `code = NULL` — widerspruchsfrei,
ohne Fehler, und für jeden code-basierten Leser dauerhaft unsichtbar. Der Sweep ist sicher
wiederholbar, weil seine Auswahlbedingung schlicht `code IS NULL` lautet — jede noch offene
Zeile, unabhängig davon, wie sie entstand. Erst Dry-Run, dann anwenden:

```bash
DATABASE_URL=... pnpm --filter @clokr/api exec tsx scripts/backfill-leave-type-code.ts --all-tenants
DATABASE_URL=... pnpm --filter @clokr/api exec tsx scripts/backfill-leave-type-code.ts --all-tenants --apply
```

**Diese Form gilt für dev und int, NICHT für prod.** Sie setzt einen Repo-Checkout mit `pnpm`
UND eine von aussen erreichbare Datenbank voraus. Auf prod ist der Postgres-Port im
Compose-Netz sichtbar, aber nicht auf den Host veröffentlicht — am 2026-09-22 gemessen:

```
docker inspect clokr-db --format '{{json .NetworkSettings.Ports}}'  ->  {"5432/tcp":null}
```

Kein `DATABASE_URL` von aussen erreicht sie also. Auf prod läuft der Sweep **im API-Container**.
Dort gibt es weder `pnpm` noch `npx`, wohl aber den TypeScript-Runner und das Skript selbst:

```bash
ssh <prod-host> 'docker exec clokr-api sh -lc \
  "cd /app && ./node_modules/.bin/tsx apps/api/scripts/backfill-leave-type-code.ts --all-tenants"'
```

Ausgabe des Laufs vom 2026-09-22 (prod, gegen v1.11.0, Dry-Run):

```json
{
  "dryRun": true,
  "tenantsScanned": 1,
  "rowsScanned": 5,
  "planned": [],
  "applied": 0,
  "unmapped": [],
  "conflicts": []
}
```

**Ist `planned` leer, wird `--apply` NICHT gefahren** — es gäbe nichts anzuwenden, und ein
Leerlauf ist kein zusätzlicher Beleg. Der Nachweis ist dann Schritt 4, nicht ein zweiter Aufruf.

**Nachtrag (Issue #206):** Der Sweep war ein einmaliger Rollout-Schritt für das Fenster zwischen
Backfill-Migration und `SET NOT NULL`. Die Migration
`packages/db/prisma/migrations/20260923090815_leave_type_code_not_null` hat den Zustand
`code IS NULL` in der Datenbank dauerhaft unmöglich gemacht — der Sweep hätte ab diesem Release
für immer nichts mehr zu finden. `scripts/backfill-leave-type-code.ts` wurde deshalb mit dieser
Änderung entfernt (samt seiner Testdatei); die Befehle und die gemessene Ausgabe oben bleiben als
Beleg für den abgeschlossenen Rollout stehen, sind aber nicht mehr ausführbar.

Nebenbei, weil es die Erwartung an diesen Schritt verschiebt: prod läuft als
Docker-Compose-Recreate, nicht als Rolling Deploy. Das Fenster, in dem das ALTE Image über
`ensureLeaveType()` eine Zeile ohne Code anlegen könnte, existiert dort praktisch nicht — auf
int (ArgoCD, echtes Rolling Deploy) sehr wohl. Der Schritt entfällt deshalb nirgends; er ist auf
prod nur erwartbar ein No-op, und genau das ist oben gemessen statt zugesichert.

**4. Verifikation — nachmessen, nicht zusichern (Lehre aus Phase 96 WR-02):**

```sql
SELECT count(*) FROM "LeaveType" WHERE code IS NULL;   -- erwartet: 0
SELECT "tenantId", code, count(*) FROM "LeaveType"
GROUP BY "tenantId", code HAVING count(*) > 1;         -- erwartet: 0 Zeilen
```

Erst wenn beide Abfragen das erwartete Ergebnis liefern, darf `SET NOT NULL` (Plan 10) laufen.
Meldet der Dry-Run `unmapped`-Zeilen, trägt ein Mandant einen eigenen Typnamen — das ist eine
Rückfrage an den Betreiber, kein Fall für einen Ersatzcode.

**5. `code` auf `NOT NULL` gesetzt — abgeschlossen, Issue #206.**

> **Rollout-Reihenfolge, nicht nur Zeitpunkt (Owner-Entscheidung 2026-09-18).** Die Vorbedingung
> nannte eine **Version**: das Release mit Phase 97 ist **v1.11.0**. prod wurde deshalb NICHT von
> v1.10.x direkt auf v1.11.1 gezogen, sondern der Reihe nach — erst v1.11.0 (dort den
> Nachlauf-Sweep gefahren und seine Ausgabe festgehalten, siehe Schritt 3), dann v1.11.1. Ein
> Versionssprung hätte diese Vorbedingung dauerhaft unerfüllbar gemacht, weil das Release, das sie
> erfüllt, auf prod nie als ausgelieferter Zustand existiert hätte. Siehe `docs/release-process.md`
> § „Upgrade path: do not skip a version on prod".

Die sechs Vorbedingungen (0 codelose Zeilen auf int UND prod, 0 Duplikat-`(tenantId, code)`-Gruppen
auf beiden, 5-Zeilen-Kontrolle) wurden am 2026-09-23 gemessen und auf Issue #206 dokumentiert. Die
Migration `packages/db/prisma/migrations/20260923090815_leave_type_code_not_null`
(`ALTER TABLE "LeaveType" ALTER COLUMN "code" SET NOT NULL`) ist damit gelandet;
`ensureLeaveType()`s Selbstheilungspfad und ein zweiter, symmetrischer 400-Riegel im
`correct`-Handler (beide griffen nur bei einer codelosen Zeile) sind mit ihr entfernt worden. Der
Nachlauf-Sweep-Skript `scripts/backfill-leave-type-code.ts` wurde ebenfalls entfernt (siehe
Nachtrag zu Schritt 3) — seine einzige Auswahlbedingung (`code IS NULL`) kann ab diesem Release
kein Ergebnis mehr liefern.

(Schritte 0-4 stehen oben; Schritt 0 ist die Rollout-Einheit R1 — Migration und Schreibpfad in
EINEM Merge.)

`apps/api/docker-entrypoint.sh` fährt `migrate deploy` im Entrypoint des NEUEN Containers,
während die ALTE Replica noch Traffic bedient. Jede Migrationsdatei, die im Repo liegt, läuft
also beim nächsten Deploy — „später" heisst deshalb: den Ordner erst in einem Folge-Release
anlegen, nicht hier und nur ungenutzt liegen lassen.

Legt das alte Image im Deploy-Fenster über `ensureLeaveType()` einen bis dahin ungenutzten Typ
an, entsteht eine Zeile mit `code = NULL`. Läuft `SET NOT NULL` im selben Release, bricht
entweder der alte Pod sichtbar mit einem 500er, oder der `migrate deploy`-Lauf des neuen Pods
scheitert an der gerade geschriebenen NULL-Zeile — und der neue Pod wird nicht gesund.
`ALTER COLUMN ... SET NOT NULL` validiert immer sofort per vollem Tabellenscan; eine
`NOT VALID`-Option gibt es für Spalten-NOT-NULL nicht.

Zwei Vorbedingungen, beide auf der Zielumgebung zu messen, bevor der Ordner überhaupt
angelegt wird:

```sql
SELECT count(*) FROM "LeaveType" WHERE code IS NULL;                    -- muss 0 sein
SELECT count(*) FROM "LeaveType" lt
  JOIN "LeaveRequest" lr ON lr."leaveTypeId" = lt.id AND lr."deletedAt" IS NULL
  WHERE lt.code IS NULL;                                                 -- muss 0 sein
```

Erst danach:

```sql
ALTER TABLE "LeaveType" ALTER COLUMN "code" SET NOT NULL;
```

und im Schema `code LeaveTypeCode?` zu `code LeaveTypeCode` ändern.
Folge-Issue: [#206](https://github.com/sebastianzabel/clokr/issues/206).

## Phase 75b — Systemrollen und Migration der Alt-Rollen (Issue #75)

**Was die Migration tut.** `packages/db/prisma/migrations/20260925070842_system_roles_and_legacy_role_assignments`
ist eine reine Datenmigration — keine Tabelle, keine Spalte, kein Index, kein Typ wird angelegt,
geändert oder gelöscht (`prisma migrate diff` bleibt leer). Sie

1. legt die drei globalen Systemrollen an (`AccessRole` mit `tenantId` NULL): Admin
   (`00000000-0000-4000-8000-00000000a001`, 87 Permissions), Manager (`…a002`, 63) und
   Mitarbeiter (`…a003`, 22). Der Code erkennt sie ausschließlich an diesen festen Ids, nie am
   Namen (`apps/api/src/contexts/platform/system-roles.ts`);
2. gibt jedem Nutzer mit `Employee`, dessen Mitarbeiter NICHT anonymisiert ist und der noch
   keine `RoleAssignment` hat, genau eine Zuweisung mit Scope `TENANT` (leere Salon- und
   Personenliste, `tenantId` = Mandant des Mitarbeiters) auf die Systemrolle seiner Alt-Rolle
   `User.role` (ADMIN → Admin, MANAGER → Manager, EMPLOYEE → Mitarbeiter);
3. schreibt pro angelegter Zuweisung genau einen Audit-Eintrag: `action` `CREATE`, `entity`
   `RoleAssignment`, `userId` NULL (Akteur ist das System), `newValue` mit
   `origin: "SYSTEM"`, `reason: "Migration der Alt-Rolle (#75)"`, `legacyRole` und den
   Schlüsseln der Phase-74b-Audits (`userId`, `accessRoleId`, `roleName`, `scopeType`,
   `salonIds`, `employeeIds`);
4. meldet per `RAISE NOTICE` vier Zahlen, die zusammen jeden `User` genau einmal zählen:
   angelegte Zuweisungen, Nutzer ohne `Employee` (bekommen keine Zuweisung — ohne Mitarbeiter
   gibt es keinen Mandanten), übersprungene Anonymisierte und übersprungene Nutzer, die schon
   eine Zuweisung hatten.

Sie ist **additiv** und **idempotent**: Die Rollen werden mit `ON CONFLICT ("id") DO NOTHING`
eingefügt, eine Zuweisung entsteht nur für Nutzer ohne jede Zuweisung — ein zweiter Lauf legt
nichts an und schreibt kein Audit. `User.role` wird nirgends geschrieben; jeder Nutzer behält
seine Alt-Rolle byte-gleich.

**1. Vor `migrate deploy` — Namensprüfung (lesend).** Heißt eine Kundenrolle wie eine
Systemrolle, wäre der Name nach der Namensregel aus Phase 73b nicht mehr eindeutig:

```sql
-- Customer roles whose case-insensitive name collides with a system role. Expected: 0 rows.
SELECT "id", "tenantId", "name", "nameKey"
FROM "AccessRole"
WHERE "tenantId" IS NOT NULL
  AND "nameKey" IN ('admin', 'manager', 'mitarbeiter');
```

Liefert sie Zeilen: melden und mit dem Betreiber klären, **nicht** still umbenennen — der Name
einer Kundenrolle gehört dem Mandanten.

**2. Vor und nach `migrate deploy` — die Zahlen der NOTICE nachrechnen (lesend).** Prisma gibt
`RAISE NOTICE` nicht aus; im Deploy-Log steht die Meldung deshalb nicht. Diese Abfrage liefert
dieselben vier Zahlen. **Vor** dem Deploy zeigt `created`, wie viele Zuweisungen die Migration
anlegen wird; **nach** dem Deploy muss `created` 0 sein und `already_assigned` um genau diese
Zahl gewachsen sein. Ein `created` größer 0 nach dem Deploy heißt: Ein alter Pod hat im
Deploy-Fenster Nutzer ohne Zuweisung angelegt. Für sie gilt weiter ihre Alt-Rolle (der
Alt-Rollen-Rückfall aus Issue #75); ein erneuter Lauf der Migration ist nicht nötig. Der Testfall in `apps/api/src/__tests__/system-roles-migration.test.ts`
liest die Abfrage aus diesem Dokument (zwischen den beiden Markierungen) und vergleicht sie mit
der NOTICE — sie kann deshalb nicht unbemerkt von der Migration abweichen.

<!-- 75b-count-selects:begin -->

```sql
-- Read-only. Every "User" row lands in exactly one bucket; "created" counts the users the
-- migration assigns (Employee present, not anonymized, no RoleAssignment yet).
SELECT
  count(*) FILTER (WHERE has_employee AND NOT anonymized AND NOT assigned) AS created,
  count(*) FILTER (WHERE NOT has_employee) AS without_employee,
  count(*) FILTER (WHERE has_employee AND anonymized) AS anonymized,
  count(*) FILTER (WHERE has_employee AND NOT anonymized AND assigned) AS already_assigned
FROM (
  SELECT
    e."id" IS NOT NULL AS has_employee,
    -- The anonymization sentinel (firstName 'Gelöscht', lastName 'GELÖSCHT-…'), umlauts escaped.
    coalesce(e."firstName" = U&'Gel\00F6scht' AND e."lastName" LIKE U&'GEL\00D6SCHT-%', false) AS anonymized,
    EXISTS (SELECT 1 FROM "RoleAssignment" ra WHERE ra."userId" = u."id") AS assigned
  FROM "User" u
  LEFT JOIN "Employee" e ON e."userId" = u."id"
) AS buckets;
```

<!-- 75b-count-selects:end -->

Nach dem Deploy zusätzlich, beides lesend:

```sql
-- One System audit row per assignment the migration created. Expected: the "created" number
-- measured before the deploy.
SELECT count(*)
FROM "AuditLog"
WHERE "entity" = 'RoleAssignment'
  AND "userId" IS NULL
  AND "newValue"->>'reason' = 'Migration der Alt-Rolle (#75)';

-- The three system roles. Expected: 3 rows, 87 / 63 / 22 permissions, tenantId NULL.
SELECT "id", "name", cardinality("permissions") AS permissions, "tenantId"
FROM "AccessRole"
WHERE "id" IN (
  '00000000-0000-4000-8000-00000000a001',
  '00000000-0000-4000-8000-00000000a002',
  '00000000-0000-4000-8000-00000000a003'
)
ORDER BY "id";
```

**3. Nach dem Rollout, sobald der ALTE Pod vollständig terminiert ist — Konsistenzprüfung
(lesend).** `apps/api/docker-entrypoint.sh` fährt `migrate deploy` beim Start des NEUEN
Containers, während der alte noch Anfragen bedient (auf int ein echtes Rolling Deploy). Ändert der
alte Pod in diesem Fenster über `PATCH /employees/:id` eine Rolle, schreibt er nur `User.role` —
die gespeicherte Zuweisung, nach der der neue Code entscheidet, bleibt die alte. Diese Abfrage
findet genau solche Nutzer: die Rolle, die sich aus den GESPEICHERTEN Zuweisungen ergibt (Admin
bei einer `TENANT`-Zuweisung auf die Admin-Systemrolle, sonst Manager bei mindestens einer
ZUGEWIESEN-Permission, sonst Mitarbeiter), weicht von `User.role` ab. Nutzer ohne Zuweisung
fehlen darin absichtlich — für sie gilt `User.role` unverändert.

<!-- 75b-consistency-select:begin -->

```sql
-- Read-only. Users whose role derived from their STORED assignments differs from "User"."role".
-- Expected right after this migration: 0 rows.
WITH derived AS (
  SELECT
    ra."userId",
    CASE
      WHEN bool_or(ra."accessRoleId" = '00000000-0000-4000-8000-00000000a001'
                   AND ra."scopeType" = 'TENANT') THEN 'ADMIN'
      WHEN bool_or(EXISTS (SELECT 1 FROM unnest(ar."permissions") AS p(key)
                           WHERE p.key LIKE '%:ZUGEWIESEN')) THEN 'MANAGER'
      ELSE 'EMPLOYEE'
    END AS derived_role
  FROM "RoleAssignment" ra
  JOIN "AccessRole" ar ON ar."id" = ra."accessRoleId"
  GROUP BY ra."userId"
)
SELECT u."id", u."role"::text AS column_role, d.derived_role
FROM derived d
JOIN "User" u ON u."id" = d."userId"
WHERE u."role"::text <> d.derived_role;
```

<!-- 75b-consistency-select:end -->

Abhilfe für jede gefundene Zeile: die gewünschte Rolle über den NEUEN Code erneut speichern
(`PATCH /employees/:id` mit `role`). Im selben Release (Issue #75) ersetzt dieser Aufruf die
Systemrollen-Zuweisung und schreibt `User.role` aus den Zuweisungen zurück — danach ist die Zeile
aus der Abfrage verschwunden.

**4. Rollback.** Das vorige Release liest weder `AccessRole` noch `RoleAssignment` für eine
Zugriffsentscheidung; es ignoriert die neuen Zeilen. `User.role` ist für jeden Nutzer, den die
Migration berührt hat, unverändert — ein Rollback auf das vorige Image funktioniert ohne
Datenkorrektur (AC-75-8). **Eine Einschränkung gilt erst später:** Sobald ein Nutzer eine
Kundenrolle mit mindestens einer ZUGEWIESEN-Permission hält, schreibt der neue Code `MANAGER` in
`User.role` (D-14). Ein Rollback würde diesen Nutzer als vollen Manager lesen. Vor 75b hält kein
produktiver Nutzer eine Kundenrolle — das ist deshalb kein Risiko des Deploys selbst, wohl aber
eines jedes späteren Rollbacks über 75b hinweg.

## Retention EOL policy (COMP-V1814-07)

Clokr uses a **two-stage retention lifecycle** for employee data:

**Stage 1 — Soft-delete / documented archive** (`data-retention.ts`)

The `dataRetentionPlugin` runs annually (Jan 2nd, 03:00 Europe/Berlin) and soft-deletes
time entries, leave requests, and absences older than the tenant's `dataRetentionYears`
configuration (default 10, minimum 2). Soft-delete sets `deletedAt` — the rows are
preserved for audit trail but hidden from normal queries. This IS the documented archive:
it satisfies §147 AO / §257 HGB retention requirements.

**Stage 2 — Hard-delete** (`DELETE /api/v1/employees/:id/hard-delete`)

Irreversible erasure of the employee record and all related data, invoked only when DSGVO
Art. 17 requires it after the longest applicable retention period. Hard-delete is gated by
**two unconditional guards**:

1. **§16 Abs. 2 ArbZG 2-year floor** — The employee's `exitDate` (or `createdAt` if no
   exit date is recorded) must be more than 2 full calendar years in the past. No
   `forceDelete` flag or admin override can bypass this floor. Returns HTTP 409 with
   `floorExpiresAt`.

2. **4-eyes gate inside the retention window** — If the full retention period has not yet
   expired but an ADMIN requests `forceDelete: true`, a second ADMIN must first call
   `POST /api/v1/employees/:id/hard-delete/authorize`. This writes a
   `HARD_DELETE_AUTHORIZED` AuditLog entry (TTL 15 minutes). The hard-delete then checks
   for a valid authorization authored by a **different** admin (`userId ≠ caller`) within
   the last 15 minutes. Self-authorization is rejected. Returns HTTP 409 with
   `"4-Augen-Prinzip"` message if no valid token is found.

Only after both guards pass does the `$transaction` delete cascade proceed.
