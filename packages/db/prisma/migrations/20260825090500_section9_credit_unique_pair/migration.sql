-- Phase 104 code review WR-03: exactly ONE section 9 Vorgang per
-- (sickRequestId, vacationRequestId) pair.
--
-- The detection path in routes/leave.ts guarded duplicates with a findFirst/create
-- pair that is NOT wrapped in a transaction, so two concurrent approvals of the same
-- Krankmeldung (double click, retried request, a manager racing a cron path) could
-- create two AU_PENDING rows for the same overlap. If both were later confirmed,
-- reverseVacationDays() would run twice and sumConfirmedSection9DaysByRequest() would
-- sum both -- a double vacation credit that SURVIVES selfHealUsedDays(), because the
-- self-heal trusts the credit sum. Only the database can rule this out.
--
-- Safe to apply forward: the pairing has been unique by intent since the model was
-- introduced (20260824153739_section9_credit, one day earlier), so no environment can
-- carry a duplicate that predates the guard. Verified empty on dev before writing this.

-- CreateIndex
CREATE UNIQUE INDEX "Section9Credit_sickRequestId_vacationRequestId_key" ON "Section9Credit"("sickRequestId", "vacationRequestId");
