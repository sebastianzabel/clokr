/**
 * Issue #85 / #547 (547-AC3, D-04 "whole-tenant callers byte-identical") — neutrality pins for the
 * whole-tenant view of three handlers that Phase 85b narrows for SCOPED callers:
 *   (a) GET /api/v1/employees (default and ?includeAnonymized=true),
 *   (c) GET /api/v1/dashboard/today-attendance,
 *   (d) GET /api/v1/time-entries (the admin's own entries) and
 *   (e) the same list with ?employeeId=<another employee>.
 *
 * The literals below were captured on the UNCHANGED tree at commit 4e7b1311cba7d956a7737720848c3a831d0a661e BEFORE 85b
 * changed any of these handlers. A later failure means the whole-tenant response changed:
 * investigate the production change, never re-capture a literal. Only the tenant admin (a
 * whole-tenant reach) is exercised here — the scoped branches are proven in the plan-specific
 * test files of 85b.
 *
 * Normalisation: every non-null value whose key is `id`, ends in `Id` or `At`, or equals `email`,
 * `employeeNumber` or `token` is replaced by the string "<v>" (run-specific values). The keys
 * themselves stay, so an added or removed key still fails the pin; the real ids are checked
 * separately as an exact multiset against the fixture. No person names in fixtures.
 *
 * Fixed clock: Wed 2026-06-17T10:00:00Z (CEST, 12:00 local). Only `Date` is faked, and only around
 * the requests (the 84 frozen-pin pattern).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  grantSystemRole,
  reissueTokenNow,
} from "./setup";

const FAKE_NOW = new Date("2026-06-17T10:00:00Z");

const EXPECTED_EMPLOYEES = [
  {
    id: "<v>",
    tenantId: "<v>",
    userId: "<v>",
    employeeNumber: "<v>",
    firstName: "Pin",
    lastName: "PinHoliday",
    nfcCardId: null,
    wifiMacs: [],
    wifiPresenceEnabled: false,
    wifiOptInAt: null,
    avatarPath: null,
    classification: "VOLLZEIT",
    coverageWeight: "1",
    requiresSupervision: false,
    hireDate: "2025-01-01T00:00:00.000Z",
    exitDate: null,
    birthDate: null,
    annualVacationDays: null,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    phorestPrepMinutesOverride: null,
    phorestWrapupMinutesOverride: null,
    bsSlotFirstLongDayMinutes: null,
    bsSlotSecondLongDayMinutes: null,
    bsSlotShortDayMinutes: null,
    bsSlotBlockWeekMinutes: null,
    isTimeTrackingExempt: false,
    createdAt: "<v>",
    updatedAt: "<v>",
    user: {
      email: "<v>",
      role: "EMPLOYEE",
      isActive: true,
      lastLoginAt: null,
    },
    overtimeAccount: {
      balanceHours: "-8",
    },
    workSchedule: {
      id: "<v>",
      employeeId: "<v>",
      type: "FIXED_SCHEDULE",
      weeklyHours: "40",
      monthlyHours: null,
      mondayHours: "8",
      tuesdayHours: "8",
      wednesdayHours: "8",
      thursdayHours: "8",
      fridayHours: "8",
      saturdayHours: "0",
      sundayHours: "0",
      workDays: [1, 2, 3, 4, 5],
      contractWorkDaysPerWeek: null,
      usualWorkDays: [],
      coreStart: null,
      coreEnd: null,
      coreDays: [],
      overtimeThreshold: "60",
      allowOvertimePayout: false,
      overtimeMode: "CARRY_FORWARD",
      maxNegativeBalanceMinutes: null,
      validFrom: "2025-01-01T00:00:00.000Z",
      createdAt: "<v>",
      updatedAt: "<v>",
    },
    invitationStatus: "NONE",
  },
  {
    id: "<v>",
    tenantId: "<v>",
    userId: "<v>",
    employeeNumber: "<v>",
    firstName: "Pin",
    lastName: "PinLeave",
    nfcCardId: null,
    wifiMacs: [],
    wifiPresenceEnabled: false,
    wifiOptInAt: null,
    avatarPath: null,
    classification: "VOLLZEIT",
    coverageWeight: "1",
    requiresSupervision: false,
    hireDate: "2025-01-01T00:00:00.000Z",
    exitDate: null,
    birthDate: null,
    annualVacationDays: null,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    phorestPrepMinutesOverride: null,
    phorestWrapupMinutesOverride: null,
    bsSlotFirstLongDayMinutes: null,
    bsSlotSecondLongDayMinutes: null,
    bsSlotShortDayMinutes: null,
    bsSlotBlockWeekMinutes: null,
    isTimeTrackingExempt: false,
    createdAt: "<v>",
    updatedAt: "<v>",
    user: {
      email: "<v>",
      role: "EMPLOYEE",
      isActive: true,
      lastLoginAt: null,
    },
    overtimeAccount: {
      balanceHours: "0",
    },
    workSchedule: {
      id: "<v>",
      employeeId: "<v>",
      type: "FIXED_SCHEDULE",
      weeklyHours: "40",
      monthlyHours: null,
      mondayHours: "8",
      tuesdayHours: "8",
      wednesdayHours: "8",
      thursdayHours: "8",
      fridayHours: "8",
      saturdayHours: "0",
      sundayHours: "0",
      workDays: [1, 2, 3, 4, 5],
      contractWorkDaysPerWeek: null,
      usualWorkDays: [],
      coreStart: null,
      coreEnd: null,
      coreDays: [],
      overtimeThreshold: "60",
      allowOvertimePayout: false,
      overtimeMode: "CARRY_FORWARD",
      maxNegativeBalanceMinutes: null,
      validFrom: "2025-01-01T00:00:00.000Z",
      createdAt: "<v>",
      updatedAt: "<v>",
    },
    invitationStatus: "NONE",
  },
  {
    id: "<v>",
    tenantId: "<v>",
    userId: "<v>",
    employeeNumber: "<v>",
    firstName: "Pin",
    lastName: "PinMissing",
    nfcCardId: null,
    wifiMacs: [],
    wifiPresenceEnabled: false,
    wifiOptInAt: null,
    avatarPath: null,
    classification: "VOLLZEIT",
    coverageWeight: "1",
    requiresSupervision: false,
    hireDate: "2025-01-01T00:00:00.000Z",
    exitDate: null,
    birthDate: null,
    annualVacationDays: null,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    phorestPrepMinutesOverride: null,
    phorestWrapupMinutesOverride: null,
    bsSlotFirstLongDayMinutes: null,
    bsSlotSecondLongDayMinutes: null,
    bsSlotShortDayMinutes: null,
    bsSlotBlockWeekMinutes: null,
    isTimeTrackingExempt: false,
    createdAt: "<v>",
    updatedAt: "<v>",
    user: {
      email: "<v>",
      role: "EMPLOYEE",
      isActive: true,
      lastLoginAt: null,
    },
    overtimeAccount: null,
    workSchedule: {
      id: "<v>",
      employeeId: "<v>",
      type: "FIXED_SCHEDULE",
      weeklyHours: "40",
      monthlyHours: null,
      mondayHours: "8",
      tuesdayHours: "8",
      wednesdayHours: "8",
      thursdayHours: "8",
      fridayHours: "8",
      saturdayHours: "0",
      sundayHours: "0",
      workDays: [1, 2, 3, 4, 5],
      contractWorkDaysPerWeek: null,
      usualWorkDays: [],
      coreStart: null,
      coreEnd: null,
      coreDays: [],
      overtimeThreshold: "60",
      allowOvertimePayout: false,
      overtimeMode: "CARRY_FORWARD",
      maxNegativeBalanceMinutes: null,
      validFrom: "2025-01-01T00:00:00.000Z",
      createdAt: "<v>",
      updatedAt: "<v>",
    },
    invitationStatus: "NONE",
  },
  {
    id: "<v>",
    tenantId: "<v>",
    userId: "<v>",
    employeeNumber: "<v>",
    firstName: "Pin",
    lastName: "PinPresent",
    nfcCardId: null,
    wifiMacs: [],
    wifiPresenceEnabled: false,
    wifiOptInAt: null,
    avatarPath: null,
    classification: "VOLLZEIT",
    coverageWeight: "1",
    requiresSupervision: false,
    hireDate: "2025-01-01T00:00:00.000Z",
    exitDate: null,
    birthDate: null,
    annualVacationDays: null,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    phorestPrepMinutesOverride: null,
    phorestWrapupMinutesOverride: null,
    bsSlotFirstLongDayMinutes: null,
    bsSlotSecondLongDayMinutes: null,
    bsSlotShortDayMinutes: null,
    bsSlotBlockWeekMinutes: null,
    isTimeTrackingExempt: false,
    createdAt: "<v>",
    updatedAt: "<v>",
    user: {
      email: "<v>",
      role: "EMPLOYEE",
      isActive: true,
      lastLoginAt: null,
    },
    overtimeAccount: {
      balanceHours: "0.75",
    },
    workSchedule: {
      id: "<v>",
      employeeId: "<v>",
      type: "FIXED_SCHEDULE",
      weeklyHours: "40",
      monthlyHours: null,
      mondayHours: "8",
      tuesdayHours: "8",
      wednesdayHours: "8",
      thursdayHours: "8",
      fridayHours: "8",
      saturdayHours: "0",
      sundayHours: "0",
      workDays: [1, 2, 3, 4, 5],
      contractWorkDaysPerWeek: null,
      usualWorkDays: [],
      coreStart: null,
      coreEnd: null,
      coreDays: [],
      overtimeThreshold: "60",
      allowOvertimePayout: false,
      overtimeMode: "CARRY_FORWARD",
      maxNegativeBalanceMinutes: null,
      validFrom: "2025-01-01T00:00:00.000Z",
      createdAt: "<v>",
      updatedAt: "<v>",
    },
    invitationStatus: "ACCEPTED",
  },
  {
    id: "<v>",
    tenantId: "<v>",
    userId: "<v>",
    employeeNumber: "<v>",
    firstName: "Admin",
    lastName: "Test",
    nfcCardId: null,
    wifiMacs: [],
    wifiPresenceEnabled: false,
    wifiOptInAt: null,
    avatarPath: null,
    classification: "VOLLZEIT",
    coverageWeight: "1",
    requiresSupervision: false,
    hireDate: "2024-01-01T00:00:00.000Z",
    exitDate: null,
    birthDate: null,
    annualVacationDays: null,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    phorestPrepMinutesOverride: null,
    phorestWrapupMinutesOverride: null,
    bsSlotFirstLongDayMinutes: null,
    bsSlotSecondLongDayMinutes: null,
    bsSlotShortDayMinutes: null,
    bsSlotBlockWeekMinutes: null,
    isTimeTrackingExempt: false,
    createdAt: "<v>",
    updatedAt: "<v>",
    user: {
      email: "<v>",
      role: "ADMIN",
      isActive: true,
      lastLoginAt: "<v>",
    },
    overtimeAccount: {
      balanceHours: "-3.25",
    },
    workSchedule: {
      id: "<v>",
      employeeId: "<v>",
      type: "FIXED_SCHEDULE",
      weeklyHours: "40",
      monthlyHours: null,
      mondayHours: "8",
      tuesdayHours: "8",
      wednesdayHours: "8",
      thursdayHours: "8",
      fridayHours: "8",
      saturdayHours: "0",
      sundayHours: "0",
      workDays: [1, 2, 3, 4, 5],
      contractWorkDaysPerWeek: null,
      usualWorkDays: [],
      coreStart: null,
      coreEnd: null,
      coreDays: [],
      overtimeThreshold: "60",
      allowOvertimePayout: false,
      overtimeMode: "CARRY_FORWARD",
      maxNegativeBalanceMinutes: null,
      validFrom: "2024-01-01T00:00:00.000Z",
      createdAt: "<v>",
      updatedAt: "<v>",
    },
    invitationStatus: "NONE",
  },
  {
    id: "<v>",
    tenantId: "<v>",
    userId: "<v>",
    employeeNumber: "<v>",
    firstName: "Max",
    lastName: "Test",
    nfcCardId: null,
    wifiMacs: [],
    wifiPresenceEnabled: false,
    wifiOptInAt: null,
    avatarPath: null,
    classification: "VOLLZEIT",
    coverageWeight: "1",
    requiresSupervision: false,
    hireDate: "2024-01-01T00:00:00.000Z",
    exitDate: null,
    birthDate: null,
    annualVacationDays: null,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    phorestPrepMinutesOverride: null,
    phorestWrapupMinutesOverride: null,
    bsSlotFirstLongDayMinutes: null,
    bsSlotSecondLongDayMinutes: null,
    bsSlotShortDayMinutes: null,
    bsSlotBlockWeekMinutes: null,
    isTimeTrackingExempt: false,
    createdAt: "<v>",
    updatedAt: "<v>",
    user: {
      email: "<v>",
      role: "EMPLOYEE",
      isActive: true,
      lastLoginAt: "<v>",
    },
    overtimeAccount: {
      balanceHours: "12.5",
    },
    workSchedule: {
      id: "<v>",
      employeeId: "<v>",
      type: "FIXED_SCHEDULE",
      weeklyHours: "40",
      monthlyHours: null,
      mondayHours: "8",
      tuesdayHours: "8",
      wednesdayHours: "8",
      thursdayHours: "8",
      fridayHours: "8",
      saturdayHours: "0",
      sundayHours: "0",
      workDays: [1, 2, 3, 4, 5],
      contractWorkDaysPerWeek: null,
      usualWorkDays: [],
      coreStart: null,
      coreEnd: null,
      coreDays: [],
      overtimeThreshold: "60",
      allowOvertimePayout: false,
      overtimeMode: "CARRY_FORWARD",
      maxNegativeBalanceMinutes: null,
      validFrom: "2024-01-01T00:00:00.000Z",
      createdAt: "<v>",
      updatedAt: "<v>",
    },
    invitationStatus: "NONE",
  },
];
const EXPECTED_EMPLOYEES_WITH_ANONYMIZED = [
  {
    id: "<v>",
    tenantId: "<v>",
    userId: "<v>",
    employeeNumber: "<v>",
    firstName: "Gelöscht",
    lastName: "GELÖSCHT-PINANON",
    nfcCardId: null,
    wifiMacs: [],
    wifiPresenceEnabled: false,
    wifiOptInAt: null,
    avatarPath: null,
    classification: "VOLLZEIT",
    coverageWeight: "1",
    requiresSupervision: false,
    hireDate: "2025-01-01T00:00:00.000Z",
    exitDate: null,
    birthDate: null,
    annualVacationDays: null,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    phorestPrepMinutesOverride: null,
    phorestWrapupMinutesOverride: null,
    bsSlotFirstLongDayMinutes: null,
    bsSlotSecondLongDayMinutes: null,
    bsSlotShortDayMinutes: null,
    bsSlotBlockWeekMinutes: null,
    isTimeTrackingExempt: false,
    createdAt: "<v>",
    updatedAt: "<v>",
    user: {
      email: "<v>",
      role: "EMPLOYEE",
      isActive: false,
      lastLoginAt: null,
    },
    overtimeAccount: {
      balanceHours: "1",
    },
    workSchedule: {
      id: "<v>",
      employeeId: "<v>",
      type: "FIXED_SCHEDULE",
      weeklyHours: "40",
      monthlyHours: null,
      mondayHours: "8",
      tuesdayHours: "8",
      wednesdayHours: "8",
      thursdayHours: "8",
      fridayHours: "8",
      saturdayHours: "0",
      sundayHours: "0",
      workDays: [1, 2, 3, 4, 5],
      contractWorkDaysPerWeek: null,
      usualWorkDays: [],
      coreStart: null,
      coreEnd: null,
      coreDays: [],
      overtimeThreshold: "60",
      allowOvertimePayout: false,
      overtimeMode: "CARRY_FORWARD",
      maxNegativeBalanceMinutes: null,
      validFrom: "2025-01-01T00:00:00.000Z",
      createdAt: "<v>",
      updatedAt: "<v>",
    },
    invitationStatus: "EXPIRED",
  },
  {
    id: "<v>",
    tenantId: "<v>",
    userId: "<v>",
    employeeNumber: "<v>",
    firstName: "Pin",
    lastName: "PinHoliday",
    nfcCardId: null,
    wifiMacs: [],
    wifiPresenceEnabled: false,
    wifiOptInAt: null,
    avatarPath: null,
    classification: "VOLLZEIT",
    coverageWeight: "1",
    requiresSupervision: false,
    hireDate: "2025-01-01T00:00:00.000Z",
    exitDate: null,
    birthDate: null,
    annualVacationDays: null,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    phorestPrepMinutesOverride: null,
    phorestWrapupMinutesOverride: null,
    bsSlotFirstLongDayMinutes: null,
    bsSlotSecondLongDayMinutes: null,
    bsSlotShortDayMinutes: null,
    bsSlotBlockWeekMinutes: null,
    isTimeTrackingExempt: false,
    createdAt: "<v>",
    updatedAt: "<v>",
    user: {
      email: "<v>",
      role: "EMPLOYEE",
      isActive: true,
      lastLoginAt: null,
    },
    overtimeAccount: {
      balanceHours: "-8",
    },
    workSchedule: {
      id: "<v>",
      employeeId: "<v>",
      type: "FIXED_SCHEDULE",
      weeklyHours: "40",
      monthlyHours: null,
      mondayHours: "8",
      tuesdayHours: "8",
      wednesdayHours: "8",
      thursdayHours: "8",
      fridayHours: "8",
      saturdayHours: "0",
      sundayHours: "0",
      workDays: [1, 2, 3, 4, 5],
      contractWorkDaysPerWeek: null,
      usualWorkDays: [],
      coreStart: null,
      coreEnd: null,
      coreDays: [],
      overtimeThreshold: "60",
      allowOvertimePayout: false,
      overtimeMode: "CARRY_FORWARD",
      maxNegativeBalanceMinutes: null,
      validFrom: "2025-01-01T00:00:00.000Z",
      createdAt: "<v>",
      updatedAt: "<v>",
    },
    invitationStatus: "NONE",
  },
  {
    id: "<v>",
    tenantId: "<v>",
    userId: "<v>",
    employeeNumber: "<v>",
    firstName: "Pin",
    lastName: "PinLeave",
    nfcCardId: null,
    wifiMacs: [],
    wifiPresenceEnabled: false,
    wifiOptInAt: null,
    avatarPath: null,
    classification: "VOLLZEIT",
    coverageWeight: "1",
    requiresSupervision: false,
    hireDate: "2025-01-01T00:00:00.000Z",
    exitDate: null,
    birthDate: null,
    annualVacationDays: null,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    phorestPrepMinutesOverride: null,
    phorestWrapupMinutesOverride: null,
    bsSlotFirstLongDayMinutes: null,
    bsSlotSecondLongDayMinutes: null,
    bsSlotShortDayMinutes: null,
    bsSlotBlockWeekMinutes: null,
    isTimeTrackingExempt: false,
    createdAt: "<v>",
    updatedAt: "<v>",
    user: {
      email: "<v>",
      role: "EMPLOYEE",
      isActive: true,
      lastLoginAt: null,
    },
    overtimeAccount: {
      balanceHours: "0",
    },
    workSchedule: {
      id: "<v>",
      employeeId: "<v>",
      type: "FIXED_SCHEDULE",
      weeklyHours: "40",
      monthlyHours: null,
      mondayHours: "8",
      tuesdayHours: "8",
      wednesdayHours: "8",
      thursdayHours: "8",
      fridayHours: "8",
      saturdayHours: "0",
      sundayHours: "0",
      workDays: [1, 2, 3, 4, 5],
      contractWorkDaysPerWeek: null,
      usualWorkDays: [],
      coreStart: null,
      coreEnd: null,
      coreDays: [],
      overtimeThreshold: "60",
      allowOvertimePayout: false,
      overtimeMode: "CARRY_FORWARD",
      maxNegativeBalanceMinutes: null,
      validFrom: "2025-01-01T00:00:00.000Z",
      createdAt: "<v>",
      updatedAt: "<v>",
    },
    invitationStatus: "NONE",
  },
  {
    id: "<v>",
    tenantId: "<v>",
    userId: "<v>",
    employeeNumber: "<v>",
    firstName: "Pin",
    lastName: "PinMissing",
    nfcCardId: null,
    wifiMacs: [],
    wifiPresenceEnabled: false,
    wifiOptInAt: null,
    avatarPath: null,
    classification: "VOLLZEIT",
    coverageWeight: "1",
    requiresSupervision: false,
    hireDate: "2025-01-01T00:00:00.000Z",
    exitDate: null,
    birthDate: null,
    annualVacationDays: null,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    phorestPrepMinutesOverride: null,
    phorestWrapupMinutesOverride: null,
    bsSlotFirstLongDayMinutes: null,
    bsSlotSecondLongDayMinutes: null,
    bsSlotShortDayMinutes: null,
    bsSlotBlockWeekMinutes: null,
    isTimeTrackingExempt: false,
    createdAt: "<v>",
    updatedAt: "<v>",
    user: {
      email: "<v>",
      role: "EMPLOYEE",
      isActive: true,
      lastLoginAt: null,
    },
    overtimeAccount: null,
    workSchedule: {
      id: "<v>",
      employeeId: "<v>",
      type: "FIXED_SCHEDULE",
      weeklyHours: "40",
      monthlyHours: null,
      mondayHours: "8",
      tuesdayHours: "8",
      wednesdayHours: "8",
      thursdayHours: "8",
      fridayHours: "8",
      saturdayHours: "0",
      sundayHours: "0",
      workDays: [1, 2, 3, 4, 5],
      contractWorkDaysPerWeek: null,
      usualWorkDays: [],
      coreStart: null,
      coreEnd: null,
      coreDays: [],
      overtimeThreshold: "60",
      allowOvertimePayout: false,
      overtimeMode: "CARRY_FORWARD",
      maxNegativeBalanceMinutes: null,
      validFrom: "2025-01-01T00:00:00.000Z",
      createdAt: "<v>",
      updatedAt: "<v>",
    },
    invitationStatus: "NONE",
  },
  {
    id: "<v>",
    tenantId: "<v>",
    userId: "<v>",
    employeeNumber: "<v>",
    firstName: "Pin",
    lastName: "PinPresent",
    nfcCardId: null,
    wifiMacs: [],
    wifiPresenceEnabled: false,
    wifiOptInAt: null,
    avatarPath: null,
    classification: "VOLLZEIT",
    coverageWeight: "1",
    requiresSupervision: false,
    hireDate: "2025-01-01T00:00:00.000Z",
    exitDate: null,
    birthDate: null,
    annualVacationDays: null,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    phorestPrepMinutesOverride: null,
    phorestWrapupMinutesOverride: null,
    bsSlotFirstLongDayMinutes: null,
    bsSlotSecondLongDayMinutes: null,
    bsSlotShortDayMinutes: null,
    bsSlotBlockWeekMinutes: null,
    isTimeTrackingExempt: false,
    createdAt: "<v>",
    updatedAt: "<v>",
    user: {
      email: "<v>",
      role: "EMPLOYEE",
      isActive: true,
      lastLoginAt: null,
    },
    overtimeAccount: {
      balanceHours: "0.75",
    },
    workSchedule: {
      id: "<v>",
      employeeId: "<v>",
      type: "FIXED_SCHEDULE",
      weeklyHours: "40",
      monthlyHours: null,
      mondayHours: "8",
      tuesdayHours: "8",
      wednesdayHours: "8",
      thursdayHours: "8",
      fridayHours: "8",
      saturdayHours: "0",
      sundayHours: "0",
      workDays: [1, 2, 3, 4, 5],
      contractWorkDaysPerWeek: null,
      usualWorkDays: [],
      coreStart: null,
      coreEnd: null,
      coreDays: [],
      overtimeThreshold: "60",
      allowOvertimePayout: false,
      overtimeMode: "CARRY_FORWARD",
      maxNegativeBalanceMinutes: null,
      validFrom: "2025-01-01T00:00:00.000Z",
      createdAt: "<v>",
      updatedAt: "<v>",
    },
    invitationStatus: "ACCEPTED",
  },
  {
    id: "<v>",
    tenantId: "<v>",
    userId: "<v>",
    employeeNumber: "<v>",
    firstName: "Admin",
    lastName: "Test",
    nfcCardId: null,
    wifiMacs: [],
    wifiPresenceEnabled: false,
    wifiOptInAt: null,
    avatarPath: null,
    classification: "VOLLZEIT",
    coverageWeight: "1",
    requiresSupervision: false,
    hireDate: "2024-01-01T00:00:00.000Z",
    exitDate: null,
    birthDate: null,
    annualVacationDays: null,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    phorestPrepMinutesOverride: null,
    phorestWrapupMinutesOverride: null,
    bsSlotFirstLongDayMinutes: null,
    bsSlotSecondLongDayMinutes: null,
    bsSlotShortDayMinutes: null,
    bsSlotBlockWeekMinutes: null,
    isTimeTrackingExempt: false,
    createdAt: "<v>",
    updatedAt: "<v>",
    user: {
      email: "<v>",
      role: "ADMIN",
      isActive: true,
      lastLoginAt: "<v>",
    },
    overtimeAccount: {
      balanceHours: "-3.25",
    },
    workSchedule: {
      id: "<v>",
      employeeId: "<v>",
      type: "FIXED_SCHEDULE",
      weeklyHours: "40",
      monthlyHours: null,
      mondayHours: "8",
      tuesdayHours: "8",
      wednesdayHours: "8",
      thursdayHours: "8",
      fridayHours: "8",
      saturdayHours: "0",
      sundayHours: "0",
      workDays: [1, 2, 3, 4, 5],
      contractWorkDaysPerWeek: null,
      usualWorkDays: [],
      coreStart: null,
      coreEnd: null,
      coreDays: [],
      overtimeThreshold: "60",
      allowOvertimePayout: false,
      overtimeMode: "CARRY_FORWARD",
      maxNegativeBalanceMinutes: null,
      validFrom: "2024-01-01T00:00:00.000Z",
      createdAt: "<v>",
      updatedAt: "<v>",
    },
    invitationStatus: "NONE",
  },
  {
    id: "<v>",
    tenantId: "<v>",
    userId: "<v>",
    employeeNumber: "<v>",
    firstName: "Max",
    lastName: "Test",
    nfcCardId: null,
    wifiMacs: [],
    wifiPresenceEnabled: false,
    wifiOptInAt: null,
    avatarPath: null,
    classification: "VOLLZEIT",
    coverageWeight: "1",
    requiresSupervision: false,
    hireDate: "2024-01-01T00:00:00.000Z",
    exitDate: null,
    birthDate: null,
    annualVacationDays: null,
    breakOver6hOverride: null,
    breakOver9hOverride: null,
    phorestPrepMinutesOverride: null,
    phorestWrapupMinutesOverride: null,
    bsSlotFirstLongDayMinutes: null,
    bsSlotSecondLongDayMinutes: null,
    bsSlotShortDayMinutes: null,
    bsSlotBlockWeekMinutes: null,
    isTimeTrackingExempt: false,
    createdAt: "<v>",
    updatedAt: "<v>",
    user: {
      email: "<v>",
      role: "EMPLOYEE",
      isActive: true,
      lastLoginAt: "<v>",
    },
    overtimeAccount: {
      balanceHours: "12.5",
    },
    workSchedule: {
      id: "<v>",
      employeeId: "<v>",
      type: "FIXED_SCHEDULE",
      weeklyHours: "40",
      monthlyHours: null,
      mondayHours: "8",
      tuesdayHours: "8",
      wednesdayHours: "8",
      thursdayHours: "8",
      fridayHours: "8",
      saturdayHours: "0",
      sundayHours: "0",
      workDays: [1, 2, 3, 4, 5],
      contractWorkDaysPerWeek: null,
      usualWorkDays: [],
      coreStart: null,
      coreEnd: null,
      coreDays: [],
      overtimeThreshold: "60",
      allowOvertimePayout: false,
      overtimeMode: "CARRY_FORWARD",
      maxNegativeBalanceMinutes: null,
      validFrom: "2024-01-01T00:00:00.000Z",
      createdAt: "<v>",
      updatedAt: "<v>",
    },
    invitationStatus: "NONE",
  },
];
const EXPECTED_TODAY_ATTENDANCE = {
  date: "2026-06-17",
  employees: [
    {
      id: "<v>",
      name: "Admin Test",
      employeeNumber: "<v>",
      status: "missing",
      reason: null,
    },
    {
      id: "<v>",
      name: "Max Test",
      employeeNumber: "<v>",
      status: "clocked_in",
      reason: null,
    },
    {
      id: "<v>",
      name: "Pin PinHoliday",
      employeeNumber: "<v>",
      status: "holiday",
      reason: "Hausfeiertag wt85f",
    },
    {
      id: "<v>",
      name: "Pin PinLeave",
      employeeNumber: "<v>",
      status: "absent",
      reason: "Urlaub",
    },
    {
      id: "<v>",
      name: "Pin PinMissing",
      employeeNumber: "<v>",
      status: "missing",
      reason: null,
    },
    {
      id: "<v>",
      name: "Pin PinPresent",
      employeeNumber: "<v>",
      status: "present",
      reason: null,
    },
  ],
  summary: {
    present: 1,
    absent: 1,
    clockedIn: 1,
    missing: 2,
    holiday: 1,
  },
};
const EXPECTED_TIME_ENTRIES_OWN = [
  {
    id: "<v>",
    employeeId: "<v>",
    date: "2026-06-12T00:00:00.000Z",
    startTime: "2026-06-12T06:00:00.000Z",
    endTime: null,
    breakMinutes: 0,
    type: "WORK",
    source: "MANUAL",
    note: null,
    isLocked: false,
    lockedAt: null,
    isInvalid: false,
    invalidReason: null,
    invalidReasonCode: null,
    deletedAt: null,
    createdAt: "<v>",
    updatedAt: "<v>",
    createdBy: null,
    breakStatus: "CONFIRMED",
    breakWaivedReason: null,
    activityKind: "UNSPECIFIED",
    retroRequestId: null,
    salonId: "<v>",
    employee: {
      firstName: "Admin",
      lastName: "Test",
    },
    breaks: [],
    activityShares: [],
    presenceMinutes: null,
    workingMinutes: null,
  },
  {
    id: "<v>",
    employeeId: "<v>",
    date: "2026-06-10T00:00:00.000Z",
    startTime: "2026-06-10T06:00:00.000Z",
    endTime: "2026-06-10T15:00:00.000Z",
    breakMinutes: 30,
    type: "WORK",
    source: "MANUAL",
    note: null,
    isLocked: false,
    lockedAt: null,
    isInvalid: false,
    invalidReason: null,
    invalidReasonCode: null,
    deletedAt: null,
    createdAt: "<v>",
    updatedAt: "<v>",
    createdBy: null,
    breakStatus: "CONFIRMED",
    breakWaivedReason: null,
    activityKind: "UNSPECIFIED",
    retroRequestId: null,
    salonId: "<v>",
    employee: {
      firstName: "Admin",
      lastName: "Test",
    },
    breaks: [
      {
        id: "<v>",
        timeEntryId: "<v>",
        startTime: "2026-06-10T10:00:00.000Z",
        endTime: "2026-06-10T10:30:00.000Z",
        createdAt: "<v>",
      },
    ],
    activityShares: [],
    presenceMinutes: 540,
    workingMinutes: 510,
  },
];
const EXPECTED_TIME_ENTRIES_OTHER = [
  {
    id: "<v>",
    employeeId: "<v>",
    date: "2026-06-17T00:00:00.000Z",
    startTime: "2026-06-17T06:00:00.000Z",
    endTime: null,
    breakMinutes: 0,
    type: "WORK",
    source: "MANUAL",
    note: null,
    isLocked: false,
    lockedAt: null,
    isInvalid: false,
    invalidReason: null,
    invalidReasonCode: null,
    deletedAt: null,
    createdAt: "<v>",
    updatedAt: "<v>",
    createdBy: null,
    breakStatus: "CONFIRMED",
    breakWaivedReason: null,
    activityKind: "UNSPECIFIED",
    retroRequestId: null,
    salonId: "<v>",
    employee: {
      firstName: "Max",
      lastName: "Test",
    },
    breaks: [],
    activityShares: [],
    presenceMinutes: null,
    workingMinutes: null,
  },
  {
    id: "<v>",
    employeeId: "<v>",
    date: "2026-06-15T00:00:00.000Z",
    startTime: "2026-06-15T06:00:00.000Z",
    endTime: "2026-06-15T14:30:00.000Z",
    breakMinutes: 30,
    type: "WORK",
    source: "MANUAL",
    note: null,
    isLocked: false,
    lockedAt: null,
    isInvalid: false,
    invalidReason: null,
    invalidReasonCode: null,
    deletedAt: null,
    createdAt: "<v>",
    updatedAt: "<v>",
    createdBy: null,
    breakStatus: "CONFIRMED",
    breakWaivedReason: null,
    activityKind: "UNSPECIFIED",
    retroRequestId: null,
    salonId: "<v>",
    employee: {
      firstName: "Max",
      lastName: "Test",
    },
    breaks: [],
    activityShares: [],
    presenceMinutes: 510,
    workingMinutes: 480,
  },
];

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const runSpecific =
        key === "id" ||
        key.endsWith("Id") ||
        key.endsWith("At") ||
        key === "email" ||
        key === "employeeNumber" ||
        key === "token";
      out[key] = runSpecific && inner !== null ? "<v>" : normalize(inner);
    }
    return out;
  }
  return value;
}

/**
 * Amendment 2026-10-16 (Issue #70, Phase 70b-06): GET /time-entries rows additionally carry the
 * display field `salonName` (the name of the entry's own salon). The frozen literals below are NOT
 * re-captured: the field is taken out of the rows before the comparison and proven separately
 * against the salon the row's `salonId` names, so every other key and value stays pinned.
 */
async function withoutSalonName(
  prisma: FastifyInstance["prisma"],
  rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  expect(rows.length).toBeGreaterThan(0);
  const salons = await prisma.salon.findMany({
    where: { id: { in: rows.map((r) => r.salonId as string) } },
    select: { id: true, name: true },
  });
  return rows.map(({ salonName, ...rest }) => {
    expect(typeof salonName).toBe("string");
    expect(salonName).toBe(salons.find((s) => s.id === rest.salonId)?.name);
    return rest;
  });
}

function day(date: string) {
  return new Date(`${date}T00:00:00Z`);
}

describe("Issue #85 / #547 — frozen whole-tenant responses (tenant admin)", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  let salonB: { id: string };
  // fixture ids per label
  const ids: Record<string, string> = {};
  let anonymizedId = "";
  let ownEntryIds: string[] = [];
  let otherEntryIds: string[] = [];

  async function createPerson(
    label: string,
    opts: { homeSalonId: string; balance: string | null; anonymized?: boolean },
  ) {
    const passwordHash = await bcrypt.hash("test1234", 10);
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${stamp}@test.de`,
        passwordHash: opts.anonymized ? "ANONYMIZED" : passwordHash,
        role: "EMPLOYEE",
        isActive: !opts.anonymized,
      },
    });
    // Issue #539 (D-10): the employee response serves the role DERIVED from stored assignments, so
    // the frozen `user.role: "EMPLOYEE"` below needs the stored Mitarbeiter row the fixture user
    // stands for (the literal itself is unchanged). The anonymized fixture row is synthetic: it
    // never went through the anonymization, which would have deleted this row (role `null`).
    await grantSystemRole(app.prisma, { tenantId: d.tenant.id, userId: user.id, role: "EMPLOYEE" });
    const number = `${label.toUpperCase()}-${stamp}`;
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: d.tenant.id,
        userId: user.id,
        employeeNumber: opts.anonymized ? `GELÖSCHT-${number}` : number,
        firstName: opts.anonymized ? "Gelöscht" : "Pin",
        lastName: opts.anonymized ? `GELÖSCHT-${label.toUpperCase()}` : label,
        hireDate: new Date("2025-01-01T00:00:00Z"),
      },
    });
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2025-01-01T00:00:00Z"),
      },
    });
    if (opts.balance !== null) {
      await app.prisma.overtimeAccount.create({
        data: { employeeId: employee.id, balanceHours: opts.balance },
      });
    }
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: d.tenant.id,
        employeeId: employee.id,
        salonId: opts.homeSalonId,
        kind: "HOME",
        validFrom: new Date("2020-01-01T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });
    ids[label] = employee.id;
    return employee;
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "wt85f");
    const prisma = app.prisma;
    salonB = await createTestSalon(prisma, d.tenant.id, { name: "Pin Salon B" });

    // Seeded persons: distinct, non-zero balances; both homed in the default salon.
    await prisma.overtimeAccount.update({
      where: { employeeId: d.adminEmployee.id },
      data: { balanceHours: "-3.25" },
    });
    await prisma.overtimeAccount.update({
      where: { employeeId: d.employee.id },
      data: { balanceHours: "12.5" },
    });
    for (const [label, employeeId] of [
      ["admin", d.adminEmployee.id],
      ["seeded", d.employee.id],
    ] as const) {
      ids[label] = employeeId;
      await prisma.employeeSalonAssignment.create({
        data: {
          tenantId: d.tenant.id,
          employeeId,
          salonId: d.salonId,
          kind: "HOME",
          validFrom: new Date("2020-01-01T00:00:00Z"),
          validUntil: null,
          weekdays: [],
        },
      });
    }

    // present: closed entry today; absent: approved vacation; holiday: salon B has a house
    // holiday today; missing: contract workday without entry (has a deployment in B and no
    // overtime account at all).
    const present = await createPerson("PinPresent", { homeSalonId: d.salonId, balance: "0.75" });
    const onLeave = await createPerson("PinLeave", { homeSalonId: d.salonId, balance: "0" });
    await createPerson("PinHoliday", { homeSalonId: salonB.id, balance: "-8" });
    const missing = await createPerson("PinMissing", { homeSalonId: d.salonId, balance: null });
    const anonymized = await createPerson("PinAnon", {
      homeSalonId: d.salonId,
      balance: "1",
      anonymized: true,
    });
    anonymizedId = anonymized.id;

    await prisma.employeeSalonAssignment.create({
      data: {
        tenantId: d.tenant.id,
        employeeId: missing.id,
        salonId: salonB.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2026-01-01T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });

    // A pending invitation (invitationStatus derivation), unaccepted.
    await prisma.invitation.create({
      data: {
        token: `pin-token-${Date.now().toString(36)}`,
        employeeId: present.id,
        email: `pin-invite-${Date.now().toString(36)}@test.de`,
        expiresAt: new Date("2099-01-01T00:00:00Z"),
      },
    });

    await prisma.publicHoliday.create({
      data: {
        tenantId: d.tenant.id,
        salonId: salonB.id,
        date: day("2026-06-17"),
        name: "Hausfeiertag wt85f",
        federalState: "NIEDERSACHSEN",
        year: 2026,
      },
    });

    // approved vacation today
    await prisma.leaveRequest.create({
      data: {
        employeeId: onLeave.id,
        leaveTypeId: d.vacationType.id,
        startDate: day("2026-06-17"),
        endDate: day("2026-06-17"),
        days: 1,
        status: "APPROVED",
        reviewedBy: d.adminUser.id,
        reviewedAt: new Date(),
      },
    });

    // today's entries: closed (present) and open (clocked_in)
    await prisma.timeEntry.create({
      data: {
        employeeId: present.id,
        date: day("2026-06-17"),
        startTime: new Date("2026-06-17T06:00:00Z"),
        endTime: new Date("2026-06-17T08:30:00Z"),
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
        salonId: d.salonId,
      },
    });
    const seededOpen = await prisma.timeEntry.create({
      data: {
        employeeId: d.employee.id,
        date: day("2026-06-17"),
        startTime: new Date("2026-06-17T06:00:00Z"),
        endTime: null,
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
        salonId: d.salonId,
      },
    });
    const seededClosed = await prisma.timeEntry.create({
      data: {
        employeeId: d.employee.id,
        date: day("2026-06-15"),
        startTime: new Date("2026-06-15T06:00:00Z"),
        endTime: new Date("2026-06-15T14:30:00Z"),
        breakMinutes: 30,
        type: "WORK",
        source: "MANUAL",
        salonId: d.salonId,
      },
    });
    otherEntryIds = [seededOpen.id, seededClosed.id];

    // the admin's own entries: one closed with a Break row, one open
    const adminClosed = await prisma.timeEntry.create({
      data: {
        employeeId: d.adminEmployee.id,
        date: day("2026-06-10"),
        startTime: new Date("2026-06-10T06:00:00Z"),
        endTime: new Date("2026-06-10T15:00:00Z"),
        breakMinutes: 30,
        breakStatus: "CONFIRMED",
        type: "WORK",
        source: "MANUAL",
        salonId: d.salonId,
      },
    });
    await prisma.break.create({
      data: {
        timeEntryId: adminClosed.id,
        startTime: new Date("2026-06-10T10:00:00Z"),
        endTime: new Date("2026-06-10T10:30:00Z"),
      },
    });
    const adminOpen = await prisma.timeEntry.create({
      data: {
        employeeId: d.adminEmployee.id,
        date: day("2026-06-12"),
        startTime: new Date("2026-06-12T06:00:00Z"),
        endTime: null,
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
        salonId: d.salonId,
      },
    });
    ownEntryIds = [adminOpen.id, adminClosed.id]; // date desc
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("whole-tenant-frozen-85 cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function get(url: string): Promise<unknown> {
    vi.useFakeTimers({ now: FAKE_NOW, toFake: ["Date"] });
    try {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${reissueTokenNow(app, d.adminToken)}` },
      });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body);
    } finally {
      vi.useRealTimers();
    }
  }

  function byName(
    rows: Array<Record<string, unknown>>,
    key: (r: Record<string, unknown>) => string,
  ) {
    return [...rows].sort((a, b) => key(a).localeCompare(key(b)));
  }

  const employeeKey = (r: Record<string, unknown>) => `${r.lastName}|${r.firstName}`;
  const allVisibleIds = () =>
    [ids.admin, ids.seeded, ids.PinPresent, ids.PinLeave, ids.PinHoliday, ids.PinMissing].sort(
      (a, b) => a.localeCompare(b),
    );

  it("(a) GET /employees answers the frozen literal", async () => {
    const body = (await get("/api/v1/employees")) as Array<Record<string, unknown>>;
    expect(body.map((r) => r.id as string).sort((a, b) => a.localeCompare(b))).toEqual(
      allVisibleIds(),
    );
    expect(normalize(byName(body, employeeKey))).toEqual(EXPECTED_EMPLOYEES);
  });

  it("(b) GET /employees?includeAnonymized=true answers the frozen literal", async () => {
    const body = (await get("/api/v1/employees?includeAnonymized=true")) as Array<
      Record<string, unknown>
    >;
    expect(body.map((r) => r.id as string).sort((a, b) => a.localeCompare(b))).toEqual(
      [...allVisibleIds(), anonymizedId].sort((a, b) => a.localeCompare(b)),
    );
    expect(normalize(byName(body, employeeKey))).toEqual(EXPECTED_EMPLOYEES_WITH_ANONYMIZED);
  });

  it("(c) GET /dashboard/today-attendance answers the frozen literal", async () => {
    const body = (await get("/api/v1/dashboard/today-attendance")) as {
      employees: Array<Record<string, unknown>>;
    };
    expect(body.employees.map((r) => r.id as string).sort((a, b) => a.localeCompare(b))).toEqual(
      allVisibleIds(),
    );
    const sorted = { ...body, employees: byName(body.employees, (r) => String(r.name)) };
    expect(normalize(sorted)).toEqual(EXPECTED_TODAY_ATTENDANCE);
  });

  it("(d) GET /time-entries (own entries) answers the frozen literal", async () => {
    const body = (await get("/api/v1/time-entries?from=2026-06-01&to=2026-06-30")) as Array<
      Record<string, unknown>
    >;
    expect(body.map((r) => r.id)).toEqual(ownEntryIds);
    expect(normalize(await withoutSalonName(app.prisma, body))).toEqual(EXPECTED_TIME_ENTRIES_OWN);
  });

  it("(e) GET /time-entries?employeeId= answers the frozen literal", async () => {
    const body = (await get(
      `/api/v1/time-entries?from=2026-06-01&to=2026-06-30&employeeId=${ids.seeded}`,
    )) as Array<Record<string, unknown>>;
    expect(body.map((r) => r.id)).toEqual(otherEntryIds);
    expect(normalize(await withoutSalonName(app.prisma, body))).toEqual(
      EXPECTED_TIME_ENTRIES_OTHER,
    );
  });
});
