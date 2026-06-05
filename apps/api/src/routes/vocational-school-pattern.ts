import { FastifyInstance } from "fastify";
import { z } from "zod";
import { FederalState } from "@clokr/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { syncSchoolHolidaysForTenant } from "../plugins/school-holidays-sync";
import { runVocationalSchoolGeneration } from "../utils/vocational-school-generator";

// ── Schemas ──────────────────────────────────────────────────────────────────

// Phase 62 — Berufsschultag pattern item.
// LOCKED decision (CONTEXT.md): at least one of daysOfWeek OR blockWeeks must be set.
// blockYear is required when blockWeeks is set so annual block-week intent is unambiguous.
//
// Phase 67.1 (v1.7.4) — daysOfWeek Int[] replaces single-value dayOfWeek Int?.
// Legacy callers sending `dayOfWeek: N` are normalised in the PUT handler to
// `daysOfWeek: [N]` so old clients (NFC terminal, integration tests) keep working
// during the soak release. Drop the legacy field in v1.7.5.
const federalStateEnum = z.enum([
  "NIEDERSACHSEN",
  "BAYERN",
  "BERLIN",
  "BRANDENBURG",
  "BREMEN",
  "HAMBURG",
  "HESSEN",
  "MECKLENBURG_VORPOMMERN",
  "NORDRHEIN_WESTFALEN",
  "RHEINLAND_PFALZ",
  "SAARLAND",
  "SACHSEN",
  "SACHSEN_ANHALT",
  "SCHLESWIG_HOLSTEIN",
  "THUERINGEN",
  "BADEN_WUERTTEMBERG",
]);

const patternItemSchema = z
  .object({
    // Legacy single-value field, kept for backwards compat during v1.7.4 soak.
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    // New multi-day field — array of 0=Mo..6=So.
    daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]),
    blockWeeks: z.array(z.number().int().min(1).max(53)).default([]),
    blockYear: z.number().int().min(2000).max(2100).nullable().optional(),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "validFrom muss YYYY-MM-DD sein"),
    validUntil: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "validUntil muss YYYY-MM-DD sein")
      .nullable()
      .optional(),
    // Phase 67.2 — KMK-Ferien apply by default for IHK-Berufe; opt-out for
    // Pflegeschulen / Berufsakademien which follow their own schedule.
    respectSchoolHolidays: z.boolean().default(true),
    // Phase 67.2 — Pendler-Azubi-Support: BS-Bundesland ≠ Betrieb. NULL/omitted
    // falls back to Tenant.federalState in the generator.
    federalStateOverride: federalStateEnum.nullable().optional(),
  })
  // At least one weekday OR at least one block week must be set.
  // Legacy `dayOfWeek` counts as "weekday set" since the PUT handler normalises it.
  .refine(
    (p) =>
      (p.daysOfWeek && p.daysOfWeek.length > 0) ||
      p.dayOfWeek != null ||
      (p.blockWeeks && p.blockWeeks.length > 0),
    {
      message: "Entweder daysOfWeek oder blockWeeks muss gesetzt sein",
    },
  )
  .refine((p) => (p.blockWeeks && p.blockWeeks.length > 0 ? p.blockYear != null : true), {
    message: "blockYear ist erforderlich wenn blockWeeks gesetzt ist",
  });

const putPatternsSchema = z.object({
  patterns: z.array(patternItemSchema),
});

// ── Routes ───────────────────────────────────────────────────────────────────

export async function vocationalSchoolPatternRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // GET /api/v1/employees/:id/vocational-school-pattern
  // Returns active vocational-school patterns for an employee.
  // Access: ADMIN, MANAGER, or the employee themselves.
  app.get("/:id/vocational-school-pattern", {
    schema: { tags: ["Berufsschule"], security: [{ bearerAuth: [] }] },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };

      const employee = await app.prisma.employee.findFirst({
        where: { id, tenantId: req.user.tenantId },
        select: { id: true, userId: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Permission: EMPLOYEE may only read their own patterns
      if (req.user.role === "EMPLOYEE" && req.user.employeeId !== id) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const patterns = await app.prisma.employeeVocationalSchoolPattern.findMany({
        where: { employeeId: id, isActive: true },
        orderBy: [{ validFrom: "desc" }],
      });

      // Phase 67.1: Response includes BOTH `daysOfWeek` (new canonical) AND `dayOfWeek`
      // (legacy single value, derived for backwards-compat consumers — populated only when
      // the row maps to exactly one weekday). Drop `dayOfWeek` from the response in v1.7.5.
      // Phase 67.2: `respectSchoolHolidays` and `federalStateOverride` are surfaced
      // explicitly so the UI can render the Pflegeschule opt-out toggle + Pendler
      // override picker without depending on row-shape spread order.
      return patterns.map((p) => ({
        ...p,
        dayOfWeek: p.daysOfWeek.length === 1 ? p.daysOfWeek[0] : (p.dayOfWeek ?? null),
        daysOfWeek: p.daysOfWeek,
        respectSchoolHolidays: p.respectSchoolHolidays,
        federalStateOverride: p.federalStateOverride,
        validFrom: p.validFrom.toISOString().slice(0, 10),
        validUntil: p.validUntil ? p.validUntil.toISOString().slice(0, 10) : null,
      }));
    },
  });

  // PUT /api/v1/employees/:id/vocational-school-pattern
  // Replaces the active patterns for an employee (ADMIN + MANAGER only).
  // Existing patterns for this employee are deactivated; new ones are inserted.
  app.put("/:id/vocational-school-pattern", {
    schema: { tags: ["Berufsschule"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = putPatternsSchema.parse(req.body);

      const employee = await app.prisma.employee.findFirst({
        where: { id, tenantId: req.user.tenantId },
        select: { id: true },
      });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Audit before-snapshot — include ALL rows (including inactive) so the audit trail
      // captures the full history at the time of the replace.
      const oldPatterns = await app.prisma.employeeVocationalSchoolPattern.findMany({
        where: { employeeId: id },
      });

      // Phase 67.2 — Detect "first active BS-pattern for tenant" to trigger an
      // on-demand sync after the transaction commits. The check MUST happen
      // BEFORE the transaction's updateMany() flips this employee's existing
      // active rows to isActive=false, otherwise the count would always be 0
      // on every PUT (RESEARCH §200 pitfall #9).
      const hadActivePatternsBefore = await app.prisma.employeeVocationalSchoolPattern.count({
        where: { isActive: true, employee: { tenantId: req.user.tenantId } },
      });

      // Replace-Semantik: deactivate all currently active rows + create each new row.
      // No upsert needed — there's no unique constraint to upsert on (multiple active
      // patterns per employee are allowed in the data model; consistency is application-side).
      const created = await app.prisma.$transaction(async (tx) => {
        await tx.employeeVocationalSchoolPattern.updateMany({
          where: { employeeId: id, isActive: true },
          data: { isActive: false },
        });

        const out = [];
        for (const p of body.patterns) {
          // Phase 67.1 normalisation: legacy clients send `dayOfWeek: N` instead of
          // `daysOfWeek: [N]`. Coerce into the new shape (dedup + sort for stable rows).
          // Legacy `dayOfWeek` column is still written for one release of soak so a
          // downgrade can roll back to v1.7.3 without breaking existing readers; new
          // canonical reads come from `daysOfWeek`.
          const incomingDays =
            p.daysOfWeek && p.daysOfWeek.length > 0
              ? p.daysOfWeek
              : p.dayOfWeek != null
                ? [p.dayOfWeek]
                : [];
          const normalisedDays = Array.from(new Set(incomingDays)).sort((a, b) => a - b);
          const legacyDayOfWeek = normalisedDays.length === 1 ? normalisedDays[0] : null;

          const row = await tx.employeeVocationalSchoolPattern.create({
            data: {
              employeeId: id,
              dayOfWeek: legacyDayOfWeek,
              daysOfWeek: normalisedDays,
              blockWeeks: p.blockWeeks ?? [],
              blockYear: p.blockYear ?? null,
              validFrom: new Date(p.validFrom),
              validUntil: p.validUntil ? new Date(p.validUntil) : null,
              isActive: true,
              // Phase 67.2 — Persist Ferien-Steuerung + Pendler-Override.
              respectSchoolHolidays: p.respectSchoolHolidays ?? true,
              federalStateOverride: p.federalStateOverride ?? null,
            },
          });
          out.push(row);
        }
        return out;
      });

      await app.audit({
        userId: req.user.sub,
        action: "REPLACE",
        entity: "EmployeeVocationalSchoolPattern",
        entityId: id,
        oldValue: { patterns: oldPatterns },
        newValue: { patterns: created },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      // Phase 67.2 — Fire-and-forget on-demand SchoolHolidayPeriod sync when
      // this PUT created the FIRST active BS-pattern for the tenant. This avoids
      // the "first generator run has no Ferien data" pitfall (RESEARCH §200 #9).
      // The call is NOT awaited so the PUT response is not blocked by the
      // upstream OpenHolidays API (Threat T-67.2-10 mitigation). Failures are
      // logged but never surface to the client; the weekly cron will fill on
      // Saturday if this attempt fails.
      if (hadActivePatternsBefore === 0 && body.patterns.length > 0) {
        const tenant = await app.prisma.tenant.findUniqueOrThrow({
          where: { id: req.user.tenantId },
          select: { federalState: true },
        });
        const needed = new Set<FederalState>([tenant.federalState]);
        for (const p of body.patterns) {
          if (p.federalStateOverride) needed.add(p.federalStateOverride as FederalState);
        }
        const now = new Date();
        // Fire-and-forget: don't await; log on failure.
        // v1.8 race fix — track via the same registry as the BS-generator so tests
        // can drain pending OpenHolidays-API work before asserting on DB state.
        // Without this, the sync (hundreds of ms) can finish AFTER a later test's
        // beforeEach wipes SchoolHolidayPeriod, repopulating it mid-test and
        // triggering the generator's Ferien-aware orphan-sweep to soft-delete
        // valid Absences (root cause of BERSCH-02 idempotency CI flake).
        const syncRun = syncSchoolHolidaysForTenant(
          app.prisma,
          req.user.tenantId,
          [...needed],
          { from: now.getFullYear(), to: now.getFullYear() + 1 },
          app.log,
        ).catch((err) => app.log.warn({ err }, "on-demand school-holidays sync failed"));
        app.trackPendingBSGeneration?.(syncRun);
      }

      // v1.7.4 hotfix — On-demand BS-Absence-Generator trigger.
      // Without this, pattern changes only reflect in Absences after the daily
      // cron run at 02:30 UTC, leaving the user with stale/missing rows for
      // up to 24h. Fire-and-forget so the PUT response stays snappy; the
      // generator is idempotent (existing-Absence guard via BERSCH-08) so a
      // race with the daily cron is safe. Failures are logged, never surface
      // to the client. The weekly Saturday cron fills any gap.
      //
      // v1.8 fix — register the bg promise with the plugin's tracker so tests
      // can `await app.waitForPendingBSGenerations()` to drain pending work
      // before asserting on DB state. Production behavior is unchanged (we
      // still don't await the promise from this handler — the response goes
      // out immediately).
      const bgRun = runVocationalSchoolGeneration(app.prisma, app.audit, {
        tenantId: req.user.tenantId,
        now: new Date(),
      }).catch((err) => app.log.warn({ err }, "on-demand BS-generator run failed"));
      app.trackPendingBSGeneration?.(bgRun);

      return reply.code(200).send({
        patterns: created.map((p) => ({
          ...p,
          // Phase 67.1: mirror GET shape so the UI's optimistic re-hydrate works
          // regardless of whether it reads `daysOfWeek` (new) or `dayOfWeek` (legacy).
          dayOfWeek: p.daysOfWeek.length === 1 ? p.daysOfWeek[0] : (p.dayOfWeek ?? null),
          daysOfWeek: p.daysOfWeek,
          // Phase 67.2: surface explicitly so UI bindings don't depend on spread order.
          respectSchoolHolidays: p.respectSchoolHolidays,
          federalStateOverride: p.federalStateOverride,
          validFrom: p.validFrom.toISOString().slice(0, 10),
          validUntil: p.validUntil ? p.validUntil.toISOString().slice(0, 10) : null,
        })),
      });
    },
  });
}
