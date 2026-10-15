/**
 * Issue #93 (Phase 93b-02, D-05, D-24) — composition seam of the operator's support reads.
 *
 * The operator support routes live in the Unterbau and must not import a business context or read a
 * person model themselves (ADR 0002, Entscheidung 9; the operator source scan). The reads they open
 * under a support access come in through this port, which the composition root hands to the route
 * plugin. It owns no model and carries no rule: it assembles explicit-key DTOs from public exports.
 *
 * Data minimisation (D-05, Art. 5 (1) (c) DSGVO): the employee list selects id, Personalnummer, names
 * and the entry and exit dates only, never the e-mail, birth date, NFC card id, WLAN addresses or
 * avatar. An anonymised employee is listed with its stored (anonymised) values (D-13).
 *
 * Every query below carries the tenant in its `where` (directly, or through `employee: { tenantId }`):
 * the tenant-scoping gate cannot see a composition module that has no request, so the foreign-tenant
 * case of `support-access-grant-93.test.ts` and the source scan of the later support tests are the
 * proof that a read never leaves the tenant of the grant.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import {
  homeSalonsForDays,
  listSalons,
  supportEmployeeStatus,
  type OperatorSupportPorts,
  type SupportEmployeeDto,
} from "../contexts/platform";
import { dateStrInTz, getTenantTimezone, todayInTz } from "../contexts/working-time-account";

async function employeeExists(
  db: Prisma.TransactionClient,
  tenantId: string,
  employeeId: string,
): Promise<boolean> {
  const row = await db.employee.findFirst({
    where: { id: employeeId, tenantId },
    select: { id: true },
  });
  return row !== null;
}

async function listEmployees(
  app: FastifyInstance,
  tenantId: string,
): Promise<SupportEmployeeDto[]> {
  const tz = await getTenantTimezone(app.prisma, tenantId);
  const today = todayInTz(tz);
  const todayDay = today.toISOString().slice(0, 10);
  const now = new Date();

  const employees = await app.prisma.employee.findMany({
    where: { tenantId },
    select: {
      id: true,
      employeeNumber: true,
      firstName: true,
      lastName: true,
      hireDate: true,
      exitDate: true,
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
  });
  if (employees.length === 0) return [];
  const ids = employees.map((employee) => employee.id);

  // Current contract type: the newest row that is already valid. A person whose first contract starts
  // in the future has none yet.
  const schedules = await app.prisma.workSchedule.findMany({
    where: { employee: { tenantId }, employeeId: { in: ids }, validFrom: { lte: now } },
    orderBy: [{ validFrom: "desc" }, { id: "asc" }],
    select: { employeeId: true, type: true },
  });
  const scheduleTypeByEmployee = new Map<string, string>();
  for (const schedule of schedules) {
    if (!scheduleTypeByEmployee.has(schedule.employeeId)) {
      scheduleTypeByEmployee.set(schedule.employeeId, schedule.type);
    }
  }

  // Stammsalon of today; inactive salons stay in the lookup (a person may still belong to one).
  const homeByEmployee = await homeSalonsForDays(app.prisma, tenantId, ids, todayDay, todayDay);
  const salons = await listSalons(app.prisma, tenantId, { includeInactive: true });
  const salonNameById = new Map(salons.map((salon) => [salon.id, salon.name]));

  return employees.map((employee) => {
    const homeSalonId = homeByEmployee.get(employee.id)?.get(todayDay) ?? null;
    const homeSalonName = homeSalonId === null ? undefined : salonNameById.get(homeSalonId);
    return {
      id: employee.id,
      employeeNumber: employee.employeeNumber,
      firstName: employee.firstName,
      lastName: employee.lastName,
      hireDate: dateStrInTz(employee.hireDate, tz),
      exitDate: employee.exitDate ? dateStrInTz(employee.exitDate, tz) : null,
      status: supportEmployeeStatus(employee, today),
      homeSalon:
        homeSalonId !== null && homeSalonName !== undefined
          ? { id: homeSalonId, name: homeSalonName }
          : null,
      scheduleType: scheduleTypeByEmployee.get(employee.id) ?? null,
    };
  });
}

export const operatorSupportPorts = {
  employeeExists,
  listEmployees,
} satisfies OperatorSupportPorts;
