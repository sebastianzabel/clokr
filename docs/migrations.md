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

## Phase 76b — Systemrollen-Templates (Issue #76)

**Was die Migration tut.** `packages/db/prisma/migrations/20260926074542_system_role_templates`
ist eine reine Datenmigration — keine Tabelle, keine Spalte, kein Index, kein Typ wird angelegt,
geändert oder gelöscht (`prisma migrate diff` bleibt leer). Sie legt vier weitere globale
Systemrollen an (`AccessRole` mit `tenantId` NULL): Inhaber (`…a004`, 87 Permissions),
Salonmanager (`…a005`, 24), Personalabteilung (`…a006`, 13) und Ausbilder (`…a007`, 5). Die Ids
werden mit `ON CONFLICT ("id") DO NOTHING` eingefügt, ein zweiter Lauf legt nichts an. Die vier
Zeilen weisen niemandem etwas zu — keine `RoleAssignment`-Zeile, kein Audit-Eintrag (AK-76b-8):
Ein Kunde übernimmt ein Template nur über den bestehenden Endpunkt `POST /api/v1/roles/:id/copy`.

**1. Vor `migrate deploy` — Namensprüfung (lesend).** Heißt eine Kundenrolle wie eines der vier
neuen Templates, wäre der Name nach der Namensregel aus Phase 73b nicht mehr eindeutig:

```sql
-- Customer roles whose case-insensitive name collides with one of the four new templates.
-- Expected: 0 rows.
SELECT "id", "tenantId", "name", "nameKey"
FROM "AccessRole"
WHERE "tenantId" IS NOT NULL
  AND "nameKey" IN ('inhaber', 'salonmanager', 'personalabteilung', 'ausbilder');
```

Liefert sie Zeilen: melden und mit dem Betreiber klären, **nicht** still umbenennen — der Name
einer Kundenrolle gehört dem Mandanten. Eine bestehende Kundenrolle mit einem dieser Namen bleibt
danach funktionsfähig, kann aber nicht mehr in diesen Namen umbenannt oder neu unter diesem Namen
angelegt werden (409) — die vier Namen sind ab dieser Migration für Kundenrollen reserviert.

**2. Nach `migrate deploy` — Kontrolle (lesend).**

```sql
-- The seven global system-role rows. Expected: 7 rows, 87/63/22/87/24/13/5 permissions, tenantId
-- NULL for all.
SELECT "id", "name", cardinality("permissions") AS permissions, "tenantId"
FROM "AccessRole"
WHERE "id" IN (
  '00000000-0000-4000-8000-00000000a001',
  '00000000-0000-4000-8000-00000000a002',
  '00000000-0000-4000-8000-00000000a003',
  '00000000-0000-4000-8000-00000000a004',
  '00000000-0000-4000-8000-00000000a005',
  '00000000-0000-4000-8000-00000000a006',
  '00000000-0000-4000-8000-00000000a007'
)
ORDER BY "id";
```

**3. Rollback.** Das vorige Release trifft keine Zugriffsentscheidung anhand der vier neuen Ids —
niemand kann ihnen zugewiesen sein, weil erst diese Phase sie überhaupt kennt (`SYSTEM_ROLE_IDS`
des alten Codes hat nur drei Einträge). Ein Rollback auf das vorige Image funktioniert ohne
Datenkorrektur; eine Löschung der vier Zeilen ist nicht nötig. **Eine Einschränkung gilt für die
Dauer eines Rollbacks:** Die alte `isSystemRoleId()` erkennt die vier neuen Zeilen nicht als
Systemrolle, `GET /api/v1/roles` listet sie unter dem alten Code aber ganz normal mit auf (die
Route selektiert jede globale Rolle, nicht nur die per Id bekannten) — der alte Code würde ein
`PATCH`/`DELETE` auf eine der vier Ids deshalb nicht mit dem 409-Systemrollen-Schutz ablehnen. Kein
Problem für einen kurzen Rollback ohne Bedienung dieser Rollen; bei einem längeren Rollback vorher
mit dem Betreiber klären.

## Phase 86b — Personalabteilung erhält Berichte lesen und Salons lesen (Issue #86)

**Release-Hinweis.** Die Migration gilt sofort für **alle** Konten mit der Systemrolle
Personalabteilung (Owner-Entscheidung 16.10.2026, Semantikänderung des Unterbaus): Sie erhalten
`report:read:ZUGEWIESEN` und `salon:read:ZUGEWIESEN`. Kundenkopien des Templates (mandanteneigene
Rollen) bleiben unverändert.

**Was die Migration tut.** `packages/db/prisma/migrations/20261016102152_hr_template_report_salon_read`
ist eine reine Datenmigration — keine Tabelle, keine Spalte, kein Index, kein Typ wird angelegt,
geändert oder gelöscht (`prisma migrate diff` bleibt leer). Sie aktualisiert genau eine Zeile: die
globale Personalabteilung (`…a006`, `tenantId` NULL) von 13 auf 15 Permissions. Der
`IS DISTINCT FROM`-Schutz macht einen zweiten Lauf zu einem No-op, der weder eine Zeile noch einen
Zeitstempel ändert. Niemandem wird etwas zugewiesen, es entsteht kein Audit-Eintrag.

**1. Vor `migrate deploy` — wer die Rechte erhält (lesend).**

```sql
-- Assignments of the global HR template per tenant and scope: these accounts gain the two keys.
SELECT "tenantId", "scopeType", count(*) AS assignments
FROM "RoleAssignment"
WHERE "accessRoleId" = '00000000-0000-4000-8000-00000000a006'
GROUP BY "tenantId", "scopeType"
ORDER BY "tenantId", "scopeType";

-- Tenant-owned roles whose permissions equal the OLD 13-key template (copies). Informational:
-- they are NOT changed by the migration; expected rows stay unchanged afterwards.
SELECT "id", "tenantId", "name"
FROM "AccessRole"
WHERE "tenantId" IS NOT NULL
  AND "permissions" = ARRAY[
    'employee:read:ZUGEWIESEN', 'employee:create:ZUGEWIESEN', 'employee:update:ZUGEWIESEN',
    'employee:update-avatar:ZUGEWIESEN', 'contract:read:ZUGEWIESEN', 'contract:update:ZUGEWIESEN',
    'leave-request:read:ZUGEWIESEN', 'section9:read:ZUGEWIESEN', 'leave-entitlement:read:ZUGEWIESEN',
    'leave-entitlement:update:ZUGEWIESEN', 'vocational-school:read:ZUGEWIESEN',
    'overtime:read:ZUGEWIESEN', 'month-close:read:ZUGEWIESEN'
  ]::text[];
```

**2. Nach `migrate deploy` — Kontrolle (lesend).**

```sql
-- The seven global system-role rows. Expected: 7 rows, 87/63/22/87/24/15/5 permissions, tenantId
-- NULL for all; only the Personalabteilung row (a006) differs from Phase 76b (13 -> 15).
SELECT "id", "name", cardinality("permissions") AS permissions, "tenantId"
FROM "AccessRole"
WHERE "id" IN (
  '00000000-0000-4000-8000-00000000a001',
  '00000000-0000-4000-8000-00000000a002',
  '00000000-0000-4000-8000-00000000a003',
  '00000000-0000-4000-8000-00000000a004',
  '00000000-0000-4000-8000-00000000a005',
  '00000000-0000-4000-8000-00000000a006',
  '00000000-0000-4000-8000-00000000a007'
)
ORDER BY "id";
```

**3. Rollback.** Das vorige Image liest die Zeile aus der Datenbank: Die Personalabteilung behielte
unter dem alten Code die zwei neuen Keys, und dem alten Code fehlt die Tageslisten-Schwärzung aus
Plan 86b-02. Für einen Rollback, der länger als ein kurzes Fenster dauert, die alte Zeile mit dem
Gegen-UPDATE wiederherstellen und das im Audit-Pfad des Releases vermerken. Es gibt keine
Schemaänderung und in beiden Richtungen keinen Datenverlust.

```sql
-- Reverse of the Phase 86b migration: restores the 13-key Phase 76b template row.
UPDATE "AccessRole"
SET "permissions" = ARRAY[
      'employee:read:ZUGEWIESEN', 'employee:create:ZUGEWIESEN', 'employee:update:ZUGEWIESEN',
      'employee:update-avatar:ZUGEWIESEN', 'contract:read:ZUGEWIESEN', 'contract:update:ZUGEWIESEN',
      'leave-request:read:ZUGEWIESEN', 'section9:read:ZUGEWIESEN', 'leave-entitlement:read:ZUGEWIESEN',
      'leave-entitlement:update:ZUGEWIESEN', 'vocational-school:read:ZUGEWIESEN',
      'overtime:read:ZUGEWIESEN', 'month-close:read:ZUGEWIESEN'
    ]::text[],
    "updatedAt" = NOW()
WHERE "id" = '00000000-0000-4000-8000-00000000a006'
  AND "tenantId" IS NULL;
```

## Phase 566 — Gebuchte Pakete je Mandant (Bestandsschutz, Issue #566)

**Hinweis für die Release Notes (v1.16.0).** Dieser Abschnitt ist der Release-Hinweis zu Phase 566: Vor dem
Deploy gehört die lesende Vorschau (Schritt 1) auf int und prod in den Ablauf, und ihre Ausgabe gehört zum
Material der Release Notes. Ohne sie lässt sich nach dem Deploy nicht belegen, dass kein Mandant etwas
verloren hat.

**Was die Migration tut.** `packages/db/prisma/migrations/20261013233636_tenant_packages` ist additiv: Sie legt den
Aufzählungstyp `TenantModule` (`CHAIN`, `INTEGRATIONS`, `HARDWARE_CLOCK`, `ANALYTICS`) an, ergänzt
`Tenant.bookedModules` (Standard leer) und `Tenant.salonQuota` (Standard 1, `CHECK ("salonQuota" >= 1)`) und führt
danach **eine** markierte `UPDATE`-Anweisung aus (`-- 566-data-migration:begin` … `:end`). Die Anweisung
gibt jedem vorhandenen Mandanten, **auch einem deaktivierten**, was er heute nutzt: `salonQuota` = Zahl aktiver
Salons (mindestens 1); `CHAIN` bei mehr als einem Salon (jeder Zustand), Kundenrolle, Rollenzuweisung mit Bereich
Salons/Personen oder Einsatz-Zuordnung; `INTEGRATIONS` bei Kopplung, API-Schlüssel (auch widerrufen) oder
Phorest-Zugangsdaten; `HARDWARE_CLOCK` bei Terminal-Schlüssel oder Anwesenheitsquelle (jeder Zustand);
`ANALYTICS` bei klassifiziertem Zeiteintrag oder Tätigkeitsanteil. Das gibt absichtlich eher zu viel als zu
wenig. Die Anweisung ist durch eine Bedingung geschützt (nur Mandanten mit Kontingent 1 und ohne Module) und
daher wiederholbar; ein vom Betreiber bereits bearbeiteter Mandant bleibt unberührt. Die
Tätigkeitsarten (Phase 81) erscheinen im selben Release: Auf int und prod gibt es vor dem Deploy keine
Klassifizierung, `ANALYTICS` wird dort also nicht vergeben.

**1. Vor `migrate deploy` — Vorschau (lesend, auf int UND prod).**
`apps/api/scripts/audit-566-package-backfill.ts` schreibt nichts (es gibt keinen Schreib-Schalter, `--apply` und
`--confirm` werden abgelehnt) und gibt je Mandant nur Id, Kontingent, Module und die ausgelösten Signale aus — keine
Namen, keine Zugangsdaten. Das Skript liegt erst im Image des neuen Release; **der Standard-Einstiegspunkt dieses
Images führt `prisma migrate deploy` aus und darf vor der Deploy-Entscheidung niemals gegen int oder prod
gestartet werden.** Deshalb wird der Einstiegspunkt überschrieben:

```bash
# DATABASE_URL zeigt auf die Datenbank der Umgebung (int bzw. prod); aus der Umgebung weitergereicht,
# nicht auf der Kommandozeile ausgeschrieben.
docker run --rm -e DATABASE_URL --entrypoint sh <neues-api-image> \
  -lc 'cd /app/apps/api && pnpm tsx scripts/audit-566-package-backfill.ts' \
  | tee "566-backfill-<umgebung>-$(date +%Y%m%d).txt"
```

Gleichwertig und ebenso sicher: aus einem Checkout des Release-Stands gegen eine wiederhergestellte Kopie des Dumps
(`DATABASE_URL=<Kopie> pnpm --filter @clokr/api exec tsx scripts/audit-566-package-backfill.ts`). Auf
einer Datenbank vor der Migration (Normalfall) meldet das Skript die Tätigkeitsart-Signale als
`analytics=not-evaluable`, alle anderen Zuteilungen stehen vollständig in der Ausgabe; die letzte Zeile
`Totals:` nennt Mandantenzahl und Zahl je Modul. Die Ausgabe aufbewahren (Material der Release Notes). Prüfen:
Jeder Mandant mit mehreren aktiven Salons steht mit `CHAIN`; jeder Mandant mit Kopplung, Schlüssel oder
Anwesenheitsquelle mit dem passenden Modul. Weicht eine Zeile von der Erwartung ab, vor dem Deploy mit dem Betreiber
klären — nichts still korrigieren.

**2. `migrate deploy`** wie gewohnt (Einstiegspunkt des neuen Images, vorher `pg_dump`).

**3. Nach dem Deploy — Vergleich (lesend).**

```sql
-- Stored packages per tenant. Compare with the saved preview: for every tenant an operator has not
-- edited since the deploy, "salonQuota" and "bookedModules" must equal the preview line.
SELECT "id", "bookedModules", "salonQuota" FROM "Tenant" ORDER BY "id";
```

Jede Abweichung, die keine Betreiberänderung ist (`OperatorAuditLog`, Aktion `TENANT_PACKAGES_CHANGED`), wird
gemeldet und **nie still korrigiert**. Ein Betreiber ändert Pakete danach nur über die Konsole
(`/betreiber`, Abschnitt „Pakete“); jede Änderung steht doppelt im Protokoll. Einen neuen Mandanten legt der
Betreiber mit der Grundversion an (keine Module, Kontingent 1) und bucht danach.

**4. Rollback.** Das vorige Image kennt die neuen Spalten nicht und liest sie nie; sie haben Standardwerte, sodass
seine Inserts weiter gelingen, und die `CHECK`-Bedingung verletzt kein altes Schreiben. Ein Rollback funktioniert
deshalb ohne Datenkorrektur, die Migration wird nicht zurückgenommen (vorher wie immer `pg_dump`). Für die Dauer
des Rollbacks gelten die Paketgrenzen **nicht** (der alte Code kennt sie nicht): Alle Mandanten können wieder
beliebig viele Salons, Schlüssel, Terminals und Quellen anlegen. Beim erneuten Vorwärts-Deploy bleiben die
gespeicherten Pakete bestehen; dann den Vergleich aus Schritt 3 wiederholen, weil in der Zwischenzeit Salons
entstanden sein können (die Kontingente lassen sie bestehen, nur neue werden abgelehnt — nie rückwirkend).

## Phase 93b — Support-Zugriff (Issue #93)

**Was die Migrationen tun.** Zwei Verzeichnisse, beide rein additiv, kein Backfill, kein Eingriff in eine bestehende Tabelle:

- `20261015131930_support_access` (**generiert** mit `prisma migrate diff` gegen die Schatten-Datenbank, vor dem Anwenden
  gelesen): legt die Tabelle `SupportAccess` mit zwei Indizes und zwei Fremdschlüsseln an (`Tenant` und `OperatorAccount`,
  beide `ON DELETE RESTRICT`).
- `20261015131931_support_access_append_only` (**von Hand geschrieben**, nur DDL): die Funktion `support_access_guard()`,
  die Trigger `support_access_no_update_delete` (zeilenweise) und `support_access_no_truncate` (je Anweisung) sowie die
  CHECK-Regeln `SupportAccess_endedBy_valid`, `SupportAccess_end_pair` und `SupportAccess_window_valid`.

**Der Trigger ist der zweite des Projekts** (der erste schützt `OperatorAuditLog`, Phase 88). Eine Zeile wird nie
gelöscht und nie geändert, außer durch den einmaligen Übergang von leer auf einen Wert bei `endedAt`/`endedBy`
(`endedByUserId` darf mitgesetzt werden); DELETE ist nur in einer Transaktion mit dem Schalter
`clokr.support_access_retention = 'on'` und nur für Zeilen, die älter als 120 Monate sind, erlaubt (die Bereinigung
`purgeExpiredSupportAccess` im täglichen Aufbewahrungslauf); TRUNCATE ist immer verboten. Der Trigger schützt gegen
Anwendungsfehler, nicht gegen den Tabelleneigentümer, der ihn entfernen könnte.

**Der Drift-Wächter sieht den Trigger nicht.** Prisma bildet weder Trigger noch CHECK-Regeln ab; `prisma migrate diff`
bleibt deshalb leer, und genau deshalb ist die zweite Migration von Hand geschrieben. Der Trigger darf **nie** außerhalb
der Testbereinigung abgeschaltet werden: Nur `cleanupTestData` in `apps/api/src/__tests__/setup.ts` schaltet ihn
innerhalb **einer** Transaktion ab und wieder an; kein Anwendungscode, kein Skript und keine Wartung tut das.

**Rollout.** Reines `prisma migrate deploy` (Einstiegspunkt des neuen Images, vorher wie immer `pg_dump`) auf int und
prod; kein Vorabskript, keine Datenkorrektur, keine Vorschau. `prisma generate` ist nach dem Anwenden nötig, wo der
Client nicht aus dem Image kommt. Der Betreiberzugang bleibt unverändert (`OPERATOR_JWT_SECRET`); ohne ihn sind die sieben
Betreiberrouten nicht registriert, die drei Mandantenrouten (`/api/v1/support-accesses`) sind es immer und zeigen dann eine
leere Liste.

**Rollback.** Das vorige Image kennt `SupportAccess` nicht und liest die Tabelle nie; seine Schreibvorgänge berühren sie
nicht, also braucht ein Rollback keine Datenkorrektur und die Migrationen werden nicht zurückgenommen. Für die Dauer des
Rollbacks gibt es keinen Support-Zugriff (der alte Code kennt die Routen nicht); ein laufender Zugriff läuft durch seine
Frist von höchstens 24 Stunden ab. Die Tabelle nie von Hand leeren oder löschen — der Trigger verweigert es, und ein
Umgehen wäre ein Eingriff in das Nachweisprotokoll.

**Vor dem ersten Einsatz prüfen (lesend).**

```sql
-- The table exists and both triggers are installed.
SELECT tgname FROM pg_trigger WHERE tgrelid = '"SupportAccess"'::regclass AND NOT tgisinternal ORDER BY tgname;
-- expected: support_access_no_truncate, support_access_no_update_delete
```

Mandanten-Auffrischung int: siehe `docs/data-refresh-process.md` (`SupportAccess` bleibt unverändert erhalten).

## Phase 539 — Altrollen-Rückfall entfernt (Release A, Issue #539)

**Hinweis für die Release Notes.** Dieser Abschnitt ist der Release-Hinweis zu Release A von #539: **Vor dem Deploy**
gehört der lesende Probelauf (Schritt 1) auf int UND prod in den Ablauf, und bei jedem Treffer das Übernehmen
(Schritt 2). Ohne diesen Schritt kann sich ein aktiver Nutzer ohne gespeicherte Rollenzuweisung nach dem Deploy nicht mehr
anmelden (403 `NO_ROLE_ASSIGNED`), weil Berechtigungen ab Release A nur noch aus gespeicherten Zuweisungen kommen.

**Was sich ändert.** Es gibt **keine Schema-Migration** und keinen Backfill im Entrypoint. Der Altrollen-Rückfall
(ein Nutzer ohne Zuweisung galt als Inhaber der Systemrolle seiner Spalte `User.role`) entfällt an allen Auflösungsstellen,
kein Token trägt mehr einen `role`-Claim, und die Spalte bleibt bis Release B stehen und wird weiter aus den Zuweisungen
geschrieben (D-06). Beim Weglassen der Übernahme droht genau eine Wirkung: ausgesperrte aktive Nutzer.

**1. Vor dem Deploy — Probelauf (lesend, auf int UND prod).**
`apps/api/scripts/backfill-539-role-assignments.ts` schreibt ohne `--confirm` nichts. Es gibt je Treffer nur Nutzer-Id,
Mandant und Alt-Rolle aus (keine Namen, keine E-Mail-Adressen) und danach eine Zeile `Totals:` sowie eine Zeile
`Informational:`. Ein Treffer ist ein **aktiver** Nutzer mit Mitarbeiterdatensatz, der in seinem Mandanten keine
einzige Rollenzuweisung hat. Inaktive und anonymisierte Nutzer sowie Nutzer ohne Mitarbeiterdatensatz werden nie
angefasst (Anonymisierung löscht Zuweisungen absichtlich, #74b).

```bash
# DATABASE_URL zeigt per Port-Forward auf die Datenbank der Umgebung (int bzw. prod); aus der Umgebung
# weitergereicht, nicht auf der Kommandozeile ausgeschrieben.
DATABASE_URL="$DSN" pnpm --filter @clokr/api exec tsx scripts/backfill-539-role-assignments.ts \
  | tee "539-takeover-<umgebung>-$(date +%Y%m%d).txt"
echo "exit=${PIPESTATUS[0]}"
```

Das Skript liegt erst im Image des neuen Release; der Standard-Einstiegspunkt dieses Images führt `prisma migrate deploy`
aus und darf vor der Deploy-Entscheidung nicht gegen int oder prod gestartet werden. Deshalb entweder aus einem Checkout
des Release-Stands per Port-Forward (wie oben) oder mit überschriebenem Einstiegspunkt:

```bash
docker run --rm -e DATABASE_URL --entrypoint sh <neues-api-image> \
  -lc 'cd /app/apps/api && pnpm tsx scripts/backfill-539-role-assignments.ts'
```

Erwartet: Messung vom 15.10.2026 (nur lesend, Kommentar am Issue #539): int und prod sind identisch, 20 Nutzer, 17 mit
Zuweisung, 3 ohne, und diese 3 sind **inaktiv**. Der Probelauf meldet daher auf beiden Stufen `eligible=0`
(`No active user without a stored role assignment. Nothing to take over.`) und Exit-Code **0**. Die Zeile
`Informational:` nennt die nicht übernommenen Nutzer (`inactiveWithoutAssignment`, `anonymisedWithoutAssignment`,
`withoutEmployee`, `malformedOnly`) und `columnDrift` (Nutzer, deren Spalte von der aus den Zuweisungen abgeleiteten Rolle
abweicht): **diese Zahl notieren**, sie ändert sich durch die Übernahme nicht. Exit-Code **2** heißt: es gibt mindestens
einen übernehmbaren Nutzer; Exit-Code **1** ist ein Fehler (fehlende `DATABASE_URL`, Verbindung).

**2. Bei Exit-Code 2 — Übernehmen (`--confirm`).** Die Treffer prüfen (sind es wirklich aktive Personen, die sich
anmelden sollen?), dann:

```bash
DATABASE_URL="$DSN" pnpm --filter @clokr/api exec tsx scripts/backfill-539-role-assignments.ts --confirm
DATABASE_URL="$DSN" pnpm --filter @clokr/api exec tsx scripts/backfill-539-role-assignments.ts   # muss Exit-Code 0 liefern
```

Jeder übernommene Nutzer bekommt genau eine Zuweisung mit Scope Mandant auf die Systemrolle seiner Spalte (dieselben
Rechte, die der Rückfall bisher gab; der Test `backfill-539-role-assignments.test.ts` belegt die Rechteneutralität) und
eine Audit-Zeile `CREATE RoleAssignment` mit Grund „Übernahme der Alt-Rolle (#75)“. Pro Nutzer eine Transaktion;
ein Abbruch mitten im Lauf ist unkritisch, der Lauf ist wiederholbar (zweiter Lauf: `written=0`). Die Spalte `User.role`
wird nie geschrieben. Wer auf int oder prod **nicht** übernommen werden soll, bekommt stattdessen vor dem Deploy
eine bewusst gewählte Rolle über die Mitarbeiterverwaltung oder wird deaktiviert.

**3. Deploy** wie gewohnt (Einstiegspunkt des neuen Images, vorher `pg_dump`). Es gibt keine Migration.

**4. Nach dem Deploy — Stichprobe.** Ein Admin meldet sich an (es muss gelingen). Im Audit-Protokoll stehen
abgewiesene Anmeldungen als `LOGIN_REFUSED` mit Grund `NO_ROLE_ASSIGNED`; jede ist ein Nutzer, den Schritt 1 und 2 hätten
erfassen müssen oder der absichtlich keine Rolle hat (das Mitarbeiterformular zeigt „Keine Rolle zugewiesen“).

**5. Rollback.** Das vorige Image liest weiter `User.role` und den Rückfall; da Release A die Spalte unverändert aus den
Zuweisungen weiterschreibt (D-06), findet es konsistente Werte. Die übernommenen Zuweisungen bleiben bestehen und
schaden dem alten Code nicht (er liest gespeicherte Zuweisungen zuerst). Ein altes Token mit `role`-Claim bleibt gültig,
der Claim wird aber von Release A nicht mehr gelesen. Spalte und Enum entfernt erst Release B (eigene Migration nach dem
Muster #470, Folge-Issue #641).

## Phase 70b — Mehrere Zeiteinträge pro Tag (Issue #70)

**Hinweis für die Release Notes.** #70 und #92 erscheinen im **selben Release** (v1.16.0): ohne erfassbare Fahrzeit wäre
jeder Tag mit Salonwechsel ein Klärungsfall. Für die Notes: Mitarbeitende in Mandanten mit mehreren Salons können an
einem Tag mehrere Einträge in verschiedenen Salons erfassen (Stempeln im anderen Salon, Feld „Salon“ in der
Zeiterfassung); Mandanten mit einem Salon sehen keine Änderung. Ein **CSV-Import** desselben Tages mit anderen Zeiten legt
jetzt einen zweiten Eintrag an (statt eines Fehlers), überlappende Zeilen werden weiter als Fehler gemeldet. Der Feiertag
eines Tages mit mehreren Einträgen gilt im Salon des frühesten Eintrags (§ 2 EFZG). Der Zeitnachtrag bleibt ein Antrag
je Tag.

**Was die Migrationen tun.** Zwei Verzeichnisse in `packages/db/prisma/migrations/`, beide ändern keine Zeile:

- `20261016130000_time_entry_multi_entry_per_day` — vom Generator erzeugt (`prisma migrate diff`), eine Anweisung: der
  einfache Index `TimeEntry_employeeId_date_idx` auf `("employeeId", "date")`.
- `20261016130001_time_entry_no_overlap` — von Hand geschrieben, weil Prisma weder Ausschlussbedingungen noch partielle
  Indizes modelliert und die CI-Driftprüfung beides nicht sieht (gemessen: Exit 0): `DROP INDEX` des alten partiellen
  Unique-Index `TimeEntry_employeeId_date_unique_not_deleted` (Prisma erzeugt dafür kein `DROP`), `CREATE EXTENSION IF NOT
EXISTS btree_gist`, die Ausschlussbedingung `TimeEntry_no_overlap_closed` (zwei nicht gelöschte **abgeschlossene**
  Einträge einer Person überschneiden sich nie) und der partielle Unique-Index `TimeEntry_employeeId_date_open_unique`
  (höchstens ein **offener** Eintrag je Person und Tag). Gewählt wurde der Weg „Ausschlussbedingung“ (Weg A, kein
  Trigger); Begründung und Messungen: `docs/adr/0001-abweichungen.md`, Eintrag AA.

**1. Vor dem Deploy — Prüfung (lesend, auf int UND prod).**
`ADD CONSTRAINT … EXCLUDE` prüft jede vorhandene Zeile; **eine** verletzende Altzeile bricht den ganzen Deploy ab (der
Entrypoint stoppt dann). `apps/api/scripts/audit-70-entry-overlaps.ts` schreibt nichts (nur `SELECT`, kein Schreib-Schalter),
nennt je Treffer nur Ids und Kalendertage (keine Namen) und danach eine Zeile `Totals:` mit `overlap`, `inverted` und
`multipleOpen`.

```bash
# DATABASE_URL zeigt per Port-Forward auf die Datenbank der Umgebung (int bzw. prod); aus der Umgebung
# weitergereicht, nicht auf der Kommandozeile ausgeschrieben.
DATABASE_URL="$DSN" pnpm --filter @clokr/api exec tsx scripts/audit-70-entry-overlaps.ts \
  | tee "70-overlaps-<umgebung>-$(date +%Y%m%d).txt"
echo "exit=${PIPESTATUS[0]}"
```

Das Skript liegt erst im Image des neuen Release; der Standard-Einstiegspunkt dieses Images führt `prisma migrate deploy`
aus und darf vor der Deploy-Entscheidung nicht gegen int oder prod gestartet werden. Deshalb aus einem Checkout des
Release-Stands per Port-Forward (wie oben) oder mit überschriebenem Einstiegspunkt:

```bash
docker run --rm -e DATABASE_URL --entrypoint sh <neues-api-image> \
  -lc 'cd /app/apps/api && pnpm tsx scripts/audit-70-entry-overlaps.ts'
```

Erwartet: **Exit-Code 0** (Messung vom 16.10.2026, nur lesend: auf int und prod gibt es keine überlappenden
abgeschlossenen Einträge und je Person und Tag höchstens einen offenen). **Exit-Code 2** heißt: mindestens ein Befund. Ihn
zuerst über die Korrekturbuchung (Zeitkorrektur durch die Verwaltung, mit Begründung und Audit) beheben, **nie** per
Direktzugriff auf die Tabelle und nie durch Lockern der Bedingung; danach den Lauf wiederholen. **Exit-Code 1** ist ein
Fehler (fehlende `DATABASE_URL`, Verbindung).

Zusätzlich je Umgebung prüfen (lesend):

```sql
-- Erweiterung verfügbar? (int: PostgreSQL 18, prod: PostgreSQL 17 — die Migrationen sind auf beiden Versionen belegt)
SELECT name, default_version, trusted FROM pg_available_extensions WHERE name = 'btree_gist';
SELECT version();
-- Darf die Rolle der Anwendung die Erweiterung anlegen? (Eigentümer oder Superuser genügt; btree_gist ist "trusted")
SELECT rolsuper, (SELECT pg_get_userbyid(datdba) = current_user FROM pg_database WHERE datname = current_database()) AS is_db_owner
FROM pg_roles WHERE rolname = current_user;
-- Größenordnung der Tabelle (für die Sperrzeit unten)
SELECT count(*) FROM "TimeEntry";
```

Messung vom 16.10.2026: `btree_gist` ist auf int (PostgreSQL 18.4) und prod (PostgreSQL 17.9) verfügbar, und der
Datenbanknutzer der Anwendung ist dort Eigentümer und Superuser. Ist die Erweiterung nicht anlegbar, vorher als Superuser
`CREATE EXTENSION IF NOT EXISTS btree_gist;` ausführen (die Anweisung in der Migration ändert dann nichts mehr).

**2. Deploy.** Wie gewohnt: vorher `pg_dump`, dann der Einstiegspunkt des neuen Images (`prisma migrate deploy`). **Kurze
Sperre auf `TimeEntry`:** `ADD CONSTRAINT … EXCLUDE` baut seinen GiST-Index unter einer ACCESS EXCLUSIVE-Sperre auf
`TimeEntry`, und der partielle Unique-Index wird nicht nebenläufig (`CONCURRENTLY`) angelegt, sodass Schreibzugriffe
blockiert sind. Lese- und Schreibzugriffe auf Zeiteinträge warten also, solange die Migration beim Start der API läuft.
Gemessen auf einer Wegwerf-Datenbank (PostgreSQL 18, Entwicklungscontainer, einfache Tabelle mit denselben Spalten,
100 000 Einträge ohne Überschneidung): 1,6 Sekunden für die Bedingung, 41 Millisekunden für den offenen Index. Die
Zeilenzahl auf int und prod mit der Abfrage aus Schritt 1 ermitteln: die Sperrzeit wächst ungefähr linear mit ihr, die
Messung ist eine Größenordnung und kein Versprechen. **Außerhalb der Öffnungszeiten deployen** (Stempeln und Erfassen scheitern in dieser Zeit sonst mit Zeitüberschreitung).

**3. Nach dem Deploy — Prüfung (lesend).**

```sql
SELECT extname, extversion FROM pg_extension WHERE extname = 'btree_gist';
SELECT conname, contype, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'TimeEntry_no_overlap_closed';
-- erwartet: contype x, EXCLUDE USING gist ("employeeId" WITH =, tstzrange("startTime","endTime",'[)') WITH &&)
--           WHERE (("deletedAt" IS NULL) AND ("endTime" IS NOT NULL))
SELECT indexname, indexdef FROM pg_indexes
WHERE tablename = 'TimeEntry' AND indexname IN ('TimeEntry_employeeId_date_open_unique',
  'TimeEntry_employeeId_date_idx', 'TimeEntry_employeeId_date_unique_not_deleted') ORDER BY indexname;
-- erwartet: die ersten beiden vorhanden, der dritte (alter Unique-Index) NICHT
```

Stichprobe in der Oberfläche: ein Mandant mit mehreren Salons kann an einem Tag in einem zweiten Salon einstempeln (Karte
„In anderem Salon einstempeln“); eine überlappende manuelle Erfassung wird mit 409 abgewiesen.

**4. Rollback.** Das vorige Image funktioniert mit den neuen Objekten weiter: es erzwingt „ein Eintrag pro Tag“ im Code
(zusätzlich zur Bedingung), die Migrationen werden **standardmäßig nicht zurückgenommen**. Nur **solange kein Tag mit mehreren
Einträgen existiert** lassen sich die Objekte von Hand in einer Transaktion entfernen und der alte Index wieder anlegen.
Vorab muss diese Abfrage **keine Zeile** liefern:

```sql
SELECT "employeeId", "date", count(*) FROM "TimeEntry" WHERE "deletedAt" IS NULL GROUP BY 1, 2 HAVING count(*) > 1;
```

Liefert sie Zeilen, ist der Schritt **nur vorwärts**: der alte Unique-Index kann nie wieder angelegt werden, ein Zurückgehen
geht nur über eine Korrekturbuchung der betroffenen Tage (und die Sperre des Monats) oder über das Einspielen der Sicherung
vor dem Deploy (Einträge danach gehen dabei verloren). Sonst, in einer Transaktion (die Prüfung steht noch einmal darin und
bricht ab, falls inzwischen ein Mehr-Eintrag-Tag entstand):

```sql
BEGIN;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "TimeEntry" WHERE "deletedAt" IS NULL GROUP BY "employeeId", "date" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'A multi-entry day exists: the rollback is forward-only';
  END IF;
END $$;
ALTER TABLE "TimeEntry" DROP CONSTRAINT IF EXISTS "TimeEntry_no_overlap_closed";
DROP INDEX IF EXISTS "TimeEntry_employeeId_date_open_unique";
DROP INDEX IF EXISTS "TimeEntry_employeeId_date_idx";
CREATE UNIQUE INDEX "TimeEntry_employeeId_date_unique_not_deleted"
  ON "TimeEntry"("employeeId", "date") WHERE "deletedAt" IS NULL;
DELETE FROM "_prisma_migrations"
  WHERE migration_name IN ('20261016130000_time_entry_multi_entry_per_day', '20261016130001_time_entry_no_overlap');
COMMIT;
```

Der SQL-Block wurde am 16.10.2026 gegen eine frische Datenbank mit allen Migrationen geprüft: mit einem Tag mit zwei
Einträgen bricht er in der Prüfung ab und ändert nichts, ohne einen solchen Tag entfernt er die Bedingung und beide Indizes,
legt den alten Unique-Index wieder an und löscht die zwei Zeilen in `_prisma_migrations`.

Das Löschen der beiden Zeilen in `_prisma_migrations` sorgt dafür, dass ein späteres Deploy des neuen Release die Objekte
wieder anlegt; `btree_gist` darf stehen bleiben. Danach das vorige Image starten; der alte Unique-Index ist wieder
vorhanden.

## Phase 92b — Fahrzeit zwischen Salons (Issue #92)

**Hinweis für die Release Notes.** #92 erscheint **nur gemeinsam mit #70** (v1.16.0, Abschnitt „Phase 70b“ oben): eine
Fahrzeit liegt zwischen zwei Einträgen eines Tages, und die gibt es erst mit #70. Für die Notes: Mitarbeitende und
Führungskräfte in Mandanten mit mehreren Salons erfassen die Fahrt zwischen zwei Salons als eigenen Zeiteintrag
(Schalter „Fahrzeit zwischen Salons“, „Von Salon“, „Nach Salon“); sie zählt voll als Arbeitszeit (§ 2 Abs. 1 ArbZG) und
beendet für diese Lücke die Rückfrage „Fahrzeit oder Pause?“. Der Weg von und nach Hause ist keine Arbeitszeit und
nicht erfassbar. Die getrennte Auswertung (`activityMinutes.TRAVEL`) gehört zum Modul „Auswertungen“; die Erfassung wird
nie durch ein Modul gesperrt. Berichte, PDFs und DATEV zeigen die Fahrzeit als gewöhnliche Arbeitszeitzeile. Mandanten
mit einem Salon sehen keine Änderung. Hinweis für Mandanten mit Betriebsrat: `docs/compliance.md`, Abschnitt „Fahrzeit
zwischen Salons“.

**Was die Migrationen tun.** Drei Verzeichnisse in `packages/db/prisma/migrations/`, alle rein additiv, keine Zeile
wird geschrieben oder geändert:

- `20261016171900_activity_kind_travel` — eine Anweisung, `ALTER TYPE "ActivityKind" ADD VALUE 'TRAVEL'` (vom Generator
  erzeugt). Der neue Wert steht bewusst in einer eigenen Datei: ein neuer Enum-Wert ist in der Transaktion, die ihn
  anlegt, nicht verwendbar.
- `20261016171901_time_entry_travel_to_salon` — vom Generator erzeugt, drei Anweisungen: die Spalte
  `TimeEntry.travelToSalonId` (`TEXT`, nullable, ohne Vorgabe), der Index `TimeEntry_travelToSalonId_idx` und der
  Fremdschlüssel `TimeEntry_travelToSalonId_fkey` auf `Salon` mit `ON DELETE RESTRICT` (neue Abhängigkeit auf den
  Unterbau, genehmigt mit Issue #92 in `Ready`).
- `20261016171902_time_entry_travel_shape_check` — von Hand geschrieben (Prisma modelliert keine CHECK-Bedingung, die
  CI-Driftprüfung bleibt leer, gemessen), die Bedingung `TimeEntry_travel_shape_check`: eine Fahrzeit-Zeile hat ein Ziel
  und ein Ziel gehört nur zu einer Fahrzeit-Zeile; Ziel ≠ Abfahrtssalon, Art `WORK`, abgeschlossen, Ende nach Beginn,
  `breakMinutes = 0`. **Jede vorhandene Zeile erfüllt sie** (kein Ziel, nicht `TRAVEL`), deshalb braucht es keine
  Datenprüfung vor dem Deploy. Gemessen: die Migrationskette (59 Verzeichnisse) läuft auf PostgreSQL 17.11 und 18.3 mit
  identischem Katalog; ein Test spielt die echten Anweisungen über einen Altdatensatz ab, alle Saldo-Eingaben danach
  bytegleich (`travel-migration-92.test.ts`).

**1. Vor dem Deploy.** Keine Datenprüfung nötig (siehe oben). Die Prüfung aus Abschnitt „Phase 70b“
(`audit-70-entry-overlaps.ts`, int UND prod) gilt weiterhin und ist wegen der gemeinsamen Auslieferung der erste Schritt.

**2. Deploy.** Wie gewohnt: vorher `pg_dump`, dann der Einstiegspunkt des neuen Images (`prisma migrate deploy`; dieselbe
Auslieferung wie #70, ein Neustart). **Sperren:** das Anlegen der CHECK-Bedingung prüft jede vorhandene Zeile unter einer
ACCESS EXCLUSIVE-Sperre auf `TimeEntry`; der (nicht nebenläufige) Index und der Fremdschlüssel halten ebenfalls kurz eine
Sperre, die Spalte (nullable, ohne Vorgabe) und der Enum-Wert nur Katalogeinträge. Gemessen am 16.10.2026 auf einer
Wegwerf-Datenbank (PostgreSQL 18.3, Entwicklungscontainer, `TimeEntry`-förmige Tabelle mit denselben Spalten,
**1 000 000 Einträge**, keine gleichzeitigen Zugriffe): Enum-Wert 0,6 ms, Spalte 0,4 ms, Index 124 ms, Fremdschlüssel
49 ms, CHECK-Bedingung 59 ms. Das ist eine Größenordnung und kein Versprechen; sie liegt weit unter der Sperrzeit der
Ausschlussbedingung aus #70 und wird zusammen mit ihr im selben Zeitfenster abgedeckt: **außerhalb der Öffnungszeiten
deployen**.

**3. Nach dem Deploy — Prüfung (lesend).**

```sql
SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
WHERE t.typname = 'ActivityKind' ORDER BY e.enumsortorder;
-- erwartet: UNSPECIFIED, PRODUCTIVE, SETUP_CLEANING, TRAVEL (TRAVEL zuletzt)
SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
WHERE table_name = 'TimeEntry' AND column_name = 'travelToSalonId';
-- erwartet: text, YES, NULL
SELECT conname, contype, confdeltype, confrelid::regclass FROM pg_constraint
WHERE conname = 'TimeEntry_travelToSalonId_fkey';
-- erwartet: contype f, confdeltype r (RESTRICT), "Salon"
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'TimeEntry_travel_shape_check';
-- erwartet: CHECK mit den sechs Klauseln der Migration (Paarung Art/Ziel, Ziel <> salonId, type = 'WORK',
--           endTime IS NOT NULL, endTime > startTime, breakMinutes = 0)
SELECT indexname FROM pg_indexes WHERE tablename = 'TimeEntry' AND indexname = 'TimeEntry_travelToSalonId_idx';
-- erwartet: eine Zeile
SELECT count(*) FROM "TimeEntry" WHERE "activityKind" = 'TRAVEL' OR "travelToSalonId" IS NOT NULL;
-- erwartet direkt nach dem Deploy: 0
```

Stichprobe in der Oberfläche: in einem Mandanten mit mehreren Salons einen Tag mit je einem Eintrag in zwei Salons
anlegen und die Fahrt dazwischen mit „Fahrzeit zwischen Salons“ erfassen (Zeile mit Kennzeichen „Fahrzeit“ und
„Von → Nach“); dieselbe Fahrt von zu Hause (vor dem ersten Eintrag) wird mit 409 abgewiesen.

**4. Rollback.** Die Migrationen werden **standardmäßig nicht zurückgenommen**. Das vorige Image läuft mit den neuen
Objekten weiter und ignoriert die neue Spalte; die CHECK-Bedingung erfüllt jeder Schreibvorgang des alten Codes (kein
Ziel, nie `TRAVEL`). **Bedingung: es existiert noch keine Fahrzeit.** Das alte Prisma-Client kann den Enum-Wert `TRAVEL`
nicht lesen, sobald eine Zeile ihn trägt; jede Abfrage, die eine solche Zeile liefert, schlägt fehl (für Zeiterfassung,
Saldo und Berichte der betroffenen Person). Vorab muss diese Abfrage **0** liefern:

```sql
SELECT count(*) FROM "TimeEntry" WHERE "activityKind" = 'TRAVEL';
```

Liefert sie mehr als 0, ist der Rückschritt **nur vorwärts**: weiter mit einem korrigierten Release statt eines
Zurückgehens. Wegen der gemeinsamen Auslieferung gilt dasselbe für #70: ein Tag mit einer Fahrzeit hat mindestens drei
Einträge, das Rollback-SQL aus „Phase 70b“ ist dann ebenfalls nicht mehr möglich. Die Migrationen von Hand zu entfernen ist
nicht nötig; ein Enum-Wert lässt sich in PostgreSQL ohnehin nicht entfernen.

## Phase 614 — Anonymisierung beendet die Beschäftigung (Issue #614)

**Hinweis für die Release Notes.** Dieser Abschnitt ist der Release-Hinweis zu Phase 614: Vor dem Deploy gehört die
lesende Vorschau (Schritt 1) auf int und prod in den Ablauf, und ihre Ausgabe gehört zum Material der Release Notes.
Verhaltensänderung für Personalabteilung und Administration: Eine DSGVO-Löschung beendet die Beschäftigung und die
**Personalnummer bleibt erhalten**.

**Was sich ändert.** Es gibt **keine Migration und keinen Schemawechsel**. Ab diesem Release setzt die Anonymisierung
(`DELETE /api/v1/employees/:id`) ein leeres Austrittsdatum auf den Tag der Anonymisierung, behält die Personalnummer (sie
bleibt im Mandanten reserviert, Wiederverwendung antwortet 409) und storniert bzw. kürzt Urlaube und Berufsschultage nach
dem Austritt; abgeschlossene Monate bleiben unverändert (ADR 0001-abweichungen, Eintrag N, Nachtrag Issue #614). **Dieses
Release korrigiert keine Bestandszeile:** Personen, die vorher anonymisiert wurden, behalten ihren Zustand. Ob und wie sie
nachgezogen werden, entscheidet das Folge-Issue #666.

**1. Vor dem Deploy — Vorschau (lesend, auf int UND prod).**
`apps/api/scripts/audit-614-anonymized-employment.ts` schreibt nichts (es gibt keinen Schreib-Schalter, `--apply` und
`--confirm` werden abgelehnt) und gibt je anonymisierter Person mit Befund nur Mandanten-Id, Personen-Id, die Kategorien und
die Ids der betroffenen Anträge und Abwesenheiten aus — keine Namen, keine Personalnummern, keine E-Mail-Adressen. Das
Skript liegt erst im Image des neuen Release; **der Standard-Einstiegspunkt dieses Images führt `prisma migrate deploy` aus
und darf vor der Deploy-Entscheidung niemals gegen int oder prod gestartet werden.** Deshalb wird der Einstiegspunkt
überschrieben:

```bash
# DATABASE_URL zeigt auf die Datenbank der Umgebung (int bzw. prod); aus der Umgebung weitergereicht,
# nicht auf der Kommandozeile ausgeschrieben.
docker run --rm -e DATABASE_URL --entrypoint sh <neues-api-image> \
  -lc 'cd /app/apps/api && pnpm tsx scripts/audit-614-anonymized-employment.ts' \
  | tee "614-bestand-<umgebung>-$(date +%Y%m%d).txt"
```

Gleichwertig und ebenso sicher: aus einem Checkout des Release-Stands gegen eine wiederhergestellte Kopie des Dumps
(`DATABASE_URL=<Kopie> pnpm --filter @clokr/api exec tsx scripts/audit-614-anonymized-employment.ts`). Ein Aufruf mit
`--tenant <id>` begrenzt die Ausgabe auf einen Mandanten. Exit-Code `0` heißt: kein Befund; `2`: mindestens ein Befund (die
Liste steht in der Ausgabe); `1`: Aufruf- oder Verbindungsfehler. Die Kategorien: `NO_EXIT_DATE` (kein Austrittsdatum),
`LEAVE_AFTER_EXIT` (aktiver Antrag endet nach dem Austritt), `ABSENCE_AFTER_EXIT` (aktive Abwesenheit endet nach dem
Austritt), `NUMBER_OVERWRITTEN` (Personalnummer trägt noch die frühere Überschreibung; `anonymizeAudit=present` sagt nur, ob
der ANONYMIZE-Audit der Person existiert, der die alte Nummer noch enthalten kann). Die letzte Zeile `Totals:` nennt die
Zahl je Kategorie. Die Ausgabe aufbewahren (Material der Release Notes und Grundlage für #666). Prüfen: Stimmt die Zahl der
Befunde mit der Erwartung überein? Weicht sie ab, vor dem Deploy mit dem Betreiber klären — nichts still korrigieren.

**2. Deploy** wie gewohnt (Einstiegspunkt des neuen Images, vorher `pg_dump`). Es läuft keine Migration.

**3. Nichts still korrigieren.** Bestandsfälle gehören zu #666: weder Austrittsdaten noch Abwesenheiten oder
Personalnummern der Vorschau werden von Hand oder per Skript geändert, bevor dort entschieden ist. Eine neue
Anonymisierung nach dem Deploy braucht keinen Eingriff; ihre übersprungenen Zeilen (`skipped` im ANONYMIZE-Audit, IDs und
Codes) werden fachlich geklärt, nicht still nachgezogen.

**4. Rollback.** Das vorige Image überschreibt die Personalnummer bei einer Anonymisierung wieder und beendet keine
Abwesenheiten; das gilt für Anonymisierungen, die **nach** dem Rollback laufen. Was das neue Release bis dahin gemacht hat
(Austrittsdatum, Stornos, Kürzungen), bleibt bestehen und ist auditiert (`auditReason` „Anonymisierung“); es gibt nichts
zurückzunehmen. Beim erneuten Vorwärts-Deploy die Vorschau aus Schritt 1 wiederholen, weil zwischenzeitlich nach dem alten
Muster anonymisiert worden sein kann.

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
