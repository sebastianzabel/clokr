/** Thin wrappers over the real tenant API calls the provisioning and the admin bot share. */
import type { ApiClient } from "../http";
import type { PersonSpec } from "../plan";
import { localIso } from "../tz";

export class ApiFailure extends Error {
  constructor(
    readonly what: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${what} failed with status ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
}

export function expectOk<T>(
  what: string,
  res: { status: number; body: T },
  ok: readonly number[] = [200, 201, 204],
): T {
  if (!ok.includes(res.status)) throw new ApiFailure(what, res.status, res.body);
  return res.body;
}

/** Opening hours: 0 = Monday ... 6 = Sunday (salon convention). Sunday closed. */
export function standardOpeningHours() {
  return Array.from({ length: 7 }, (_, day) => ({
    day,
    open: "09:00",
    close: "19:00",
    closed: day === 6,
  }));
}

export function employeePayload(person: PersonSpec, homeSalonId: string, tz: string) {
  return {
    email: person.email,
    firstName: person.firstName,
    lastName: person.lastName,
    employeeNumber: person.employeeNumber,
    hireDate: localIso(person.hireDate, "00:00", tz),
    role: person.role,
    password: person.password,
    scheduleType: person.scheduleType,
    classification: person.classification,
    weeklyHours: person.weeklyHours,
    monthlyHours: person.monthlyHours,
    workDays: person.workDays,
    contractWorkDaysPerWeek: person.contractWorkDaysPerWeek,
    usualWorkDays: person.usualWorkDays,
    birthDate: person.birthDate,
    nfcCardId: person.nfcCardId ?? undefined,
    homeSalonId,
  };
}

export async function createEmployee(
  api: ApiClient,
  token: string,
  person: PersonSpec,
  homeSalonId: string,
  tz: string,
): Promise<{ employeeId: string; userId: string }> {
  const res = await api.post<{ id: string; userId?: string; user?: { id: string } }>(
    "/api/v1/employees",
    employeePayload(person, homeSalonId, tz),
    token,
  );
  const body = expectOk(`create employee ${person.key}`, res);
  return { employeeId: body.id, userId: body.userId ?? body.user?.id ?? "" };
}
