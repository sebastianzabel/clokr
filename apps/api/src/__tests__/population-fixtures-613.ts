/**
 * Issue #613 — shared fixture for every population test of the phase.
 *
 * `createPopulationPerson` builds one person around a period boundary: exited, login-deactivated,
 * anonymised (the DSGVO sentinel) or hired late. It reuses the setup.ts helpers (system role grant)
 * and the Stammsalon assignment the way production employee creation writes it. No real names, no
 * real e-mails: the e-mail is synthetic and the names are fixed fixture strings.
 */
import { randomBytes } from "crypto";
import type { FastifyInstance } from "fastify";
import { grantSystemRole } from "./setup";

export interface PopulationPersonOptions {
  tenantId: string;
  /** Active salon of the same tenant; the person's HOME (Stammsalon) assignment. */
  salonId: string;
  /** Short label — part of the e-mail, the employee number and the last name. */
  tag: string;
  hireDate: Date;
  exitDate?: Date | null;
  /** Login state, default true. Independent of the employment (the Elternzeit case). */
  loginActive?: boolean;
  /** The DSGVO sentinel (firstName "Gelöscht", lastName "GELÖSCHT-…"), login off. */
  anonymized?: boolean;
  /** Compat column value of the user, default EMPLOYEE. */
  userRole?: "EMPLOYEE" | "MANAGER";
  /** A bcrypt hash to allow a real login; absent = the person cannot sign in. */
  passwordHash?: string;
}

export interface PopulationPerson {
  userId: string;
  employeeId: string;
  email: string;
  employeeNumber: string;
}

const UNUSABLE_PASSWORD_HASH = "$2a$10$0000000000000000000000.0000000000000000000000000000000";

export async function createPopulationPerson(
  app: FastifyInstance,
  opts: PopulationPersonOptions,
): Promise<PopulationPerson> {
  const prisma = app.prisma;
  const random = randomBytes(3).toString("hex");
  const tag = opts.tag.toUpperCase();
  const email = `613-${opts.tag}-${random}@example.invalid`;
  const employeeNumber = opts.anonymized ? `GELÖSCHT-${tag}-${random}` : `P613-${tag}-${random}`;

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: opts.anonymized ? "ANONYMIZED" : (opts.passwordHash ?? UNUSABLE_PASSWORD_HASH),
      role: opts.userRole ?? "EMPLOYEE",
      isActive: opts.anonymized ? false : (opts.loginActive ?? true),
    },
  });
  const employee = await prisma.employee.create({
    data: {
      tenantId: opts.tenantId,
      userId: user.id,
      employeeNumber,
      firstName: opts.anonymized ? "Gelöscht" : "Pop",
      lastName: opts.anonymized ? employeeNumber : `P613${opts.tag}`,
      hireDate: opts.hireDate,
      exitDate: opts.exitDate ?? null,
    },
  });
  await grantSystemRole(prisma, {
    tenantId: opts.tenantId,
    userId: user.id,
    role: opts.userRole === "MANAGER" ? "MANAGER" : "EMPLOYEE",
  });
  await prisma.workSchedule.create({
    data: {
      employeeId: employee.id,
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      validFrom: opts.hireDate,
    },
  });
  await prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
  await prisma.employeeSalonAssignment.create({
    data: {
      tenantId: opts.tenantId,
      employeeId: employee.id,
      salonId: opts.salonId,
      kind: "HOME",
      validFrom: new Date(opts.hireDate.toISOString().slice(0, 10) + "T00:00:00Z"),
      validUntil: null,
      weekdays: [],
    },
  });
  return { userId: user.id, employeeId: employee.id, email, employeeNumber };
}
