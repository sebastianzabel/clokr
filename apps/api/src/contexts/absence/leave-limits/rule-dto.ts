/**
 * Issue #836 (D-836-02/D-836-13) - the wire shape of a leave-limit rule: the Zod body of POST and
 * PUT and the response DTO. Pure, no I/O. The schema mirrors the database CHECKs
 * (`LeaveLimitRule_maxPersons_check`, `_window_check`, `_group_shape_check`), which stay the backstop
 * for every other writer.
 */
import { z } from "zod";
import { EmployeeClassification } from "@clokr/db";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day as `YYYY-MM-DD` (rejects 2027-02-30 instead of rolling it over). */
const daySchema = z
  .string()
  .regex(DAY_PATTERN, "Datum muss das Format JJJJ-MM-TT haben.")
  .refine((value) => new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value, {
    message: "Ungültiges Datum.",
  });

export const leaveLimitRuleBodySchema = z
  .object({
    salonId: z.string().uuid().nullable(),
    groupKind: z.enum(["ALL", "CLASSIFICATION", "ACCESS_ROLE"]),
    classification: z.enum(EmployeeClassification).nullable().optional(),
    accessRoleId: z.string().uuid().nullable().optional(),
    maxPersons: z
      .number({ error: "Die Höchstzahl muss eine Zahl sein." })
      .int("Die Höchstzahl muss eine ganze Zahl sein.")
      .min(0, "Die Höchstzahl darf nicht negativ sein.")
      .max(999, "Die Höchstzahl darf höchstens 999 sein."),
    validFrom: daySchema.nullable().optional(),
    validUntil: daySchema.nullable().optional(),
    name: z.string().trim().min(1).max(80).nullable().optional(),
  })
  .superRefine((body, ctx) => {
    const hasClassification = body.classification != null;
    const hasRole = body.accessRoleId != null;
    if (body.groupKind === "CLASSIFICATION" && (!hasClassification || hasRole)) {
      ctx.addIssue({
        code: "custom",
        path: ["classification"],
        message: "Für eine Gruppe nach Beschäftigungsart ist genau eine Beschäftigungsart nötig.",
      });
    }
    if (body.groupKind === "ACCESS_ROLE" && (!hasRole || hasClassification)) {
      ctx.addIssue({
        code: "custom",
        path: ["accessRoleId"],
        message: "Für eine Gruppe nach Rolle ist genau eine Rolle nötig.",
      });
    }
    if (body.groupKind === "ALL" && (hasClassification || hasRole)) {
      ctx.addIssue({
        code: "custom",
        path: ["groupKind"],
        message: "Für alle Mitarbeitenden darf weder Beschäftigungsart noch Rolle gesetzt sein.",
      });
    }
    if (body.validFrom && body.validUntil && body.validFrom > body.validUntil) {
      ctx.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "Das Ende des Zeitraums darf nicht vor dem Beginn liegen.",
      });
    }
  });

export type LeaveLimitRuleBody = z.infer<typeof leaveLimitRuleBodySchema>;

/** The columns a body writes, as Prisma data (days become UTC-midnight `@db.Date` values). */
export function ruleDataFromBody(body: LeaveLimitRuleBody) {
  return {
    groupKind: body.groupKind,
    classification: body.groupKind === "CLASSIFICATION" ? (body.classification ?? null) : null,
    accessRoleId: body.groupKind === "ACCESS_ROLE" ? (body.accessRoleId ?? null) : null,
    maxPersons: body.maxPersons,
    validFrom: body.validFrom ? new Date(`${body.validFrom}T00:00:00.000Z`) : null,
    validUntil: body.validUntil ? new Date(`${body.validUntil}T00:00:00.000Z`) : null,
    name: body.name ?? null,
  };
}

export type LeaveLimitRuleRecord = {
  id: string;
  salonId: string | null;
  groupKind: "ALL" | "CLASSIFICATION" | "ACCESS_ROLE";
  classification: EmployeeClassification | null;
  accessRoleId: string | null;
  maxPersons: number;
  validFrom: Date | null;
  validUntil: Date | null;
  name: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LeaveLimitRuleDto = {
  id: string;
  salonId: string | null;
  salonName: string | null;
  salonActive: boolean | null;
  groupKind: "ALL" | "CLASSIFICATION" | "ACCESS_ROLE";
  classification: EmployeeClassification | null;
  accessRoleId: string | null;
  accessRoleName: string | null;
  maxPersons: number;
  validFrom: string | null;
  validUntil: string | null;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  canManage: boolean;
};

function dayOf(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

export function toLeaveLimitRuleDto(
  row: LeaveLimitRuleRecord,
  context: {
    salon: { name: string; isActive: boolean } | null;
    roleName: string | null;
    canManage: boolean;
  },
): LeaveLimitRuleDto {
  return {
    id: row.id,
    salonId: row.salonId,
    salonName: context.salon?.name ?? null,
    salonActive: context.salon ? context.salon.isActive : null,
    groupKind: row.groupKind,
    classification: row.classification,
    accessRoleId: row.accessRoleId,
    accessRoleName: row.accessRoleId ? context.roleName : null,
    maxPersons: row.maxPersons,
    validFrom: dayOf(row.validFrom),
    validUntil: dayOf(row.validUntil),
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    canManage: context.canManage,
  };
}
