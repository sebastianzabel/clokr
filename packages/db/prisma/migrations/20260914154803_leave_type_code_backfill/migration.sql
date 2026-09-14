-- Phase 97 (T2, AC-4) — Bestandszeilen auf den stabilen Code abbilden.
-- Reines DML auf genau EINER Tabelle: keine Spalte, kein Index, keine Zeile wird angelegt
-- oder geloescht. Die Anspruchs- und die Antragstabelle werden nicht angefasst (AC-5 gilt
-- hier durch Konstruktion). Ihre Namen stehen hier bewusst NICHT — das Akzeptanzkriterium
-- dieses Tasks sucht per grep nach ihnen und faende sonst den eigenen Kommentar.
--
-- ROLLOUT-EINHEIT R1: Diese Migration gehoert untrennbar zu den Plaenen 01-04 der Phase 97.
-- Sie darf nicht auf eine Umgebung ausgerollt werden, deren Image Abwesenheitsarten noch
-- ueber den Anzeigenamen anlegt — sonst entsteht ab dem Deploy fortlaufend neuer Bestand
-- ohne Code. Details und Verifikation: docs/migrations.md, Abschnitt Phase 97.
--
-- Namen mit Umlaut werden als U&-Escape geschrieben, damit die Zuordnung nicht von der
-- Dateikodierung abhaengt (dieselbe Vorsichtsmassnahme wie Phase 96s U&'\2013').
-- Kein Catch-all: ein unmappbarer Name behaelt code = NULL und wird unten laut gemeldet.

-- 1) Kanonische Namen (routes/leave.ts LEAVE_TYPE_DEFS)
UPDATE "LeaveType" SET "code" = 'VACATION'      WHERE "code" IS NULL AND "name" = 'Urlaub';
UPDATE "LeaveType" SET "code" = 'OVERTIME_COMP' WHERE "code" IS NULL AND "name" = U&'\00DCberstundenausgleich';
UPDATE "LeaveType" SET "code" = 'SPECIAL'       WHERE "code" IS NULL AND "name" = 'Sonderurlaub';
UPDATE "LeaveType" SET "code" = 'UNPAID'        WHERE "code" IS NULL AND "name" = 'Unbezahlter Urlaub';
UPDATE "LeaveType" SET "code" = 'SICK'          WHERE "code" IS NULL AND "name" = 'Krankmeldung';
UPDATE "LeaveType" SET "code" = 'SICK_CHILD'    WHERE "code" IS NULL AND "name" = 'Kinderkrank';
UPDATE "LeaveType" SET "code" = 'EDUCATION'     WHERE "code" IS NULL AND "name" = 'Bildungsurlaub';
UPDATE "LeaveType" SET "code" = 'MATERNITY'     WHERE "code" IS NULL AND "name" = 'Mutterschutz';
UPDATE "LeaveType" SET "code" = 'PARENTAL'      WHERE "code" IS NULL AND "name" = 'Elternzeit';

-- 2) Legacy-Aliase (routes/leave.ts LEGACY_ALIASES.VACATION). Der dev- und der prod-Bestand
--    enthalten diese Namen nicht mehr (D-07, zweifach gemessen), int und aeltere Dumps
--    koennen sie noch enthalten. NUR wenn der Mandant noch keine VACATION-Zeile hat --
--    sonst entstuende ein Duplikat, das Migration 3 zum Scheitern braechte.
UPDATE "LeaveType" lt SET "code" = 'VACATION'
  WHERE lt."code" IS NULL
    AND lt."name" IN ('Jahresurlaub', 'Urlaub (Jahresurlaub)')
    AND NOT EXISTS (
      SELECT 1 FROM "LeaveType" o
      WHERE o."tenantId" = lt."tenantId" AND o."code" = 'VACATION'
    );

-- 3) Verifikation statt Zusicherung (Lehre aus Phase 96 WR-02).
--    3a) Ein echtes Duplikat bricht HIER laut ab, nicht erst als fehlgeschlagener
--        CREATE UNIQUE INDEX in Migration 3.
DO $$
DECLARE dup_count int;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT "tenantId", "code" FROM "LeaveType"
    WHERE "code" IS NOT NULL
    GROUP BY "tenantId", "code" HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Phase 97 backfill produced % duplicate (tenantId, code) group(s) in LeaveType -- inspect and resolve before re-running', dup_count;
  END IF;
END $$;

--    3b) Nicht zuordenbare Namen blockieren den Deploy NICHT (ein Mandant darf einen
--        eigenen Namen tragen), werden aber laut gemeldet. Der endgueltige Gate ist
--        Plan 10: SET NOT NULL laeuft erst, wenn count(*) WHERE code IS NULL = 0 ist.
DO $$
DECLARE unmapped int;
BEGIN
  SELECT count(*) INTO unmapped FROM "LeaveType" WHERE "code" IS NULL;
  IF unmapped > 0 THEN
    RAISE WARNING 'Phase 97 backfill left % LeaveType row(s) without a code -- run scripts/backfill-leave-type-code.ts --dry-run to inspect', unmapped;
  END IF;
END $$;
