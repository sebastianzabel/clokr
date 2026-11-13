/**
 * Provisioning of the synthetic tenants (Issue #715). Everything goes through real APIs: the
 * operator API creates the tenants and books the packages, the tenant API (as the tenant's own
 * admin) creates salons, people, contracts and device keys. There is no database access.
 */
import {
  buildPopulation,
  FULL_SIZE,
  SMALL_SIZE,
  type PopulationSize,
  type TenantPlan,
} from "../plan";
import { ApiClient, login, mapLimit, type Session } from "../http";
import { loadOperatorCredentials, operatorLogin } from "../operator";
import { mailpitClient, waitForInvitationToken } from "../mail";
import { rngFor } from "../rng";
import { addDays, dayInTz, weekdayOf } from "../tz";
import { saveState, type SimState, type TenantState } from "../state";
import type { SimConfig } from "../config";
import { createEmployee, expectOk, standardOpeningHours } from "./tenant-api";

const FEDERAL_STATES = [
  "BERLIN",
  "NIEDERSACHSEN",
  "BAYERN",
  "NORDRHEIN_WESTFALEN",
  "HAMBURG",
  "HESSEN",
  "SACHSEN",
  "BADEN_WUERTTEMBERG",
] as const;

export interface ProvisionOptions {
  size: "full" | "small";
  mailUrl: string;
  /** Days of history between the epoch and today (people are employed from the epoch). */
  backfillDays: number;
  log?: (line: string) => void;
}

export function sizeFor(name: "full" | "small"): PopulationSize {
  return name === "full" ? FULL_SIZE : SMALL_SIZE;
}

async function provisionTenant(
  api: ApiClient,
  operatorToken: string,
  config: SimConfig,
  plan: TenantPlan,
  epoch: string,
  options: ProvisionOptions,
): Promise<TenantState> {
  const log = options.log ?? (() => {});
  const adminPassword = `Sim-${rngFor(config.seed, "admin", plan.key).int(100000, 999999)}-Kx!z`;

  const created = expectOk(
    `create tenant ${plan.slug}`,
    await api.post<{
      tenant: { id: string };
      defaultSalonId: string;
    }>(
      "/api/v1/operator/tenants",
      {
        name: plan.name,
        slug: plan.slug,
        federalState: "BERLIN",
        timezone: config.tz,
        admin: {
          email: plan.adminEmail,
          firstName: "Sim",
          lastName: `Admin-${plan.key}`,
          employeeNumber: `ADM-${plan.key}`,
        },
      },
      operatorToken,
    ),
  );
  const tenantId = created.tenant.id;
  log(`tenant ${plan.slug}: ${tenantId}`);

  // All packages, and room for every salon: the simulation tests the chain case, not the quota.
  expectOk(
    "book packages",
    await api.put(
      `/api/v1/operator/tenants/${tenantId}/packages`,
      {
        bookedModules: ["CHAIN", "INTEGRATIONS", "HARDWARE_CLOCK", "ANALYTICS"],
        salonQuota: plan.salons.length + 5,
      },
      operatorToken,
    ),
  );

  // The first admin sets the password through the invitation link, like a human.
  const token = await waitForInvitationToken(mailpitClient(options.mailUrl), plan.adminEmail);
  expectOk(
    "accept admin invitation",
    await api.post("/api/v1/invitations/accept", { token, password: adminPassword }),
  );
  const admin = await login(api, plan.adminEmail, adminPassword);

  // Tenant policy of the chain: the automatic break is on, like on any real salon tenant, so
  // entries recorded by the terminal or the WLAN get their legal break.
  expectOk(
    "tenant policy",
    await api.put(
      "/api/v1/settings/work",
      { autoBreakEnabled: true, defaultBreakStart: "12:00" },
      admin.token,
    ),
  );

  // Salons: the default salon becomes salon 01, the others are created. Federal states differ so
  // the holiday resolution per work location is exercised.
  const salonIds: string[] = [];
  for (const salon of plan.salons) {
    const federalState = FEDERAL_STATES[salon.index % FEDERAL_STATES.length];
    if (salon.index === 0) {
      expectOk(
        "rename default salon",
        await api.patch(
          `/api/v1/salons/${created.defaultSalonId}`,
          { name: salon.name, openingHours: standardOpeningHours() },
          admin.token,
        ),
      );
      salonIds.push(created.defaultSalonId);
      continue;
    }
    const body = expectOk(
      `create salon ${salon.index}`,
      await api.post<{ id: string }>(
        "/api/v1/salons",
        {
          name: salon.name,
          federalState,
          openingHours: standardOpeningHours(),
        },
        admin.token,
      ),
    );
    salonIds.push(body.id);
  }
  log(`  ${salonIds.length} salons`);

  // Device credentials: one NFC terminal key and one presence source key per tenant.
  const terminal = expectOk(
    "create terminal key",
    await api.post<{ rawKey: string }>("/api/v1/terminals", { name: "Sim Terminal" }, admin.token),
  );
  const source = expectOk(
    "create presence source",
    await api.post<{ rawKey: string }>(
      "/api/v1/admin/presence-sources",
      { name: "Sim WLAN" },
      admin.token,
    ),
  );

  const state: TenantState = {
    tenantId,
    adminEmail: plan.adminEmail,
    adminPassword,
    salonIds,
    terminalKey: terminal.rawKey,
    presenceKey: source.rawKey,
    persons: {},
  };

  // People employed from the epoch; later hires are created by the admin bot on their hire day.
  const initial = plan.persons.filter((p) => p.hireDate <= epoch);
  let done = 0;
  await mapLimit(initial, 4, async (person) => {
    const ids = await createEmployee(
      api,
      admin.token,
      person,
      salonIds[person.homeSalonIndex],
      config.tz,
    );
    state.persons[person.key] = { ...ids, created: true, exited: false, anonymized: false };
    done += 1;
    if (done % 50 === 0) log(`  ${done}/${initial.length} people`);
  });
  for (const person of plan.persons) {
    if (!state.persons[person.key]) {
      state.persons[person.key] = {
        employeeId: "",
        userId: "",
        created: false,
        exited: false,
        anonymized: false,
      };
    }
  }
  log(`  ${initial.length} people created, ${plan.persons.length - initial.length} pending hires`);

  await decoratePeople(api, admin, plan, state, epoch, config);
  return state;
}

/** Springer deployments, Berufsschule patterns, WLAN devices and opt-in. */
async function decoratePeople(
  api: ApiClient,
  admin: Session,
  plan: TenantPlan,
  state: TenantState,
  epoch: string,
  config: SimConfig,
): Promise<void> {
  const created = plan.persons.filter((p) => state.persons[p.key].created);

  await mapLimit(created, 4, async (person) => {
    const ids = state.persons[person.key];
    for (const salonIndex of person.extraSalonIndexes) {
      expectOk(
        `deployment ${person.key}`,
        await api.post(
          `/api/v1/employees/${ids.employeeId}/salon-assignments`,
          { salonId: state.salonIds[salonIndex], validFrom: epoch },
          admin.token,
        ),
      );
    }
    if (person.schoolDay !== null) {
      expectOk(
        `vocational school ${person.key}`,
        await api.put(
          `/api/v1/employees/${ids.employeeId}/vocational-school-pattern`,
          {
            patterns: [
              {
                // The pattern API counts Monday as 0.
                daysOfWeek: [person.schoolDay - 1],
                validFrom: epoch,
                respectSchoolHolidays: true,
              },
            ],
          },
          admin.token,
        ),
      );
    }
  });

  // WLAN users enrol their own device after giving consent: their own login, their own calls.
  const wifi = created.filter((p) => p.channel === "WIFI");
  await mapLimit(wifi, 4, async (person) => {
    const session = await login(api, person.email, person.password);
    expectOk(
      `wifi opt-in ${person.key}`,
      await api.patch("/api/v1/employees/me/wifi", { wifiPresenceEnabled: true }, session.token),
    );
    expectOk(
      `wifi device ${person.key}`,
      await api.post(
        "/api/v1/employees/me/wifi/devices",
        { mac: macFor(config.seed, person.key), label: "Sim Phone" },
        session.token,
      ),
    );
  });
}

/** A locally administered, obviously fake MAC derived from seed and person. */
export function macFor(seed: string, personKey: string): string {
  const rng = rngFor(seed, "mac", personKey);
  const octets = [0x02, 0x51, rng.int(0, 255), rng.int(0, 255), rng.int(0, 255), rng.int(0, 255)];
  return octets.map((o) => o.toString(16).padStart(2, "0")).join(":");
}

export async function provision(config: SimConfig, options: ProvisionOptions): Promise<SimState> {
  const log = options.log ?? (() => {});
  const api = new ApiClient(config.apiUrl);
  const today = dayInTz(new Date(), config.tz);
  const epoch = addDays(today, -options.backfillDays);
  const plan = buildPopulation(config.seed, epoch, sizeFor(options.size));
  const operatorToken = await operatorLogin(api, loadOperatorCredentials(config.stateDir));

  const state: SimState = { plan, provisionedAt: new Date().toISOString(), tenants: {} };
  for (const tenantPlan of plan.tenants) {
    state.tenants[tenantPlan.key] = await provisionTenant(
      api,
      operatorToken,
      config,
      tenantPlan,
      epoch,
      options,
    );
    saveState(config.stateDir, state);
  }
  log(`epoch ${epoch} (a ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekdayOf(epoch)]})`);
  return state;
}
