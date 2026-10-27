/**
 * The synthetic population (Issue #715). Pure and deterministic: the same seed and size always give
 * the same salons, persons and traits. Nothing here resembles a real person: names are generated
 * from a fixed list of obviously fake given names plus a running "Bot-NNNN" family name, addresses
 * end in `.invalid` (RFC 2606, never deliverable).
 */
import { rngFor, type Rng } from "./rng";
import { addDays } from "./tz";

export type SimTenantKey = "chain" | "small";

export type PersonKind =
  | "FIXED"
  | "FLEX"
  | "MONTHLY_HOURS"
  | "MONTHLY_NO_HOURS"
  | "SHIFT"
  | "AZUBI"
  | "MINOR"
  | "SPRINGER";

export type ClockChannel = "WEB" | "WIFI" | "NFC";

export interface PersonTraits {
  /** Probability of arriving up to 25 minutes late on a working day. */
  lateness: number;
  /** Probability of forgetting to clock out (NFC users only; leaves an open entry). */
  forgetsClockOut: number;
  /** Probability of a sick day. */
  sickness: number;
  /** Probability per day of filing a vacation request. */
  vacationAppetite: number;
  /** Probability of a deliberately long day or a missing break (intentional ArbZG finding). */
  violationProne: number;
}

export interface PersonSpec {
  key: string;
  tenant: SimTenantKey;
  firstName: string;
  lastName: string;
  email: string;
  employeeNumber: string;
  role: "ADMIN" | "MANAGER" | "EMPLOYEE";
  kind: PersonKind;
  scheduleType: "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED";
  classification: "VOLLZEIT" | "TEILZEIT" | "MINIJOB" | "AZUBI";
  weeklyHours: number;
  monthlyHours: number | null;
  /** 0 = Sunday .. 6 = Saturday. */
  workDays: number[];
  contractWorkDaysPerWeek: number | null;
  usualWorkDays: number[] | null;
  birthDate: string | null;
  /** Hire date as a calendar day relative to the simulation epoch. */
  hireDate: string;
  /** Planned exit, only ever set by the admin bot on the given day (never at provisioning). */
  plannedExitDay: string | null;
  homeSalonIndex: number;
  /** Extra salons a Springer works in. */
  extraSalonIndexes: number[];
  /** Vocational school weekday (Azubi), 0 = Sunday .. 6 = Saturday. */
  schoolDay: number | null;
  channel: ClockChannel;
  nfcCardId: string | null;
  password: string;
  traits: PersonTraits;
}

export interface SalonSpec {
  index: number;
  name: string;
}

export interface TenantPlan {
  key: SimTenantKey;
  name: string;
  slug: string;
  adminEmail: string;
  salons: SalonSpec[];
  persons: PersonSpec[];
}

export interface PopulationPlan {
  seed: string;
  epoch: string;
  tenants: TenantPlan[];
}

export interface PopulationSize {
  chainSalons: number;
  chainPersons: number;
  smallPersons: number;
}

export const FULL_SIZE: PopulationSize = { chainSalons: 30, chainPersons: 300, smallPersons: 8 };
export const SMALL_SIZE: PopulationSize = { chainSalons: 2, chainPersons: 15, smallPersons: 3 };

const GIVEN_NAMES = [
  "Alpha",
  "Bravo",
  "Charly",
  "Delta",
  "Echo",
  "Foxi",
  "Golf",
  "Hotel",
  "Indigo",
  "Juno",
  "Kilo",
  "Lima",
  "Mike",
  "Nova",
  "Oskar",
  "Papa",
  "Quark",
  "Romeo",
  "Sierra",
  "Tango",
];

const KIND_WEIGHTS: { value: PersonKind; weight: number }[] = [
  { value: "FIXED", weight: 34 },
  { value: "FLEX", weight: 10 },
  { value: "MONTHLY_HOURS", weight: 8 },
  { value: "MONTHLY_NO_HOURS", weight: 3 },
  { value: "SHIFT", weight: 28 },
  { value: "AZUBI", weight: 7 },
  { value: "MINOR", weight: 3 },
  { value: "SPRINGER", weight: 7 },
];

const ALL_KINDS: PersonKind[] = [
  "SHIFT",
  "FIXED",
  "FLEX",
  "MONTHLY_HOURS",
  "MONTHLY_NO_HOURS",
  "AZUBI",
  "MINOR",
  "SPRINGER",
];

function passwordFor(rng: Rng): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz";
  let body = "";
  for (let i = 0; i < 10; i += 1) body += alphabet[rng.int(0, alphabet.length - 1)];
  return `Sim-${body}-7Q!`;
}

function sortedUnique(days: number[]): number[] {
  return [...new Set(days)].sort((a, b) => a - b);
}

function contractFor(kind: PersonKind, rng: Rng) {
  const monFri = [1, 2, 3, 4, 5];
  const monSat = [1, 2, 3, 4, 5, 6];
  switch (kind) {
    case "FIXED":
      return rng.chance(0.6)
        ? {
            scheduleType: "FIXED_SCHEDULE" as const,
            classification: "VOLLZEIT" as const,
            weeklyHours: 40,
            monthlyHours: null,
            workDays: rng.chance(0.5) ? monFri : [2, 3, 4, 5, 6],
            contractWorkDaysPerWeek: null,
            usualWorkDays: null,
          }
        : {
            scheduleType: "FIXED_SCHEDULE" as const,
            classification: "TEILZEIT" as const,
            weeklyHours: 24,
            monthlyHours: null,
            workDays: sortedUnique(rng.shuffle(monSat).slice(0, 3)),
            contractWorkDaysPerWeek: null,
            usualWorkDays: null,
          };
    case "FLEX":
      return {
        scheduleType: "FLEXTIME" as const,
        classification: "VOLLZEIT" as const,
        weeklyHours: 38.5,
        monthlyHours: null,
        workDays: monFri,
        contractWorkDaysPerWeek: null,
        usualWorkDays: null,
      };
    case "MONTHLY_HOURS":
      return {
        scheduleType: "MONTHLY_HOURS" as const,
        classification: "MINIJOB" as const,
        weeklyHours: 10,
        monthlyHours: 43,
        workDays: sortedUnique(rng.shuffle(monSat).slice(0, 3)),
        contractWorkDaysPerWeek: null,
        usualWorkDays: null,
      };
    case "MONTHLY_NO_HOURS":
      return {
        scheduleType: "MONTHLY_HOURS" as const,
        classification: "MINIJOB" as const,
        weeklyHours: 0,
        monthlyHours: null,
        workDays: sortedUnique(rng.shuffle(monSat).slice(0, 2)),
        contractWorkDaysPerWeek: null,
        usualWorkDays: null,
      };
    case "SHIFT":
    case "SPRINGER": {
      const perWeek = rng.pick([4, 5]);
      const usual = sortedUnique(rng.shuffle(monSat).slice(0, perWeek));
      return {
        scheduleType: "SHIFT_BASED" as const,
        classification: "VOLLZEIT" as const,
        weeklyHours: 36,
        monthlyHours: null,
        workDays: usual,
        contractWorkDaysPerWeek: perWeek,
        usualWorkDays: usual,
      };
    }
    case "AZUBI":
    case "MINOR":
      return {
        scheduleType: "FIXED_SCHEDULE" as const,
        classification: "AZUBI" as const,
        weeklyHours: kind === "MINOR" ? 38 : 40,
        monthlyHours: null,
        workDays: monFri,
        contractWorkDaysPerWeek: null,
        usualWorkDays: null,
      };
  }
}

function buildTenant(
  seed: string,
  epoch: string,
  key: SimTenantKey,
  salonCount: number,
  personCount: number,
): TenantPlan {
  const prefix = key === "chain" ? "c" : "s";
  const root = rngFor(seed, "tenant", key);
  const salons: SalonSpec[] = Array.from({ length: salonCount }, (_, index) => ({
    index,
    name: `Sim ${key === "chain" ? "Kette" : "Solo"} Salon ${String(index + 1).padStart(2, "0")}`,
  }));
  // One manager per two salons (at least one), the rest are employees.
  const managerCount = Math.max(1, Math.floor(salonCount / 2));
  const persons: PersonSpec[] = [];
  for (let n = 1; n <= personCount; n += 1) {
    const personKey = `${prefix}${String(n).padStart(4, "0")}`;
    const rng = rngFor(seed, "person", key, personKey);
    const isManager = n <= managerCount;
    // The first non-managers walk through every kind once, so even a tiny population covers all
    // contract models; the rest follows the weights.
    const ordinal = n - managerCount - 1;
    const kind: PersonKind = isManager
      ? "FIXED"
      : ordinal < ALL_KINDS.length
        ? ALL_KINDS[ordinal]
        : root.weighted(KIND_WEIGHTS);
    const contract = contractFor(kind, rng);
    const minor = kind === "MINOR";
    const azubi = kind === "AZUBI" || minor;
    // Minors are 16 or 17 on the epoch day; everyone else is 19 to 58.
    const age = minor ? rng.int(16, 17) : azubi ? rng.int(18, 24) : rng.int(19, 58);
    const birthYear = Number(epoch.slice(0, 4)) - age;
    const birthDate = `${birthYear}-${String(rng.int(1, 12)).padStart(2, "0")}-${String(rng.int(1, 28)).padStart(2, "0")}`;
    const homeSalonIndex = isManager ? ((n - 1) * 2) % salonCount : rng.int(0, salonCount - 1);
    const extra: number[] = [];
    if (kind === "SPRINGER" && salonCount > 1) {
      for (const idx of rng.shuffle(salons.map((s) => s.index)).slice(0, 2)) {
        if (idx !== homeSalonIndex) extra.push(idx);
      }
    }
    // Like the kinds, the first people walk through every clock channel so a tiny population still
    // exercises NFC, WLAN and the web.
    const channel: ClockChannel =
      !isManager && ordinal < 9
        ? (["NFC", "WIFI", "WEB"] as const)[ordinal % 3]
        : rng.weighted<ClockChannel>([
            { value: "WEB", weight: 60 },
            { value: "WIFI", weight: 25 },
            { value: "NFC", weight: 15 },
          ]);
    persons.push({
      key: personKey,
      tenant: key,
      firstName: GIVEN_NAMES[(n - 1) % GIVEN_NAMES.length],
      lastName: `Bot-${personKey.toUpperCase()}`,
      email: `sim-${personKey}@sim.invalid`,
      employeeNumber: `${prefix.toUpperCase()}${String(n).padStart(5, "0")}`,
      role: isManager ? "MANAGER" : "EMPLOYEE",
      kind,
      ...contract,
      birthDate: `${birthDate}T00:00:00.000Z`,
      // The population is employed from the epoch; ~4 % join later (the admin bot hires them).
      hireDate: !isManager && rng.chance(0.04) ? addDays(epoch, rng.int(3, 20)) : epoch,
      plannedExitDay: !isManager && rng.chance(0.03) ? addDays(epoch, rng.int(10, 24)) : null,
      homeSalonIndex,
      extraSalonIndexes: extra,
      schoolDay: azubi ? rng.pick([1, 2, 3, 4]) : null,
      channel,
      nfcCardId: channel === "NFC" ? `SIM-${key}-${personKey}` : null,
      password: passwordFor(rng),
      traits: {
        lateness: rng.pick([0.02, 0.08, 0.2]),
        forgetsClockOut: channel === "NFC" ? rng.pick([0.02, 0.06]) : 0,
        sickness: rng.pick([0.01, 0.02, 0.04]),
        vacationAppetite: rng.pick([0.004, 0.01]),
        violationProne: rng.pick([0, 0, 0.01, 0.03]),
      },
    });
  }
  return {
    key,
    name: key === "chain" ? "Sim Kette GmbH" : "Sim Solo GmbH",
    slug: key === "chain" ? "sim-kette" : "sim-solo",
    adminEmail: `sim-admin-${key}@sim.invalid`,
    salons,
    persons,
  };
}

export function buildPopulation(seed: string, epoch: string, size: PopulationSize): PopulationPlan {
  return {
    seed,
    epoch,
    tenants: [
      buildTenant(seed, epoch, "chain", size.chainSalons, size.chainPersons),
      buildTenant(seed, epoch, "small", 1, size.smallPersons),
    ],
  };
}

/** Counts per kind, used by the provisioning summary and by the coverage test. */
export function countKinds(persons: readonly PersonSpec[]): Record<PersonKind, number> {
  const counts = {
    FIXED: 0,
    FLEX: 0,
    MONTHLY_HOURS: 0,
    MONTHLY_NO_HOURS: 0,
    SHIFT: 0,
    AZUBI: 0,
    MINOR: 0,
    SPRINGER: 0,
  } satisfies Record<PersonKind, number>;
  for (const person of persons) counts[person.kind] += 1;
  return counts;
}
